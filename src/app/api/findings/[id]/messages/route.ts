import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse } from '@/server/api/http'
import { assertUuid, requireSession } from '@/server/auth/guard'
import { askFindingQuestion, loadOwnedFindingContext, sanitizeQuestion } from '@/core/review/conversation'
import {
  imageAttachmentSchema,
  MAX_IMAGES_PER_MESSAGE,
  type ImageAttachment,
} from '@/core/contracts/conversation'
import { listFindingMessages, type MessageRow } from '@/server/queries/messages'
import type { ApiErrorCode } from '@/core/contracts/api'
import type { ConversationOutcome } from '@/core/review/conversation'

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({ text: z.unknown(), images: z.unknown().optional() })

/** 图像附件校验（多模态追问）：≤3 张、mime 白名单、base64 长度上限 */
function parseImages(raw: unknown): { ok: true; images: ImageAttachment[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] }
  if (!Array.isArray(raw)) return { ok: false, message: 'images 必须是数组' }
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, message: `截图最多 ${MAX_IMAGES_PER_MESSAGE} 张` }
  }
  const parsed = z.array(imageAttachmentSchema).safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: '截图格式不合法（仅支持 png/jpeg/webp/gif，单张 ≤1MB）' }
  }
  return { ok: true, images: parsed.data }
}

export const runtime = 'nodejs'
// 追问整轮预算 60s；函数执行上限与之对齐
export const maxDuration = 60

/**
 * POST：提交追问。空白/超长 400，未登录 401，跨会话 finding 404。
 * 超时/取消/预算耗尽/AI 未配置返回结构化错误，已产生的有效消息保留（可 GET 恢复）。
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '问题')
    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success || typeof parsed.data.text !== 'string') {
      return jsonError(400, 'invalid_request', 'text 必须是字符串')
    }
    const sanitized = sanitizeQuestion(parsed.data.text)
    if (!sanitized.ok) {
      return jsonError(
        400,
        'invalid_request',
        sanitized.reason === 'blank' ? '问题不能为空' : '问题长度超过上限',
      )
    }
    const images = parseImages(parsed.data.images)
    if (!images.ok) return jsonError(400, 'invalid_request', images.message)

    const outcome = await askFindingQuestion(sql, {
      sessionId: session.id,
      findingId: id,
      text: parsed.data.text,
      images: images.images,
      signal: req.signal,
    })
    return conversationResponse(outcome)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** 成功返回回答/引用/usage/degradedReason；故障态返回结构化错误（消息已保留） */
function conversationResponse(outcome: ConversationOutcome) {
  const payload = {
    status: outcome.status,
    degradedReason: outcome.degradedReason,
    userMessageId: outcome.userMessageId,
    assistantMessageId: outcome.assistantMessageId,
    citations: outcome.citations,
    guidelineChunkIds: outcome.guidelineChunkIds,
    usage: outcome.usage,
  }
  if (outcome.status === 'answered' || outcome.status === 'insufficient_evidence') {
    return jsonOk(payload)
  }
  const errorMap: Partial<
    Record<typeof outcome.status, { status: number; code: ApiErrorCode; message: string }>
  > = {
    ai_unavailable: { status: 503, code: 'ai_unavailable', message: 'AI 未配置，无法生成回答' },
    timeout: { status: 504, code: 'timeout', message: '追问超时，已保留你的问题' },
    cancelled: { status: 409, code: 'cancelled', message: '追问已取消，已保留你的问题' },
    budget_exhausted: { status: 429, code: 'budget_exceeded', message: '预算耗尽，已保留你的问题' },
  }
  const mapped = errorMap[outcome.status]
  if (!mapped) return jsonError(500, 'internal_error', '追问失败')
  return jsonError(mapped.status, mapped.code, mapped.message)
}

/** GET：分页返回当前 finding 的历史消息（跨会话 404） */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '问题')
    // 归属校验：跨会话 finding 404（预置项目只读，同样 404）
    await loadOwnedFindingContext(sql, session.id, id)
    const cursor = req.nextUrl.searchParams.get('cursor')
    const limitRaw = req.nextUrl.searchParams.get('limit')
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
    const page = await listFindingMessages(sql, id, {
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
    return jsonOk({ items: page.items satisfies MessageRow[], nextCursor: page.nextCursor })
  } catch (err) {
    return toErrorResponse(err)
  }
}

import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse } from '@/server/api/http'
import { assertUuid, requireSession } from '@/server/auth/guard'
import { proposePatchForFinding, type PatchProposalOutcome } from '@/core/patch/propose'
import { getLatestFindingPatch } from '@/server/queries/patches'
import { loadOwnedFindingContext } from '@/core/review/conversation'
import type { ApiErrorCode } from '@/core/contracts/api'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'
// 提案整轮预算 60s（规格 11：POST /api/findings/:id/patch 最长 60 秒）
export const maxDuration = 60

/**
 * POST：生成补丁提案（规格 9.5/11）。跨会话 finding 404；预算 2 次模型请求 / 60s。
 * chat 未配置时使用确定性 MockPatchProvider（明确标注 Mock 示例提案，非真实 AI 修复）。
 * 已有同基线提案时返回既有提案（status=existing），不再发起模型调用。
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '问题')
    const outcome = await proposePatchForFinding(sql, {
      sessionId: session.id,
      findingId: id,
      signal: req.signal,
    })
    return proposalResponse(outcome)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** 成功返回提案与三项验证；故障态返回结构化错误（{error:{code,message,requestId}}） */
function proposalResponse(outcome: PatchProposalOutcome) {
  if (outcome.status === 'proposed' || outcome.status === 'invalid' || outcome.status === 'existing') {
    return jsonOk({
      status: outcome.status,
      patch: {
        id: outcome.patchId,
        baseFileHash: outcome.baseFileHash,
        diffText: outcome.diffText,
        validation: outcome.validation,
        note: outcome.note,
      },
      reasons: outcome.reasons,
      usage: outcome.usage,
    })
  }
  const errorMap: Partial<
    Record<typeof outcome.status, { status: number; code: ApiErrorCode; message: string }>
  > = {
    unsupported_file: { status: 409, code: 'conflict', message: outcome.reasons[0] ?? '该文件不支持生成补丁提案' },
    no_proposal: { status: 409, code: 'conflict', message: '模型未给出可审阅的补丁提案' },
    budget_exhausted: { status: 429, code: 'budget_exceeded', message: '预算耗尽，未能生成补丁提案' },
    timeout: { status: 504, code: 'timeout', message: '补丁提案生成超时' },
    cancelled: { status: 409, code: 'cancelled', message: '补丁提案生成已取消' },
    ai_unavailable: { status: 503, code: 'ai_unavailable', message: 'AI 未配置，无法生成补丁提案' },
  }
  const mapped = errorMap[outcome.status]
  if (!mapped) return jsonError(500, 'internal_error', '补丁提案生成失败')
  return jsonError(mapped.status, mapped.code, mapped.message)
}

/**
 * GET：恢复当前 finding 的既有提案（刷新后 UI 恢复用）。
 * 无提案返回 {patch:null}；跨会话 finding 404。
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '问题')
    await loadOwnedFindingContext(sql, session.id, id)
    const patch = await getLatestFindingPatch(sql, id)
    if (!patch || patch.status === 'superseded') {
      return jsonOk({ patch: null })
    }
    return jsonOk({ patch })
  } catch (err) {
    return toErrorResponse(err)
  }
}

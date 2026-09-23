import { z } from 'zod'
import { codeRefSchema, type CodeRef } from './findings'

/**
 * 追问会话合同（规格 9.5 / R05）：围绕当前 finding 的受限追问。
 * 每轮至多 4 次模型请求、8 次工具调用、60 秒；引用必须通过证据校验。
 */

/** 追问轮预算（规格 9.5） */
export const CONVERSATION_BUDGET = {
  maxModelCalls: 4,
  maxToolCalls: 8,
  maxInputTokens: 60_000,
  maxOutputTokens: 8_000,
  wallMs: 60_000,
} as const

/** 用户问题长度上限（客户端与服务端同值校验） */
export const MAX_QUESTION_LENGTH = 1000

/** 模型回答长度上限 */
export const MAX_ANSWER_LENGTH = 4000

/** 图像附件（多模态追问）：仅随当轮请求发给模型；服务端只存元数据，不存原图 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const MAX_IMAGES_PER_MESSAGE = 3
/** 单张图像 base64 长度上限（≈1MB 原始字节） */
export const MAX_IMAGE_BASE64_LENGTH = 1_400_000

export const imageAttachmentSchema = z.object({
  mime: z.enum(IMAGE_MIME_TYPES),
  dataBase64: z
    .string()
    .min(16)
    .max(MAX_IMAGE_BASE64_LENGTH)
    .regex(/^[A-Za-z0-9+/=\s]+$/, 'dataBase64 必须是 base64 编码'),
  name: z.string().max(120).optional(),
})
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>

/**
 * 消息状态标签：区分正常回答 / 证据不足 / 超时 / 取消 / 预算耗尽 / AI 未配置。
 * 随 assistant 消息的 usageJson 持久化，刷新后可恢复；user 消息 usageJson 为 null。
 */
export type MessageStatus =
  | 'answered'
  | 'insufficient_evidence'
  | 'timeout'
  | 'cancelled'
  | 'budget_exhausted'
  | 'ai_unavailable'

/** 消息 usage 标签（含 provider/Mock、调用计数、检索模式；不含密钥与思维链） */
export interface MessageUsage {
  provider: 'mock' | 'openai'
  modelId: string | null
  modelCalls: number
  toolCalls: number
  inputTokensEstimated: number
  outputTokensEstimated: number
  inputTokensMeasured: number | null
  outputTokensMeasured: number | null
  elapsedMs: number
  retrievalMode: 'hybrid' | 'lexical_only' | null
  status: MessageStatus
  degradedReason: string | null
  /** 用户消息随附图像的元数据（原图不持久化；assistant 消息无此字段） */
  images?: Array<{ mime: string; name?: string; bytes: number }>
}

/** 已通过证据校验的代码引用（持久化到 messages.citationsJson） */
export type MessageCitation = CodeRef

/**
 * submit_answer 工具输入：模型只能通过该工具提交结构化回答，
 * 引用与规范块 id 由服务端按 R04 同一证据逻辑校验后才入库。
 */
export const answerInputSchema = z.object({
  answer: z.string().min(1).max(MAX_ANSWER_LENGTH),
  citations: z.array(codeRefSchema).max(10).default([]),
  guidelineChunkIds: z.array(z.string()).max(10).default([]),
})
export type AnswerInput = z.infer<typeof answerInputSchema>

import { z } from 'zod'

/** 单文件补丁编辑（规格 9.5）：替换快照文件的 [startLine, endLine] 行为 replacementText（统一 LF 严格匹配旧文本） */
export const patchEditSchema = z.object({
  path: z.string().min(1),
  baseFileHash: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  expectedOldText: z.string(),
  replacementText: z.string(),
})
export type PatchEdit = z.infer<typeof patchEditSchema>

export const patchEditListSchema = z
  .array(patchEditSchema)
  .min(1)
  .refine((edits) => new Set(edits.map((e) => e.path)).size === 1, {
    message: '补丁只能修改单个文件',
  })
export type PatchEditList = z.infer<typeof patchEditListSchema>

export const patchSyntaxStatusSchema = z.enum([
  'pass',
  'fail',
  'not_checkable',
  'baseline_failed',
])
export type PatchSyntaxStatus = z.infer<typeof patchSyntaxStatusSchema>

/**
 * 提案生成 provider 标签：mock = 确定性 Mock（非真实 AI 修复）；
 * openai = 真实/受控 ChatProvider（无真实凭证时受控 provider 同样走此标签，
 * 由调用方注入）。持久化在 validationJson，刷新后 UI 仍能如实标注。
 */
export const patchProviderSchema = z.enum(['mock', 'openai'])
export type PatchProviderLabel = z.infer<typeof patchProviderSchema>

/** 补丁验证结果：applicable / syntax / tests 三项分开记录，不得混称 */
export const patchValidationSchema = z.object({
  applicable: z.boolean(),
  syntax: patchSyntaxStatusSchema,
  tests: z.literal('not_run'),
  reasons: z.array(z.string()).default([]),
  baselineSyntaxErrors: z.number().default(0),
  patchedSyntaxErrors: z.number().default(0),
  /** R06：生成方标签（Mock 提案必须如实标注），随 validationJson 持久化 */
  provider: patchProviderSchema.optional(),
})
export type PatchValidation = z.infer<typeof patchValidationSchema>

/** submit_patch 工具输入：模型只能通过该工具提交单文件编辑列表，服务端校验后才入库 */
export const submitPatchInputSchema = z.object({
  edits: patchEditListSchema,
  /** 模型对修改的简短说明（可空；不作为可信结论展示） */
  note: z.string().max(1000).optional(),
})
export type SubmitPatchInput = z.infer<typeof submitPatchInputSchema>

export const patchStatusSchema = z.enum(['proposed', 'invalid', 'superseded'])
export type PatchStatus = z.infer<typeof patchStatusSchema>

/* ---------- R06：补丁提案预算与合同扩展 ---------- */

/** 单次补丁最多变更行数（规格 9.5）。口径：Σ max(旧行数, 新行数) */
export const MAX_PATCH_CHANGED_LINES = 200

/** 提案生成每轮预算：至多 2 次模型请求（含 1 次结构修复）、60 秒墙钟 */
export const PATCH_BUDGET = {
  maxModelCalls: 2,
  maxToolCalls: 4,
  maxInputTokens: 60_000,
  maxOutputTokens: 8_000,
  wallMs: 60_000,
} as const

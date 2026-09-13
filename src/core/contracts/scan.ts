import { z } from 'zod'

export const scanStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
])
export type ScanStatus = z.infer<typeof scanStatusSchema>

export const stageSchema = z.enum([
  'ingest',
  'index',
  'static',
  'ai',
  'validate',
  'report',
])
export type Stage = z.infer<typeof stageSchema>

export const SCAN_STAGES: Stage[] = [
  'ingest',
  'index',
  'static',
  'ai',
  'validate',
  'report',
]

export const scanConfigSchema = z.object({
  enableCloudAI: z.boolean().default(false),
  mode: z.literal('standard').default('standard'),
})
export type ScanConfig = z.infer<typeof scanConfigSchema>

export const jobKindSchema = z.enum(['scan', 'document_index', 'evaluation'])
export type JobKind = z.infer<typeof jobKindSchema>

export const jobStateSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type JobState = z.infer<typeof jobStateSchema>

export const toolCallStatusSchema = z.enum(['ok', 'error', 'budget_exceeded'])
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>

export interface ToolCallRecord {
  sequence: number
  toolName: string
  inputSummary: string
  resultSummary: string
  elapsedMs: number
  status: ToolCallStatus
}

/** 扫描覆盖信息（规格 9.1：静态覆盖与 AI 覆盖单独计数） */
export interface CoverageInfo {
  totalFiles: number
  analyzableFiles: number
  ignoredFiles: number
  parseFailedFiles: number
  staticCheckedFiles: number
  ai: {
    enabled: boolean
    completed: boolean
    degradedReason: string | null // 'ai_unavailable' | 'lexical_only' | 'budget_exceeded' | ...
    selectedFiles: string[]
    readFiles: string[]
    readLineRanges: Record<string, Array<[number, number]>>
    notReadCount: number
    selectionBasis: string
  }
}

export interface UsageInfo {
  provider: 'mock' | 'openai'
  modelId: string | null
  modelCalls: number
  toolCalls: number
  inputTokensEstimated: number
  outputTokensEstimated: number
  inputTokensMeasured: number | null
  outputTokensMeasured: number | null
  aiElapsedMs: number
}

/** 风险指标（规格 12）riskIndex = min(100, 20*critical + 10*high + 4*medium + low) */
export interface RiskInfo {
  riskIndex: number
  counts: Record<string, number>
  countedFindings: number
  needsReview: number
  falsePositives: number
  formula: string
  note: string
}

export const SCAN_RULE_VERSION = 'static-rules-v1'
export const PROMPT_VERSION = 'review-prompt-v1'

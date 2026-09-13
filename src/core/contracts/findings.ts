import { z } from 'zod'

export const severitySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
])
export type Severity = z.infer<typeof severitySchema>

export const categorySchema = z.enum([
  'security',
  'correctness',
  'performance',
  'maintainability',
])
export type Category = z.infer<typeof categorySchema>

export const sourceSchema = z.enum(['static', 'ai', 'combined'])
export type SourceLabel = z.infer<typeof sourceSchema>

export const evidenceStatusSchema = z.enum(['valid', 'needs_review'])
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>

export const feedbackSchema = z.enum(['unreviewed', 'confirmed', 'false_positive'])
export type Feedback = z.infer<typeof feedbackSchema>

/** 代码引用：路径 + 行段（1 起始）+ 引文 */
export const codeRefSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  quote: z.string(),
})
export type CodeRef = z.infer<typeof codeRefSchema>

/** 模型/规则产出的问题草稿（规格 9.3） */
export const findingDraftSchema = z
  .object({
    title: z.string().min(1).max(200),
    category: categorySchema,
    severity: severitySchema,
    confidence: z.number().min(0).max(1),
    primary: codeRefSchema,
    related: z.array(codeRefSchema).max(10).default([]),
    condition: z.string().max(1000).default(''),
    impact: z.string().max(1000).default(''),
    reasoningSummary: z.string().max(2000).default(''),
    recommendation: z.string().max(2000).default(''),
    guidelineChunkIds: z.array(z.string()).max(10).default([]),
    symbol: z.string().max(200).optional(),
  })
  .refine((d) => d.primary.startLine <= d.primary.endLine, {
    message: 'primary.startLine 必须小于等于 endLine',
    path: ['primary', 'startLine'],
  })
export type FindingDraft = z.infer<typeof findingDraftSchema>

/** 数据库中存储的完整 finding 记录（draft + 来源追踪字段） */
export interface FindingRecord {
  id: string
  scanId: string
  ruleId: string | null
  fingerprint: string
  draft: FindingDraft
  source: SourceLabel
  evidenceStatus: EvidenceStatus
  feedback: Feedback
  createdAt: string
}

/** 去重指纹输入：同一规范化路径 + 重叠行范围 + 相同 ruleId（规格 9.3） */
export function staticFingerprint(
  ruleId: string,
  path: string,
  startLine: number,
  endLine: number,
): string {
  return `static:${ruleId}:${path}:${startLine}-${endLine}`
}

import { z } from 'zod'

/**
 * 评测合同（规格 13 / R08）：三模式固定配置、消融仅切换 RAG；
 * 指标含 N/A（分母为零）规则与样例集口径声明。
 */

export const evaluationModeSchema = z.enum(['static_only', 'llm_no_rag', 'hybrid_rag'])
export type EvaluationMode = z.infer<typeof evaluationModeSchema>

export const EVALUATION_MODE_LABELS: Record<EvaluationMode, string> = {
  static_only: '仅静态规则（无 AI）',
  llm_no_rag: 'AI 审查 · 无规范检索（消融基线）',
  hybrid_rag: 'AI 审查 · 混合 RAG（消融实验组）',
}

export const evaluationSplitSchema = z.enum(['dev', 'holdout', 'all'])
export type EvaluationSplit = z.infer<typeof evaluationSplitSchema>

/** evaluations.config_json 的结构化形态 */
export interface EvaluationRunConfig {
  mode: EvaluationMode
  split: EvaluationSplit
  executor: 'worker' | 'cli'
  requestedAt: string
  projectLimit?: number
}

/** 指标值：null 表示分母为零（展示为 N/A，规格 13） */
export type MetricValue = number | null

export interface MetricSummary {
  tp: number
  fp: number
  fn: number
  precision: MetricValue
  recall: MetricValue
  f1: MetricValue
  annotationCount: number
  candidateCount: number
  /** 重复报警（指向已匹配标注的额外候选），额外计入 FP */
  duplicates: number
  /** 引文与快照行不符的报警：单列计数，仍计入 FP，不丢弃 */
  invalidCitations: number
  /** 证据有效率 = 有效引文候选 / 全部候选；无候选时 N/A */
  evidenceValidRate: MetricValue
}

/** evaluations.metrics_json 的结构化形态 */
export interface EvaluationMetricsJson {
  config: {
    datasetVersion: string
    mode: EvaluationMode
    modeLabel: string
    split: EvaluationSplit
    ruleVersion: string
    promptVersion: string
    modelId: string | null
    provider: 'mock' | 'openai'
    providerIsMock: boolean
    ragEnabled: boolean
    /** true = 真实模型运行；false = 静态或 Mock 管线（不得作为真实模型指标） */
    realModelRun: boolean
    executor: 'worker' | 'cli'
    projectLimit: number | null
    /** 本次实际执行的项目数（split/limit 过滤后） */
    projectCount: number
    /** 是否在运行中途被取消（保留已完成部分，不再新增工作） */
    cancelled: boolean
    executedAt: string
    note: string
  }
  totals: MetricSummary
  latency: { p50Ms: MetricValue; p95Ms: MetricValue; samples: number }
  tokens: {
    /** 输入+输出 token 估计与实测合并口径（实测优先） */
    total: number
    perProject: MetricValue
    inputEstimated: number
    outputEstimated: number
    inputMeasured: number | null
    outputMeasured: number | null
  }
  projects: Array<{
    projectId: string
    kind: 'defect' | 'control'
    categoryKey: string
    split: 'dev' | 'holdout'
    scanId: string
    scanStatus: string
    latencyMs: number
    /** 本项目扫描的输入+输出 token（实测优先，缺省估算） */
    tokenTotal: number
    metrics: MetricSummary
  }>
  failures: Array<{ projectId: string; error: string }>
  disclaimer: string
}

/** 小样本口径固定声明（规格 13：不能推广为所有项目准确率） */
export const EVALUATION_DISCLAIMER =
  '本样例集结果（小样本口径）：仅说明检测管线在本数据集上的行为，不能推广为所有项目的准确率。'

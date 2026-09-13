import postgres from 'postgres'
import { asJson } from '@/server/db/json'
import { HttpError } from '@/server/api/http'
import type {
  Category,
  CodeRef,
  EvidenceStatus,
  Feedback,
  FindingDraft,
  Severity,
  SourceLabel,
} from '@/core/contracts/findings'
import type { CoverageInfo, RiskInfo, ScanConfig, UsageInfo } from '@/core/contracts/scan'
import type { PatchStatus, PatchSyntaxStatus } from '@/core/contracts/patch'
import type { CompareFindingInput, CompareScanInput } from './compare'

/**
 * 共享报告模型（R07）：从 scanId 构建统一 ReportModel，
 * 服务端页面、API 与 JSON/Markdown/HTML 三种导出全部消费同一模型，
 * 保证 UI、JSON、Markdown、HTML 的问题数量与覆盖数字一致。
 */

export const REPORT_SCHEMA_VERSION = 1

/** 规范引用文本快照在报告中保留的最大字符数（scan_citations 原文已 ≤2000） */
export const CITATION_SNAPSHOT_MAX_CHARS = 240

export interface ReportCitation {
  title: string
  version: number
  sourceUrl: string | null
  /** 截断后的文本快照（超过 CITATION_SNAPSHOT_MAX_CHARS 以 … 结尾） */
  textSnapshot: string
}

export interface ReportFindingPatch {
  patchId: string
  status: PatchStatus
  applicable: boolean
  syntax: PatchSyntaxStatus
  /** 生成方标签（mock = 确定性 Mock，非真实 AI 修复） */
  provider: string | null
  /** 展示用状态：有效提案 / 无效提案 / 已被更新提案取代 */
  label: string
}

export interface ReportFinding {
  id: string
  ruleId: string | null
  source: SourceLabel
  evidenceStatus: EvidenceStatus
  feedback: Feedback
  title: string
  severity: Severity
  category: Category
  confidence: number
  path: string
  startLine: number
  endLine: number
  symbol: string | null
  condition: string
  impact: string
  reasoningSummary: string
  recommendation: string
  primaryQuote: string
  related: CodeRef[]
  /** 该问题引用的规范快照（来自 scan_citations，按 chunkId 对应） */
  citations: ReportCitation[]
  /** R06 补丁提案状态（存在/有效/无效）；无提案为 null，取不到不阻塞导出 */
  patch: ReportFindingPatch | null
}

export interface ReportModel {
  schemaVersion: number
  generatedAt: string
  scan: {
    id: string
    snapshotId: string
    projectId: string
    projectName: string
    status: string
    stage: string
    config: ScanConfig | null
    ruleVersion: string
    promptVersion: string
    modelId: string | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    errorText: string | null
    /** 未完成原因（失败/取消/部分完成/进行中）；completed 为 null */
    incompleteReason: string | null
  }
  /** 风险指标（存储值；仅 evidenceStatus=valid、非误报、非低置信待核查计入） */
  risk: RiskInfo | null
  /** 全部问题的严重度分布（未过滤 evidence/feedback；total = findings.length） */
  severityCounts: { critical: number; high: number; medium: number; low: number; info: number; total: number }
  findingCount: number
  /** 待核查数（needs_review 且非误报；不进入风险指数） */
  needsReviewCount: number
  coverage: CoverageInfo | null
  usage: UsageInfo | null
  /** 本次扫描引用的规范快照（报告存证：知识库删除/更新后仍可解释来源） */
  citations: ReportCitation[]
  /** 展示说明（启发式口径、Mock 标注等） */
  notes: string[]
  findings: ReportFinding[]
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

const SCAN_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  partial: '局部完成',
  failed: '失败',
  cancelled: '已取消',
}

export function scanStatusLabel(status: string): string {
  return SCAN_STATUS_LABEL[status] ?? status
}

/** 未完成原因（规格 12：部分完成语义必须明示） */
function buildIncompleteReason(
  status: string,
  errorText: string | null,
  coverage: CoverageInfo | null,
): string | null {
  if (status === 'failed') {
    return errorText ? `扫描失败：${errorText}` : '扫描失败，结果不完整'
  }
  if (status === 'cancelled') {
    return '扫描已取消：以下仅包含取消前已持久化的部分结果'
  }
  if (status === 'partial') {
    const ai = coverage?.ai
    const parts = ['扫描部分完成']
    if (ai && ai.enabled && !ai.completed) {
      parts.push(ai.degradedReason ? `AI 阶段未完成（${ai.degradedReason}）` : 'AI 阶段未完成')
    }
    if (errorText) parts.push(errorText)
    return parts.join('：')
  }
  if (status === 'queued' || status === 'running') {
    return '扫描尚未完成，以下为当前已持久化的部分结果'
  }
  return null
}

function patchLabel(status: PatchStatus, applicable: boolean): string {
  if (status === 'invalid' || !applicable) return '无效提案（不可下载）'
  if (status === 'superseded') return '已被更新提案取代'
  return '有效提案（可下载 .patch，未执行测试）'
}

/**
 * 构建共享报告模型。scanId 必须已由调用方完成会话归属校验
 * （requireReadableScan），本函数只负责读取与组装。
 */
export async function buildReportModel(
  sql: postgres.Sql,
  scanId: string,
): Promise<ReportModel> {
  const scanRows = (await sql`
    select sc.id, sc.snapshot_id, sc.status, sc.stage, sc.config_json, sc.rule_version,
      sc.prompt_version, sc.model_id, sc.coverage_json, sc.usage_json, sc.risk_json,
      sc.error_text, sc.started_at, sc.completed_at, sc.created_at,
      s.project_id, p.name as project_name
    from scans sc
    join snapshots s on s.id = sc.snapshot_id
    join projects p on p.id = s.project_id
    where sc.id = ${scanId} limit 1`) as unknown as Array<{
    id: string
    snapshot_id: string
    status: string
    stage: string
    config_json: unknown
    rule_version: string
    prompt_version: string
    model_id: string | null
    coverage_json: unknown
    usage_json: unknown
    risk_json: unknown
    error_text: string | null
    started_at: unknown
    completed_at: unknown
    created_at: unknown
    project_id: string
    project_name: string
  }>
  const scan = scanRows[0]
  if (!scan) throw new HttpError(404, 'not_found', '扫描不存在')

  const coverage = asJson<CoverageInfo | null>(scan.coverage_json)
  const usage = asJson<UsageInfo | null>(scan.usage_json)
  const risk = asJson<RiskInfo | null>(scan.risk_json)

  const findingRows = (await sql`
    select id, rule_id, draft_json, source, evidence_status, feedback
    from findings where scan_id = ${scanId}`) as unknown as Array<{
    id: string
    rule_id: string | null
    draft_json: unknown
    source: SourceLabel
    evidence_status: EvidenceStatus
    feedback: Feedback
  }>

  /* 规范引用快照（规格 9.4：报告保存被检索块的版本和文本快照） */
  const citationRows = (await sql`
    select chunk_id, title, version, text_snapshot, source_url
    from scan_citations where scan_id = ${scanId}`) as unknown as Array<{
    chunk_id: string | null
    title: string
    version: number
    text_snapshot: string
    source_url: string | null
  }>
  const citationByChunkId = new Map<string, ReportCitation>()
  const citations: ReportCitation[] = []
  for (const row of citationRows) {
    const citation: ReportCitation = {
      title: row.title,
      version: row.version,
      sourceUrl: row.source_url,
      textSnapshot: truncate(row.text_snapshot, CITATION_SNAPSHOT_MAX_CHARS),
    }
    citations.push(citation)
    if (row.chunk_id) citationByChunkId.set(row.chunk_id, citation)
  }

  /* 补丁提案状态（R06）：能取到就带上，取不到不阻塞导出；每个 finding 取最新一条 */
  const findingIds = findingRows.map((r) => r.id)
  const latestPatchByFinding = new Map<string, { id: string; status: PatchStatus; validation_json: unknown }>()
  if (findingIds.length > 0) {
    const patchRows = (await sql`
      select id, finding_id, status, validation_json, created_at
      from patches where finding_id in ${sql(findingIds)}
      order by created_at asc`) as unknown as Array<{
      id: string
      finding_id: string
      status: string
      validation_json: unknown
      created_at: unknown
    }>
    for (const row of patchRows) {
      latestPatchByFinding.set(row.finding_id, {
        id: row.id,
        status: (['proposed', 'invalid', 'superseded'].includes(row.status) ? row.status : 'proposed') as PatchStatus,
        validation_json: row.validation_json,
      })
    }
  }

  const findings: ReportFinding[] = findingRows.map((row) => {
    const draft = asJson<FindingDraft>(row.draft_json)
    const patchRef = latestPatchByFinding.get(row.id)
    let patch: ReportFindingPatch | null = null
    if (patchRef) {
      const validation = asJson<{ applicable?: boolean; syntax?: PatchSyntaxStatus; provider?: string } | null>(
        patchRef.validation_json,
      )
      const applicable = validation?.applicable === true
      patch = {
        patchId: patchRef.id,
        status: patchRef.status,
        applicable,
        syntax: validation?.syntax ?? 'not_checkable',
        provider: validation?.provider ?? null,
        label: patchLabel(patchRef.status, applicable),
      }
    }
    return {
      id: row.id,
      ruleId: row.rule_id,
      source: row.source,
      evidenceStatus: row.evidence_status,
      feedback: row.feedback,
      title: draft.title,
      severity: draft.severity,
      category: draft.category,
      confidence: draft.confidence,
      path: draft.primary.path,
      startLine: draft.primary.startLine,
      endLine: draft.primary.endLine,
      symbol: draft.symbol ?? null,
      condition: draft.condition,
      impact: draft.impact,
      reasoningSummary: draft.reasoningSummary,
      recommendation: draft.recommendation,
      primaryQuote: draft.primary.quote,
      related: draft.related ?? [],
      citations: (draft.guidelineChunkIds ?? [])
        .map((chunkId) => citationByChunkId.get(chunkId))
        .filter((c): c is ReportCitation => c !== undefined),
      patch,
    }
  })

  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: findings.length }
  for (const f of findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1
  }
  const needsReviewCount = findings.filter(
    (f) => f.evidenceStatus === 'needs_review' && f.feedback !== 'false_positive',
  ).length

  const notes = [
    '本报告由确定性静态规则与（如启用）受预算约束的 AI 审查生成，均为启发式结果：未检出问题不代表代码安全，证据状态 valid 仅代表代码引用有效。',
  ]
  if (usage?.provider === 'mock') {
    notes.push('本次扫描 AI 阶段使用 Mock provider（非真实模型），结论仅用于流程演示。')
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scan: {
      id: scan.id,
      snapshotId: scan.snapshot_id,
      projectId: scan.project_id,
      projectName: scan.project_name,
      status: scan.status,
      stage: scan.stage,
      config: asJson<ScanConfig | null>(scan.config_json),
      ruleVersion: scan.rule_version,
      promptVersion: scan.prompt_version,
      modelId: scan.model_id,
      startedAt: toIso(scan.started_at),
      completedAt: toIso(scan.completed_at),
      createdAt: toIso(scan.created_at) ?? '',
      errorText: scan.error_text,
      incompleteReason: buildIncompleteReason(scan.status, scan.error_text, coverage),
    },
    risk,
    severityCounts,
    findingCount: findings.length,
    needsReviewCount,
    coverage,
    usage,
    citations,
    notes,
    findings,
  }
}

const ANALYZABLE_LANGUAGES = ['js', 'ts', 'jsx', 'tsx', 'vue']

/**
 * 构建对比输入（scanId 须已通过归属校验）。
 * 静态覆盖口径 = 收录且可分析且解析成功的文件；AI 覆盖口径 = coverage.ai.readLineRanges
 * （A01：AI 问题按行段完整覆盖判定，不只看读过文件）。
 */
export async function buildCompareScanInput(
  sql: postgres.Sql,
  scanId: string,
): Promise<CompareScanInput> {
  const scanRows = (await sql`
    select id, snapshot_id, status, model_id, rule_version, prompt_version, coverage_json
    from scans where id = ${scanId} limit 1`) as unknown as Array<{
    id: string
    snapshot_id: string
    status: string
    model_id: string | null
    rule_version: string
    prompt_version: string
    coverage_json: unknown
  }>
  const scan = scanRows[0]
  if (!scan) throw new HttpError(404, 'not_found', '扫描不存在')

  const coverage = asJson<CoverageInfo | null>(scan.coverage_json)
  const findingRows = (await sql`
    select id, rule_id, draft_json, source, evidence_status, feedback
    from findings where scan_id = ${scanId}`) as unknown as Array<{
    id: string
    rule_id: string | null
    draft_json: unknown
    source: SourceLabel
    evidence_status: EvidenceStatus
    feedback: Feedback
  }>
  const fileRows = (await sql`
    select path, content_hash, parse_status, language
    from files where snapshot_id = ${scan.snapshot_id}`) as unknown as Array<{
    path: string
    content_hash: string
    parse_status: string
    language: string
  }>

  const findings: CompareFindingInput[] = findingRows.map((row) => {
    const draft = asJson<FindingDraft>(row.draft_json)
    return {
      findingId: row.id,
      ruleId: row.rule_id,
      source: row.source,
      evidenceStatus: row.evidence_status,
      feedback: row.feedback,
      title: draft.title,
      severity: draft.severity,
      category: draft.category,
      confidence: draft.confidence,
      path: draft.primary.path,
      startLine: draft.primary.startLine,
      endLine: draft.primary.endLine,
      symbol: draft.symbol ?? null,
      quote: draft.primary.quote,
    }
  })

  const fileHashes: Record<string, string> = {}
  const staticCoveredPaths: string[] = []
  for (const f of fileRows) {
    fileHashes[f.path] = f.content_hash
    if (ANALYZABLE_LANGUAGES.includes(f.language) && f.parse_status === 'ok') {
      staticCoveredPaths.push(f.path)
    }
  }

  return {
    scanId: scan.id,
    snapshotId: scan.snapshot_id,
    // completed/partial 才有完整覆盖语义；failed/cancelled/queued/running 一律不可比
    completed: scan.status === 'completed' || scan.status === 'partial',
    modelId: scan.model_id,
    ruleVersion: scan.rule_version,
    promptVersion: scan.prompt_version,
    findings,
    fileHashes,
    staticCoveredPaths,
    aiEnabled: coverage?.ai?.enabled === true,
    aiReadFiles: coverage?.ai?.readFiles ?? [],
    // A01：AI 覆盖判定用的实际读取行段合同（coverage.ai.readLineRanges）
    aiReadLineRanges: coverage?.ai?.readLineRanges ?? {},
  }
}

import postgres from 'postgres'
import { asJson, asJsonArray } from '@/server/db/json'
import { readSnapshotFile } from '@/server/storage'
import type { CoverageInfo, RiskInfo, UsageInfo } from '@/core/contracts/scan'
import type { FindingDraft } from '@/core/contracts/findings'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/core/contracts/api'
import { HttpError } from '@/server/api/http'

/**
 * 扫描详情/问题列表共享查询（R02）：
 * GET /api/scans/:id、GET /api/scans/:id/findings、GET /api/findings/:id、
 * GET /api/snapshots/:id/files 与服务端页面首屏预取共用，
 * 避免 API 与页面各维护一套 DTO/SQL。
 */

export interface ScanSummary {
  scan: {
    id: string
    snapshotId: string
    status: string
    stage: string
    config: { enableCloudAI?: boolean; mode?: string } | null
    ruleVersion: string
    promptVersion: string
    modelId: string | null
    coverage: CoverageInfo | null
    usage: UsageInfo | null
    risk: RiskInfo | null
    errorText: string | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
  }
  project: { content_hash: string; project_id: string; project_name: string } | null
  severityCounts: Array<{ severity: string; evidenceStatus: string; feedback: string; c: number }>
  toolCalls: Array<{
    sequence: number
    tool_name: string
    input_summary: string
    result_summary: string
    elapsed_ms: number
    status: string
  }>
}

/** 扫描详情（GET /api/scans/:id 主体）；scanId 须已通过 requireReadableScan */
export async function loadScanDetail(
  sql: postgres.Sql,
  scanId: string,
  snapshotId: string,
): Promise<ScanSummary> {
  const rows = (await sql`select id, snapshot_id, status, stage, config_json, rule_version,
      prompt_version, model_id, coverage_json, usage_json, risk_json, error_text,
      started_at, completed_at, created_at
    from scans where id = ${scanId}`) as unknown as Array<{
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
    started_at: string | null
    completed_at: string | null
    created_at: string
  }>
  const scan = rows[0]
  if (!scan) throw new HttpError(404, 'not_found', '扫描不存在')

  const severityCounts = (await sql`
    select (draft_json->>'severity') as severity, evidence_status as "evidenceStatus", feedback, count(*)::int as c
    from findings where scan_id = ${scanId}
    group by (draft_json->>'severity'), evidence_status, feedback`) as unknown as ScanSummary['severityCounts']
  const toolCalls = (await sql`select sequence, tool_name, input_summary, result_summary, elapsed_ms, status
    from tool_calls where scan_id = ${scanId} order by sequence asc limit 100`) as unknown as ScanSummary['toolCalls']

  const snapshot = (await sql`select s.content_hash, p.id as project_id, p.name as project_name
    from snapshots s join projects p on p.id = s.project_id where s.id = ${snapshotId}`) as unknown as ScanSummary['project'][]

  return {
    scan: {
      id: scan.id,
      snapshotId: scan.snapshot_id,
      status: scan.status,
      stage: scan.stage,
      config: asJson<ScanSummary['scan']['config']>(scan.config_json),
      ruleVersion: scan.rule_version,
      promptVersion: scan.prompt_version,
      modelId: scan.model_id,
      coverage: asJson<CoverageInfo | null>(scan.coverage_json),
      usage: asJson<UsageInfo | null>(scan.usage_json),
      risk: asJson<RiskInfo | null>(scan.risk_json),
      errorText: scan.error_text,
      startedAt: scan.started_at,
      completedAt: scan.completed_at,
      createdAt: scan.created_at,
    },
    project: snapshot[0] ?? null,
    severityCounts,
    toolCalls,
  }
}

export interface FindingListItem {
  id: string
  ruleId: string | null
  source: 'static' | 'ai' | 'combined'
  evidenceStatus: 'valid' | 'needs_review'
  feedback: 'unreviewed' | 'confirmed' | 'false_positive'
  createdAt: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category: 'security' | 'correctness' | 'performance' | 'maintainability'
  confidence: number
  path: string
  startLine: number
  endLine: number
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])
const VALID_CATEGORIES = new Set(['security', 'correctness', 'performance', 'maintainability'])
const VALID_SOURCES = new Set(['static', 'ai', 'combined'])
const VALID_FEEDBACK = new Set(['unreviewed', 'confirmed', 'false_positive'])

export interface FindingsFilter {
  severity?: string[]
  category?: string[]
  source?: string[]
  feedback?: string[]
  cursor?: string | null
  limit?: number
}

/** 问题列表（GET /api/scans/:id/findings 主体）：过滤 + 游标分页 + 严重度排序 */
export async function listFindings(
  sql: postgres.Sql,
  scanId: string,
  filter: FindingsFilter,
): Promise<{ items: FindingListItem[]; nextCursor: string | null }> {
  const severity = (filter.severity ?? []).filter((s) => VALID_SEVERITIES.has(s))
  const category = (filter.category ?? []).filter((c) => VALID_CATEGORIES.has(c))
  const source = (filter.source ?? []).filter((s) => VALID_SOURCES.has(s))
  const feedback = (filter.feedback ?? []).filter((f) => VALID_FEEDBACK.has(f))
  const cursor = filter.cursor ?? null
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, filter.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
  )

  const rows = (await sql`
    select id, rule_id, draft_json, source, evidence_status, feedback, created_at
    from findings
    where scan_id = ${scanId}
      ${severity.length > 0 ? sql`and (draft_json->>'severity') in ${sql(severity)}` : sql``}
      ${category.length > 0 ? sql`and (draft_json->>'category') in ${sql(category)}` : sql``}
      ${source.length > 0 ? sql`and source in ${sql(source)}` : sql``}
      ${feedback.length > 0 ? sql`and feedback in ${sql(feedback)}` : sql``}
      ${cursor ? sql`and id > ${cursor}` : sql``}
    order by id asc
    limit ${limit + 1}
  `) as unknown as Array<{
    id: string
    rule_id: string | null
    draft_json: unknown
    source: 'static' | 'ai' | 'combined'
    evidence_status: 'valid' | 'needs_review'
    feedback: 'unreviewed' | 'confirmed' | 'false_positive'
    created_at: string
  }>

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const items: FindingListItem[] = page.map((r) => {
    const draft = asJson<FindingDraft>(r.draft_json)
    return {
      id: r.id,
      ruleId: r.rule_id,
      source: r.source,
      evidenceStatus: r.evidence_status,
      feedback: r.feedback,
      createdAt: r.created_at,
      title: draft.title,
      severity: draft.severity,
      category: draft.category,
      confidence: draft.confidence,
      path: draft.primary.path,
      startLine: draft.primary.startLine,
      endLine: draft.primary.endLine,
    }
  })
  // 按严重程度排序展示
  items.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine,
  )
  return { items, nextCursor: hasMore ? page[page.length - 1]!.id : null }
}

export interface FindingDetailRow {
  id: string
  scanId: string
  ruleId: string | null
  source: 'static' | 'ai' | 'combined'
  evidenceStatus: 'valid' | 'needs_review'
  feedback: 'unreviewed' | 'confirmed' | 'false_positive'
  draft: FindingDraft
}

/** 单条问题（GET /api/findings/:id 主体）；调用方自行做归属校验 */
export async function getFindingDetail(
  sql: postgres.Sql,
  findingId: string,
): Promise<FindingDetailRow> {
  const rows = (await sql`select f.id, f.scan_id, f.rule_id, f.draft_json, f.source, f.evidence_status, f.feedback
      from findings f where f.id = ${findingId} limit 1`) as unknown as Array<{
    id: string
    scan_id: string
    rule_id: string | null
    draft_json: unknown
    source: 'static' | 'ai' | 'combined'
    evidence_status: 'valid' | 'needs_review'
    feedback: 'unreviewed' | 'confirmed' | 'false_positive'
  }>
  const row = rows[0]
  if (!row) throw new HttpError(404, 'not_found', '问题不存在')
  return {
    id: row.id,
    scanId: row.scan_id,
    ruleId: row.rule_id,
    source: row.source,
    evidenceStatus: row.evidence_status,
    feedback: row.feedback,
    draft: asJson<FindingDraft>(row.draft_json),
  }
}

export interface SnapshotFileContent {
  snapshotId: string
  path: string
  language: string
  lineCount: number
  contentHash: string
  content: string
  redactedRanges: Array<{ line: number; start: number; end: number }>
}

/** 单文件内容（GET /api/snapshots/:id/files?path=... 主体）；不存在时抛 404 */
export async function readSnapshotFileDetail(
  sql: postgres.Sql,
  projectId: string,
  snapshotId: string,
  path: string,
): Promise<SnapshotFileContent> {
  const rows = (await sql`select path, language, line_count, content_hash, storage_key, redacted_ranges
    from files where snapshot_id = ${snapshotId} and path = ${path} limit 1`) as unknown as Array<{
    path: string
    language: string
    line_count: number
    content_hash: string
    storage_key: string
    redacted_ranges: unknown
  }>
  if (rows.length === 0) {
    throw new HttpError(404, 'not_found', '文件不存在')
  }
  const row = rows[0]
  const content = await readSnapshotFile(projectId, snapshotId, row.storage_key)
  return {
    snapshotId,
    path: row.path,
    language: row.language,
    lineCount: row.line_count,
    contentHash: row.content_hash,
    content,
    redactedRanges: asJsonArray<{ line: number; start: number; end: number }>(row.redacted_ranges),
  }
}

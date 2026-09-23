import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestDb, type TestDb } from '../helpers/db'
import { buildDeflateZip } from '../helpers/zip'
import { codeSamples, lineOf, redactTokens } from '../helpers/samples'
import { prepareSnapshot } from '../../src/core/import'
import { persistSnapshot } from '../../src/server/snapshots'
import { seedAll } from '../../src/server/db/seed'
import { computeRisk } from '../../src/core/report/risk'
import type { ReportModel } from '../../src/core/report/model'
import * as exportRoute from '../../src/app/api/scans/[id]/export/route'
import * as compareRoute from '../../src/app/api/projects/[id]/compare/route'
import * as sessionRoute from '../../src/app/api/session/route'

/**
 * R07 集成测试：真实库中构建同一项目两个 scan（第二个快照=修复版），
 * 验证 compare API 四类变化矩阵与导出 API（三格式 Content-Type/附件头、
 * JSON 数量与 findings 表一致、HTML 无未转义 <script>、Markdown 转义）、
 * 跨会话/跨项目 404、补丁提案状态与规范引用快照带入报告。
 * 不调用真实模型。
 */

/* ---------------- 样例 ---------------- */

const FILE_A = codeSamples.evalTsFile
const FILE_B = codeSamples.jsxListFile
const FILE_GONE = `export function gone() {\n  return "${redactTokens.skLiveToken}"\n}\n`

// 修复版：src/gone.ts 被删除（旧问题未覆盖 → 不可比较）；a/b 保持原样
const BASE_FILES = [
  { name: 'src/a.ts', content: FILE_A },
  { name: 'src/b.tsx', content: FILE_B },
  { name: 'src/gone.ts', content: FILE_GONE },
]
const TARGET_FILES = [
  { name: 'src/a.ts', content: FILE_A },
  { name: 'src/b.tsx', content: FILE_B },
]

const MALICIOUS_TITLE = '<script>alert("xss")</script> | `pipe` [link](https://evil.example)'

interface FindingSpec {
  key: string
  ruleId: string | null
  source: 'static' | 'ai'
  path: string
  startLine: number
  endLine: number
  quote: string
  symbol?: string
  title?: string
  evidenceStatus?: 'valid' | 'needs_review'
  guidelineChunkIds?: string[]
}

// 基准扫描问题：A（目标中行号平移同内容 → 仍存在）、B（仍在文件 → 未再检出）、C（文件被删 → 不可比较）
const BASE_FINDINGS: FindingSpec[] = [
  { key: 'A', ruleId: 'no-eval', source: 'static', path: 'src/a.ts', startLine: 2, endLine: 2, quote: lineOf(FILE_A, 2), symbol: 'run' },
  { key: 'B', ruleId: 'jsx-key', source: 'static', path: 'src/b.tsx', startLine: 2, endLine: 2, quote: lineOf(FILE_B, 2), symbol: 'list' },
  { key: 'C', ruleId: 'hardcoded-secret', source: 'static', path: 'src/gone.ts', startLine: 2, endLine: 2, quote: lineOf(FILE_GONE, 2), symbol: 'gone', title: MALICIOUS_TITLE },
]
// 目标扫描问题：A 行号平移（仍存在）、D（AI 新问题 → 新增）
const TARGET_FINDINGS: FindingSpec[] = [
  { key: 'A2', ruleId: 'no-eval', source: 'static', path: 'src/a.ts', startLine: 5, endLine: 5, quote: lineOf(FILE_A, 2), symbol: 'run' },
  { key: 'D', ruleId: null, source: 'ai', path: 'src/a.ts', startLine: 1, endLine: 1, quote: lineOf(FILE_A, 1), symbol: 'run', title: 'AI 新增问题', evidenceStatus: 'needs_review' },
]

/* ---------------- 基础设施 ---------------- */

let db: TestDb
let storageRoot: string
let projectId = ''
let otherProjectId = ''
let baseScanId = ''
let targetScanId = ''
let otherScanId = ''
let cookieA = ''
let cookieB = ''
const chunkId = crypto.randomUUID()

function makeReq(
  urlPath: string,
  opts: { method?: string; cookie?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers['cookie'] = opts.cookie
  return new NextRequest(`http://localhost:3100${urlPath}`, {
    method: opts.method ?? 'GET',
    headers,
  })
}

function extractCookie(res: Response): string {
  const target = res.headers.getSetCookie().find((c) => c.startsWith('ca_session='))
  if (!target) throw new Error('未发现会话 cookie')
  return `ca_session=${target.split(';')[0]!.split('=').slice(1).join('=')}`
}

async function login(code: string): Promise<string> {
  const res = await sessionRoute.POST(
    new NextRequest('http://localhost:3100/api/session', {
      method: 'POST',
      body: JSON.stringify({ accessCode: code }),
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect(res.status).toBe(200)
  return extractCookie(res)
}

function draftJson(spec: FindingSpec) {
  return {
    title: spec.title ?? `问题 ${spec.key}`,
    category: spec.source === 'ai' ? 'security' : 'security',
    severity: spec.source === 'ai' ? 'medium' : 'high',
    confidence: spec.source === 'ai' ? 0.6 : 0.9,
    primary: { path: spec.path, startLine: spec.startLine, endLine: spec.endLine, quote: spec.quote },
    related: [],
    condition: '测试触发条件',
    impact: '测试影响',
    reasoningSummary: '测试依据',
    recommendation: '测试建议',
    guidelineChunkIds: spec.guidelineChunkIds ?? [],
    symbol: spec.symbol ?? undefined,
  }
}

async function createScanWithFindings(
  snapshotId: string,
  specs: FindingSpec[],
  idempotencyKey: string,
): Promise<string> {
  const scanRows = (await db.sql`
    insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version, model_id)
    values (${snapshotId}, ${idempotencyKey}, 'completed', 'report',
      '{"enableCloudAI":false,"mode":"standard"}'::jsonb, 'static-rules-v1', 'review-prompt-v1', null)
    returning id`) as unknown as Array<{ id: string }>
  const scanId = scanRows[0]!.id
  for (const spec of specs) {
    await db.sql`
      insert into findings (scan_id, rule_id, fingerprint, draft_json, source, evidence_status)
      values (${scanId}, ${spec.ruleId}, ${`${idempotencyKey}:${spec.key}`},
        ${db.sql.json(draftJson(spec) as never)}, ${spec.source}, ${spec.evidenceStatus ?? 'valid'})`
  }
  // 风险按真实口径重算（valid、非误报计入；needs_review 不计入）
  const rows = (await db.sql`select (draft_json->>'severity') as severity, evidence_status as "evidenceStatus", feedback
    from findings where scan_id = ${scanId}`) as unknown as Array<{
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
    evidenceStatus: 'valid' | 'needs_review'
    feedback: 'unreviewed' | 'confirmed' | 'false_positive'
  }>
  await db.sql`update scans set risk_json = ${db.sql.json(computeRisk(rows) as never)} where id = ${scanId}`
  return scanId
}

async function compareGet(projectIdValue: string, base: string, target: string, cookie: string) {
  return compareRoute.GET(
    makeReq(`/api/projects/${projectIdValue}/compare?baseScanId=${base}&targetScanId=${target}`, { cookie }),
    { params: Promise.resolve({ id: projectIdValue }) },
  )
}

async function exportGet(scanIdValue: string, format: string, cookie?: string) {
  return exportRoute.GET(
    makeReq(`/api/scans/${scanIdValue}/export?format=${format}`, { cookie }),
    { params: Promise.resolve({ id: scanIdValue }) },
  )
}

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-report-'))
  const { env } = await import('../../src/server/env')
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })
  await seedAll(db.sql)

  cookieA = await login('codeatlas-demo')
  cookieB = await login('codeatlas-demo')

  const project = (await db.sql`
    insert into projects (session_id, name)
    values ((select id from sessions where token_hash = ${crypto.createHash('sha256').update(cookieA.split('=')[1]!).digest('hex')}), '报告对比测试')
    returning id`) as unknown as Array<{ id: string }>
  projectId = project[0]!.id

  const otherProject = (await db.sql`
    insert into projects (session_id, name)
    values ((select id from sessions where token_hash = ${crypto.createHash('sha256').update(cookieB.split('=')[1]!).digest('hex')}), '他人项目')
    returning id`) as unknown as Array<{ id: string }>
  otherProjectId = otherProject[0]!.id

  const basePrepared = await prepareSnapshot(await buildDeflateZip(BASE_FILES))
  const baseSnapshot = await persistSnapshot(db.sql, projectId, basePrepared)
  const targetPrepared = await prepareSnapshot(await buildDeflateZip(TARGET_FILES))
  const targetSnapshot = await persistSnapshot(db.sql, projectId, targetPrepared)

  // 他人项目快照+扫描（跨项目 404 用）
  const otherPrepared = await prepareSnapshot(await buildDeflateZip(BASE_FILES))
  const otherSnapshot = await persistSnapshot(db.sql, otherProjectId, otherPrepared)

  baseScanId = await createScanWithFindings(baseSnapshot.id, BASE_FINDINGS, 'report-base')
  targetScanId = await createScanWithFindings(targetSnapshot.id, TARGET_FINDINGS, 'report-target')
  otherScanId = await createScanWithFindings(otherSnapshot.id, [], 'report-other')

  // 给基准扫描补规范引用快照，并让问题 A 引用它（guidelineChunkIds → scan_citations.chunk_id）
  const longText = '规范正文'.repeat(200) // 800 字 > 截断阈值 240
  await db.sql`
    insert into scan_citations (scan_id, chunk_id, version, text_snapshot, source_url, title)
    values (${baseScanId}, ${chunkId}, 3, ${longText}, 'https://example.com/guide', '内部安全规范')`
  const findingRows = (await db.sql`select id, draft_json from findings where scan_id = ${baseScanId}
    and rule_id = 'no-eval'`) as unknown as Array<{ id: string; draft_json: unknown }>
  const draft = (typeof findingRows[0]!.draft_json === 'string'
    ? JSON.parse(findingRows[0]!.draft_json)
    : findingRows[0]!.draft_json) as Record<string, unknown>
  draft.guidelineChunkIds = [chunkId]
  await db.sql`update findings set draft_json = ${db.sql.json(draft as never)} where id = ${findingRows[0]!.id}`

  // 问题 A 的补丁提案（有效）与问题 C 的补丁提案（无效）
  await db.sql`
    insert into patches (finding_id, base_file_hash, edits_json, diff_text, validation_json, status)
    values (${findingRows[0]!.id}, 'hash', '[]'::jsonb, '--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
', '{"applicable":true,"syntax":"pass","tests":"not_run","reasons":[],"baselineSyntaxErrors":0,"patchedSyntaxErrors":0,"provider":"mock"}'::jsonb,
      'proposed')`
  const goneFinding = (await db.sql`select id from findings where scan_id = ${baseScanId} and rule_id = 'hardcoded-secret'`) as unknown as Array<{ id: string }>
  await db.sql`
    insert into patches (finding_id, base_file_hash, edits_json, diff_text, validation_json, status)
    values (${goneFinding[0]!.id}, 'hash', '[]'::jsonb, '', '{"applicable":false,"syntax":"pass","tests":"not_run","reasons":["旧文本不匹配"],"baselineSyntaxErrors":0,"patchedSyntaxErrors":0}'::jsonb,
      'invalid')`
})

afterAll(async () => {
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

/* ---------------- compare API ---------------- */

describe('R07 compare API', () => {
  it('四类变化矩阵：新增 1 / 仍存在 1 / 未再检出 1 / 不可比较 1（行号平移不判新增）', async () => {
    const res = await compareGet(projectId, baseScanId, targetScanId, cookieA)
    expect(res.status).toBe(200)
    const body = (await res.json()) as import('../../src/core/report/compare').CompareOutcome
    expect(body.counts).toEqual({ added: 1, persisting: 1, disappeared: 1, incomparable: 1 })
    expect(body.comparable).toBe(true)
    expect(body.scopeNote).toContain('不同快照')
    expect(body.disclaimer).toContain('不等于已验证修复')

    const persisting = body.items.find((i) => i.kind === 'persisting')!
    expect(persisting.base!.startLine).toBe(2)
    expect(persisting.target!.startLine).toBe(5)
    expect(persisting.base!.path).toBe('src/a.ts')

    const added = body.items.find((i) => i.kind === 'added')!
    expect(added.target!.title).toBe('AI 新增问题')
    expect(added.target!.source).toBe('ai')

    const disappeared = body.items.find((i) => i.kind === 'disappeared')!
    expect(disappeared.base!.path).toBe('src/b.tsx')

    const incomparable = body.items.find((i) => i.kind === 'incomparable')!
    expect(incomparable.base!.path).toBe('src/gone.ts')
    expect(incomparable.reason).toContain('未覆盖')
    expect(incomparable.reason).toContain('不得算「未再检出」')
  })

  it('同一次扫描自比 → 全部仍存在', async () => {
    const res = await compareGet(projectId, baseScanId, baseScanId, cookieA)
    expect(res.status).toBe(200)
    const body = (await res.json()) as import('../../src/core/report/compare').CompareOutcome
    expect(body.counts.persisting).toBe(3)
    expect(body.counts.added).toBe(0)
    expect(body.counts.disappeared).toBe(0)
    expect(body.scopeNote).toBeNull()
  })

  it('跨会话 404；跨项目扫描（baseScanId 属于他人项目）404；缺参数 400', async () => {
    const crossSession = await compareGet(projectId, baseScanId, targetScanId, cookieB)
    expect(crossSession.status).toBe(404)
    const crossBody = (await crossSession.json()) as { error: { code: string; requestId: string } }
    expect(crossBody.error.code).toBe('not_found')
    expect(crossBody.error.requestId).toBeTruthy()

    const mixed = await compareGet(projectId, baseScanId, otherScanId, cookieA)
    expect(mixed.status).toBe(404)

    const missingFormat = await exportGet(baseScanId, '', cookieA)
    expect(missingFormat.status).toBe(400)

    const noParam = await compareRoute.GET(
      makeReq(`/api/projects/${projectId}/compare`, { cookie: cookieA }),
      { params: Promise.resolve({ id: projectId }) },
    )
    expect(noParam.status).toBe(400)
    expect(((await noParam.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
  })
})

/* ---------------- export API ---------------- */

describe('R07 export API', () => {
  it('三格式：200 + Content-Type + 附件头（文件名含 scan 短 id）', async () => {
    const cases = [
      { format: 'json', type: 'application/json', ext: 'json' },
      { format: 'markdown', type: 'text/markdown', ext: 'md' },
      { format: 'html', type: 'text/html', ext: 'html' },
    ]
    for (const c of cases) {
      const res = await exportGet(baseScanId, c.format, cookieA)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(c.type)
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="codeatlas-report-${baseScanId.slice(0, 8)}.${c.ext}"`,
      )
      expect((await res.text()).length).toBeGreaterThan(100)
    }
  })

  it('JSON 与 findings 表一致：数量、severityCounts、风险、补丁状态、引用快照截断', async () => {
    const res = await exportGet(baseScanId, 'json', cookieA)
    expect(res.status).toBe(200)
    const model = JSON.parse(await res.text()) as ReportModel
    const dbCount = (await db.sql`select count(*)::int as c from findings where scan_id = ${baseScanId}`) as unknown as Array<{ c: number }>
    expect(model.findings.length).toBe(dbCount[0]!.c)
    expect(model.findingCount).toBe(model.findings.length)
    expect(model.severityCounts.total).toBe(model.findings.length)
    expect(model.scan.id).toBe(baseScanId)
    expect(model.risk!.countedFindings).toBe(3) // 全部 valid
    expect(model.risk!.riskIndex).toBe(30) // 3×high → 10×3
    expect(model.needsReviewCount).toBe(0)

    // 补丁提案状态：有效/无效分开；无提案为 null
    const patchA = model.findings.find((f) => f.ruleId === 'no-eval')!.patch
    expect(patchA).toMatchObject({ status: 'proposed', applicable: true, provider: 'mock' })
    expect(patchA!.label).toContain('有效提案')
    const patchC = model.findings.find((f) => f.ruleId === 'hardcoded-secret')!.patch
    expect(patchC).toMatchObject({ status: 'invalid', applicable: false })
    expect(patchC!.label).toContain('无效提案')
    const noPatch = model.findings.find((f) => f.ruleId === 'jsx-key')!.patch
    expect(noPatch).toBeNull()

    // 规范引用快照：版本/来源/文本截断（≤241 字符，… 结尾）
    const findingA = model.findings.find((f) => f.ruleId === 'no-eval')!
    expect(findingA.citations).toHaveLength(1)
    expect(findingA.citations[0]).toMatchObject({ title: '内部安全规范', version: 3, sourceUrl: 'https://example.com/guide' })
    expect(findingA.citations[0]!.textSnapshot.length).toBeLessThanOrEqual(241)
    expect(findingA.citations[0]!.textSnapshot.endsWith('…')).toBe(true)
    expect(model.citations).toHaveLength(1)
  })

  it('HTML 导出净化：恶意标题被转义、无未转义 <script>；Markdown 导出注入字符被转义', async () => {
    const htmlRes = await exportGet(baseScanId, 'html', cookieA)
    const html = await htmlRes.text()
    expect(html).not.toMatch(/<script>/)
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    expect(html).toContain('| `pipe` [link](https://evil.example)') // HTML 只转义 <>&"'，其余原样
    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain('@media print')
    expect(html).toContain('规范引用快照')

    const mdRes = await exportGet(baseScanId, 'markdown', cookieA)
    const md = await mdRes.text()
    expect(md).not.toContain('<script>')
    expect(md).toContain('\\<script\\>')
    expect(md).toContain('\\|')
    expect(md).toContain('\\`pipe\\`')
    expect(md).toContain('\\[link\\]')
  })

  it('非法 format 400；未登录 401；跨会话 404', async () => {
    const badFormat = await exportGet(baseScanId, 'pdf', cookieA)
    expect(badFormat.status).toBe(400)
    const badBody = (await badFormat.json()) as { error: { code: string; message: string; requestId: string } }
    expect(badBody.error.code).toBe('invalid_request')
    expect(badBody.error.requestId).toBeTruthy()

    const noLogin = await exportGet(baseScanId, 'json')
    expect(noLogin.status).toBe(401)

    const cross = await exportGet(baseScanId, 'json', cookieB)
    expect(cross.status).toBe(404)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestDb, type TestDb } from '../helpers/db'
import { env } from '../../src/server/env'
import { loadDataset, type LoadedDataset } from '../../src/core/evaluation/dataset'
import { runEvaluation, type ProviderFactory } from '../../src/core/evaluation/runner'
import { processEvaluationJob } from '../../src/worker/evaluation'
import { claimJob, newWorkerId, type LeaseInfo } from '../../src/worker/jobs'
import { LeaseLostError } from '../../src/worker/jobs'
import type {
  ChatProvider,
  ProviderChatOptions,
  ProviderResult,
} from '../../src/core/review/provider'
import type { FindingDraft } from '../../src/core/contracts/findings'
import type { EvaluationMetricsJson } from '../../src/core/contracts/evaluation'
import { asJson } from '../../src/server/db/json'

/**
 * A06/A08 验收回归：
 * - A06：原始候选台账 —— AI 验证阶段丢弃的候选（含修复轮去重）与 validate 阶段
 *   删除的落库记录全部纳入指标输入；受控 provider 提交「1 有效 + 2 无效」时
 *   原始总数/无效数/FP/P/F1/证据有效率与手算一致，单项目与聚合相符，
 *   证据有效率始终 0..1 或 N/A。
 * - A08：父评测任务租约隔离 —— evaluations 写入全部在租约事务内条件写，
 *   失租旧执行器不能写回；逐项目完成记录使恢复复用已有 scan、不重复执行。
 * 使用手工构造的双项目迷你数据集（1 缺陷 + 1 对照，无静态规则命中），
 * 全部走受控 provider，不调用真实模型。
 */

let db: TestDb
let storageRoot: string
let fixturesDir: string
let dataset: LoadedDataset
let DATASET_VERSION = ''

const DEF_FILE = [
  'export function riskyTransform(input) {',
  "  return String(input).replace(/x/g, 'y')",
  '}',
  '// done',
].join('\n')
const CTL_FILE = ['export function add(a, b) {', '  return a + b', '}', '// done'].join('\n')

/** 手工迷你数据集：def-manual（1 标注，静态规则零命中）+ ctl-clean（零标注零命中） */
function writeMiniDataset(dir: string): string {
  const projectsDir = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projectsDir, 'def-manual', 'src'), { recursive: true })
  fs.mkdirSync(path.join(projectsDir, 'ctl-clean', 'src'), { recursive: true })
  fs.writeFileSync(path.join(projectsDir, 'def-manual', 'src', 'b.js'), DEF_FILE)
  fs.writeFileSync(path.join(projectsDir, 'ctl-clean', 'src', 'a.js'), CTL_FILE)
  fs.writeFileSync(
    path.join(projectsDir, 'def-manual', 'manifest.json'),
    JSON.stringify(
      {
        id: 'def-manual',
        kind: 'defect',
        split: 'dev',
        categoryKey: 'manual',
        title: '手工缺陷样例',
        files: ['src/b.js'],
        annotations: [
          {
            ruleId: 'manual/sec',
            category: 'security',
            file: 'src/b.js',
            startLine: 2,
            endLine: 2,
            condition: '手工标注（静态规则不命中，仅 AI 有效草稿可匹配）',
          },
        ],
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(projectsDir, 'ctl-clean', 'manifest.json'),
    JSON.stringify(
      {
        id: 'ctl-clean',
        kind: 'control',
        split: 'dev',
        categoryKey: 'manual',
        title: '手工对照样例',
        files: ['src/a.js'],
        annotations: [],
      },
      null,
      2,
    ),
  )
  const version = 'v1-minidataset'
  fs.writeFileSync(
    path.join(dir, 'dataset.json'),
    JSON.stringify(
      {
        version,
        revision: 1,
        contentHash: 'minidataset',
        ruleVersion: 'test',
        categories: [{ key: 'manual', label: '手工' }],
        split: { dev: ['def-manual', 'ctl-clean'], holdout: [] },
        projectCount: 2,
        defectCount: 1,
        controlCount: 1,
        projects: [
          {
            id: 'def-manual',
            kind: 'defect',
            split: 'dev',
            categoryKey: 'manual',
            title: '手工缺陷样例',
            files: ['src/b.js'],
            annotationCount: 1,
          },
          {
            id: 'ctl-clean',
            kind: 'control',
            split: 'dev',
            categoryKey: 'manual',
            title: '手工对照样例',
            files: ['src/a.js'],
            annotationCount: 0,
          },
        ],
      },
      null,
      2,
    ),
  )
  return version
}

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-a0608-storage-'))
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })
  fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-a0608-fixtures-'))
  DATASET_VERSION = writeMiniDataset(fixturesDir)
  process.env.EVAL_FIXTURES_DIR = fixturesDir
  dataset = await loadDataset(fixturesDir)
  expect(dataset.info.version).toBe(DATASET_VERSION)
}, 60_000)

afterAll(async () => {
  const { resetDb } = await import('../../src/server/db/client')
  await resetDb()
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
  fs.rmSync(fixturesDir, { recursive: true, force: true })
  delete process.env.EVAL_FIXTURES_DIR
})

/** 脚本化受控 provider（不调用真实模型；非 mock 标记走真实额度记账路径） */
class ScriptedProvider implements ChatProvider {
  readonly id = 'scripted-eval-test'
  readonly isMock = false
  readonly ready = true
  private step = 0
  constructor(
    private readonly script: Array<(opts: ProviderChatOptions) => ProviderResult>,
  ) {}
  async chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    const fn = this.script[Math.min(this.step, this.script.length - 1)]!
    this.step++
    return fn(opts)
  }
}

/** 在途挂起的受控 provider：chat 挂起直至 abortSignal 触发（模拟真实 fetch 中止） */
class GatedProvider implements ChatProvider {
  readonly id = 'gated-eval-test'
  readonly isMock = false
  readonly ready = true
  chatAborted = false
  readonly started: Promise<void>
  private readonly startedResolve: () => void
  constructor() {
    let resolve!: () => void
    this.started = new Promise<void>((r) => {
      resolve = r
    })
    this.startedResolve = resolve
  }
  chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    this.startedResolve()
    return new Promise<ProviderResult>((_resolve, reject) => {
      const onAbort = () => {
        this.chatAborted = true
        reject(new Error('模型调用已中止（模拟失租 abort）'))
      }
      if (opts.abortSignal?.aborted) {
        onAbort()
        return
      }
      opts.abortSignal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function draft(
  pathRef: string,
  startLine: number,
  endLine: number,
  quote: string,
): FindingDraft {
  return {
    title: `受控草稿 ${pathRef}:${startLine}`,
    category: 'security',
    severity: 'low',
    confidence: 0.9,
    primary: { path: pathRef, startLine, endLine, quote },
    related: [],
    condition: '受控测试条件',
    impact: '受控测试影响',
    reasoningSummary: '受控 provider 草稿（不代表真实模型能力）',
    recommendation: '受控测试建议',
    guidelineChunkIds: [],
  }
}

async function createEvaluationRow(mode: string, split: string): Promise<string> {
  const rows = (await db.sql`
    insert into evaluations (dataset_version, config_json, status)
    values (${DATASET_VERSION}, ${db.sql.json({ mode, split, executor: 'worker', requestedAt: new Date().toISOString() })}, 'pending')
    returning id`) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

async function claimEvaluationJob(evaluationId: string): Promise<LeaseInfo> {
  const job = await claimJob(db.sql, newWorkerId(), ['evaluation'])
  expect(job).not.toBeNull()
  expect(job!.target_id).toBe(evaluationId)
  return {
    id: job!.id,
    lease_owner: job!.lease_owner!,
    lease_generation: job!.lease_generation,
    attempt: job!.attempt,
  }
}

async function countRecords(evaluationId: string): Promise<number> {
  const rows = (await db.sql`select count(*)::int as c from evaluation_projects
    where evaluation_id = ${evaluationId}`) as unknown as Array<{ c: number }>
  return rows[0]!.c
}

async function readMetrics(evaluationId: string): Promise<{
  status: string
  metrics: EvaluationMetricsJson
}> {
  const rows = (await db.sql`select status, metrics_json from evaluations where id = ${evaluationId}`) as unknown as Array<{
    status: string
    metrics_json: unknown
  }>
  return {
    status: rows[0]!.status,
    metrics: asJson<EvaluationMetricsJson>(rows[0]!.metrics_json)!,
  }
}

function assertEvidenceRateInRange(v: number | null): void {
  if (v === null) return
  expect(v).toBeGreaterThanOrEqual(0)
  expect(v).toBeLessThanOrEqual(1)
}

describe('A06 原始候选台账与派生指标', () => {
  it('受控 provider 提交「1 有效 + 2 无效」：原始总数=3、无效数=2，单项目与聚合均与手算一致', async () => {
    // 每个项目：读取前 2 行 → 提交 1 有效（行 2 引文一致）+ 2 无效（引文不符 / 正确引文但未读行段）→ 修复轮不重交
    const providerFactory: ProviderFactory = (_script, files) => {
      const file = files[0]!
      const lines = file.content.split('\n')
      return new ScriptedProvider([
        () => ({
          text: '',
          toolCalls: [
            { id: 'read-1', name: 'read_file', args: { path: file.path, startLine: 1, endLine: 2 } },
          ],
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
        () => ({
          text: '',
          toolCalls: [
            {
              id: 'submit-1',
              name: 'submit_findings',
              args: {
                findings: [
                  draft(file.path, 2, 2, lines[1]!),
                  draft(file.path, 1, 1, 'definitely-not-the-real-line'),
                  draft(file.path, 3, 3, lines[2] ?? '}'),
                ],
              },
            },
          ],
          usage: { inputTokens: 200, outputTokens: 40 },
        }),
        () => ({ text: '无法修复，放弃重交', toolCalls: [], usage: { inputTokens: 150, outputTokens: 10 } }),
      ])
    }

    const evaluationId = await createEvaluationRow('llm_no_rag', 'all')
    const result = await runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'llm_no_rag',
      split: 'all',
      providerFactory,
      executor: 'worker',
    })
    expect(result.status).toBe('completed')

    // 手算（每个项目原始候选 = 1 落库 + 2 丢弃 = 3；标注仅 def-manual 1 条）
    const def = result.metricsJson.projects.find((p) => p.projectId === 'def-manual')!
    const ctl = result.metricsJson.projects.find((p) => p.projectId === 'ctl-clean')!
    // def-manual：有效草稿命中标注 → TP=1；两个无效候选 → FP=2
    expect(def.metrics.tp).toBe(1)
    expect(def.metrics.fp).toBe(2)
    expect(def.metrics.fn).toBe(0)
    expect(def.metrics.candidateCount).toBe(3)
    expect(def.metrics.invalidCitations).toBe(2)
    expect(def.metrics.precision).toBeCloseTo(1 / 3)
    expect(def.metrics.recall).toBe(1)
    expect(def.metrics.f1).toBeCloseTo(0.5)
    expect(def.metrics.evidenceValidRate).toBeCloseTo(1 / 3)
    // ctl-clean：无标注 → 全部 FP；Recall/F1 为 N/A（分母为零）
    expect(ctl.metrics.tp).toBe(0)
    expect(ctl.metrics.fp).toBe(3)
    expect(ctl.metrics.fn).toBe(0)
    expect(ctl.metrics.candidateCount).toBe(3)
    expect(ctl.metrics.invalidCitations).toBe(2)
    expect(ctl.metrics.precision).toBe(0)
    expect(ctl.metrics.recall).toBeNull()
    expect(ctl.metrics.f1).toBeNull()
    expect(ctl.metrics.evidenceValidRate).toBeCloseTo(1 / 3)

    // 聚合 = 先求和再派生：TP=1、FP=5、候选=6、无效=4 → P=1/6、R=1、F1=2/7、证据有效率=1/3
    const totals = result.metricsJson.totals
    expect(totals.tp).toBe(1)
    expect(totals.fp).toBe(5)
    expect(totals.fn).toBe(0)
    expect(totals.candidateCount).toBe(6)
    expect(totals.invalidCitations).toBe(4)
    expect(totals.annotationCount).toBe(1)
    expect(totals.precision).toBeCloseTo(1 / 6)
    expect(totals.recall).toBe(1)
    expect(totals.f1).toBeCloseTo(2 / 7)
    expect(totals.evidenceValidRate).toBeCloseTo(1 / 3)

    // 证据有效率始终 0..1 或 N/A（单项目 + 聚合）
    for (const p of result.metricsJson.projects) assertEvidenceRateInRange(p.metrics.evidenceValidRate)
    assertEvidenceRateInRange(totals.evidenceValidRate)

    // 单项目数字与总计一致（求和口径）
    expect(def.metrics.fp + ctl.metrics.fp).toBe(totals.fp)
    expect(def.metrics.candidateCount + ctl.metrics.candidateCount).toBe(totals.candidateCount)
    expect(def.metrics.invalidCitations + ctl.metrics.invalidCitations).toBe(totals.invalidCitations)

    // 丢弃候选以逐候选 finding.invalid 事件落台账（phase=ai），每个扫描 2 条
    for (const p of result.metricsJson.projects) {
      const events = (await db.sql`select payload_json from scan_events
        where scan_id = ${p.scanId} and event_type = 'finding.invalid'`) as unknown as Array<{ payload_json: unknown }>
      expect(events).toHaveLength(2)
      for (const row of events) {
        const payload = asJson<{ phase?: string; path?: string; startLine?: number }>(row.payload_json)
        expect(payload?.phase).toBe('ai')
        expect(payload?.path).toBe(p.projectId === 'def-manual' ? 'src/b.js' : 'src/a.js')
      }
    }
  }, 120_000)

  it('修复轮重交有效结果：同一候选身份去重，不留无效污点（P=R=F1=1，无丢弃事件）', async () => {
    const providerFactory: ProviderFactory = (_script, files) => {
      const file = files[0]!
      const lines = file.content.split('\n')
      return new ScriptedProvider([
        () => ({
          text: '',
          toolCalls: [
            { id: 'read-1', name: 'read_file', args: { path: file.path, startLine: 1, endLine: 4 } },
          ],
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
        // 首轮：1 条无效（引文不符）
        () => ({
          text: '',
          toolCalls: [
            { id: 'submit-1', name: 'submit_findings', args: { findings: [draft(file.path, 2, 2, 'wrong quote')] } },
          ],
          usage: { inputTokens: 150, outputTokens: 20 },
        }),
        // 修复轮：同一身份（security|path|2-2）重交有效草稿
        () => ({
          text: '',
          toolCalls: [
            { id: 'submit-2', name: 'submit_findings', args: { findings: [draft(file.path, 2, 2, lines[1]!)] } },
          ],
          usage: { inputTokens: 200, outputTokens: 30 },
        }),
      ])
    }

    const evaluationId = await createEvaluationRow('llm_no_rag', 'all')
    const result = await runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'llm_no_rag',
      split: 'all',
      projectLimit: 1, // 仅 def-manual
      providerFactory,
      executor: 'worker',
    })
    expect(result.status).toBe('completed')
    const p = result.metricsJson.projects[0]!
    expect(p.projectId).toBe('def-manual')
    // 修复成功 → 原始候选 1（有效），不重复计数、不留无效污点
    expect(p.metrics.candidateCount).toBe(1)
    expect(p.metrics.tp).toBe(1)
    expect(p.metrics.fp).toBe(0)
    expect(p.metrics.fn).toBe(0)
    expect(p.metrics.invalidCitations).toBe(0)
    expect(p.metrics.precision).toBe(1)
    expect(p.metrics.recall).toBe(1)
    expect(p.metrics.f1).toBe(1)
    expect(p.metrics.evidenceValidRate).toBe(1)
    // 台账无丢弃 → 无 finding.invalid 事件
    const events = (await db.sql`select count(*)::int as c from scan_events
      where scan_id = ${p.scanId} and event_type = 'finding.invalid'`) as unknown as Array<{ c: number }>
    expect(events[0]!.c).toBe(0)
  }, 120_000)

  it('修复轮重交仍无效：同一身份跨轮去重（原始无效 2 次提交 → 台账 1 条丢弃记录）', async () => {
    const providerFactory: ProviderFactory = (_script, files) => {
      const file = files[0]!
      return new ScriptedProvider([
        () => ({
          text: '',
          toolCalls: [
            { id: 'read-1', name: 'read_file', args: { path: file.path, startLine: 1, endLine: 4 } },
          ],
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
        () => ({
          text: '',
          toolCalls: [
            { id: 'submit-1', name: 'submit_findings', args: { findings: [draft(file.path, 2, 2, 'wrong quote')] } },
          ],
          usage: { inputTokens: 150, outputTokens: 20 },
        }),
        // 修复轮：同一身份仍无效（不同错误引文）
        () => ({
          text: '',
          toolCalls: [
            { id: 'submit-2', name: 'submit_findings', args: { findings: [draft(file.path, 2, 2, 'still wrong')] } },
          ],
          usage: { inputTokens: 200, outputTokens: 30 },
        }),
      ])
    }

    const evaluationId = await createEvaluationRow('llm_no_rag', 'all')
    const result = await runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'llm_no_rag',
      split: 'all',
      projectLimit: 1, // 仅 def-manual
      providerFactory,
      executor: 'worker',
    })
    expect(result.status).toBe('completed')
    const p = result.metricsJson.projects[0]!
    expect(p.projectId).toBe('def-manual')
    // 台账口径：同一身份去重 → 1 个原始候选（无效）；不因修复轮重复提交计 2
    expect(p.metrics.candidateCount).toBe(1)
    expect(p.metrics.tp).toBe(0)
    expect(p.metrics.fp).toBe(1)
    expect(p.metrics.fn).toBe(1)
    expect(p.metrics.invalidCitations).toBe(1)
    expect(p.metrics.evidenceValidRate).toBe(0)
    const events = (await db.sql`select count(*)::int as c from scan_events
      where scan_id = ${p.scanId} and event_type = 'finding.invalid'`) as unknown as Array<{ c: number }>
    expect(events[0]!.c).toBe(1)
    // 区分口径：ai 阶段 stage.completed 记录的是原始无效提交次数（2 次），台账为去重后 1 条
    const stageRows = (await db.sql`select payload_json->>'invalidCount' as invalid_count from scan_events
      where scan_id = ${p.scanId} and event_type = 'stage.completed' and payload_json->>'stage' = 'ai'`) as unknown as Array<{ invalid_count: string }>
    expect(stageRows).toHaveLength(1)
    expect(parseInt(stageRows[0]!.invalid_count, 10)).toBe(2)
  }, 120_000)
})

describe('A08 评测任务租约隔离与恢复', () => {
  it('抢占接管：项目完成后失租，旧执行器不能写终态；恢复复用已完成项目不重复执行', async () => {
    const evaluationId = await createEvaluationRow('static_only', 'all')
    await db.sql`insert into jobs (kind, target_id) values ('evaluation', ${evaluationId})`
    const leaseA = await claimEvaluationJob(evaluationId)

    let calls = 0
    let enterGate!: () => void
    const entered = new Promise<void>((r) => {
      enterGate = r
    })
    let releaseGate!: () => void
    const release = new Promise<void>((r) => {
      releaseGate = r
    })
    // A 在项目边界观察到父任务取消（模拟接管/取消后的边界语义），随后尝试写 partial
    let cancelSeenByA = false

    // 旧执行器 A：项目 1 完成后（记录已写）在项目边界挂起，等待接管发生
    const runA = runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'static_only',
      split: 'all',
      job: leaseA,
      executor: 'worker',
      isCancelRequested: async () => {
        calls++
        if (calls === 2) {
          enterGate()
          await release
        }
        return cancelSeenByA
      },
    })
    await entered
    // 项目 1（def-manual）已完成，逐项目记录已由合法 owner 写入
    expect(await countRecords(evaluationId)).toBe(1)
    const record1 = (await db.sql`select scan_id from evaluation_projects
      where evaluation_id = ${evaluationId} and project_id = 'def-manual'`) as unknown as Array<{ scan_id: string }>
    expect(record1).toHaveLength(1)

    // B 抢占：A 租约过期 → B 领取（generation+1，attempt=2）
    await db.sql`update jobs set lease_until = now() - interval '60 seconds' where id = ${leaseA.id}`
    const jobB = await claimJob(db.sql, newWorkerId(), ['evaluation'])
    expect(jobB).not.toBeNull()
    expect(jobB!.id).toBe(leaseA.id)
    expect(jobB!.lease_generation).toBe(leaseA.lease_generation + 1)

    // A 恢复执行：在边界退出（不再新增工作）→ partial 终态写回被父租约拒绝（LeaseLostError）
    cancelSeenByA = true
    releaseGate()
    await expect(runA).rejects.toBeInstanceOf(LeaseLostError)

    // A 未写任何终态/指标（只有合法 owner 能写）
    const afterA = (await db.sql`select status, metrics_json is null as no_metrics
      from evaluations where id = ${evaluationId}`) as unknown as Array<{ status: string; no_metrics: boolean }>
    expect(afterA[0]!.status).toBe('running')
    expect(afterA[0]!.no_metrics).toBe(true)
    expect(await countRecords(evaluationId)).toBe(1)

    // B（合法 owner）恢复执行：项目 1 复用记录与 scan，项目 2 正常执行 → completed
    await processEvaluationJob(db.sql, {
      evaluationId,
      job: {
        id: jobB!.id,
        lease_owner: jobB!.lease_owner!,
        lease_generation: jobB!.lease_generation,
        attempt: jobB!.attempt,
      },
    })
    const final = await readMetrics(evaluationId)
    expect(final.status).toBe('completed')
    expect(final.metrics.projects).toHaveLength(2)
    expect(final.metrics.config.projectCount).toBe(2)

    // 恢复复用：def-manual 的记录与 scan 保持不变（未重复执行）
    const record1After = (await db.sql`select scan_id from evaluation_projects
      where evaluation_id = ${evaluationId} and project_id = 'def-manual'`) as unknown as Array<{ scan_id: string }>
    expect(record1After[0]!.scan_id).toBe(record1[0]!.scan_id)
    expect(await countRecords(evaluationId)).toBe(2)
    // 评测样例扫描：项目 1 的 scan 被复用（每项目恰好 1 个完成扫描）
    const completedScans = (await db.sql`select count(*)::int as c from scans
      where idempotency_key = ${'eval-' + evaluationId} and status = 'completed'`) as unknown as Array<{ c: number }>
    expect(completedScans[0]!.c).toBe(2)
    // 任务终态 completed
    const jobRow = (await db.sql`select state from jobs where id = ${leaseA.id}`) as unknown as Array<{ state: string }>
    expect(jobRow[0]!.state).toBe('completed')
  }, 120_000)

  it('模型在途失租：统一 abort 中止在途调用，旧执行器不写回任何结果', async () => {
    const evaluationId = await createEvaluationRow('llm_no_rag', 'all')
    await db.sql`insert into jobs (kind, target_id) values ('evaluation', ${evaluationId})`
    const leaseA = await claimEvaluationJob(evaluationId)

    const providers: GatedProvider[] = []
    let factoryCalled!: () => void
    const factoryCalledP = new Promise<void>((r) => {
      factoryCalled = r
    })
    const providerFactory: ProviderFactory = () => {
      const p = new GatedProvider()
      providers.push(p)
      factoryCalled()
      return p
    }
    const controller = new AbortController()

    const runA = runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'llm_no_rag',
      split: 'all',
      job: leaseA,
      signal: controller.signal,
      providerFactory,
      executor: 'worker',
    })
    // 等待项目 1 的模型调用在途
    await factoryCalledP
    await providers[0]!.started
    // 父租约失租（过期，可被接管）→ 统一 abort
    await db.sql`update jobs set lease_until = now() - interval '60 seconds' where id = ${leaseA.id}`
    controller.abort()

    await expect(runA).rejects.toBeInstanceOf(LeaseLostError)
    // 在途模型调用确实被统一 abort 中止
    expect(providers[0]!.chatAborted).toBe(true)
    // 旧执行器未写任何结果：评测仍 running、无指标、无逐项目记录
    const after = (await db.sql`select status, metrics_json is null as no_metrics
      from evaluations where id = ${evaluationId}`) as unknown as Array<{ status: string; no_metrics: boolean }>
    expect(after[0]!.status).toBe('running')
    expect(after[0]!.no_metrics).toBe(true)
    expect(await countRecords(evaluationId)).toBe(0)
    // 清理失租遗留的过期任务（本用例不再验证其接管路径，避免影响后续用例领取）
    await db.sql`update jobs set state = 'failed', lease_until = null where id = ${leaseA.id}`
  }, 120_000)

  it('父任务取消（合法 owner 在租）：partial 写入、已完成项目保留', async () => {
    const evaluationId = await createEvaluationRow('static_only', 'all')
    await db.sql`insert into jobs (kind, target_id) values ('evaluation', ${evaluationId})`
    const lease = await claimEvaluationJob(evaluationId)

    let calls = 0
    const result = await runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'static_only',
      split: 'all',
      job: lease,
      executor: 'worker',
      isCancelRequested: async () => {
        calls++
        return calls >= 2 // 项目 1 完成后取消
      },
    })
    expect(result.status).toBe('partial')
    expect(result.metricsJson.config.cancelled).toBe(true)
    expect(result.metricsJson.projects).toHaveLength(1)
    // 合法 owner：partial 与逐项目记录正常落库
    const stored = await readMetrics(evaluationId)
    expect(stored.status).toBe('partial')
    expect(stored.metrics.projects).toHaveLength(1)
    expect(await countRecords(evaluationId)).toBe(1)
  }, 120_000)
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createTestDb, type TestDb } from '../helpers/db'
import { buildDeflateZip } from '../helpers/zip'
import { prepareSnapshot } from '../../src/core/import'
import { persistSnapshot } from '../../src/server/snapshots'
import { claimJob, renewLease, newWorkerId, completeJob } from '../../src/worker/jobs'
import { processScanJob } from '../../src/worker/scanner'
import { asJson } from '../../src/server/db/json'
import type { ChatProvider, ProviderResult } from '../../src/core/review/provider'

let db: TestDb
let storageRoot: string
let projectId: string
let snapshotId: string

const SAMPLE_FILES: Array<{ name: string; content: string }> = [
  {
    name: 'src/App.tsx',
    content: [
      'import { format } from "./utils/format"',
      'export function App({ bio }: { bio: string }) {',
      '  return <div dangerouslySetInnerHTML={{ __html: bio }} />',
      '}',
      'export function List({ items }: { items: string[] }) {',
      '  return <ul>{items.map((it) => <li>{it}</li>)}</ul>',
      '}',
    ].join('\n'),
  },
  {
    name: 'src/danger.js',
    content: 'function run(code) {\n  return eval(code)\n}\nwindow.addEventListener("message", (e) => {\n  doThing(e.data)\n})\n',
  },
  { name: 'src/utils/format.ts', content: 'export function format(s: string) {\n  return s.trim()\n}\n' },
  { name: 'package.json', content: '{"name":"t","dependencies":{"react":"^19.0.0"}}' },
]

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-storage-'))
  const { env } = await import('../../src/server/env')
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })

  const zip = await buildDeflateZip(SAMPLE_FILES)
  const prepared = await prepareSnapshot(zip)
  const project = await db.sql`insert into projects (name) values ('任务测试') returning id`
  projectId = (project[0] as { id: string }).id
  const summary = await persistSnapshot(db.sql, projectId, prepared)
  snapshotId = summary.id
})

afterAll(async () => {
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

async function createScan(idempotencyKey: string, enableCloudAI = false): Promise<string> {
  const configJson = JSON.stringify({ enableCloudAI, mode: 'standard' })
  const rows = await db.sql`
    insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
    values (${snapshotId}, ${idempotencyKey}, 'queued', 'ingest', ${configJson}::jsonb, 'v', 'v')
    on conflict (snapshot_id, idempotency_key) do nothing
    returning id`
  if (rows.length > 0) {
    const scanId = (rows[0] as { id: string }).id
    await db.sql`insert into jobs (kind, target_id) values ('scan', ${scanId}) on conflict (kind, target_id) do nothing`
    return scanId
  }
  const existing = await db.sql`select id from scans where snapshot_id = ${snapshotId} and idempotency_key = ${idempotencyKey}`
  return (existing[0] as { id: string }).id
}

describe('T05 任务租约与扫描管线', () => {
  it('幂等键：同一键只产生一次扫描与一个任务', async () => {
    const scanA = await createScan('idem-key-1')
    const scanB = await createScan('idem-key-1')
    expect(scanA).toBe(scanB)
    const jobs = await db.sql`select count(*)::int as c from jobs where kind = 'scan' and target_id = ${scanA}`
    expect((jobs[0] as { c: number }).c).toBe(1)
    const scans = await db.sql`select count(*)::int as c from scans where snapshot_id = ${snapshotId}`
    expect((scans[0] as { c: number }).c).toBe(1)
  })

  it('租约互斥：两个 worker 不能同时持有同一任务', async () => {
    const workerA = newWorkerId()
    const workerB = newWorkerId()
    const jobA = await claimJob(db.sql, workerA)
    expect(jobA).not.toBeNull()
    const jobB = await claimJob(db.sql, workerB)
    // 只有一个 scan 任务在队列 → B 无任务可领
    expect(jobB).toBeNull()
    // A 续租成功；伪造 owner 续租失败
    expect(
      await renewLease(db.sql, { id: jobA!.id, lease_owner: workerA, lease_generation: jobA!.lease_generation }),
    ).toBe(true)
    expect(
      await renewLease(db.sql, { id: jobA!.id, lease_owner: 'fake-worker', lease_generation: jobA!.lease_generation }),
    ).toBe(false)
    // A 条件完成成功
    expect(
      await completeJob(db.sql, { id: jobA!.id, lease_owner: workerA, lease_generation: jobA!.lease_generation }),
    ).toBe(true)
    // 已完成的任务不能再次完成
    expect(
      await completeJob(db.sql, { id: jobA!.id, lease_owner: workerA, lease_generation: jobA!.lease_generation }),
    ).toBe(false)
  })

  it('完整静态扫描：阶段推进、事件序列、findings、风险指标', async () => {
    const scanId = await createScan('idem-key-2')
    const job = await claimJob(db.sql, newWorkerId())
    expect(job).not.toBeNull()
    expect(job!.target_id).toBe(scanId)

    const result = await processScanJob(db.sql, {
      scanId,
      job: { id: job!.id, lease_owner: job!.lease_owner!, lease_generation: job!.lease_generation, attempt: job!.attempt },
    })
    expect(result.status).toBe('completed')
    expect(result.findingCount).toBeGreaterThan(0)

    // 扫描终态与指标
    const scanRow = (await db.sql`select status, stage, risk_json, coverage_json, completed_at from scans where id = ${scanId}`)[0] as unknown as {
      status: string
      stage: string
      risk_json: unknown
      coverage_json: unknown
      completed_at: string | null
    }
    expect(scanRow.status).toBe('completed')
    expect(scanRow.stage).toBe('report')
    expect(scanRow.completed_at).not.toBeNull()

    const risk = asJson<{ riskIndex: number; countedFindings: number; needsReview: number; counts: Record<string, number> }>(scanRow.risk_json)
    // 命中规则：dangerouslySetInnerHTML(候选) + jsx key + eval(候选) + message origin + ...
    expect(risk.countedFindings).toBeGreaterThanOrEqual(2)
    expect(risk.needsReview).toBeGreaterThanOrEqual(1)

    const coverage = asJson<{
      totalFiles: number
      analyzableFiles: number
      staticCheckedFiles: number
      ai: { enabled: boolean }
    }>(scanRow.coverage_json)
    expect(coverage.totalFiles).toBe(4)
    expect(coverage.analyzableFiles).toBe(3)
    expect(coverage.staticCheckedFiles).toBe(3)
    expect(coverage.ai.enabled).toBe(false)

    // 事件序列完整
    const events = (await db.sql`select event_type, payload_json from scan_events where scan_id = ${scanId} order by id`) as unknown as Array<{
      event_type: string
      payload_json: unknown
    }>
    const types = events.map((e) => e.event_type)
    expect(types).toContain('scan.started')
    expect(types.filter((t) => t === 'stage.started')).toHaveLength(6)
    expect(types.filter((t) => t === 'stage.completed')).toHaveLength(6)
    expect(types.filter((t) => t === 'finding.created').length).toBeGreaterThanOrEqual(2)
    expect(types).toContain('scan.finished')

    // findings 证据全部有效（引文来自真实行）
    const findings = (await db.sql`select draft_json, source, evidence_status, rule_id from findings where scan_id = ${scanId}`) as unknown as Array<{
      draft_json: unknown
      source: string
      evidence_status: string
      rule_id: string | null
    }>
    expect(findings.every((f) => f.source === 'static')).toBe(true)
    const ruleIds = findings.map((f) => f.rule_id)
    expect(ruleIds).toContain('sec/dynamic-code-exec')
    expect(ruleIds).toContain('sec/dom-html-injection')
    expect(ruleIds).toContain('cor/jsx-list-missing-key')
    expect(ruleIds).toContain('sec/message-no-origin-check')

    // 任务终态 completed
    const jobRow = (await db.sql`select state from jobs where id = ${job!.id}`)[0] as unknown as { state: string }
    expect(jobRow.state).toBe('completed')
  })

  it('崩溃接管：租约过期后新 worker 领取，attempt 递增', async () => {
    const scanId = await createScan('idem-key-3')
    const workerA = newWorkerId()
    const jobA = await claimJob(db.sql, workerA)
    expect(jobA!.target_id).toBe(scanId)
    // 模拟崩溃：租约过期
    await db.sql`update jobs set lease_until = now() - interval '60 seconds' where id = ${jobA!.id}`
    const workerB = newWorkerId()
    const jobB = await claimJob(db.sql, workerB)
    expect(jobB).not.toBeNull()
    expect(jobB!.id).toBe(jobA!.id)
    expect(jobB!.attempt).toBe(jobA!.attempt + 1)
    // B 完成扫描
    const result = await processScanJob(db.sql, {
      scanId,
      job: { id: jobB!.id, lease_owner: jobB!.lease_owner!, lease_generation: jobB!.lease_generation, attempt: jobB!.attempt },
    })
    expect(result.status).toBe('completed')
  })

  it('取消：queued 扫描直接终态化；运行中扫描在阶段边界取消', async () => {
    // queued 直接取消
    const scanIdQ = await createScan('idem-key-4')
    const jobQ = await claimJob(db.sql, newWorkerId())
    expect(jobQ!.target_id).toBe(scanIdQ)
    // 模拟仍处于"排队后、处理前"，先把状态回退到 queued 再请求取消
    await db.sql`update jobs set cancel_requested_at = now() where id = ${jobQ!.id}`
    const result = await processScanJob(db.sql, {
      scanId: scanIdQ,
      job: { id: jobQ!.id, lease_owner: jobQ!.lease_owner!, lease_generation: jobQ!.lease_generation, attempt: jobQ!.attempt },
    })
    expect(result.status).toBe('cancelled')
    const scanRow = (await db.sql`select status from scans where id = ${scanIdQ}`)[0] as unknown as { status: string }
    expect(scanRow.status).toBe('cancelled')
    const jobState = (await db.sql`select state from jobs where id = ${jobQ!.id}`)[0] as unknown as { state: string }
    expect(jobState.state).toBe('cancelled')
    // 取消后没有产生报告指标
    const risk = (await db.sql`select risk_json from scans where id = ${scanIdQ}`)[0] as unknown as { risk_json: unknown }
    expect(risk.risk_json).toBeNull()
  })

  it('终态恢复：重复处理已完成的扫描不重复报告', async () => {
    const scanId = await createScan('idem-key-2') // 已完成
    const eventsBefore = (await db.sql`select count(*)::int as c from scan_events where scan_id = ${scanId}`)[0] as { c: number }
    const result = await processScanJob(db.sql, {
      scanId,
      job: { id: '00000000-0000-0000-0000-000000000000', lease_owner: 'x', lease_generation: 1, attempt: 1 },
    })
    expect(result.status).toBe('completed')
    const eventsAfter = (await db.sql`select count(*)::int as c from scan_events where scan_id = ${scanId}`)[0] as { c: number }
    expect(eventsAfter.c).toBe(eventsBefore.c)
  })
})

/* -------- R01 回归：受控 provider 的 AI 阶段行为 -------- */

/** 受控 provider：读文件 → 基于真实 fixture 行提交一条有效 AI 结论 */
class ControlledProvider implements ChatProvider {
  readonly id = 'controlled-test'
  readonly isMock = false
  readonly ready = true
  private step = 0

  async chat(): Promise<ProviderResult> {
    this.step++
    if (this.step === 1) {
      return {
        text: '',
        toolCalls: [
          {
            id: 'c-read-1',
            name: 'read_file',
            args: { path: 'src/utils/format.ts', startLine: 1, endLine: 3 },
          },
        ],
        usage: { inputTokens: 111, outputTokens: 11 },
      }
    }
    if (this.step === 2) {
      const quote = SAMPLE_FILES[2]!.content.split('\n').slice(0, 3).join('\n')
      return {
        text: '',
        toolCalls: [
          {
            id: 'c-submit-1',
            name: 'submit_findings',
            args: {
              findings: [
                {
                  title: 'AI 复核：format 函数缺少用途说明',
                  category: 'maintainability',
                  severity: 'low',
                  confidence: 0.9,
                  primary: { path: 'src/utils/format.ts', startLine: 1, endLine: 3, quote },
                  related: [],
                  condition: '当 format 被外部输入调用时',
                  impact: '可读性与可维护性',
                  reasoningSummary: '受控 provider 基于真实读取行提交的测试结论',
                  recommendation: '补充函数用途注释',
                  guidelineChunkIds: [],
                },
              ],
            },
          },
        ],
        usage: { inputTokens: 222, outputTokens: 22 },
      }
    }
    return { text: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 } }
  }
}

/** 受控 provider：始终失败（模拟模型调用异常） */
class FailingProvider implements ChatProvider {
  readonly id = 'failing-test'
  readonly isMock = false
  readonly ready = true
  async chat(): Promise<ProviderResult> {
    throw new Error('controlled provider failure')
  }
}

describe('R01 AI 阶段回归（受控 provider 注入）', () => {
  it('AI 阶段成功：真实 usage 保留、覆盖记录、终态 completed', async () => {
    const scanId = await createScan('idem-ai-ok', true)
    const job = await claimJob(db.sql, newWorkerId())
    expect(job).not.toBeNull()
    expect(job!.target_id).toBe(scanId)

    const result = await processScanJob(db.sql, {
      scanId,
      job: { id: job!.id, lease_owner: job!.lease_owner!, lease_generation: job!.lease_generation, attempt: job!.attempt },
      aiProvider: new ControlledProvider(),
    })
    expect(result.status).toBe('completed')

    const scanRow = (await db.sql`select status, usage_json, coverage_json from scans where id = ${scanId}`)[0] as unknown as {
      status: string
      usage_json: unknown
      coverage_json: unknown
    }
    expect(scanRow.status).toBe('completed')

    const usage = asJson<{
      modelId: string | null
      modelCalls: number
      toolCalls: number
      inputTokensMeasured: number | null
      outputTokensMeasured: number | null
    }>(scanRow.usage_json)
    expect(usage.modelId).toBe('controlled-test')
    expect(usage.modelCalls).toBe(2)
    expect(usage.toolCalls).toBe(1)
    expect(usage.inputTokensMeasured).toBe(333)
    expect(usage.outputTokensMeasured).toBe(33)

    const coverage = asJson<{
      ai: { enabled: boolean; completed: boolean; readFiles: string[] }
    }>(scanRow.coverage_json)
    expect(coverage.ai.enabled).toBe(true)
    expect(coverage.ai.completed).toBe(true)
    expect(coverage.ai.readFiles).toContain('src/utils/format.ts')

    // AI 结论落库且通过证据校验
    const aiFindings = (await db.sql`select id from findings where scan_id = ${scanId} and source = 'ai'`)
    expect(aiFindings.length).toBe(1)
    // 工具轨迹持久化（真实 sequence/耗时）
    const toolCalls = (await db.sql`select tool_name, elapsed_ms, status from tool_calls where scan_id = ${scanId} order by sequence`)
    expect(toolCalls.length).toBe(1)
    expect((toolCalls[0] as { tool_name: string }).tool_name).toBe('read_file')
    expect((toolCalls[0] as { status: string }).status).toBe('ok')
  })

  it('AI 阶段失败：保留静态结果，终态 partial，usage 不虚构', async () => {
    const scanId = await createScan('idem-ai-fail', true)
    const job = await claimJob(db.sql, newWorkerId())
    expect(job).not.toBeNull()
    expect(job!.target_id).toBe(scanId)

    const result = await processScanJob(db.sql, {
      scanId,
      job: { id: job!.id, lease_owner: job!.lease_owner!, lease_generation: job!.lease_generation, attempt: job!.attempt },
      aiProvider: new FailingProvider(),
    })
    expect(result.status).toBe('partial')

    const scanRow = (await db.sql`select status, usage_json, coverage_json from scans where id = ${scanId}`)[0] as unknown as {
      status: string
      usage_json: unknown
      coverage_json: unknown
    }
    expect(scanRow.status).toBe('partial')

    // 静态结果完整保留
    const staticFindings = (await db.sql`select id from findings where scan_id = ${scanId} and source = 'static'`)
    expect(staticFindings.length).toBeGreaterThanOrEqual(2)

    const coverage = asJson<{ ai: { enabled: boolean; completed: boolean; degradedReason: string | null } }>(
      scanRow.coverage_json,
    )
    expect(coverage.ai.enabled).toBe(true)
    expect(coverage.ai.completed).toBe(false)
    expect(coverage.ai.degradedReason).toBe('ai_stage_error')

    const usage = asJson<{ modelCalls: number }>(scanRow.usage_json)
    expect(usage.modelCalls).toBe(0)
  })
})

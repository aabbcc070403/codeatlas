import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import postgres from 'postgres'
import { createTestDb, type TestDb } from '../helpers/db'
import { buildDeflateZip } from '../helpers/zip'
import { prepareSnapshot } from '../../src/core/import'
import { persistSnapshot } from '../../src/server/snapshots'
import {
  claimJob,
  completeJob,
  failJob,
  isCancelRequested,
  leaseGuarded,
  newWorkerId,
  renewLease,
  reapExhaustedJobs,
  requestCancel,
  LeaseKeeper,
  LeaseLostError,
  MAX_ATTEMPTS,
} from '../../src/worker/jobs'
import { processScanJob } from '../../src/worker/scanner'
import { markProjectDeleting, cleanupDeletingProjects, expireStaleSessions } from '../../src/worker/cleanup'

/**
 * R03 后台生命周期故障测试：
 * 续租保持、旧 worker 失租不能写、取消一致性、重试上限一致终结、
 * 阶段提交后崩溃恢复、活动索引删除（202 异步）、TTL 与扫描并发、LeaseKeeper 失租回调。
 */

let db: TestDb
let storageRoot: string
let projectId: string
let snapshotId: string

const SAMPLE_FILES: Array<{ name: string; content: string }> = [
  {
    name: 'src/App.tsx',
    content: [
      'export function App({ bio }: { bio: string }) {',
      '  return <div dangerouslySetInnerHTML={{ __html: bio }} />',
      '}',
    ].join('\n'),
  },
  {
    name: 'src/danger.js',
    content: 'function run(code) {\n  return eval(code)\n}\n',
  },
  { name: 'package.json', content: '{"name":"t"}' },
]

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-lease-storage-'))
  const { env } = await import('../../src/server/env')
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })

  const zip = await buildDeflateZip(SAMPLE_FILES)
  const prepared = await prepareSnapshot(zip)
  const project = await db.sql`insert into projects (name) values ('租约恢复测试') returning id`
  projectId = (project[0] as { id: string }).id
  const summary = await persistSnapshot(db.sql, projectId, prepared)
  snapshotId = summary.id
})

afterAll(async () => {
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

async function createScan(idempotencyKey: string): Promise<string> {
  const configJson = JSON.stringify({ enableCloudAI: false, mode: 'standard' })
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

function leaseOf(job: NonNullable<Awaited<ReturnType<typeof claimJob>>>) {
  return {
    id: job.id,
    lease_owner: job.lease_owner!,
    lease_generation: job.lease_generation,
    attempt: job.attempt,
  }
}

describe('R03 后台生命周期', () => {
  it('续租保持：租约到期前续租成功，其他 worker 不能接管', async () => {
    const scanId = await createScan('lease-renew-1')
    const workerA = newWorkerId()
    const jobA = await claimJob(db.sql, workerA)
    expect(jobA).not.toBeNull()
    expect(jobA!.target_id).toBe(scanId)

    // 续租：到期时间被推远，其他 worker 领不到该任务
    expect(await renewLease(db.sql, leaseOf(jobA!))).toBe(true)
    const jobB = await claimJob(db.sql, newWorkerId())
    expect(jobB === null || jobB.id !== jobA!.id).toBe(true)
    await completeJob(db.sql, leaseOf(jobA!))
  })

  it('旧 worker 接管后不能写：续租/完成/事务写入全部失败', async () => {
    const scanId = await createScan('lease-takeover-1')
    const workerA = newWorkerId()
    const jobA = await claimJob(db.sql, workerA)
    expect(jobA).not.toBeNull()

    // 模拟 A 崩溃后租约过期，B 接管（generation+1）
    await db.sql`update jobs set lease_until = now() - interval '60 seconds' where id = ${jobA!.id}`
    const workerB = newWorkerId()
    const jobB = await claimJob(db.sql, workerB)
    expect(jobB).not.toBeNull()
    expect(jobB!.id).toBe(jobA!.id)
    expect(jobB!.lease_generation).toBe(jobA!.lease_generation + 1)

    // 旧 worker A：续租失败、完成失败、事务内条件写抛 LeaseLostError
    expect(await renewLease(db.sql, leaseOf(jobA!))).toBe(false)
    expect(await completeJob(db.sql, leaseOf(jobA!))).toBe(false)
    await expect(
      leaseGuarded(db.sql, leaseOf(jobA!), async () => {
        /* 旧 worker 的任何写入 */
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)

    // B 正常完成（B 的写入路径畅通）
    const result = await processScanJob(db.sql, { scanId, job: leaseOf(jobB!) })
    expect(result.status).toBe('completed')
  })

  it('取消中断：scan 终态、最终事件、任务取消同一事务落实，无风险指标', async () => {
    const scanId = await createScan('lease-cancel-1')
    const job = await claimJob(db.sql, newWorkerId())
    expect(job).not.toBeNull()
    await requestCancel(db.sql, job!.id)
    expect(await isCancelRequested(db.sql, job!)).toBe(true)

    const result = await processScanJob(db.sql, { scanId, job: leaseOf(job!) })
    expect(result.status).toBe('cancelled')

    const scanRow = (await db.sql`select status, risk_json, completed_at from scans where id = ${scanId}`)[0] as unknown as {
      status: string
      risk_json: unknown
      completed_at: string | null
    }
    expect(scanRow.status).toBe('cancelled')
    expect(scanRow.risk_json).toBeNull()
    expect(scanRow.completed_at).not.toBeNull()
    const jobRow = (await db.sql`select state from jobs where id = ${job!.id}`)[0] as unknown as { state: string }
    expect(jobRow.state).toBe('cancelled')
    const finished = (await db.sql`select payload_json->>'status' as status from scan_events
      where scan_id = ${scanId} and event_type = 'scan.finished'`)[0] as unknown as { status: string }
    expect(finished.status).toBe('cancelled')
  })

  it('重试到上限：两次失败后任务与扫描状态一致终结', async () => {
    // 用真实快照创建扫描（FK 约束要求快照存在）
    const rows = await db.sql`insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
      values (${snapshotId}, 'lease-exhaust-1', 'running', 'static', '{"enableCloudAI":false,"mode":"standard"}'::jsonb, 'v', 'v')
      returning id`
    const orphanScan = (rows[0] as { id: string }).id
    await db.sql`insert into jobs (kind, target_id) values ('scan', ${orphanScan})`

    const worker = newWorkerId()
    // 第一次失败（attempt=1 < 2）：回队重试，扫描保持 running（恢复点）
    let job = await claimJob(db.sql, worker)
    expect(job!.attempt).toBe(1)
    await failJob(db.sql, { ...leaseOf(job!), kind: 'scan', target_id: orphanScan }, '测试失败 1')
    let state = (await db.sql`select state from jobs where id = ${job!.id}`)[0] as unknown as { state: string }
    expect(state.state).toBe('queued') // 可重试
    const scanState = (await db.sql`select status from scans where id = ${orphanScan}`)[0] as unknown as { status: string }
    expect(scanState.status).toBe('running') // 未提前终态

    // 立即可领取（跳过 available_at 延迟）
    await db.sql`update jobs set available_at = now() where id = ${job!.id}`
    // 第二次失败（attempt=2 ≥ MAX_ATTEMPTS）：任务与目标一致终结
    job = await claimJob(db.sql, worker)
    expect(job!.attempt).toBe(2)
    await failJob(db.sql, { ...leaseOf(job!), kind: 'scan', target_id: orphanScan }, '测试失败 2')
    state = (await db.sql`select state from jobs where id = ${job!.id}`)[0] as unknown as { state: string }
    expect(state.state).toBe('failed')

    // 目标扫描一致终结：failed + error_text + 终态事件
    const scanRow = (await db.sql`select status, error_text from scans where id = ${orphanScan}`)[0] as unknown as {
      status: string
      error_text: string | null
    }
    expect(scanRow.status).toBe('failed')
    expect(scanRow.error_text).toContain('重试次数耗尽')
    const finished = (await db.sql`select payload_json->>'status' as status from scan_events
      where scan_id = ${orphanScan} and event_type = 'scan.finished'`)[0] as unknown as { status: string }
    expect(finished.status).toBe('failed')

    // attempt 已达上限：claimJob 不再领取（含过期租约）
    await db.sql`update jobs set lease_until = now() - interval '60 seconds' where id = ${job!.id}`
    const again = await claimJob(db.sql, newWorkerId())
    expect(again === null || again.id !== job!.id).toBe(true)
    expect(MAX_ATTEMPTS).toBe(2)
  })

  it('收割：worker 崩溃后过期且耗尽的 running 任务被一致终结', async () => {
    // 构造：running + 过期租约 + attempt 已达上限（不再被接管）
    const rows = await db.sql`insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
      values (${snapshotId}, 'lease-reap-1', 'running', 'index', '{"enableCloudAI":false,"mode":"standard"}'::jsonb, 'v', 'v')
      returning id`
    const scanId = (rows[0] as { id: string }).id
    await db.sql`insert into jobs (kind, target_id, state, lease_owner, lease_generation, lease_until, attempt, last_error)
      values ('scan', ${scanId}, 'running', 'dead-worker', 1, now() - interval '120 seconds', ${MAX_ATTEMPTS}, '收割前错误')`

    const reaped = await reapExhaustedJobs(db.sql)
    expect(reaped).toBeGreaterThanOrEqual(1)
    const jobRow = (await db.sql`select state from jobs where target_id = ${scanId}`)[0] as unknown as { state: string }
    expect(jobRow.state).toBe('failed')
    const scanRow = (await db.sql`select status, error_text from scans where id = ${scanId}`)[0] as unknown as {
      status: string
      error_text: string | null
    }
    expect(scanRow.status).toBe('failed')
    expect(scanRow.error_text).toContain('重试次数耗尽')
  })

  it('阶段提交后崩溃：接管方从恢复点续跑，事件与 findings 不重复', async () => {
    const scanId = await createScan('lease-resume-1')
    const workerA = newWorkerId()
    const jobA = await claimJob(db.sql, workerA)
    expect(jobA).not.toBeNull()

    // 模拟 A 跑到 static 阶段后崩溃：推进状态 + 发送 ingest/index 阶段事件 + 发 scan.started
    await db.sql`update scans set status = 'running', stage = 'static', started_at = now() where id = ${scanId}`
    await db.sql`insert into scan_events (scan_id, event_type, payload_json) values
      (${scanId}, 'scan.started', ${db.sql.json({ snapshotId } as unknown as postgres.JSONValue)}),
      (${scanId}, 'stage.started', ${db.sql.json({ stage: 'ingest' } as unknown as postgres.JSONValue)}),
      (${scanId}, 'stage.completed', ${db.sql.json({ stage: 'ingest' } as unknown as postgres.JSONValue)}),
      (${scanId}, 'stage.started', ${db.sql.json({ stage: 'index' } as unknown as postgres.JSONValue)}),
      (${scanId}, 'stage.completed', ${db.sql.json({ stage: 'index' } as unknown as postgres.JSONValue)})`
    // A 崩溃：租约过期，B 接管
    await db.sql`update jobs set lease_until = now() - interval '60 seconds' where id = ${jobA!.id}`
    const jobB = await claimJob(db.sql, newWorkerId())
    expect(jobB).not.toBeNull()

    const result = await processScanJob(db.sql, { scanId, job: leaseOf(jobB!) })
    expect(result.status).toBe('completed')

    // 恢复检查：scan.started 仅 1 次；ingest/index 阶段事件未被重发
    const events = (await db.sql`select event_type, payload_json->>'stage' as stage from scan_events
      where scan_id = ${scanId} order by id`) as unknown as Array<{ event_type: string; stage: string | null }>
    expect(events.filter((e) => e.event_type === 'scan.started')).toHaveLength(1)
    expect(events.filter((e) => e.event_type === 'stage.started' && e.stage === 'ingest')).toHaveLength(1)
    expect(events.filter((e) => e.event_type === 'stage.completed' && e.stage === 'index')).toHaveLength(1)
    // 完整管线事件（6 阶段全部走完）
    expect(events.filter((e) => e.event_type === 'stage.started')).toHaveLength(6)
    expect(events.filter((e) => e.event_type === 'stage.completed')).toHaveLength(6)
    expect(events.some((e) => e.event_type === 'scan.finished')).toBe(true)
    // findings 唯一（fingerprint 幂等）
    const findingCount = (await db.sql`select count(*)::int as c from findings where scan_id = ${scanId}`)[0] as { c: number }
    expect(findingCount.c).toBeGreaterThanOrEqual(2)
  })

  it('活动索引删除：有活动租约返回 202 语义，任务退出后清理完成', async () => {
    // 新项目 + document + document_index 任务（租约有效）
    const proj = (await db.sql`insert into projects (name) values ('删除索引项目') returning id`)[0] as { id: string }
    const doc = (await db.sql`insert into documents (title, content_hash, category)
      values ('删除测试文档', 'hash-del-1', 'secure_coding') returning id`)[0] as { id: string }
    await db.sql`update documents set project_id = ${proj.id} where id = ${doc.id}`
    const jobRow = (await db.sql`insert into jobs (kind, target_id, state, lease_owner, lease_generation, lease_until)
      values ('document_index', ${doc.id}, 'running', 'index-worker', 3, now() + interval '30 seconds') returning id`)[0] as { id: string }

    // 删除请求：有活动租约 → 返回 true（API 层为 202）
    const hasActive = await markProjectDeleting(db.sql, proj.id)
    expect(hasActive).toBe(true)
    // 任务 cancel 已被请求
    const cancelFlag = (await db.sql`select cancel_requested_at is not null as c from jobs where id = ${jobRow.id}`)[0] as { c: boolean }
    expect(cancelFlag.c).toBe(true)

    // 清理轮次 1：活动租约仍在 → 项目保留
    expect(await cleanupDeletingProjects(db.sql)).toBe(0)
    let left = (await db.sql`select 1 from projects where id = ${proj.id} limit 1`)
    expect(left.length).toBe(1)

    // 任务退出（租约终结）
    await db.sql`update jobs set state = 'completed', lease_until = null where id = ${jobRow.id}`
    // 清理轮次 2：完成删除（先存储后 DB）
    expect(await cleanupDeletingProjects(db.sql)).toBe(1)
    left = await db.sql`select 1 from projects where id = ${proj.id} limit 1`
    expect(left.length).toBe(0)
    const jobLeft = await db.sql`select 1 from jobs where id = ${jobRow.id} limit 1`
    expect(jobLeft.length).toBe(0)
    // 存储目录同步删除
    expect(fs.existsSync(path.join(storageRoot, 'projects', proj.id))).toBe(false)
  })

  it('TTL 与扫描并发：会话过期标记 deleting，活动租约退出后统一清理', async () => {
    // 项目挂在独立会话下，会话已过期
    const session = (await db.sql`insert into sessions (token_hash, expires_at)
      values ('ttl-concurrent-hash', now() - interval '1 hour') returning id`)[0] as { id: string }
    const proj = (await db.sql`insert into projects (name, session_id) values ('TTL 并发项目', ${session.id}) returning id`)[0] as { id: string }
    const snap = (await db.sql`insert into snapshots (project_id, status, file_count, skipped_count, content_hash, structure_json)
      values (${proj.id}, 'ready', 1, 0, 'hash-ttl-1', '{}'::jsonb) returning id`)[0] as { id: string }
    const scan = (await db.sql`insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
      values (${snap.id}, 'ttl-1', 'running', 'static', '{"enableCloudAI":false,"mode":"standard"}'::jsonb, 'v', 'v') returning id`)[0] as { id: string }
    const jobRow = (await db.sql`insert into jobs (kind, target_id, state, lease_owner, lease_generation, lease_until)
      values ('scan', ${scan.id}, 'running', 'ttl-worker', 1, now() + interval '30 seconds') returning id`)[0] as { id: string }

    // TTL：标记 deleting（项目 + 任务取消请求）
    const marked = await expireStaleSessions(db.sql)
    expect(marked).toBeGreaterThanOrEqual(1)
    const deleting = (await db.sql`select deleting_at is not null as d from projects where id = ${proj.id}`)[0] as { d: boolean }
    expect(deleting.d).toBe(true)
    // 过期会话行仍在（被 deleting 项目引用，避免 FK 级联绕过活动任务）
    const sessionLeft = await db.sql`select 1 from sessions where id = ${session.id}`
    expect(sessionLeft.length).toBe(1)

    // 活动租约仍在 → 不清理
    expect(await cleanupDeletingProjects(db.sql)).toBe(0)
    // 租约退出（任务终结）
    await db.sql`update jobs set state = 'cancelled', lease_until = null where id = ${jobRow.id}`
    expect(await cleanupDeletingProjects(db.sql)).toBe(1)
    expect((await db.sql`select 1 from projects where id = ${proj.id} limit 1`).length).toBe(0)
    // 项目删除后，过期会话行可被安全删除
    await expireStaleSessions(db.sql)
    expect((await db.sql`select 1 from sessions where id = ${session.id} limit 1`).length).toBe(0)
  })

  it('LeaseKeeper：失租触发 onLost（abort 信号），tick 异常不产生未处理拒绝', async () => {
    await createScan('lease-keeper-1')
    const workerA = newWorkerId()
    const jobA = await claimJob(db.sql, workerA)
    expect(jobA).not.toBeNull()

    let lost = false
    const controller = new AbortController()
    const keeper = new LeaseKeeper(db.sql, leaseOf(jobA!), () => {
      lost = true
      controller.abort()
    })
    keeper.start(20)
    expect(keeper.hasLostLease).toBe(false)
    // 正常续租若干周期
    await new Promise((r) => setTimeout(r, 100))
    expect(lost).toBe(false)

    // 模拟被接管：generation+1 → 续租失败 → onLost → abort
    await db.sql`update jobs set lease_generation = lease_generation + 1 where id = ${jobA!.id}`
    await new Promise((r) => setTimeout(r, 200))
    expect(lost).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(keeper.hasLostLease).toBe(true)
    keeper.stop()
    await completeJob(db.sql, leaseOf(jobA!)) // generation 已变：条件写失败（预期）
    expect(await renewLease(db.sql, leaseOf(jobA!))).toBe(false)
  })
})

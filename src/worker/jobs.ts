import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

/**
 * 任务租约（规格 11 / R03）：FOR UPDATE SKIP LOCKED 原子领取，
 * 30 秒租约、10 秒续租、过期接管、最多 2 次尝试。
 * 所有写入带租约条件，失去租约即停止；上限耗尽时任务与目标状态一致终结。
 */

export const LEASE_MS = 30_000
export const MAX_ATTEMPTS = 2

/** 失去租约（被接管/项目删除/异常）：不能写任何结果，由接管方恢复 */
export class LeaseLostError extends Error {
  constructor(message = '失去任务租约') {
    super(message)
    this.name = 'LeaseLostError'
  }
}

export interface JobRow {
  id: string
  kind: 'scan' | 'document_index' | 'evaluation'
  target_id: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  lease_owner: string | null
  lease_generation: number
  lease_until: string | null
  attempt: number
  cancel_requested_at: string | null
  last_error: string | null
  payload_json: Record<string, unknown> | null
}

/** 租约身份（处理函数持有任务时的凭据） */
export interface LeaseInfo {
  id: string
  lease_owner: string
  lease_generation: number
  attempt: number
}

export function newWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`
}

/** 原子领取一个可执行任务（含接管过期租约；attempt 达上限的任务不再领取） */
export async function claimJob(
  sql: postgres.Sql,
  workerId: string,
  kinds: Array<JobRow['kind']> = ['scan', 'document_index', 'evaluation'],
): Promise<JobRow | null> {
  const kindList = sql(kinds as string[])
  const rows = await sql`
    update jobs set
      state = 'running',
      lease_owner = ${workerId},
      lease_generation = jobs.lease_generation + 1,
      lease_until = now() + interval '30 seconds',
      attempt = jobs.attempt + 1,
      updated_at = now()
    where id = (
      select id from jobs
      where kind in ${kindList}
        and state in ('queued', 'running')
        and available_at <= now()
        and attempt < ${MAX_ATTEMPTS}
        and (
          state = 'queued'
          or lease_until is null
          or lease_until < now()
        )
      order by created_at asc
      for update skip locked
      limit 1
    )
    returning id, kind, target_id, state, lease_owner, lease_generation, lease_until, attempt, cancel_requested_at, last_error, payload_json
  `
  if (rows.length === 0) return null
  return rows[0] as unknown as JobRow
}

/** 续租：仅当仍持有租约时成功 */
export async function renewLease(
  sql: postgres.Sql,
  job: { id: string; lease_owner: string; lease_generation: number },
): Promise<boolean> {
  const rows = await sql`
    update jobs set lease_until = now() + interval '30 seconds', updated_at = now()
    where id = ${job.id}
      and lease_owner = ${job.lease_owner}
      and lease_generation = ${job.lease_generation}
      and state = 'running'
    returning id
  `
  return rows.length > 0
}

/** 非事务快速校验：任务仍由本 worker 持有且租约未过期 */
export async function assertLease(
  sql: postgres.Sql,
  job: { id: string; lease_owner: string; lease_generation: number },
): Promise<boolean> {
  const rows = await sql`select 1 from jobs
    where id = ${job.id}
      and lease_owner = ${job.lease_owner}
      and lease_generation = ${job.lease_generation}
      and state = 'running'
      and lease_until > now()`
  return rows.length > 0
}

/** 事务内锁定任务行并确认租约（owner/generation/running/未过期）；失租抛 LeaseLostError */
export async function leaseGuarded<T>(
  sql: postgres.Sql,
  job: { id: string; lease_owner: string; lease_generation: number },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    const rows = await tx`select 1 from jobs
      where id = ${job.id}
        and lease_owner = ${job.lease_owner}
        and lease_generation = ${job.lease_generation}
        and state = 'running'
        and lease_until > now()
      for update`
    if (rows.length === 0) throw new LeaseLostError()
    return fn(tx)
  })
  return result as T
}

/** 完成任务：条件写（失去租约则失败返回 false） */
export async function completeJob(
  sql: postgres.Sql,
  job: { id: string; lease_owner: string; lease_generation: number },
): Promise<boolean> {
  const rows = await sql`
    update jobs set state = 'completed', lease_until = null, updated_at = now()
    where id = ${job.id}
      and lease_owner = ${job.lease_owner}
      and lease_generation = ${job.lease_generation}
      and state = 'running'
    returning id
  `
  return rows.length > 0
}

/**
 * 任务失败：未达尝试上限回队延迟重试；达上限时任务与目标状态一致终结
 * （scan → failed + error_text + 终态事件，同一事务）。
 */
export async function failJob(
  sql: postgres.Sql,
  job: LeaseInfo & { kind: JobRow['kind']; target_id: string },
  error: string,
): Promise<void> {
  const exhausted = job.attempt >= MAX_ATTEMPTS
  await sql.begin(async (tx) => {
    const rows = await tx`update jobs set
        state = case when ${exhausted} then 'failed' else 'queued' end,
        lease_until = null,
        available_at = now() + interval '5 seconds',
        last_error = ${error.slice(0, 500)},
        updated_at = now()
      where id = ${job.id}
        and lease_owner = ${job.lease_owner}
        and lease_generation = ${job.lease_generation}
      returning id`
    if (rows.length === 0 || !exhausted) return
    if (job.kind === 'scan') {
      // 上限耗尽：目标扫描一致终结（条件写：仅非终态扫描）
      const updated = await tx`update scans set status = 'failed',
          error_text = ${`重试次数耗尽：${error}`.slice(0, 500)},
          completed_at = now()
        where id = ${job.target_id} and status in ('queued', 'running')
        returning id`
      if (updated.length > 0) {
        await tx`insert into scan_events (scan_id, event_type, payload_json)
          values (${job.target_id}, 'scan.finished', ${sql.json(
            { status: 'failed', error: '任务重试次数耗尽' } as unknown as postgres.JSONValue,
          )})`
      }
    } else if (job.kind === 'evaluation') {
      // 上限耗尽：评测记录一致终结（R08；条件写：仅非终态评测）
      await tx`update evaluations set status = 'failed',
          error_text = ${`评测任务重试次数耗尽：${error}`.slice(0, 500)},
          completed_at = now()
        where id = ${job.target_id} and status in ('pending', 'running')
        returning id`
    }
  })
}

/**
 * 收割过期且尝试耗尽的 running 任务（worker 崩溃后再无接管可能）：
 * 任务与目标状态一致终结。可接管的过期任务由 claimJob 正常处理，此处不碰。
 */
export async function reapExhaustedJobs(sql: postgres.Sql): Promise<number> {
  const rows = (await sql`select id, kind, target_id, last_error, attempt from jobs
    where state = 'running' and lease_until < now() and attempt >= ${MAX_ATTEMPTS}
    order by created_at asc limit 50`) as unknown as Array<{
    id: string
    kind: JobRow['kind']
    target_id: string
    last_error: string | null
  }>
  for (const row of rows) {
    try {
      await sql.begin(async (tx) => {
        // 先终结目标（scan），再终结任务：中途崩溃可由下一轮收割重复进入
        if (row.kind === 'scan') {
          const updated = await tx`update scans set status = 'failed',
              error_text = ${`重试次数耗尽：${row.last_error ?? '未知错误'}`.slice(0, 500)},
              completed_at = now()
            where id = ${row.target_id} and status in ('queued', 'running')
            returning id`
          if (updated.length > 0) {
            await tx`insert into scan_events (scan_id, event_type, payload_json)
              values (${row.target_id}, 'scan.finished', ${sql.json(
                { status: 'failed', error: '任务重试次数耗尽' } as unknown as postgres.JSONValue,
              )})`
          }
        } else if (row.kind === 'evaluation') {
          await tx`update evaluations set status = 'failed',
              error_text = ${`评测任务重试次数耗尽：${row.last_error ?? '未知错误'}`.slice(0, 500)},
              completed_at = now()
            where id = ${row.target_id} and status in ('pending', 'running')`
        }
        await tx`update jobs set state = 'failed', lease_until = null, updated_at = now()
          where id = ${row.id} and state = 'running'`
      })
    } catch (err) {
      console.error(`[jobs] 收割任务 ${row.id} 失败:`, err instanceof Error ? err.message : err)
    }
  }
  return rows.length
}

/** 外部请求取消（不直接改 state，由 worker 在工具边界落实） */
export async function requestCancel(sql: postgres.Sql, jobId: string): Promise<void> {
  await sql`update jobs set cancel_requested_at = now(), updated_at = now() where id = ${jobId}`
}

/** worker 侧落实取消：条件写终态 */
export async function cancelJob(
  sql: postgres.Sql,
  job: { id: string; lease_owner: string; lease_generation: number },
): Promise<boolean> {
  const rows = await sql`
    update jobs set state = 'cancelled', lease_until = null, updated_at = now()
    where id = ${job.id}
      and lease_owner = ${job.lease_owner}
      and lease_generation = ${job.lease_generation}
      and state = 'running'
    returning id
  `
  return rows.length > 0
}

/** 检查取消请求（每个阶段/工具边界调用） */
export async function isCancelRequested(
  sql: postgres.Sql,
  job: { id: string },
): Promise<boolean> {
  const rows = await sql`select cancel_requested_at from jobs where id = ${job.id}`
  if (rows.length === 0) return true // 任务不存在（被清理）也视为取消
  return (rows[0] as { cancel_requested_at: string | null }).cancel_requested_at !== null
}

/** 周期续租器：AI 长阶段期间保持租约；失去租约时触发 abort。
 *  DB 异常不直接放弃（防抖动），连续失败达到阈值才视为失租；tick 全程捕获，杜绝未处理拒绝。 */
export class LeaseKeeper {
  private timer: ReturnType<typeof setInterval> | null = null
  private lost = false
  private dbErrorCount = 0
  private readonly onLost: () => void

  constructor(
    private sql: postgres.Sql,
    private job: { id: string; lease_owner: string; lease_generation: number },
    onLost: () => void,
  ) {
    this.onLost = onLost
  }

  start(intervalMs = 10_000): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
  }

  private async tick(): Promise<void> {
    if (this.lost) return
    try {
      const ok = await renewLease(this.sql, this.job)
      this.dbErrorCount = 0
      if (!ok) this.markLost()
    } catch {
      this.dbErrorCount++
      if (this.dbErrorCount >= 3) this.markLost()
    }
  }

  private markLost(): void {
    if (this.lost) return
    this.lost = true
    this.stop()
    try {
      this.onLost()
    } catch (err) {
      console.error('[jobs] LeaseKeeper onLost 回调异常:', err instanceof Error ? err.message : err)
    }
  }

  get hasLostLease(): boolean {
    return this.lost
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

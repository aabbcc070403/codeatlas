import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { env } from '@/server/env'

/**
 * AI 日额度（规格 9.2 / R04 / A04）：每次模型/embedding 调用**之前**原子预留，
 * 实际 usage 结算时释放预留并记账；调用失败释放预留。
 * 限制检查为单条原子 UPDATE（used + reserved + n ≤ 日限额），并发安全；
 * 缺实测 usage 时用保守估算结算，不按零计费。
 *
 * A04：预留返回绑定「预留日期 + 唯一 ID」的 reservation，结算/释放只作用于
 * 该 reservation 且幂等（重复 settle/release、settle 已 released 的预留都是 no-op），
 * 跨 UTC 日期结算不再更新新日期行。Mock 调用方完全跳过本模块（不预留/不结算/不释放）。
 *
 * 回收政策（进程崩溃/未知结果）：调用后进程中断会导致预留停留在 reserved 状态——
 * 这是保守方向（占住当日额度、不会漏记或多记实际消耗）；daily_usage 按天分行，
 * 泄漏不跨日累积。运营方可在维护窗口将过期 reserved 行标记 released
 * （update daily_reservations set state='released' where state='reserved' and updated_at < now() - interval '1 hour'
 * 并同步回减 daily_usage.reserved_tokens），本项目不做自动回收。
 */

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 一次预留的凭证：结算/释放绑定它（日期 + 唯一 ID），幂等 */
export interface DailyTokenReservation {
  /** 预留发生时的 UTC 日期（YYYY-MM-DD）：结算/释放固定作用于该日 */
  readonly day: string
  /** 全局唯一 ID：daily_reservations 幂等键 */
  readonly id: string
  readonly tokens: number
}

/**
 * 原子预留 n tokens：成功返回 reservation；日额度不足
 * （used + reserved + n 超限）返回 null。
 */
export async function reserveDailyTokens(
  sql: postgres.Sql,
  n: number,
): Promise<DailyTokenReservation | null> {
  const day = todayUtc()
  if (n <= 0) return { day, id: randomUUID(), tokens: 0 }
  return sql.begin(async (tx) => {
    // 先确保行存在（幂等），再原子条件预留
    await tx`insert into daily_usage (day) values (${day}) on conflict (day) do nothing`
    const rows = await tx`
      update daily_usage set reserved_tokens = reserved_tokens + ${n}, updated_at = now()
      where day = ${day}
        and (input_tokens + output_tokens + reserved_tokens + ${n}) <= ${env.AI_DAILY_TOKEN_LIMIT}
      returning 1 as ok`
    if (rows.length === 0) return null
    const reservation: DailyTokenReservation = { day, id: randomUUID(), tokens: n }
    await tx`insert into daily_reservations (id, day, tokens) values (${reservation.id}, ${day}, ${n})`
    return reservation
  })
}

/**
 * 结算一次调用：释放预留，按 actual（实测，缺省由调用方回退保守估算，不按零计费）
 * 记账到预留发生的日期。幂等：reservation 已结算/已释放时为 no-op。
 */
export async function settleDailyReservation(
  sql: postgres.Sql,
  reservation: DailyTokenReservation,
  actualInput: number,
  actualOutput: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    // 只有 reserved → settled 的状态迁移才记账（幂等键：id + day）
    const rows = await tx`
      update daily_reservations set state = 'settled', updated_at = now()
      where id = ${reservation.id} and day = ${reservation.day} and state = 'reserved'
      returning 1 as ok`
    if (rows.length === 0) return
    await tx`
      update daily_usage set
        input_tokens = input_tokens + ${actualInput},
        output_tokens = output_tokens + ${actualOutput},
        requests = requests + 1,
        reserved_tokens = greatest(0, reserved_tokens - ${reservation.tokens}),
        updated_at = now()
      where day = ${reservation.day}`
  })
}

/** 调用失败：仅释放预留（不记账、不计数）。幂等：非 reserved 状态为 no-op。 */
export async function releaseDailyReservation(
  sql: postgres.Sql,
  reservation: DailyTokenReservation,
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      update daily_reservations set state = 'released', updated_at = now()
      where id = ${reservation.id} and day = ${reservation.day} and state = 'reserved'
      returning 1 as ok`
    if (rows.length === 0) return
    await tx`
      update daily_usage set reserved_tokens = greatest(0, reserved_tokens - ${reservation.tokens}), updated_at = now()
      where day = ${reservation.day}`
  })
}

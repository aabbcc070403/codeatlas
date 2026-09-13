import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import {
  reserveDailyTokens,
  settleDailyReservation,
  releaseDailyReservation,
} from '../../src/core/review/daily-budget'

/**
 * A04 日额度 reservation 账本（独立临时 PGlite / 显式 PostgreSQL）：
 * 跨 UTC 日期结算绑定预留日期、重复 settle/release 幂等、
 * 进程中断（未结算预留）按保守政策保留。
 */

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.dispose()
})

interface UsageRow {
  day: string
  reserved_tokens: number
  input_tokens: number
  output_tokens: number
  requests: number
}

async function usageRows(): Promise<UsageRow[]> {
  return (await db.sql`
    select day, reserved_tokens, input_tokens, output_tokens, requests from daily_usage order by day`) as unknown as UsageRow[]
}

async function clean(): Promise<void> {
  await db.sql`delete from daily_usage`
  await db.sql`delete from daily_reservations`
}

/** 跨 UTC 日期探针同款固定时钟（结束后恢复） */
async function withFixedClock<T>(clock: string, fn: (bump: (next: string) => void) => Promise<T>): Promise<T> {
  const RealDate = Date
  let current = clock
  const FixedDate = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(current)
      else super(args[0] as string)
    }
  } as DateConstructor
  globalThis.Date = FixedDate
  try {
    return await fn((next) => {
      current = next
    })
  } finally {
    globalThis.Date = RealDate
  }
}

describe('A04 日额度 reservation 账本', () => {
  it('跨 UTC 日期结算：绑定预留发生日期，不更新新日期行', async () => {
    await clean()
    const r = await withFixedClock('2030-01-01T23:59:59Z', async (bump) => {
      const reservation = await reserveDailyTokens(db.sql, 100)
      expect(reservation).not.toBeNull()
      expect(reservation!.day).toBe('2030-01-01')
      bump('2030-01-02T00:00:01Z') // 午夜后结算
      return reservation
    })
    await settleDailyReservation(db.sql, r!, 80, 20)
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      day: '2030-01-01',
      reserved_tokens: 0,
      input_tokens: 80,
      output_tokens: 20,
      requests: 1,
    })
  })

  it('跨 UTC 日期释放：同样绑定预留发生日期', async () => {
    await clean()
    const r = await withFixedClock('2030-01-01T23:59:59Z', async (bump) => {
      const reservation = await reserveDailyTokens(db.sql, 60)
      expect(reservation).not.toBeNull()
      bump('2030-01-02T00:00:01Z')
      return reservation
    })
    await releaseDailyReservation(db.sql, r!)
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.day).toBe('2030-01-01')
    expect(rows[0]!.reserved_tokens).toBe(0)
    expect(rows[0]!.input_tokens).toBe(0)
  })

  it('重复 settle 幂等：只记账一次', async () => {
    await clean()
    const r = await reserveDailyTokens(db.sql, 100)
    expect(r).not.toBeNull()
    await settleDailyReservation(db.sql, r!, 80, 20)
    await settleDailyReservation(db.sql, r!, 80, 20) // 重复结算
    await settleDailyReservation(db.sql, r!, 999, 999) // 重复结算
    const rows = await usageRows()
    expect(rows[0]).toMatchObject({
      reserved_tokens: 0,
      input_tokens: 80,
      output_tokens: 20,
      requests: 1,
    })
  })

  it('重复 release 幂等；settle 已释放预留为 no-op', async () => {
    await clean()
    const r = await reserveDailyTokens(db.sql, 50)
    expect(r).not.toBeNull()
    await releaseDailyReservation(db.sql, r!)
    await releaseDailyReservation(db.sql, r!) // 重复释放
    await settleDailyReservation(db.sql, r!, 123, 45) // 已释放后结算：不记账
    const rows = await usageRows()
    expect(rows[0]).toMatchObject({
      reserved_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      requests: 0,
    })
  })

  it('进程中断（预留未结算）：预留保守保留——不漏记、不重复记账', async () => {
    await clean()
    const r = await reserveDailyTokens(db.sql, 100)
    expect(r).not.toBeNull()
    // 模拟调用后进程崩溃：既不 settle 也不 release
    const rows = await usageRows()
    expect(rows[0]).toMatchObject({
      reserved_tokens: 100,
      input_tokens: 0,
      output_tokens: 0,
      requests: 0,
    })
    // 恢复路径：接管方释放预留（维护窗口回收政策）
    await releaseDailyReservation(db.sql, r!)
    const after = await usageRows()
    expect(after[0]!.reserved_tokens).toBe(0)
    expect(after[0]!.input_tokens).toBe(0)
    expect(after[0]!.requests).toBe(0)
  })
})

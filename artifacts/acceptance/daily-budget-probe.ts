// Isolated database probe; does not touch development data or call external models.
// A04 (fixed) assert-style probes: exit 0 only when behavior matches expectations.
import { createTestDb } from '../../tests/helpers/db'
import {
  reserveDailyTokens,
  settleDailyReservation,
  releaseDailyReservation,
} from '../../src/core/review/daily-budget'

const db = await createTestDb()
const RealDate = Date
let clock = '2030-01-01T23:59:59Z'
const FixedDate = class extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock)
    else super(args[0] as string)
  }
} as DateConstructor
let failures = 0
try {
  globalThis.Date = FixedDate

  // cross-midnight-settlement: reserve before UTC midnight, settle after —
  // the settlement must bind to the reservation's original day (not "today").
  const r1 = await reserveDailyTokens(db.sql, 100)
  clock = '2030-01-02T00:00:01Z'
  if (!r1) {
    failures++
    console.log(JSON.stringify({ probe: 'cross-midnight-settlement', pass: false, diff: '预留应成功' }))
  } else {
    await settleDailyReservation(db.sql, r1, 80, 20)
    await settleDailyReservation(db.sql, r1, 80, 20) // 重复 settle：幂等，不得重复记账
    const rows = (await db.sql`
      select day, reserved_tokens, input_tokens, output_tokens, requests from daily_usage order by day`) as unknown as Array<{
      day: string
      reserved_tokens: number
      input_tokens: number
      output_tokens: number
      requests: number
    }>
    const oldDay = rows.find((r) => r.day === '2030-01-01')
    const newDay = rows.find((r) => r.day === '2030-01-02')
    const pass =
      oldDay !== undefined &&
      oldDay.reserved_tokens === 0 &&
      oldDay.input_tokens === 80 &&
      oldDay.output_tokens === 20 &&
      oldDay.requests === 1 &&
      newDay === undefined
    if (pass) {
      console.log(JSON.stringify({ probe: 'cross-midnight-settlement', pass: true, actual: { oldDay, newDay: newDay ?? null } }))
    } else {
      failures++
      console.log(JSON.stringify({
        probe: 'cross-midnight-settlement', pass: false,
        expected: '原预留日期行 reserved=0/input=80/output=20/requests=1，且不产生新日期行',
        actual: { oldDay: oldDay ?? null, newDay: newDay ?? null },
      }))
    }
  }

  // zero-reservation-settlement: the fixed contract — settlement/release must bind
  // to a reservation returned by reserveDailyTokens, and be idempotent. A released
  // reservation settles to no-op (the old "settle with reserved=0 charges usage"
  // Mock-pollution path no longer exists at the call sites, which skip daily
  // budget operations entirely for Mock providers).
  const r2 = await reserveDailyTokens(db.sql, 1)
  if (!r2) {
    failures++
    console.log(JSON.stringify({ probe: 'zero-reservation-settlement', pass: false, diff: '预留应成功' }))
  } else {
    await releaseDailyReservation(db.sql, r2)
    await settleDailyReservation(db.sql, r2, 123, 45) // 已释放：no-op，不得记账
    await releaseDailyReservation(db.sql, r2) // 重复 release：no-op
    const rows = (await db.sql`
      select reserved_tokens, input_tokens, output_tokens, requests from daily_usage where day = '2030-01-02'`) as unknown as Array<{
      reserved_tokens: number
      input_tokens: number
      output_tokens: number
      requests: number
    }>
    const row = rows[0]
    const pass =
      row !== undefined && row.reserved_tokens === 0 && row.input_tokens === 0 && row.output_tokens === 0 && row.requests === 0
    if (pass) {
      console.log(JSON.stringify({ probe: 'zero-reservation-settlement', pass: true, actual: row }))
    } else {
      failures++
      console.log(JSON.stringify({
        probe: 'zero-reservation-settlement', pass: false,
        expected: '已释放预留的 settle/release 均为 no-op（reserved=0/input=0/output=0/requests=0）',
        actual: row ?? null,
      }))
    }
  }
} finally {
  globalThis.Date = RealDate
  await db.dispose()
}
if (failures > 0) process.exit(1)

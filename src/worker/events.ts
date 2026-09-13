import postgres from 'postgres'

/** 持久化扫描事件（SSE 游标 = scan_events.id 全局递增） */
export async function emitScanEvent(
  sql: postgres.Sql,
  scanId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql`insert into scan_events (scan_id, event_type, payload_json)
    values (${scanId}, ${eventType}, ${sql.json(payload as unknown as postgres.JSONValue)})`
}

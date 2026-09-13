import postgres from 'postgres'
import { asJson, asJsonArray } from '@/server/db/json'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/core/contracts/api'
import type { MessageCitation, MessageUsage } from '@/core/contracts/conversation'

/**
 * 追问消息共享查询（R05）：GET /api/findings/:id/messages 与
 * 问题详情页首屏/刷新恢复共用同一 DTO（role/text/citations/usage）。
 * 消息 id 为随机 UUID，不能当时间序：排序与翻页一律用 created_at（+id 决胜）。
 */

export interface MessageRow {
  id: string
  findingId: string
  role: 'user' | 'assistant'
  text: string
  citations: MessageCitation[]
  usage: MessageUsage | null
  createdAt: string
}

export interface MessagePage {
  items: MessageRow[]
  nextCursor: string | null
}

interface ParsedCursor {
  ts: string
  id: string
}

/** 游标格式：`${ISO 时间}|${消息 id}`；解析失败按无游标处理（返回最新一页） */
function parseCursor(cursor: string | null | undefined): ParsedCursor | null {
  if (!cursor) return null
  const idx = cursor.lastIndexOf('|')
  if (idx <= 0) return null
  const ts = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  if (!ts || !id) return null
  return { ts, id }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * 按 finding 分页取消息（升序返回，便于直接渲染会话）。
 * 首次调用不带 cursor 返回最新一页；nextCursor 指向更早一页的起点
 * （(created_at, id) 复合游标，append-only 场景下稳定）。
 */
export async function listFindingMessages(
  sql: postgres.Sql,
  findingId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
  )
  const cursor = parseCursor(opts.cursor ?? null)
  const rows = (await sql`
    select id, finding_id, role, text, citations_json, usage_json, created_at
    from messages
    where finding_id = ${findingId}
      ${
        cursor
          ? sql`and (created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
          : sql``
      }
    order by created_at desc, id desc
    limit ${limit + 1}`) as unknown as Array<{
    id: string
    finding_id: string
    role: string
    text: string
    citations_json: unknown
    usage_json: unknown
    created_at: unknown
  }>
  const hasMore = rows.length > limit
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse()
  const items: MessageRow[] = page.map((r) => ({
    id: r.id,
    findingId: r.finding_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    text: r.text,
    citations: asJsonArray<MessageCitation>(r.citations_json),
    usage: asJson<MessageUsage | null>(r.usage_json),
    createdAt: toIso(r.created_at),
  }))
  return {
    items,
    nextCursor: hasMore && items[0] ? `${items[0].createdAt}|${items[0].id}` : null,
  }
}

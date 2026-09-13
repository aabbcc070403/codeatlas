import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse } from '@/server/api/http'
import { requireSession } from '@/server/auth/guard'
import { DEFAULT_PAGE_SIZE } from '@/core/contracts/api'

export async function GET(req: NextRequest) {
  try {
    const sql = getDb()
    const session = await requireSession(sql, req)
    const limit = DEFAULT_PAGE_SIZE
    const items = await sql`select id, name, is_preset, created_at from projects
      where session_id = ${session.id} order by created_at desc limit ${limit}`
    const presetItems = await sql`select id, name, is_preset, created_at from projects
      where is_preset = true order by created_at asc limit 10`
    return jsonOk({
      items,
      presetItems,
      nextCursor: null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1, '项目名不能为空').max(80, '项目名过长'),
})

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req)
    const sql = getDb()
    const session = await requireSession(sql, req)
    const parsed = createSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError(
        400,
        'invalid_request',
        parsed.error.issues[0]?.message ?? '参数无效',
      )
    }
    const rows = await sql`insert into projects (session_id, name)
      values (${session.id}, ${parsed.data.name}) returning id, name, created_at`
    return jsonOk(rows[0], 201)
  } catch (err) {
    return toErrorResponse(err)
  }
}

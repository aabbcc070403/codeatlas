import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonOk, toErrorResponse } from '@/server/api/http'
import { requireReadableScan, requireSession } from '@/server/auth/guard'
import { listFindings } from '@/server/queries/scans'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

/** 问题列表：severity/category/source/feedback 过滤 + 游标分页 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)

    const url = new URL(req.url)
    const split = (key: string): string[] | undefined => {
      const raw = url.searchParams.get(key)
      return raw === null ? undefined : raw.split(',')
    }
    const cursor = url.searchParams.get('cursor')
    const limitRaw = Number(url.searchParams.get('limit'))

    const body = await listFindings(sql, ref.scanId, {
      severity: split('severity'),
      category: split('category'),
      source: split('source'),
      feedback: split('feedback'),
      cursor,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    })
    return jsonOk(body)
  } catch (err) {
    return toErrorResponse(err)
  }
}

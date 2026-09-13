import { NextResponse, type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonError, toErrorResponse } from '@/server/api/http'
import { assertUuid, requireSession } from '@/server/auth/guard'
import { requireOwnedPatch } from '@/server/queries/patches'
import { isDownloadable } from '@/core/patch/diff'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

/**
 * GET：下载 `.patch` 附件（规格 11）。跨会话/不存在 404；
 * 提案无效（不可应用或语法引入新错误）409，不给下载内容。
 * 快照原件不参与：diff 文本在提案生成时已持久化。
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '补丁')
    const patch = await requireOwnedPatch(sql, session.id, id)
    if (!isDownloadable(patch.validation)) {
      const reason =
        patch.validation.reasons[0] ??
        (patch.validation.applicable ? '补丁语法校验未通过' : '补丁未能通过应用校验')
      return jsonError(409, 'conflict', `提案无效，无法下载：${reason}`)
    }
    const filename = `codeatlas-patch-${patch.id.slice(0, 8)}.patch`
    return new NextResponse(patch.diffText, {
      status: 200,
      headers: {
        'content-type': 'text/x-diff; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

import { NextResponse, type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonError, toErrorResponse } from '@/server/api/http'
import { requireReadableScan, requireSession } from '@/server/auth/guard'
import { buildReportModel } from '@/core/report/model'
import {
  exportContentType,
  exportFilename,
  isExportFormat,
  reportToHtml,
  reportToJson,
  reportToMarkdown,
} from '@/core/report/export'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

/**
 * GET /api/scans/:id/export?format=json|markdown|html（规格 11 / F09）。
 * 与 UI 消费同一共享报告模型（buildReportModel），保证数字一致；
 * 响应为附件下载（Content-Disposition，文件名含 scan 短 id）；跨会话 404。
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const format = req.nextUrl.searchParams.get('format') ?? ''
    if (!isExportFormat(format)) {
      return jsonError(400, 'invalid_request', 'format 参数必须是 json、markdown 或 html')
    }
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)

    const model = await buildReportModel(sql, ref.scanId)
    const body =
      format === 'json'
        ? reportToJson(model)
        : format === 'markdown'
          ? reportToMarkdown(model)
          : reportToHtml(model)

    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': exportContentType(format),
        'content-disposition': `attachment; filename="${exportFilename(ref.scanId, format)}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse } from '@/server/api/http'
import { requireOwnedProject, requireReadableProject, requireSession } from '@/server/auth/guard'
import { prepareSnapshot, ArchiveError, ARCHIVE_LIMITS } from '@/core/import'
import { persistSnapshot } from '@/server/snapshots'
import { formatSize } from '@/core/import/archive'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    await requireReadableProject(sql, session, id)
    const snapshots = await sql`
      select s.id, s.content_hash, s.status, s.file_count, s.skipped_count, s.created_at,
        (select count(*)::int from scans sc where sc.snapshot_id = s.id) as scan_count
      from snapshots s where s.project_id = ${id} order by s.created_at desc limit 100`
    return jsonOk({ items: snapshots, nextCursor: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const project = await requireOwnedProject(sql, session, id)

    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return jsonError(415, 'unsupported_media_type', '请使用 multipart/form-data 上传 ZIP')
    }
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return jsonError(400, 'invalid_request', '缺少 file 字段')
    }
    if (file.size > ARCHIVE_LIMITS.maxCompressedBytes) {
      return jsonError(
        413,
        'payload_too_large',
        `ZIP 超过 ${formatSize(ARCHIVE_LIMITS.maxCompressedBytes)} 限制`,
      )
    }
    const buffer = Buffer.from(await file.arrayBuffer())

    const prepared = await prepareSnapshot(buffer).catch((err) => {
      if (err instanceof ArchiveError) {
        throw new HttpReject(422, err.reason)
      }
      throw err
    })
    const summary = await persistSnapshot(sql, project.id, prepared)

    return jsonOk(
      {
        snapshot: summary,
        skipped: prepared.skipped,
        structure: {
          languageCounts: prepared.structure.languageCounts,
          dependencyFiles: prepared.structure.dependencyFiles,
          lockFiles: prepared.structure.lockFiles,
          importEdgeCount: prepared.structure.importEdges.length,
          unresolvedImportCount: prepared.structure.unresolvedImports.length,
        },
      },
      201,
    )
  } catch (err) {
    if (err instanceof HttpReject) {
      return jsonError(err.status, 'invalid_request', err.message)
    }
    return toErrorResponse(err)
  }
}

class HttpReject extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

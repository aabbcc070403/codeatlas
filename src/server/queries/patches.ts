import postgres from 'postgres'
import { asJson, asJsonArray } from '@/server/db/json'
import type { PatchEdit, PatchValidation } from '@/core/contracts/patch'
import { HttpError } from '@/server/api/http'

/**
 * 补丁共享查询（R06）：GET /api/findings/:id/patch（恢复既有提案）、
 * GET /api/patches/:id/download（下载）与 UI 刷新恢复共用同一 DTO/SQL。
 */

export interface PatchRow {
  id: string
  findingId: string
  baseFileHash: string
  edits: PatchEdit[]
  diffText: string
  validation: PatchValidation
  status: 'proposed' | 'invalid' | 'superseded'
  createdAt: string
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function toPatchRow(r: {
  id: string
  finding_id: string
  base_file_hash: string
  edits_json: unknown
  diff_text: string
  validation_json: unknown
  status: string
  created_at: unknown
}): PatchRow {
  return {
    id: r.id,
    findingId: r.finding_id,
    baseFileHash: r.base_file_hash,
    edits: asJsonArray<PatchEdit>(r.edits_json),
    diffText: r.diff_text,
    validation: asJson<PatchValidation>(r.validation_json),
    status: (r.status === 'superseded' ? 'superseded' : r.status === 'invalid' ? 'invalid' : 'proposed'),
    createdAt: toIso(r.created_at),
  }
}

/** 某 finding 的最新提案（刷新恢复）；无提案返回 null */
export async function getLatestFindingPatch(
  sql: postgres.Sql,
  findingId: string,
): Promise<PatchRow | null> {
  const rows = (await sql`
    select id, finding_id, base_file_hash, edits_json, diff_text, validation_json, status, created_at
    from patches where finding_id = ${findingId}
    order by created_at desc limit 1`) as unknown as Array<Parameters<typeof toPatchRow>[0]>
  return rows[0] ? toPatchRow(rows[0]) : null
}

/**
 * 按 id 取补丁并校验会话归属：跨会话/不存在一律 404（不泄露存在性）。
 * 补丁挂在 finding → scan → snapshot → project 链上，仅本人项目可访问。
 */
export async function requireOwnedPatch(
  sql: postgres.Sql,
  sessionId: string,
  patchId: string,
): Promise<PatchRow & { projectId: string }> {
  const rows = (await sql`
    select p.id, p.finding_id, p.base_file_hash, p.edits_json, p.diff_text,
           p.validation_json, p.status, p.created_at,
           pr.id as project_id, pr.session_id as project_session_id
    from patches p
    join findings f on f.id = p.finding_id
    join scans sc on sc.id = f.scan_id
    join snapshots s on s.id = sc.snapshot_id
    join projects pr on pr.id = s.project_id
    where p.id = ${patchId} limit 1`) as unknown as Array<
    Parameters<typeof toPatchRow>[0] & { project_id: string; project_session_id: string | null }
  >
  const row = rows[0]
  if (!row || row.project_session_id !== sessionId) {
    throw new HttpError(404, 'not_found', '补丁不存在')
  }
  return { ...toPatchRow(row), projectId: row.project_id }
}

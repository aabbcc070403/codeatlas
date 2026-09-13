import postgres from 'postgres'
import { HttpError } from '../api/http'
import { getSession, type SessionInfo } from './session'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUuid(value: string, what = '资源'): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(404, 'not_found', `${what}不存在`)
  }
}

export async function requireSession(
  sql: postgres.Sql,
  req: Request,
): Promise<SessionInfo> {
  const session = await getSession(sql, req)
  if (!session) throw new HttpError(401, 'unauthorized', '会话无效或已过期，请重新登录')
  return session
}

export interface ProjectRow {
  id: string
  sessionId: string | null
  name: string
  isPreset: boolean
}

/** 读访问：本人项目或预置项目 */
export async function requireReadableProject(
  sql: postgres.Sql,
  session: SessionInfo,
  projectId: string,
): Promise<ProjectRow> {
  assertUuid(projectId, '项目')
  const rows = await sql`select id, session_id as "sessionId", name, is_preset as "isPreset" from projects where id = ${projectId}`
  if (rows.length === 0) throw new HttpError(404, 'not_found', '项目不存在')
  const row = rows[0] as ProjectRow
  if (row.sessionId !== session.id) {
    throw new HttpError(404, 'not_found', '项目不存在')
  }
  return row
}

/** 写访问：仅本人项目（预置项目只读） */
export async function requireOwnedProject(
  sql: postgres.Sql,
  session: SessionInfo,
  projectId: string,
): Promise<ProjectRow> {
  const row = await requireReadableProject(sql, session, projectId)
  if (row.isPreset || row.sessionId !== session.id) {
    throw new HttpError(404, 'not_found', '项目不存在')
  }
  return row
}

export interface SnapshotRef {
  snapshotId: string
  projectId: string
  projectIsPreset: boolean
}

export async function requireReadableSnapshot(
  sql: postgres.Sql,
  session: SessionInfo,
  snapshotId: string,
): Promise<SnapshotRef> {
  assertUuid(snapshotId, '快照')
  const rows = await sql`select s.id as "snapshotId", p.id as "projectId", p.session_id as "sessionId", p.is_preset as "projectIsPreset"
    from snapshots s join projects p on p.id = s.project_id where s.id = ${snapshotId}`
  if (rows.length === 0) throw new HttpError(404, 'not_found', '快照不存在')
  const row = rows[0] as SnapshotRef & { sessionId: string | null }
  if (row.sessionId !== session.id && !row.projectIsPreset) {
    throw new HttpError(404, 'not_found', '快照不存在')
  }
  return { snapshotId: row.snapshotId, projectId: row.projectId, projectIsPreset: row.projectIsPreset }
}

export interface ScanRef {
  scanId: string
  snapshotId: string
  projectId: string
  projectIsPreset: boolean
}

export async function requireReadableScan(
  sql: postgres.Sql,
  session: SessionInfo,
  scanId: string,
): Promise<ScanRef> {
  assertUuid(scanId, '扫描')
  const rows = await sql`select sc.id as "scanId", s.id as "snapshotId", p.id as "projectId", p.session_id as "sessionId", p.is_preset as "projectIsPreset"
    from scans sc
    join snapshots s on s.id = sc.snapshot_id
    join projects p on p.id = s.project_id
    where sc.id = ${scanId}`
  if (rows.length === 0) throw new HttpError(404, 'not_found', '扫描不存在')
  const row = rows[0] as ScanRef & { sessionId: string | null }
  if (row.sessionId !== session.id && !row.projectIsPreset) {
    throw new HttpError(404, 'not_found', '扫描不存在')
  }
  return { scanId: row.scanId, snapshotId: row.snapshotId, projectId: row.projectId, projectIsPreset: row.projectIsPreset }
}

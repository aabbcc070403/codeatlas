import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import type { PreparedSnapshot } from '@/core/import'
import type { RedactedRange } from '@/server/db/schema'
import { asPgJson } from '@/server/db/json'
import { writeSnapshotFile } from './storage'

export interface SnapshotSummary {
  id: string
  contentHash: string
  fileCount: number
  skippedCount: number
  createdAt: string
}

/** 将准备好的快照落库并写入受控存储（先写存储，后事务写 DB，失败清理） */
export async function persistSnapshot(
  sql: postgres.Sql,
  projectId: string,
  prepared: PreparedSnapshot,
): Promise<SnapshotSummary> {
  const snapshotId = randomUUID()
  const rows: Array<{
    id: string
    snapshot_id: string
    path: string
    content_hash: string
    storage_key: string
    language: string
    line_count: number
    parse_status: string
    redacted_ranges: RedactedRange[]
  }> = []

  for (const f of prepared.files) {
    await writeSnapshotFile(projectId, snapshotId, f.contentHash, f.content)
    rows.push({
      id: randomUUID(),
      snapshot_id: snapshotId,
      path: f.path,
      content_hash: f.contentHash,
      storage_key: f.contentHash,
      language: f.language,
      line_count: f.lineCount,
      parse_status: f.parseStatus,
      redacted_ranges: f.redactedRanges,
    })
  }

  try {
    await sql.begin(async (tx) => {
      await tx`insert into snapshots (id, project_id, content_hash, status, file_count, skipped_count, structure_json, skipped_json)
        values (${snapshotId}, ${projectId}, ${prepared.snapshotContentHash}, 'ready', ${prepared.files.length}, ${prepared.skipped.length},
          ${sql.json(asPgJson(prepared.structure))}, ${sql.json(asPgJson(prepared.skipped))})`
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const params: unknown[] = []
        const tuples = chunk.map((r) => {
          params.push(
            r.id,
            r.snapshot_id,
            r.path,
            r.content_hash,
            r.storage_key,
            r.language,
            r.line_count,
            r.parse_status,
            sql.json(asPgJson(r.redacted_ranges)),
          )
          const base = params.length - 9
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`
        })
        await tx.unsafe(
          `insert into files (id, snapshot_id, path, content_hash, storage_key, language, line_count, parse_status, redacted_ranges) values ${tuples.join(',')}`,
          params as never[],
        )
      }
    })
  } catch (err) {
    // 本次快照的存储残留清理（尽力而为）
    const { deleteSnapshotStorage } = await import('./storage')
    void deleteSnapshotStorage(projectId, snapshotId).catch(() => {})
    throw err
  }

  return {
    id: snapshotId,
    contentHash: prepared.snapshotContentHash,
    fileCount: prepared.files.length,
    skippedCount: prepared.skipped.length,
    createdAt: new Date().toISOString(),
  }
}

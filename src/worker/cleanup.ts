import postgres from 'postgres'
import { deleteProjectStorage } from '@/server/storage'

/**
 * 项目删除清理服务（R03）：
 * - DELETE API 与 TTL 过期共用同一路径；
 * - deleting_at 标记后先请求取消活动任务；活动租约退出或到期后才清理；
 * - 清理顺序：先删存储（可重试），再删 DB 行（级联快照/扫描/结果）；
 *   避免留下"DB 已删但文件仍在"的永久状态（存储删除失败下轮重试）；
 * - 预置项目不受影响。
 */

/** 项目相关任务的匹配条件（嵌套 sql 片段，可直接嵌入 where） */
function projectJobsCondition(
  sql: postgres.Sql | postgres.TransactionSql,
  projectId: string,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`(
    (jobs.kind = 'scan' and jobs.target_id in (
      select sc.id from scans sc join snapshots sn on sn.id = sc.snapshot_id
      where sn.project_id = ${projectId}
    ))
    or (jobs.kind = 'document_index' and jobs.target_id in (
      select d.id from documents d where d.project_id = ${projectId}
    ))
  )`
}

/**
 * 标记项目删除：请求取消相关任务并写 deleting_at。
 * 返回是否存在活动租约（running 且租约有效）——是则调用方返回 202 等待清理服务。
 */
export async function markProjectDeleting(
  sql: postgres.Sql,
  projectId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`update jobs set cancel_requested_at = now(), updated_at = now()
      where state in ('queued', 'running')
        and ${projectJobsCondition(tx, projectId)}`
    await tx`update projects set deleting_at = now() where id = ${projectId}`
    const active = await tx`select 1 from jobs
      where state = 'running' and lease_until > now()
        and ${projectJobsCondition(tx, projectId)}
      limit 1`
    return active.length > 0
  })
}

/**
 * 清理所有 deleting 状态的项目：
 * - queued 任务直接终结（无租约，无人会再处理）；
 * - running 且租约有效 → 等待下轮；
 * - 先删存储（失败重试），成功后删 DB 行（级联）与相关任务行。
 * 返回本轮完成删除的项目数。
 */
export async function cleanupDeletingProjects(sql: postgres.Sql): Promise<number> {
  const projects = (await sql`select id from projects
    where deleting_at is not null and is_preset = false`) as unknown as Array<{ id: string }>
  let cleaned = 0
  for (const p of projects) {
    try {
      // queued 任务终结（项目删除中，无意义再执行）
      await sql`update jobs set state = 'cancelled', lease_until = null, updated_at = now()
        where state = 'queued' and ${projectJobsCondition(sql, p.id)}`
      // 仍有活动租约：等待退出或到期
      const active = await sql`select 1 from jobs
        where state = 'running' and lease_until > now()
          and ${projectJobsCondition(sql, p.id)}
        limit 1`
      if (active.length > 0) continue
      // 先删存储（可重试幂等；失败保留 deleting_at 下轮再来）
      await deleteProjectStorage(p.id)
      // 存储已清：删任务行与项目行（级联快照/扫描/结果/文档）
      await sql.begin(async (tx) => {
        await tx`delete from jobs where ${projectJobsCondition(tx, p.id)}`
        await tx`delete from projects where id = ${p.id}`
      })
      cleaned++
    } catch (err) {
      console.error(
        `[cleanup] 项目 ${p.id} 清理失败（下轮重试）:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return cleaned
}

/**
 * TTL 会话过期入口（复用删除服务）：
 * - 过期会话拥有的项目标记 deleting（预置项目 session_id 为空不受影响）；
 * - 项目删除完成后，无任何项目引用的过期会话行可安全删除
 *   （条件排除仍被 deleting 中项目引用的会话，避免 FK 级联绕过活动任务等待）。
 * 返回本轮标记的项目数。
 */
export async function expireStaleSessions(sql: postgres.Sql): Promise<number> {
  const stale = (await sql`update projects p set deleting_at = now()
    from sessions s
    where p.session_id = s.id and s.expires_at < now()
      and p.is_preset = false and p.deleting_at is null
    returning p.id`) as unknown as Array<{ id: string }>
  await sql`delete from sessions s
    where s.expires_at < now()
      and not exists (select 1 from projects p where p.session_id = s.id)`
  return stale.length
}

import fs from 'node:fs'
import path from 'node:path'
import { env } from '../env'

/**
 * 受控快照存储（规格 7）：所有文件访问通过 snapshotId + storageKey 定位，
 * 不接受客户端绝对路径。布局：
 *   STORAGE_ROOT/projects/<projectId>/snapshots/<snapshotId>/<contentHash>
 * storageKey 即内容哈希，同一快照内相同内容自动去重。
 */
export function projectStorageDir(projectId: string): string {
  return path.join(env.storageRoot, 'projects', projectId)
}

export function snapshotStorageDir(projectId: string, snapshotId: string): string {
  return path.join(projectStorageDir(projectId), 'snapshots', snapshotId)
}

export function snapshotFilePath(
  projectId: string,
  snapshotId: string,
  storageKey: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(storageKey)) {
    throw new Error('非法 storageKey')
  }
  return path.join(snapshotStorageDir(projectId, snapshotId), storageKey)
}

export async function writeSnapshotFile(
  projectId: string,
  snapshotId: string,
  storageKey: string,
  content: string,
): Promise<void> {
  const file = snapshotFilePath(projectId, snapshotId, storageKey)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, content, 'utf8')
}

export async function readSnapshotFile(
  projectId: string,
  snapshotId: string,
  storageKey: string,
): Promise<string> {
  const file = snapshotFilePath(projectId, snapshotId, storageKey)
  return fs.promises.readFile(file, 'utf8')
}

/** 删除项目全部存储（DB 级联删除成功后调用，尽力而为） */
export async function deleteProjectStorage(projectId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(projectId)) return
  await fs.promises.rm(projectStorageDir(projectId), {
    recursive: true,
    force: true,
  })
}

/** 删除单个快照存储 */
export async function deleteSnapshotStorage(
  projectId: string,
  snapshotId: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(snapshotId)) return
  await fs.promises.rm(snapshotStorageDir(projectId, snapshotId), {
    recursive: true,
    force: true,
  })
}

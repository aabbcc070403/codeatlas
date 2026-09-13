import fs from 'node:fs'
import path from 'node:path'
import type { DatasetAnnotation, DatasetJson } from './fixtures'

/**
 * 从磁盘加载 fixtures 数据集（CLI / worker / API 校验共用）。
 * fixtures 目录来源：EVAL_FIXTURES_DIR 环境变量（测试与 e2e 注入）或项目根 fixtures/。
 */

export class DatasetNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetNotFoundError'
  }
}

export function resolveFixturesDir(): string {
  const override = process.env.EVAL_FIXTURES_DIR
  if (override && override.trim() !== '') return path.resolve(override)
  return path.join(process.cwd(), 'fixtures')
}

export interface LoadedDatasetProject {
  id: string
  kind: 'defect' | 'control'
  split: 'dev' | 'holdout'
  categoryKey: string
  title: string
  files: Array<{ path: string; content: string }>
  annotations: DatasetAnnotation[]
}

export interface LoadedDataset {
  dir: string
  info: DatasetJson
  projects: LoadedDatasetProject[]
}

interface ProjectManifestFile {
  id: string
  kind: 'defect' | 'control'
  split: 'dev' | 'holdout'
  categoryKey: string
  title: string
  files: string[]
  annotations: DatasetAnnotation[]
}

/** 轻量读取 dataset.json（不加载文件内容），供页面/API 展示数据集概况 */
export function readDatasetInfo(dir: string): DatasetJson | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'dataset.json'), 'utf8')
    return JSON.parse(raw) as DatasetJson
  } catch {
    return null
  }
}

/** 加载完整数据集（dataset.json + 每项目 manifest 与文件内容） */
export async function loadDataset(dir: string): Promise<LoadedDataset> {
  const info = readDatasetInfo(dir)
  if (!info) {
    throw new DatasetNotFoundError(
      `未找到评测数据集（${path.join(dir, 'dataset.json')}）。请先运行 pnpm fixtures:generate 生成 fixtures/。`,
    )
  }
  const projects: LoadedDatasetProject[] = []
  for (const summary of info.projects) {
    const projectDir = path.join(dir, 'projects', summary.id)
    let manifestRaw: string
    try {
      manifestRaw = fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8')
    } catch {
      throw new DatasetNotFoundError(
        `数据集不完整：缺少 ${summary.id}/manifest.json，请重新运行 pnpm fixtures:generate`,
      )
    }
    const manifest = JSON.parse(manifestRaw) as ProjectManifestFile
    const files = manifest.files.map((p) => ({
      path: p,
      content: fs.readFileSync(path.join(projectDir, ...p.split('/')), 'utf8'),
    }))
    projects.push({
      id: manifest.id,
      kind: manifest.kind,
      split: manifest.split,
      categoryKey: manifest.categoryKey,
      title: manifest.title,
      files,
      annotations: manifest.annotations,
    })
  }
  return { dir, info, projects }
}

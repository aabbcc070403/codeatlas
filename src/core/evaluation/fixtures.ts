import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Category } from '@/core/contracts/findings'
import { SCAN_RULE_VERSION } from '@/core/contracts/scan'
import { runStaticRules, type StaticFileInput } from '@/core/rules'
import {
  FIXTURE_PROJECTS,
  FIXTURE_CATEGORY_LABELS,
  type FixtureCategoryKey,
  type FixtureProjectDef,
} from './fixtures-defs'
import { assertSafeRelPath } from './dataset'

/**
 * 数据集构建与生成（规格 13 / R08）：
 * - 内容哈希版本化：datasetVersion = v<revision>-<hash8>；内容不变 → 幂等输出；
 *   内容变化 → revision 递增（读取磁盘上已有的 dataset.json）。
 * - 生成时强校验：每个标注与静态规则输出双向对应（文件 + 类别 + 行段相交）；
 *   控制项目必须零发现。校验失败即中止生成，保证 manifest 行段与文件真实对应。
 * - 开发/保留集按项目 16/8 划分（确定性谓词），同一项目的文件绝不跨集。
 */

export interface DatasetAnnotation {
  ruleId: string
  category: Category
  file: string
  startLine: number
  endLine: number
  symbol?: string
  condition: string
}

export interface DatasetProjectManifest {
  id: string
  kind: 'defect' | 'control'
  split: 'dev' | 'holdout'
  categoryKey: FixtureCategoryKey
  title: string
  files: string[]
  annotations: DatasetAnnotation[]
}

export interface DatasetJson {
  version: string
  revision: number
  contentHash: string
  ruleVersion: string
  categories: Array<{ key: FixtureCategoryKey; label: string }>
  split: { dev: string[]; holdout: string[] }
  projectCount: number
  defectCount: number
  controlCount: number
  projects: Array<{
    id: string
    kind: 'defect' | 'control'
    split: 'dev' | 'holdout'
    categoryKey: FixtureCategoryKey
    title: string
    files: string[]
    annotationCount: number
  }>
}

export interface DatasetProjectBuild {
  id: string
  kind: 'defect' | 'control'
  split: 'dev' | 'holdout'
  categoryKey: FixtureCategoryKey
  title: string
  files: Array<{ path: string; content: string }>
  manifest: DatasetProjectManifest
}

export interface DatasetBuild {
  version: string
  revision: number
  contentHash: string
  dataset: DatasetJson
  projects: DatasetProjectBuild[]
}

/**
 * 开发/保留集划分（确定性，按项目整体划分，禁止文件跨集）：
 * 每类场景 01 → dev；场景 02 中仅 dynamic-exec / html-injection → dev，
 * 其余场景 02 → holdout。结果：dev 16 项目（8 缺陷 + 8 对照）、holdout 8（4 + 4）。
 */
export function splitOf(project: Pick<FixtureProjectDef, 'id' | 'categoryKey'>): 'dev' | 'holdout' {
  const scenario = project.id.endsWith('-02') ? '02' : '01'
  if (scenario === '01') return 'dev'
  return project.categoryKey === 'dynamic-exec' || project.categoryKey === 'html-injection'
    ? 'dev'
    : 'holdout'
}

function canonicalProjectJson(p: FixtureProjectDef): string {
  return JSON.stringify({
    id: p.id,
    kind: p.kind,
    categoryKey: p.categoryKey,
    title: p.title,
    files: p.files
      .map((f) => ({ path: f.path, content: f.content }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    annotations: [...p.annotations].sort((a, b) =>
      `${a.file}:${a.anchor}`.localeCompare(`${b.file}:${b.anchor}`),
    ),
  })
}

export function computeContentHash(defs: FixtureProjectDef[]): string {
  const canonical = defs
    .map(canonicalProjectJson)
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** 版本号：内容哈希与上一版一致 → revision 不变（幂等）；变化 → revision+1 */
export function computeDatasetVersion(
  contentHash: string,
  previous?: { version: string; revision: number; contentHash: string } | null,
): { version: string; revision: number } {
  if (previous && previous.contentHash === contentHash) {
    return { version: previous.version, revision: previous.revision }
  }
  const revision = previous ? previous.revision + 1 : 1
  return { version: `v${revision}-${contentHash.slice(0, 8)}`, revision }
}

function locateAnchor(content: string, anchor: string, file: string, projectId: string): number {
  const lines = content.split('\n')
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(anchor)) hits.push(i + 1)
  }
  if (hits.length !== 1) {
    throw new Error(
      `标注锚点不唯一或未找到（项目 ${projectId}，文件 ${file}，锚点 ${JSON.stringify(anchor)}，命中 ${hits.length} 处）`,
    )
  }
  return hits[0]!
}

function toStaticInputs(
  files: Array<{ path: string; content: string }>,
): StaticFileInput[] {
  return files.map((f) => ({
    path: f.path,
    content: f.content,
    language: languageOf(f.path),
    parseOk: true,
    redactedRanges: [],
  }))
}

function languageOf(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'ts') return 'ts'
  if (ext === 'tsx') return 'tsx'
  if (ext === 'jsx') return 'jsx'
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js'
  if (ext === 'vue') return 'vue'
  return 'json'
}

/**
 * 构建并校验数据集（纯函数，可单测）：
 * 校验规则：①标注锚点唯一命中；②每个标注与静态规则输出相交对应；
 * ③缺陷项目的全部静态发现都被标注覆盖（避免样例自身引入未标注 FP）；
 * ④控制项目零发现；⑤划分 16/8。
 */
export function buildDataset(defs: FixtureProjectDef[]): DatasetBuild {
  const contentHash = computeContentHash(defs)
  const { version, revision } = computeDatasetVersion(contentHash)

  const projects: DatasetProjectBuild[] = []
  for (const def of defs) {
    const split = splitOf(def)
    const annotations: DatasetAnnotation[] = def.annotations.map((a) => {
      const file = def.files.find((f) => f.path === a.file)
      if (!file) {
        throw new Error(`标注指向不存在的文件（项目 ${def.id}，文件 ${a.file}）`)
      }
      const line = locateAnchor(file.content, a.anchor, a.file, def.id)
      return {
        ruleId: a.ruleId,
        category: a.category,
        file: a.file,
        startLine: line,
        endLine: line,
        symbol: a.symbol,
        condition: a.condition,
      }
    })

    const result = runStaticRules(toStaticInputs(def.files))
    const findings = result.findings

    // ① 每个标注必须有同文件、同类别、行段相交的静态发现（缺陷项目）
    if (def.kind === 'defect') {
      for (const a of annotations) {
        const hit = findings.some(
          (f) =>
            f.primary.path === a.file &&
            f.category === a.category &&
            f.primary.startLine <= a.endLine &&
            a.startLine <= f.primary.endLine,
        )
        if (!hit) {
          throw new Error(
            `标注无对应静态发现（项目 ${def.id}，${a.file}:${a.startLine}，规则 ${a.ruleId}）；` +
              `实际发现：${findings
                .map((f) => `${f.ruleId}@${f.primary.path}:${f.primary.startLine}-${f.primary.endLine}`)
                .join(', ') || '（无）'}`,
          )
        }
      }
      // ② 每个静态发现必须被至少一个标注覆盖
      for (const f of findings) {
        const covered = annotations.some(
          (a) =>
            f.primary.path === a.file &&
            f.category === a.category &&
            f.primary.startLine <= a.endLine &&
            a.startLine <= f.primary.endLine,
        )
        if (!covered) {
          throw new Error(
            `静态发现未被标注覆盖（项目 ${def.id}，规则 ${f.ruleId}，` +
              `${f.primary.path}:${f.primary.startLine}-${f.primary.endLine}）——请补充标注`,
          )
        }
      }
    } else if (findings.length > 0) {
      throw new Error(
        `对照项目必须零静态发现（项目 ${def.id}）：` +
          findings
            .map((f) => `${f.ruleId}@${f.primary.path}:${f.primary.startLine}-${f.primary.endLine}`)
            .join(', '),
      )
    }

    projects.push({
      id: def.id,
      kind: def.kind,
      split,
      categoryKey: def.categoryKey,
      title: def.title,
      files: def.files.map((f) => ({ path: f.path, content: f.content })),
      manifest: {
        id: def.id,
        kind: def.kind,
        split,
        categoryKey: def.categoryKey,
        title: def.title,
        files: def.files.map((f) => f.path),
        annotations,
      },
    })
  }

  const dev = projects.filter((p) => p.split === 'dev')
  const holdout = projects.filter((p) => p.split === 'holdout')
  if (dev.length !== 16 || holdout.length !== 8) {
    throw new Error(`划分必须为 16/8，实际 dev=${dev.length} holdout=${holdout.length}`)
  }
  const defectCount = projects.filter((p) => p.kind === 'defect').length
  const controlCount = projects.length - defectCount
  if (projects.length !== 24 || defectCount !== 12 || controlCount !== 12) {
    throw new Error(`项目必须为 24（12 缺陷 + 12 对照），实际 ${projects.length}（${defectCount}+${controlCount}）`)
  }

  const dataset: DatasetJson = {
    version,
    revision,
    contentHash,
    ruleVersion: SCAN_RULE_VERSION,
    categories: (Object.keys(FIXTURE_CATEGORY_LABELS) as FixtureCategoryKey[]).map((key) => ({
      key,
      label: FIXTURE_CATEGORY_LABELS[key],
    })),
    split: { dev: dev.map((p) => p.id), holdout: holdout.map((p) => p.id) },
    projectCount: projects.length,
    defectCount,
    controlCount,
    projects: projects.map((p) => ({
      id: p.id,
      kind: p.kind,
      split: p.split,
      categoryKey: p.categoryKey,
      title: p.title,
      files: p.manifest.files,
      annotationCount: p.manifest.annotations.length,
    })),
  }

  return { version, revision, contentHash, dataset, projects }
}

/** 读取磁盘上已有的 dataset.json（不存在返回 null） */
export function readPreviousDataset(dir: string): {
  version: string
  revision: number
  contentHash: string
} | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'dataset.json'), 'utf8')
    const parsed = JSON.parse(raw) as DatasetJson
    if (!parsed.version || !parsed.revision || !parsed.contentHash) return null
    return { version: parsed.version, revision: parsed.revision, contentHash: parsed.contentHash }
  } catch {
    return null
  }
}

/** 生成 fixtures/ 目录：dataset.json + 每项目 manifest.json + files.json 内容数据块。
 * 样例以数据块（相对路径 → 内容）存放而非展开为源码树：样例是被测功能的
 * **输入数据**（含故意植入的缺陷形态），且数据块不会被当作项目源码扫描/执行。
 * 内容不变时输出字节级幂等。 */
export function generateDataset(dir: string, defs: FixtureProjectDef[] = FIXTURE_PROJECTS): DatasetJson {
  const previous = readPreviousDataset(dir)
  const contentHash = computeContentHash(defs)
  const { version, revision } = computeDatasetVersion(contentHash, previous)
  const build = buildDataset(defs)

  fs.mkdirSync(dir, { recursive: true })
  for (const project of build.projects) {
    assertSafeRelPath(project.id)
    const projectDir = path.join(dir, 'projects', project.id)
    fs.mkdirSync(projectDir, { recursive: true })
    const blobs: Record<string, string> = {}
    for (const file of project.files) {
      assertSafeRelPath(file.path)
      blobs[file.path] = file.content
    }
    fs.writeFileSync(
      path.join(projectDir, 'files.json'),
      JSON.stringify(blobs, null, 2) + '\n',
      'utf8',
    )
    fs.writeFileSync(
      path.join(projectDir, 'manifest.json'),
      JSON.stringify(project.manifest, null, 2) + '\n',
      'utf8',
    )
  }
  fs.writeFileSync(
    path.join(dir, 'dataset.json'),
    JSON.stringify({ ...build.dataset, version, revision }, null, 2) + '\n',
    'utf8',
  )
  return { ...build.dataset, version, revision }
}

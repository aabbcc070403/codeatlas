import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runStaticRules } from '../../src/core/rules'
import {
  buildDataset,
  computeContentHash,
  computeDatasetVersion,
  generateDataset,
  readPreviousDataset,
  splitOf,
} from '../../src/core/evaluation/fixtures'
import { FIXTURE_PROJECTS } from '../../src/core/evaluation/fixtures-defs'
import { assertSafeRelPath, DatasetNotFoundError, loadDataset } from '../../src/core/evaluation/dataset'

/**
 * fixtures 数据集单测（R08）：幂等、24 项目计数与 16/8 划分、
 * manifest 行段与文件真实对应（样例确实触发规则）、对照项目零命中、
 * datasetVersion 内容哈希版本化（内容变化 → revision 递增）。
 */

const tmpDirs: string[] = []

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fixtures-test-'))
  tmpDirs.push(dir)
  return dir
}

/** 递归收集目录内全部相对路径与字节（含 dataset.json / manifest.json / 源文件） */
function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const root = path.resolve(dir)
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.resolve(current, entry.name)
      // 纵深防御：枚举出的路径必须仍落在被测目录内（entry.name 来自 readdirSync，
      // 不可能含 ../，此处显式校验边界以防根目录被误传）
      if (full !== root && !full.startsWith(root + path.sep)) continue
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, relPath)
      else out.set(relPath, fs.readFileSync(full, 'utf8'))
    }
  }
  walk(root, '')
  return out
}

describe('数据集计数与划分', () => {
  const build = buildDataset(FIXTURE_PROJECTS)

  it('24 个项目 = 12 缺陷 + 12 对照，覆盖 6 类问题（每类 2 缺陷 + 2 对照）', () => {
    expect(build.projects.length).toBe(24)
    expect(build.projects.filter((p) => p.kind === 'defect').length).toBe(12)
    expect(build.projects.filter((p) => p.kind === 'control').length).toBe(12)
    const byCategory = new Map<string, { defect: number; control: number }>()
    for (const p of build.projects) {
      const c = byCategory.get(p.categoryKey) ?? { defect: 0, control: 0 }
      c[p.kind === 'defect' ? 'defect' : 'control']++
      byCategory.set(p.categoryKey, c)
    }
    expect(byCategory.size).toBe(6)
    for (const counts of byCategory.values()) {
      expect(counts.defect).toBeGreaterThanOrEqual(2)
      expect(counts.control).toBeGreaterThanOrEqual(2)
    }
  })

  it('开发/保留集按项目 16/8 划分（dev 8+8，holdout 4+4），无项目跨集', () => {
    expect(build.dataset.split.dev.length).toBe(16)
    expect(build.dataset.split.holdout.length).toBe(8)
    const devSet = new Set(build.dataset.split.dev)
    const holdoutSet = new Set(build.dataset.split.holdout)
    for (const id of holdoutSet) expect(devSet.has(id)).toBe(false)
    for (const p of build.projects) {
      const inSplit = p.split === 'dev' ? devSet.has(p.id) : holdoutSet.has(p.id)
      expect(inSplit).toBe(true)
      // 划分是按项目整体的：manifest 中全部文件都属于同一项目目录，不跨集
      expect(p.manifest.files.every((f) => f.startsWith('src/') || f === 'package.json' || f === 'README.md')).toBe(true)
    }
    const devDefect = build.projects.filter((p) => p.split === 'dev' && p.kind === 'defect').length
    const holdoutDefect = build.projects.filter((p) => p.split === 'holdout' && p.kind === 'defect').length
    expect(devDefect).toBe(8)
    expect(holdoutDefect).toBe(4)
  })

  it('splitOf 为确定性谓词（相同输入相同划分）', () => {
    expect(splitOf({ id: 'fx-dyn-01', categoryKey: 'dynamic-exec' })).toBe('dev')
    expect(splitOf({ id: 'fx-dyn-02', categoryKey: 'dynamic-exec' })).toBe('dev')
    expect(splitOf({ id: 'fx-html-02', categoryKey: 'html-injection' })).toBe('dev')
    expect(splitOf({ id: 'fx-msg-02', categoryKey: 'postmessage' })).toBe('holdout')
    expect(splitOf({ id: 'fx-jsx-02', categoryKey: 'jsx-key' })).toBe('holdout')
    expect(splitOf({ id: 'fx-hook-02', categoryKey: 'hook-conditional' })).toBe('holdout')
    expect(splitOf({ id: 'fx-chk-02', categoryKey: 'check-disabled' })).toBe('holdout')
  })

  it('正负样例非重复包装：每对缺陷/对照的主文件内容不同', () => {
    for (const defect of build.projects.filter((p) => p.kind === 'defect')) {
      const control = build.projects.find(
        (p) => p.kind === 'control' && p.categoryKey === defect.categoryKey && p.id.endsWith(defect.id.slice(-2)),
      )
      expect(control, `缺少 ${defect.id} 的对照项目`).toBeDefined()
      const defectMain = defect.files.find((f) => f.path.startsWith('src/'))!
      const controlMain = control!.files.find((f) => f.path.startsWith('src/'))!
      expect(defectMain.content).not.toBe(controlMain.content)
    }
  })

  it('datasetVersion 形如 v<revision>-<hash8>', () => {
    expect(build.version).toMatch(/^v\d+-[0-9a-f]{8}$/)
  })
})

describe('标注 ↔ 静态规则输出双向对应（manifest 行段与文件真实对应）', () => {
  it('每个标注与一条同文件、同类别、行段相交的静态发现对应；全部发现被标注覆盖', () => {
    for (const project of buildDataset(FIXTURE_PROJECTS).projects) {
      const result = runStaticRules(
        project.files.map((f) => ({
          path: f.path,
          content: f.content,
          language: f.path.endsWith('.tsx') ? 'tsx' : f.path.endsWith('.ts') ? 'ts' : 'json',
          parseOk: true,
          redactedRanges: [],
        })),
      )
      if (project.kind === 'control') {
        expect(result.findings, `对照项目 ${project.id} 必须零发现`).toHaveLength(0)
        expect(project.manifest.annotations).toHaveLength(0)
        continue
      }
      expect(project.manifest.annotations.length).toBeGreaterThan(0)
      for (const a of project.manifest.annotations) {
        const hit = result.findings.some(
          (f) =>
            f.primary.path === a.file &&
            f.category === a.category &&
            f.primary.startLine <= a.endLine &&
            a.startLine <= f.primary.endLine,
        )
        expect(hit, `项目 ${project.id} 标注 ${a.file}:${a.startLine}（${a.ruleId}）无对应发现`).toBe(true)
      }
      for (const f of result.findings) {
        const covered = project.manifest.annotations.some(
          (a) =>
            f.primary.path === a.file &&
            f.category === a.category &&
            f.primary.startLine <= a.endLine &&
            a.startLine <= f.primary.endLine,
        )
        expect(covered, `项目 ${project.id} 发现 ${f.ruleId}@${f.primary.path}:${f.primary.startLine} 未被标注`).toBe(true)
      }
    }
  })

  it('标注行段落在文件行数范围内且该行非空', () => {
    for (const project of buildDataset(FIXTURE_PROJECTS).projects) {
      for (const a of project.manifest.annotations) {
        const file = project.files.find((f) => f.path === a.file)!
        const lines = file.content.split('\n')
        expect(a.startLine).toBeGreaterThanOrEqual(1)
        expect(a.startLine).toBeLessThanOrEqual(lines.length)
        expect(lines[a.startLine - 1]!.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('生成器幂等与磁盘产物', () => {
  it('两次运行输出字节一致（dataset.json / manifest.json / 源文件）', () => {
    const dir = makeTempDir()
    generateDataset(dir)
    const first = snapshotDir(dir)
    generateDataset(dir)
    const second = snapshotDir(dir)
    expect(second.size).toBe(first.size)
    for (const [p, content] of first) {
      expect(second.get(p), `文件不一致：${p}`).toBe(content)
    }
    expect(first.size).toBeGreaterThanOrEqual(24)
  })

  it('磁盘产物包含 dataset.json 与每项目 manifest.json + files.json 内容数据块；manifest.split 与 dataset.split 一致', () => {
    const dir = makeTempDir()
    const dataset = generateDataset(dir)
    expect(fs.existsSync(path.join(dir, 'dataset.json'))).toBe(true)
    for (const summary of dataset.projects) {
      const manifestPath = path.join(dir, 'projects', summary.id, 'manifest.json')
      expect(fs.existsSync(manifestPath), `${manifestPath} 缺失`).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        id: string
        split: 'dev' | 'holdout'
        files: string[]
        annotations: unknown[]
      }
      expect(manifest.id).toBe(summary.id)
      expect(manifest.split).toBe(summary.split)
      const inSplitList = summary.split === 'dev' ? dataset.split.dev : dataset.split.holdout
      expect(inSplitList).toContain(summary.id)
      const blobs = JSON.parse(
        fs.readFileSync(path.join(dir, 'projects', summary.id, 'files.json'), 'utf8'),
      ) as Record<string, string>
      for (const file of manifest.files) {
        expect(typeof blobs[file], `${file} 缺失`).toBe('string')
      }
    }
  })

  it('磁盘样例确实触发标注规则（从磁盘内容重跑规则校验）', () => {
    const dir = makeTempDir()
    const dataset = generateDataset(dir)
    for (const summary of dataset.projects) {
      if (summary.kind !== 'defect') continue
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'projects', summary.id, 'manifest.json'), 'utf8'),
      ) as {
        files: string[]
        annotations: Array<{ file: string; category: string; startLine: number; endLine: number }>
      }
      const blobs = JSON.parse(
        fs.readFileSync(path.join(dir, 'projects', summary.id, 'files.json'), 'utf8'),
      ) as Record<string, string>
      const result = runStaticRules(
        manifest.files
          .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
          .map((f) => ({
            path: f,
            content: blobs[f]!,
            language: f.endsWith('.tsx') ? 'tsx' : 'ts',
            parseOk: true,
            redactedRanges: [],
          })),
      )
      for (const a of manifest.annotations) {
        const hit = result.findings.some(
          (f) =>
            f.primary.path === a.file &&
            f.category === a.category &&
            f.primary.startLine <= a.endLine &&
            a.startLine <= f.primary.endLine,
        )
        expect(hit, `磁盘样例 ${summary.id} 标注 ${a.file}:${a.startLine} 未触发规则`).toBe(true)
      }
    }
  })
})

describe('数据集路径防御（纵深安全）', () => {
  it('assertSafeRelPath 拒绝穿越 / 绝对路径 / 盘符 / 反斜杠 / 空段', () => {
    expect(() => assertSafeRelPath('src/a.ts')).not.toThrow()
    expect(() => assertSafeRelPath('package.json')).not.toThrow()
    expect(() => assertSafeRelPath('')).toThrow(DatasetNotFoundError)
    expect(() => assertSafeRelPath('../x')).toThrow(DatasetNotFoundError)
    expect(() => assertSafeRelPath('a/../../x')).toThrow(DatasetNotFoundError)
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(DatasetNotFoundError)
    expect(() => assertSafeRelPath('C:\\x')).toThrow(DatasetNotFoundError)
    expect(() => assertSafeRelPath('a\\b')).toThrow(DatasetNotFoundError)
    expect(() => assertSafeRelPath('a//b')).toThrow(DatasetNotFoundError)
  })

  it('loadDataset 拒绝 manifest 中的越界路径', async () => {
    const dir = makeTempDir()
    generateDataset(dir)
    const manifestPath = path.join(dir, 'projects', 'fx-dyn-01', 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] }
    manifest.files = ['../../../../etc/passwd']
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await expect(loadDataset(dir)).rejects.toThrow(DatasetNotFoundError)
  })
})

describe('datasetVersion 内容哈希版本化', () => {  it('内容哈希不变 → 版本与 revision 不变（幂等）', () => {
    const hash = computeContentHash(FIXTURE_PROJECTS)
    const previous = { version: 'v7-abcd1234', revision: 7, contentHash: hash }
    const next = computeDatasetVersion(hash, previous)
    expect(next.revision).toBe(7)
    expect(next.version).toBe('v7-abcd1234')
  })

  it('内容哈希变化 → revision 递增、版本变化', () => {
    const hash = computeContentHash(FIXTURE_PROJECTS)
    const previous = { version: `v7-${hash.slice(0, 8)}`, revision: 7, contentHash: hash }
    const changed = 'ffff' + hash.slice(4)
    expect(changed).not.toBe(hash)
    const next = computeDatasetVersion(changed, previous)
    expect(next.revision).toBe(8)
    expect(next.version).toBe(`v8-${changed.slice(0, 8)}`)
    expect(next.version).not.toBe(previous.version)
  })

  it('修改单个样例文件内容 → 内容哈希变化', () => {
    const mutated = FIXTURE_PROJECTS.map((p) =>
      p.id === 'fx-dyn-01'
        ? { ...p, files: p.files.map((f) => (f.path === 'README.md' ? { ...f, content: f.content + '\n更新说明\n' } : f)) }
        : p,
    )
    expect(computeContentHash(mutated)).not.toBe(computeContentHash(FIXTURE_PROJECTS))
  })

  it('首次生成 revision=1；已有更高版本时变化内容在其上递增', () => {
    const dir = makeTempDir()
    const first = generateDataset(dir)
    expect(first.revision).toBe(1)
    const previous = readPreviousDataset(dir)
    expect(previous).toEqual({
      version: first.version,
      revision: 1,
      contentHash: first.contentHash,
    })
    const changed = computeDatasetVersion('deadbeef' + first.contentHash.slice(8), previous)
    expect(changed.revision).toBe(2)
  })
})

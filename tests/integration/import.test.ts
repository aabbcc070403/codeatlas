import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createTestDb, type TestDb } from '../helpers/db'
import { buildDeflateZip } from '../helpers/zip'
import { prepareSnapshot } from '../../src/core/import'
import { persistSnapshot } from '../../src/server/snapshots'

let db: TestDb
let storageRoot: string

beforeAll(async () => {
  db = await createTestDb()
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-storage-'))
  process.env.DATABASE_URL = db.url
  process.env.STORAGE_ROOT = storageRoot
  // 重新加载 env 模块以读取测试 STORAGE_ROOT
  const { env } = await import('../../src/server/env')
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })
})

afterAll(async () => {
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

const SAMPLE = {
  'package.json': JSON.stringify(
    { name: 'demo', dependencies: { react: '^19.0.0', lodash: '^4.0.0' } },
    null,
    2,
  ),
  'package-lock.json': '{ "lockfileVersion": 3 }',
  'src/App.tsx': [
    "import { format } from './utils/format'",
    "import { helper } from '@/lib/helper'",
    "import React from 'react'",
    'export function App(props) {',
    '  const html = props.userInput',
    '  return <div dangerouslySetInnerHTML={{ __html: html }} />',
    '}',
    'const API_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz123456"',
    'export default App',
  ].join('\n'),
  'src/utils/format.js': 'export function format(s) {\r\n  return s\r\n}\r\n',
  'README.md': '# Demo\n\n示例项目\n',
  '.env': 'SECRET_KEY=supersecret',
  'node_modules/react/index.js': 'module.exports = {}',
  'dist/bundle.js': 'console.log("built")',
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
}

describe('T03 ZIP 导入与快照', () => {
  it('完整导入：文件收录、忽略、脱敏、结构统计', async () => {
    const zip = await buildDeflateZip(
      Object.entries(SAMPLE).map(([name, content]) => ({ name, content: content as never })),
    )
    const prepared = await prepareSnapshot(zip)

    const paths = prepared.files.map((f) => f.path)
    expect(paths).toContain('package.json')
    expect(paths).toContain('src/App.tsx')
    expect(paths).toContain('src/utils/format.js')
    expect(paths).toContain('README.md')
    expect(paths).toContain('package-lock.json')
    // 忽略与拒绝
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('node_modules/react/index.js')
    expect(paths).not.toContain('dist/bundle.js')
    expect(paths).not.toContain('assets/logo.png')
    const reasons = Object.fromEntries(prepared.skipped.map((s) => [s.path, s.reason]))
    expect(reasons['.env']).toContain('敏感文件')
    expect(reasons['node_modules/react/index.js']).toContain('忽略目录')
    expect(reasons['dist/bundle.js']).toContain('忽略目录')
    expect(reasons['assets/logo.png']).toContain('文件类型')

    // CRLF → LF
    const formatFile = prepared.files.find((f) => f.path === 'src/utils/format.js')!
    expect(formatFile.content).not.toContain('\r')
    expect(formatFile.lineCount).toBe(3)

    // 脱敏：GitHub token 遮盖且等长
    const app = prepared.files.find((f) => f.path === 'src/App.tsx')!
    expect(app.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456')
    const originalLine = (SAMPLE['src/App.tsx'] as string).split('\n')[7]!
    const maskedLine = app.content.split('\n')[7]!
    expect(maskedLine.length).toBe(originalLine.length)
    expect(app.redactedRanges.some((r) => r.line === 8)).toBe(true)

    // 结构统计
    expect(prepared.structure.languageCounts).toEqual({
      json: 2, tsx: 1, js: 1, md: 1,
    })
    expect(prepared.structure.lockFiles).toEqual(['package-lock.json'])
    const depFile = prepared.structure.dependencyFiles.find((d) => d.path === 'package.json')!
    expect(depFile.declared).toContain('react')
    // 相对导入解析成功；别名导入标记未解析；裸模块 react 已声明
    const edges = prepared.structure.importEdges
    expect(edges).toContainEqual({
      from: 'src/App.tsx',
      to: 'src/utils/format.js',
      resolved: true,
    })
    expect(
      prepared.structure.unresolvedImports.some(
        (u) => u.from === 'src/App.tsx' && u.specifier === '@/lib/helper',
      ),
    ).toBe(true)

    // 落库
    const project = await db.sql`insert into projects (name) values ('导入测试') returning id`
    const projectId = (project[0] as { id: string }).id
    const summary = await persistSnapshot(db.sql, projectId, prepared)
    expect(summary.fileCount).toBe(prepared.files.length)

    const fileRows = await db.sql`select path, content_hash, storage_key, parse_status, redacted_ranges
      from files where snapshot_id = ${summary.id} order by path`
    expect(fileRows.length).toBe(prepared.files.length)
    const appRow = fileRows.find((r) => r.path === 'src/App.tsx') as unknown as {
      redacted_ranges: unknown
    }
    const { asJsonArray } = await import('../../src/server/db/json')
    expect(asJsonArray<{ line: number }>(appRow.redacted_ranges).some((r) => r.line === 8)).toBe(true)

    // 存储中的内容已脱敏
    const { readSnapshotFile } = await import('../../src/server/storage')
    const stored = await readSnapshotFile(
      projectId,
      summary.id,
      (fileRows.find((r) => r.path === 'src/App.tsx') as unknown as { storage_key: string })
        .storage_key,
    )
    expect(stored).not.toContain('ghp_')

    // 快照统计
    const snapRow = await db.sql`select file_count, skipped_count, structure_json from snapshots where id = ${summary.id}`
    expect((snapRow[0] as { file_count: number }).file_count).toBe(prepared.files.length)
    expect((snapRow[0] as { skipped_count: number }).skipped_count).toBe(prepared.skipped.length)

    // 相同内容 → 相同快照哈希（可复现）
    const prepared2 = await prepareSnapshot(zip)
    expect(prepared2.snapshotContentHash).toBe(prepared.snapshotContentHash)
  })

  it('解析失败文件记录独立状态', async () => {
    const zip = await buildDeflateZip([
      { name: 'bad.ts', content: 'const x = {{{{' },
      { name: 'ok.ts', content: 'const y = 1\n' },
    ])
    const prepared = await prepareSnapshot(zip)
    const bad = prepared.files.find((f) => f.path === 'bad.ts')!
    const ok = prepared.files.find((f) => f.path === 'ok.ts')!
    expect(bad.parseStatus).toBe('parse_error')
    expect(ok.parseStatus).toBe('ok')
  })

  it('Vue SFC 文件按文本收录', async () => {
    const zip = await buildDeflateZip([
      {
        name: 'src/Comp.vue',
        content: [
          '<template><div>{{ msg }}</div></template>',
          '<script setup>',
          'const msg = "hi"',
          '</script>',
        ].join('\n'),
      },
    ])
    const prepared = await prepareSnapshot(zip)
    const vue = prepared.files.find((f) => f.path === 'src/Comp.vue')!
    expect(vue.language).toBe('vue')
    expect(vue.parseStatus).toBe('ok')
  })

  it('内嵌 ZIP 不递归解析', async () => {
    const inner = await buildDeflateZip([{ name: 'inner/a.ts', content: 'const a = 1\n' }])
    const outer = await buildDeflateZip([{ name: 'nested.zip', content: inner }])
    const prepared = await prepareSnapshot(outer)
    expect(prepared.files.length).toBe(0)
    const reasons = Object.fromEntries(prepared.skipped.map((s) => [s.path, s.reason]))
    expect(reasons['nested.zip']).toContain('文件类型')
  })
})

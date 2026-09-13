import { createHash } from 'node:crypto'
import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import {
  readZip,
  ARCHIVE_LIMITS,
  type ArchiveResult,
  type SkippedItem,
} from './archive'
import { isSensitiveFilePath, redactSecrets } from './redact'
import type { RedactedRange, SkippedEntry, StructureStats } from '@/server/db/schema'

export { ARCHIVE_LIMITS }
export { ArchiveError } from './archive'

export const IMPORT_IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.cache',
  '.turbo',
])

const GENERATED_FILE_RE = /\.min\.(js|mjs|css)$|\.js\.map$|\.css\.map$/

const LOCK_FILE_RE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock)$/

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  vue: 'vue',
  json: 'json',
  md: 'md',
  markdown: 'md',
  css: 'css',
  html: 'html',
  htm: 'html',
}

const JS_FAMILY = new Set(['js', 'ts', 'tsx', 'jsx'])

export interface PreparedFile {
  path: string
  content: string
  contentHash: string
  language: string
  lineCount: number
  parseStatus: 'ok' | 'parse_error'
  redactedRanges: RedactedRange[]
}

export interface PreparedSnapshot {
  files: PreparedFile[]
  skipped: SkippedEntry[]
  structure: StructureStats
  snapshotContentHash: string
}

function ext(path: string): string {
  const base = path.split('/').pop() ?? ''
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx + 1).toLowerCase()
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 快速语法检查（不加载项目配置，不执行任何代码） */
function quickSyntaxCheck(
  language: string,
  content: string,
): 'ok' | 'parse_error' {
  if (!JS_FAMILY.has(language) && language !== 'vue') return 'ok'
  try {
    if (language === 'vue') {
      const { descriptor, errors } = parseSfc(content, { filename: 'x.vue' })
      if (errors.length > 0) return 'parse_error'
      const script = descriptor.script ?? descriptor.scriptSetup
      if (!script) return 'ok'
      const result = ts.transpileModule(script.content, {
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          jsx: ts.JsxEmit.Preserve,
        },
      })
      return result.diagnostics && result.diagnostics.length > 0 ? 'parse_error' : 'ok'
    }
    const result = ts.transpileModule(content, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        ...(language === 'jsx' || language === 'tsx'
          ? { jsx: ts.JsxEmit.Preserve }
          : {}),
      },
    })
    return result.diagnostics && result.diagnostics.length > 0 ? 'parse_error' : 'ok'
  } catch {
    return 'parse_error'
  }
}

const IMPORT_SPECIFIER_RE =
  /(?:import\s+[^'";]*?from\s*|import\s*|export\s+[^'";]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"\n]+)['"]/g

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json']

function normalizePosix(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

function resolveRelative(fromPath: string, specifier: string, fileSet: Set<string>): string | null {
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const joined = normalizePosix(dir ? `${dir}/${specifier}` : specifier)
  const candidates = [joined]
  for (const e of RESOLVE_EXTENSIONS) candidates.push(joined + e)
  for (const e of RESOLVE_EXTENSIONS) candidates.push(`${joined}/index${e}`)
  for (const c of candidates) {
    if (fileSet.has(c)) return c
  }
  return null
}

function buildStructure(files: PreparedFile[]): StructureStats {
  const languageCounts: Record<string, number> = {}
  for (const f of files) {
    languageCounts[f.language] = (languageCounts[f.language] ?? 0) + 1
  }

  const dependencyFiles: StructureStats['dependencyFiles'] = []
  const lockFiles: string[] = []
  for (const f of files) {
    const base = f.path.split('/').pop() ?? ''
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(f.content) as Record<string, unknown>
        const deps = [
          ...Object.keys((pkg.dependencies as Record<string, string>) ?? {}),
          ...Object.keys((pkg.devDependencies as Record<string, string>) ?? {}),
        ]
        dependencyFiles.push({ path: f.path, declared: deps })
      } catch {
        dependencyFiles.push({ path: f.path, declared: [] })
      }
    }
    if (LOCK_FILE_RE.test(f.path)) lockFiles.push(f.path)
  }
  const declaredPackages = new Set(dependencyFiles.flatMap((d) => d.declared))

  const fileSet = new Set(files.map((f) => f.path))
  const importEdges: StructureStats['importEdges'] = []
  const unresolvedImports: StructureStats['unresolvedImports'] = []
  const seenEdges = new Set<string>()

  for (const f of files) {
    if (!JS_FAMILY.has(f.language) && f.language !== 'vue') continue
    const source = f.language === 'vue'
      ? (parseSfc(f.content, { filename: f.path }).descriptor.script?.content ??
         parseSfc(f.content, { filename: f.path }).descriptor.scriptSetup?.content ??
         '')
      : f.content
    let m: RegExpExecArray | null
    IMPORT_SPECIFIER_RE.lastIndex = 0
    while ((m = IMPORT_SPECIFIER_RE.exec(source)) !== null) {
      const specifier = m[1]!
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const resolved = resolveRelative(f.path, specifier, fileSet)
        const key = `${f.path}->${specifier}`
        if (!seenEdges.has(key)) {
          seenEdges.add(key)
          if (resolved) {
            importEdges.push({ from: f.path, to: resolved, resolved: true })
          } else {
            importEdges.push({ from: f.path, to: specifier, resolved: false })
            unresolvedImports.push({ from: f.path, specifier })
          }
        }
      } else if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('#')) {
        // 路径别名：不推断不存在的边，明确标记
        unresolvedImports.push({ from: f.path, specifier })
      } else if (!declaredPackages.has(specifier) && /^[a-z@]/i.test(specifier)) {
        // 未在依赖中声明的裸模块（可能是缺失依赖）
        unresolvedImports.push({ from: f.path, specifier })
      }
    }
  }

  return {
    languageCounts,
    dependencyFiles,
    lockFiles,
    importEdges: importEdges.slice(0, 5000),
    unresolvedImports: unresolvedImports.slice(0, 2000),
  }
}

/**
 * ZIP → 快照准备：忽略策略、UTF-8 解码、LF 标准化、等长脱敏、
 * 内容哈希、快速语法状态与结构统计。纯函数，不落库。
 */
export async function prepareSnapshot(
  buffer: Buffer,
  limits = ARCHIVE_LIMITS,
): Promise<PreparedSnapshot> {
  const archive: ArchiveResult = await readZip(buffer, limits)
  const skipped: SkippedItem[] = [...archive.skipped]
  const files: PreparedFile[] = []

  const decoder = new TextDecoder('utf-8', { fatal: true })

  for (const entry of archive.files) {
    const segments = entry.path.split('/')
    const ignoredSeg = segments.find((s) => IMPORT_IGNORED_SEGMENTS.has(s))
    if (ignoredSeg) {
      skipped.push({ path: entry.path, reason: `忽略目录 ${ignoredSeg}` })
      continue
    }
    if (GENERATED_FILE_RE.test(entry.path)) {
      skipped.push({ path: entry.path, reason: '生成文件（minified/sourcemap）' })
      continue
    }
    if (isSensitiveFilePath(entry.path)) {
      skipped.push({ path: entry.path, reason: '敏感文件（密钥/环境变量），已拒绝收录' })
      continue
    }
    const extension = ext(entry.path)
    const language = LANGUAGE_BY_EXT[extension]
    if (!language) {
      skipped.push({ path: entry.path, reason: `不支持的文件类型 .${extension || '(无扩展名)'}` })
      continue
    }
    if (entry.content.includes(0)) {
      skipped.push({ path: entry.path, reason: '二进制内容' })
      continue
    }
    let text: string
    try {
      text = decoder.decode(entry.content)
    } catch {
      skipped.push({ path: entry.path, reason: '无法按 UTF-8 解码' })
      continue
    }
    // BOM 与换行标准化
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    text = text.replace(/\r\n?/g, '\n')

    const redacted = redactSecrets(text)
    // 行数语义：换行符数 + 末尾不完整行（"a\nb" 为 2 行，"a\nb\n" 为 2 行）
    const lines = redacted.content.split('\n')
    const lineCount = redacted.content.endsWith('\n') ? lines.length - 1 : lines.length
    files.push({
      path: entry.path,
      content: redacted.content,
      contentHash: sha256(redacted.content),
      language,
      lineCount,
      parseStatus: quickSyntaxCheck(language, redacted.content),
      redactedRanges: redacted.ranges,
    })
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  skipped.sort((a, b) => (a.path < b.path ? -1 : 1))

  const structure = buildStructure(files)
  const snapshotContentHash = sha256(
    files.map((f) => `${f.path}:${f.contentHash}`).join('\n'),
  )

  return { files, skipped, structure, snapshotContentHash }
}

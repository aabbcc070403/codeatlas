import postgres from 'postgres'
import { retrieveGuidelines } from '@/core/knowledge/retrieval'
import type { StructureStats } from '@/server/db/schema'
import { asJson } from '@/server/db/json'
import { MAX_READ_LINES } from './tool-contracts'

/**
 * 工具执行器：绑定当前快照，所有路径经快照内校验；记录调用轨迹。
 * search_code 为字面量检索；read_file 限 200 行；结果受字符预算约束。
 */

export interface SnapshotFileIndex {
  path: string
  content: string
  lineCount: number
}

export interface ToolExecutionResult {
  ok: boolean
  output: unknown
  summary: string
}

export interface ToolCallRecord {
  sequence: number
  toolName: string
  inputSummary: string
  resultSummary: string
  elapsedMs: number
  status: 'ok' | 'error' | 'budget_exceeded'
}

const MAX_SEARCH_HITS = 20
const MAX_OUTPUT_CHARS = 20_000

export class SnapshotTools {
  private sequence = 0
  readonly readLineRanges = new Map<string, Array<[number, number]>>()
  readonly readFiles = new Set<string>()
  readonly records: ToolCallRecord[] = []
  /** 本轮 retrieve_guidelines 实际返回的规范块 id（证据校验白名单，R04） */
  readonly retrievedChunkIds = new Set<string>()

  constructor(
    private readonly sql: postgres.Sql,
    private readonly files: Map<string, SnapshotFileIndex>,
    private readonly structure: StructureStats | null,
    private readonly projectId: string | null,
  ) {}

  /** 模型实际读取的行段（证据校验用） */
  getReadLineRanges(): Record<string, Array<[number, number]>> {
    const out: Record<string, Array<[number, number]>> = {}
    for (const [path, ranges] of this.readLineRanges) {
      out[path] = ranges.map((r) => [r[0], r[1]])
    }
    return out
  }

  async execute(
    name: string,
    args: unknown,
    ctx: { budgetCheck: () => boolean },
  ): Promise<ToolExecutionResult> {
    const start = Date.now()
    this.sequence++
    const seq = this.sequence
    const inputSummary = summarizeArgs(name, args)

    if (!ctx.budgetCheck()) {
      this.records.push({
        sequence: seq,
        toolName: name,
        inputSummary,
        resultSummary: '预算已耗尽',
        elapsedMs: Date.now() - start,
        status: 'budget_exceeded',
      })
      return { ok: false, output: { error: 'budget_exceeded' }, summary: '预算已耗尽' }
    }

    let result: ToolExecutionResult
    try {
      switch (name) {
        case 'read_file':
          result = this.readFile(args as { path: string; startLine: number; endLine: number })
          break
        case 'search_code':
          result = this.searchCode(args as { query: string; limit?: number })
          break
        case 'list_imports':
          result = this.listImports(args as { path: string })
          break
        case 'retrieve_guidelines':
          result = await this.retrieveGuidelines(args as { query: string; topK?: number })
          break
        default:
          result = { ok: false, output: { error: 'unknown_tool' }, summary: '未知工具' }
      }
    } catch (err) {
      result = {
        ok: false,
        output: { error: err instanceof Error ? err.message : 'tool_error' },
        summary: '执行错误',
      }
    }
    this.records.push({
      sequence: seq,
      toolName: name,
      inputSummary,
      resultSummary: result.summary.slice(0, 200),
      elapsedMs: Date.now() - start,
      status: result.ok ? 'ok' : 'error',
    })
    return result
  }

  private readFile(args: { path: string; startLine: number; endLine: number }): ToolExecutionResult {
    const file = this.files.get(args.path)
    if (!file) {
      return { ok: false, output: { error: 'file_not_in_snapshot' }, summary: '文件不在快照内' }
    }
    let start = Math.max(1, Math.floor(args.startLine))
    let end = Math.floor(args.endLine)
    if (end < start) [start, end] = [end, start]
    if (end - start + 1 > MAX_READ_LINES) {
      end = start + MAX_READ_LINES - 1
    }
    end = Math.min(end, file.lineCount)
    if (start > file.lineCount) {
      return { ok: false, output: { error: 'start_beyond_eof' }, summary: '起始行超出文件末尾' }
    }
    const lines = file.content.split('\n').slice(start - 1, end)
    const content = lines.join('\n')
    this.readFiles.add(args.path)
    this.readLineRanges.set(args.path, [
      ...(this.readLineRanges.get(args.path) ?? []),
      [start, end],
    ])
    return {
      ok: true,
      output: { path: args.path, startLine: start, endLine: end, totalLines: file.lineCount, content },
      summary: `${args.path}:${start}-${end}（${lines.length} 行）`,
    }
  }

  private searchCode(args: { query: string; limit?: number }): ToolExecutionResult {
    const query = args.query.slice(0, 200)
    const limit = Math.min(MAX_SEARCH_HITS, Math.max(1, args.limit ?? 10))
    const hits: Array<{ path: string; line: number; text: string }> = []
    for (const file of this.files.values()) {
      if (hits.length >= limit) break
      const lines = file.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= limit) break
        if (lines[i]!.includes(query)) {
          hits.push({ path: file.path, line: i + 1, text: lines[i]!.slice(0, 200) })
          this.readFiles.add(file.path)
          this.readLineRanges.set(file.path, [
            ...(this.readLineRanges.get(file.path) ?? []),
            [i + 1, i + 1],
          ])
        }
      }
    }
    return {
      ok: true,
      output: { hits, total: hits.length, truncated: hits.length >= limit },
      summary: `命中 ${hits.length} 处「${query.slice(0, 40)}」`,
    }
  }

  private listImports(args: { path: string }): ToolExecutionResult {
    if (!this.files.has(args.path)) {
      return { ok: false, output: { error: 'file_not_in_snapshot' }, summary: '文件不在快照内' }
    }
    const edges = (this.structure?.importEdges ?? []).filter((e) => e.from === args.path)
    const unresolved = (this.structure?.unresolvedImports ?? []).filter((e) => e.from === args.path)
    return {
      ok: true,
      output: {
        imports: [
          ...edges.map((e) => ({ specifier: e.to, resolved: e.resolved ? e.to : null })),
          ...unresolved.map((e) => ({ specifier: e.specifier, resolved: null })),
        ],
      },
      summary: `${edges.length + unresolved.length} 条导入`,
    }
  }

  private async retrieveGuidelines(args: {
    query: string
    topK?: number
  }): Promise<ToolExecutionResult> {
    const result = await retrieveGuidelines(this.sql, {
      query: args.query.slice(0, 200),
      projectId: this.projectId,
      topK: args.topK ?? 5,
    })
    // 记录本轮实际返回的 chunkId：guidelineChunkIds 只能引用这些（R04 白名单）
    for (const c of result.chunks) {
      this.retrievedChunkIds.add(c.chunkId)
    }
    return {
      ok: true,
      output: {
        mode: result.mode,
        note: result.note,
        chunks: result.chunks.map((c) => ({
          chunkId: c.chunkId,
          title: c.title,
          heading: c.heading,
          text: c.text.slice(0, MAX_OUTPUT_CHARS),
          sourceUrl: c.sourceUrl,
          version: c.version,
        })),
      },
      summary: `${result.chunks.length} 条规范（${result.mode}）`,
    }
  }
}

function summarizeArgs(name: string, args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? ''
    return `${name} ${s.slice(0, 120)}`
  } catch {
    return `${name} <无法序列化>`
  }
}

/** 从快照行加载文件索引（worker/AI 阶段用） */
export async function loadSnapshotFileIndex(
  sql: postgres.Sql,
  snapshotId: string,
  readContent: (storageKey: string) => Promise<string>,
): Promise<{ files: Map<string, SnapshotFileIndex>; structure: StructureStats | null }> {
  const rows = (await sql`select path, storage_key, line_count, language from files
    where snapshot_id = ${snapshotId} order by path`) as unknown as Array<{
    path: string
    storage_key: string
    line_count: number
    language: string
  }>
  const files = new Map<string, SnapshotFileIndex>()
  for (const row of rows) {
    const content = await readContent(row.storage_key)
    files.set(row.path, { path: row.path, content, lineCount: row.line_count })
  }
  const structureRow = (await sql`select structure_json from snapshots where id = ${snapshotId}`)[0] as
    | { structure_json: unknown }
    | undefined
  return {
    files,
    structure: structureRow ? asJson<StructureStats | null>(structureRow.structure_json) : null,
  }
}

import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_BUDGET,
  MAX_QUESTION_LENGTH,
  type AnswerInput,
} from '../../src/core/contracts/conversation'
import { sanitizeQuestion, validateAnswerDraft } from '../../src/core/review/conversation'
import type { SnapshotFileIndex } from '../../src/core/review/tools'

/**
 * R05 追问：问题清洗与回答证据校验（纯函数，与 R04 validateCodeRef 同一逻辑）。
 * 覆盖：伪造未读取文件、未检索 chunk、越界行号、引文不匹配、部分读取。
 */

const CONTENT_100 = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
const CONTENT_A = ['function a() {', '  return 1', '}'].join('\n')

function makeFiles(entries: Array<{ path: string; content: string }>): Map<string, SnapshotFileIndex> {
  const files = new Map<string, SnapshotFileIndex>()
  for (const e of entries) {
    files.set(e.path, { path: e.path, content: e.content, lineCount: e.content.split('\n').length })
  }
  return files
}

function baseAnswer(overrides: Partial<AnswerInput> = {}): AnswerInput {
  return {
    answer: '回答',
    citations: [],
    guidelineChunkIds: [],
    ...overrides,
  }
}

describe('R05 问题清洗', () => {
  it('空白（含纯空白字符）拒绝', () => {
    expect(sanitizeQuestion('')).toEqual({ ok: false, reason: 'blank' })
    expect(sanitizeQuestion('   \n\t  ')).toEqual({ ok: false, reason: 'blank' })
  })

  it(`超过 ${MAX_QUESTION_LENGTH} 字拒绝，恰好 ${MAX_QUESTION_LENGTH} 字通过并 trim`, () => {
    expect(sanitizeQuestion('x'.repeat(MAX_QUESTION_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    })
    const ok = sanitizeQuestion(`  ${'问'.repeat(MAX_QUESTION_LENGTH)}  `)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value).toBe('问'.repeat(MAX_QUESTION_LENGTH))
  })
})

describe('R05 追问轮预算', () => {
  it('规格 9.5：每轮至多 4 次模型请求、8 次工具调用、60 秒', () => {
    expect(CONVERSATION_BUDGET.maxModelCalls).toBe(4)
    expect(CONVERSATION_BUDGET.maxToolCalls).toBe(8)
    expect(CONVERSATION_BUDGET.wallMs).toBe(60_000)
  })
})

describe('R05 回答证据校验（与 R04 同一逻辑）', () => {
  const files = makeFiles([
    { path: 'src/a.js', content: CONTENT_A },
    { path: 'src/big.js', content: CONTENT_100 },
  ])

  it('完整读取的引用通过；规范块白名单内的 id 保留', () => {
    const result = validateAnswerDraft(
      baseAnswer({
        citations: [{ path: 'src/a.js', startLine: 1, endLine: 3, quote: CONTENT_A }],
        guidelineChunkIds: ['chunk-1'],
      }),
      {
        files,
        readLineRanges: new Map([['src/a.js', [[1, 3]]]]),
        accessibleChunkIds: new Set(['chunk-1', 'chunk-2']),
      },
    )
    expect(result.citations).toHaveLength(1)
    expect(result.guidelineChunkIds).toEqual(['chunk-1'])
    expect(result.invalidCitationCount).toBe(0)
    expect(result.droppedChunkIdCount).toBe(0)
  })

  it('引用未读取的文件 → 拒绝（模型没有读取的代码不可作为引用）', () => {
    const result = validateAnswerDraft(
      baseAnswer({
        citations: [{ path: 'src/never-read.js', startLine: 1, endLine: 2, quote: 'whatever' }],
      }),
      { files, readLineRanges: new Map(), accessibleChunkIds: new Set() },
    )
    expect(result.citations).toHaveLength(0)
    expect(result.invalidCitationCount).toBe(1)
  })

  it('只读了部分范围不能引用整体（读 10-12 引 1-100）', () => {
    const result = validateAnswerDraft(
      baseAnswer({
        citations: [
          { path: 'src/big.js', startLine: 1, endLine: 100, quote: CONTENT_100 },
        ],
      }),
      {
        files,
        readLineRanges: new Map([['src/big.js', [[10, 12]]]]),
        accessibleChunkIds: new Set(),
      },
    )
    expect(result.citations).toHaveLength(0)
    expect(result.invalidCitationCount).toBe(1)
  })

  it('越界行号拒绝', () => {
    const result = validateAnswerDraft(
      baseAnswer({
        citations: [{ path: 'src/a.js', startLine: 2, endLine: 99, quote: 'x' }],
      }),
      {
        files,
        readLineRanges: new Map([['src/a.js', [[1, 99]]]]),
        accessibleChunkIds: new Set(),
      },
    )
    expect(result.citations).toHaveLength(0)
    expect(result.invalidCitationCount).toBe(1)
  })

  it('引文与快照行不匹配拒绝（严格逐字符）', () => {
    const result = validateAnswerDraft(
      baseAnswer({
        citations: [{ path: 'src/a.js', startLine: 1, endLine: 3, quote: '  ' + CONTENT_A + '  ' }],
      }),
      {
        files,
        readLineRanges: new Map([['src/a.js', [[1, 3]]]]),
        accessibleChunkIds: new Set(),
      },
    )
    expect(result.citations).toHaveLength(0)
    expect(result.invalidCitationCount).toBe(1)
  })

  it('未检索返回的规范 chunk 拒绝（可访问但不在本轮返回同样不行）；重复 id 去重', () => {
    const result = validateAnswerDraft(
      baseAnswer({ guidelineChunkIds: ['chunk-2', 'chunk-2', 'chunk-2'] }),
      {
        files,
        readLineRanges: new Map(),
        accessibleChunkIds: new Set(['chunk-1']), // chunk-2 存在于知识库但本轮未检索返回
      },
    )
    expect(result.guidelineChunkIds).toEqual([])
    expect(result.droppedChunkIdCount).toBe(3)
  })

  it('有效与无效引用混合：分别计数，无效不入库', () => {
    const result = validateAnswerDraft(
      baseAnswer({
        citations: [
          { path: 'src/a.js', startLine: 1, endLine: 3, quote: CONTENT_A },
          { path: 'src/big.js', startLine: 1, endLine: 100, quote: CONTENT_100 },
        ],
        guidelineChunkIds: ['chunk-1', 'chunk-9'],
      }),
      {
        files,
        readLineRanges: new Map([
          ['src/a.js', [[1, 3]]],
          ['src/big.js', [[1, 50]]],
        ]),
        accessibleChunkIds: new Set(['chunk-1']),
      },
    )
    expect(result.citations).toEqual([{ path: 'src/a.js', startLine: 1, endLine: 3, quote: CONTENT_A }])
    expect(result.invalidCitationCount).toBe(1)
    expect(result.guidelineChunkIds).toEqual(['chunk-1'])
    expect(result.droppedChunkIdCount).toBe(1)
  })
})

import { describe, it, expect } from 'vitest'
import {
  validateCodeRef,
  validateDrafts,
  matchesQuote,
  mergeRanges,
  isFullyCovered,
} from '../../src/core/review/validate'
import type { SnapshotFileIndex } from '../../src/core/review/tools'
import type { FindingDraft } from '../../src/core/contracts/findings'

/** 04 文档 R04 关键回归：读取部分范围不能被判为“完整读过” */
function makeFiles(content: string): Map<string, SnapshotFileIndex> {
  const files = new Map<string, SnapshotFileIndex>()
  files.set('a.ts', { path: 'a.ts', content, lineCount: content.split('\n').length })
  return files
}

describe('R04 证据校验：读取范围', () => {
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
  const files = makeFiles(content)

  it('只读取 10-12 行不能引用 1-100（overlap 不等于读过）', () => {
    const errors = validateCodeRef(
      { path: 'a.ts', startLine: 1, endLine: 100, quote: content },
      files,
      new Map([['a.ts', [[10, 12]] as Array<[number, number]>]]),
      true,
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.includes('未完整读取'))).toBe(true)
  })

  it('相邻区间合并后完整覆盖 1-100 可通过', () => {
    const errors = validateCodeRef(
      { path: 'a.ts', startLine: 1, endLine: 100, quote: content },
      files,
      new Map([['a.ts', [[1, 50], [51, 100]] as Array<[number, number]>]]),
      true,
    )
    expect(errors).toEqual([])
  })

  it('乱序与重叠区间合并后仍完整覆盖', () => {
    const ranges: Array<[number, number]> = [[60, 70], [1, 30], [31, 59], [65, 100]]
    const errors = validateCodeRef(
      { path: 'a.ts', startLine: 1, endLine: 100, quote: content },
      files,
      new Map([['a.ts', ranges]]),
      true,
    )
    expect(errors).toEqual([])
  })

  it('中间缺一行（50）不算完整读取', () => {
    const errors = validateCodeRef(
      { path: 'a.ts', startLine: 1, endLine: 100, quote: content },
      files,
      new Map([['a.ts', [[1, 49], [51, 100]] as Array<[number, number]>]]),
      true,
    )
    expect(errors.some((e) => e.includes('未完整读取'))).toBe(true)
  })

  it('requireRead=false 时不检查读取范围', () => {
    const errors = validateCodeRef(
      { path: 'a.ts', startLine: 1, endLine: 100, quote: content },
      files,
      new Map(),
      false,
    )
    expect(errors).toEqual([])
  })
})

describe('R04 区间合并工具', () => {
  it('mergeRanges：重叠/相邻合并、乱序稳定', () => {
    expect(mergeRanges([[1, 50], [51, 100]])).toEqual([[1, 100]])
    expect(mergeRanges([[51, 100], [1, 50]])).toEqual([[1, 100]])
    expect(mergeRanges([[1, 40], [30, 50], [200, 210]])).toEqual([[1, 50], [200, 210]])
    expect(mergeRanges([])).toEqual([])
  })

  it('isFullyCovered：完全包含才通过', () => {
    expect(isFullyCovered(1, 100, [[1, 100]])).toBe(true)
    expect(isFullyCovered(1, 100, [[1, 50], [51, 100]])).toBe(true)
    expect(isFullyCovered(1, 100, [[10, 90]])).toBe(false)
    expect(isFullyCovered(10, 12, [[10, 12]])).toBe(true)
    expect(isFullyCovered(1, 100, [[1, 10], [12, 100]])).toBe(false)
  })
})

describe('R04 严格引文校验', () => {
  const content = ['const a = 1', '  const b = 2  ', 'const c = 3'].join('\n')
  const files = makeFiles(content)

  it('matchesQuote：精确匹配', () => {
    expect(matchesQuote(content, 1, 3, content)).toBe(true)
    expect(matchesQuote(content, 2, 2, '  const b = 2  ')).toBe(true)
  })

  it('首尾空白差异不再宽松通过（去掉 trim 宽松匹配）', () => {
    // 旧行为：quote.trim() 与每行 trim 后比较可通过；R04 起逐字符严格比较
    expect(matchesQuote(content, 1, 3, 'const a = 1\nconst b = 2\nconst c = 3')).toBe(false)
  })

  it('CRLF 引文统一 LF 后可匹配（规范化不可见换行差异）', () => {
    expect(matchesQuote(content, 1, 3, content.replace(/\n/g, '\r\n'))).toBe(true)
  })

  it('行号偏移的引文失败', () => {
    expect(matchesQuote(content, 2, 3, '  const b = 2  \nconst c = 3')).toBe(true)
    expect(matchesQuote(content, 1, 2, '  const b = 2  \nconst c = 3')).toBe(false)
  })

  it('validateCodeRef：引文不匹配记录原因', () => {
    const errors = validateCodeRef(
      { path: 'a.ts', startLine: 1, endLine: 3, quote: 'wrong' },
      files,
      new Map([['a.ts', [[1, 3]]]]),
      true,
    )
    expect(errors.some((e) => e.includes('引文与快照行不匹配'))).toBe(true)
  })
})

describe('R04 规范引用白名单', () => {
  const content = 'const a = 1'
  const files = makeFiles(content)
  const baseDraft: FindingDraft = {
    title: 't',
    category: 'security',
    severity: 'low',
    confidence: 0.9,
    primary: { path: 'a.ts', startLine: 1, endLine: 1, quote: content },
    related: [],
    condition: 'c',
    impact: 'i',
    reasoningSummary: 'r',
    recommendation: 'm',
    guidelineChunkIds: [],
  }
  const readAll = new Map([['a.ts', [[1, 1]] as Array<[number, number]>]])

  it('引用本轮未检索返回的 chunk 无效（可访问但未返回也算）', () => {
    const draft = { ...baseDraft, guidelineChunkIds: ['not-retrieved-id'] }
    const { valid, invalid } = validateDrafts([draft], {
      files,
      readLineRanges: readAll,
      accessibleChunkIds: new Set(['retrieved-id']),
    })
    expect(valid).toEqual([])
    expect(invalid[0]!.errors.some((e) => e.includes('规范引用无效'))).toBe(true)
  })

  it('引用本轮实际返回的 chunk 有效', () => {
    const draft = { ...baseDraft, guidelineChunkIds: ['retrieved-id'] }
    const { valid } = validateDrafts([draft], {
      files,
      readLineRanges: readAll,
      accessibleChunkIds: new Set(['retrieved-id']),
    })
    expect(valid).toHaveLength(1)
  })

  it('伪造 primary 引文（引文不在快照行）→ 无效并记录原因', () => {
    const draft = {
      ...baseDraft,
      primary: { path: 'a.ts', startLine: 1, endLine: 1, quote: 'fabricated' },
    }
    const { invalid } = validateDrafts([draft], {
      files,
      readLineRanges: readAll,
      accessibleChunkIds: new Set(),
    })
    expect(invalid[0]!.errors.some((e) => e.includes('引文与快照行不匹配'))).toBe(true)
  })

  it('跨项目/不存在路径 → 无效', () => {
    const draft = {
      ...baseDraft,
      primary: { path: 'other.ts', startLine: 1, endLine: 1, quote: 'x' },
    }
    const { invalid } = validateDrafts([draft], {
      files,
      readLineRanges: readAll,
      accessibleChunkIds: new Set(),
    })
    expect(invalid[0]!.errors.some((e) => e.includes('路径不在快照内'))).toBe(true)
  })

  it('related 无效：记录原因且被剔除', () => {
    const draft = {
      ...baseDraft,
      related: [{ path: 'a.ts', startLine: 1, endLine: 1, quote: 'bad' }],
    }
    const { invalid } = validateDrafts([draft], {
      files,
      readLineRanges: readAll,
      accessibleChunkIds: new Set(),
    })
    expect(invalid[0]!.errors.some((e) => e.includes('related 无效'))).toBe(true)
  })
})

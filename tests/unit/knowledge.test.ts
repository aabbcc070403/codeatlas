import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../src/core/knowledge/chunk'
import { bigrams, bigramSimilarity, lexicalTopN } from '../../src/core/knowledge/lexical'

describe('Markdown 切块', () => {
  it('按标题/段落切块并保留行号', () => {
    const md = [
      '# 规范文档',
      '',
      '## 第一章',
      '第一段内容，讲述转义规则。',
      '',
      '第二段内容，讲述白名单。',
      '',
      '## 第二章',
      '第二章内容。',
    ].join('\n')
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1)
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine)
      expect(c.text.length).toBeGreaterThan(0)
      expect(c.contentHash).toHaveLength(64)
    }
    // 第一个块从第 1 行附近开始
    expect(chunks[0]!.startLine).toBeLessThanOrEqual(4)
  })

  it('长文本切分为多块且重叠不超过 80 字符', () => {
    const longPara = '这是一个关于跨站脚本防护的规范条目。'.repeat(80) // ~1600 字符
    const chunks = chunkMarkdown(longPara)
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text
      const cur = chunks[i]!.text
      // 重叠：当前块开头应是前一块结尾的子串（长度 ≤ 80）
      const overlap = findOverlap(prev, cur)
      expect(overlap).toBeLessThanOrEqual(80)
    }
  })

  it('短段落合并到接近 400 字符', () => {
    const md = Array.from({ length: 20 }, (_, i) => `段落${i}：简短内容。`).join('\n\n')
    const chunks = chunkMarkdown(md)
    // 合并后不应产生 20 个碎块
    expect(chunks.length).toBeLessThan(10)
  })

  it('空内容返回空数组', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('\n\n\n')).toEqual([])
  })
})

function findOverlap(prev: string, cur: string): number {
  const max = Math.min(80, prev.length, cur.length)
  for (let len = max; len > 0; len--) {
    if (prev.endsWith(cur.slice(0, len))) return len
  }
  return 0
}

describe('字符二元组词法检索', () => {
  it('中文 bigram 相似度：同义命中高于无关文本', () => {
    const q = bigrams('跨站脚本攻击防护')
    const hit = bigrams('XSS 跨站脚本攻击的防护措施')
    const miss = bigrams('React 列表渲染需要稳定 key')
    expect(bigramSimilarity(q, hit)).toBeGreaterThan(bigramSimilarity(q, miss))
  })

  it('lexicalTopN 返回排序命中', () => {
    const candidates = [
      { id: 'a', text: '使用 key 标识列表元素，避免状态错位' },
      { id: 'b', text: '列表渲染 key 的稳定性要求' },
      { id: 'c', text: '图片懒加载与性能优化' },
    ]
    const matches = lexicalTopN('列表 key 渲染', candidates, 2)
    expect(matches.length).toBe(2)
    expect(matches[0]!.id).toBe('b')
    expect(matches.some((m) => m.id === 'c')).toBe(false)
  })

  it('无命中返回空（不编造）', () => {
    const matches = lexicalTopN('量子计算机', [{ id: 'a', text: '数据库连接池配置' }], 3)
    expect(matches).toEqual([])
  })
})

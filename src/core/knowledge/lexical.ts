/**
 * Unicode 字符二元组词法检索（规格 9.4）：
 * 中文不依赖 PostgreSQL 英文分词器，直接以字符 bigram 匹配。
 */

export function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, '')
  const set = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i++) {
    set.add(normalized.slice(i, i + 2))
  }
  if (normalized.length === 1) set.add(normalized)
  return set
}

/** Jaccard 相似度（bigram 集合交并比） */
export function bigramSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const g of a) {
    if (b.has(g)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

export interface LexicalCandidate {
  id: string
  text: string
}

export interface LexicalMatch {
  id: string
  score: number
}

/** 字面量检索：候选集内按 bigram 相似度排序，取 TopN */
export function lexicalTopN(
  query: string,
  candidates: LexicalCandidate[],
  limit: number,
): LexicalMatch[] {
  const queryGrams = bigrams(query)
  const scored = candidates
    .map((c) => ({ id: c.id, score: bigramSimilarity(queryGrams, bigrams(c.text)) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

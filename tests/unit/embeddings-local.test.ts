import { describe, it, expect } from 'vitest'
import {
  createLocalEmbeddingAdapter,
  isLocalEmbeddingModel,
  LOCAL_EMBEDDING_MODELS,
} from '../../src/core/knowledge/embeddings-local'

describe('本地嵌入适配器工厂（transformers.js）', () => {
  it('local:bge-small-zh-v1.5 → 512 维本地适配器（isLocal，跳过日额度）', () => {
    const adapter = createLocalEmbeddingAdapter('local:bge-small-zh-v1.5')
    expect(adapter).not.toBeNull()
    expect(adapter!.isLocal).toBe(true)
    expect(adapter!.dim).toBe(512)
    expect(adapter!.model).toBe('local:bge-small-zh-v1.5')
  })

  it('未知本地键与远程模型名不产出本地适配器', () => {
    expect(createLocalEmbeddingAdapter('local:unknown-model')).toBeNull()
    expect(isLocalEmbeddingModel('local:bge-small-zh-v1.5')).toBe(true)
    expect(isLocalEmbeddingModel('text-embedding-3-small')).toBe(false)
  })

  it('登记表维度为正整数且与模型键一致', () => {
    for (const [key, entry] of Object.entries(LOCAL_EMBEDDING_MODELS)) {
      expect(entry.repo, key).toContain('/')
      expect(Number.isInteger(entry.dim) && entry.dim > 0, key).toBe(true)
    }
  })
})

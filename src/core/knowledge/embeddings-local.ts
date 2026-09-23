import type { EmbeddingAdapter, EmbeddingResult } from './embeddings'

/**
 * 本地嵌入适配器（transformers.js + ONNX，WASM 后端）：
 * - 零 API 成本、可离线复现：模型文件按固定仓库 id 下载一次后本地缓存；
 *   HuggingFace 直连不可达时自动回退 hf-mirror.com 镜像（实测可达）。
 * - 不消耗日额度（无付费调用）：embedWithDailyBudget 对 isLocal 跳过预留/结算。
 * - 池化：BGE 系列用 CLS + L2 归一化（与 bge 官方用法一致）。
 * - 启用方式：AI_EMBEDDING_MODEL=local:<模型键>（见 LOCAL_EMBEDDING_MODELS），
 *   EMBEDDING_DIM 须与模型输出维度一致；换维度前重建索引。
 */

export const LOCAL_EMBEDDING_MODELS: Record<string, { repo: string; dim: number }> = {
  'bge-small-zh-v1.5': { repo: 'Xenova/bge-small-zh-v1.5', dim: 512 },
}

export function isLocalEmbeddingModel(spec: string): boolean {
  return spec.startsWith('local:')
}

/** transformers.js feature-extraction 的最小调用面（避免引入完整类型） */
type FeatureExtractor = (
  text: string,
  opts: { pooling: 'cls'; normalize: true },
) => Promise<{ data: Float32Array | number[] }>

export function createLocalEmbeddingAdapter(spec: string): EmbeddingAdapter | null {
  const key = spec.slice('local:'.length)
  const entry = LOCAL_EMBEDDING_MODELS[key]
  if (!entry) return null
  let extractorPromise: Promise<FeatureExtractor> | null = null

  const load = (): Promise<FeatureExtractor> => {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers')
        env.allowLocalModels = false
        for (const host of ['https://huggingface.co', 'https://hf-mirror.com']) {
          try {
            env.remoteHost = host
            return (await pipeline('feature-extraction', entry.repo, {
              dtype: 'fp32',
            })) as unknown as FeatureExtractor
          } catch {
            // 直连失败回退镜像
          }
        }
        throw new Error(`本地嵌入模型加载失败（网络）：${entry.repo}`)
      })()
    }
    return extractorPromise
  }

  return {
    model: spec,
    dim: entry.dim,
    isLocal: true,
    async embed(texts: string[]): Promise<EmbeddingResult> {
      const extractor = await load()
      const vectors: number[][] = []
      for (const text of texts) {
        const out = await extractor(text, { pooling: 'cls', normalize: true })
        const arr = Array.from(out.data)
        if (arr.length !== entry.dim) {
          throw new Error(
            `本地嵌入维度不匹配：模型输出 ${arr.length}，登记 ${entry.dim}（${spec}）`,
          )
        }
        for (const x of arr) {
          if (!Number.isFinite(x)) {
            throw new Error('本地嵌入分量包含非有限数值（NaN/Infinity），拒绝使用该向量')
          }
        }
        vectors.push(arr)
      }
      return { vectors, model: spec, dim: entry.dim, usageTokens: null }
    },
  }
}

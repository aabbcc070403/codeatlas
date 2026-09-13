import postgres from 'postgres'
import { env, aiProviderStatus } from '@/server/env'
import { Budget } from '@/core/review/budget'
import {
  reserveDailyTokens,
  settleDailyReservation,
  releaseDailyReservation,
} from '@/core/review/daily-budget'

/**
 * 嵌入适配器（规格 9.4）：OpenAI 兼容 embedding API。
 * 未配置真实模型时返回 null —— 检索降级为词法（lexical_only），
 * 不使用伪向量冒充语义检索。
 * A03：付费 embedding 统一走 embedWithDailyBudget（先原子预留日额度再调用，
 * 额度不足直接拒绝，不发起付费请求）。
 */

export interface EmbeddingResult {
  vectors: number[][]
  model: string
  dim: number
  /** 实测 token 数（A03 结算实测优先；未知为 null，回退保守估算） */
  usageTokens: number | null
}

export interface EmbeddingAdapter {
  readonly model: string
  readonly dim: number
  embed(texts: string[]): Promise<EmbeddingResult>
}

let cached: EmbeddingAdapter | null | undefined

export function getEmbeddingAdapter(): EmbeddingAdapter | null {
  if (cached !== undefined) return cached
  const status = aiProviderStatus()
  if (!status.embeddingReady || !status.embeddingModel) {
    cached = null
    return cached
  }
  cached = {
    model: status.embeddingModel,
    dim: env.EMBEDDING_DIM,
    async embed(texts: string[]): Promise<EmbeddingResult> {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const { embedMany } = await import('ai')
      const openai = createOpenAI({
        baseURL: env.AI_BASE_URL,
        apiKey: env.AI_API_KEY,
      })
      const result = await embedMany({
        model: openai.embedding(status.embeddingModel!),
        values: texts,
        // 单批嵌入 30 秒超时（R04）：超时抛错由调用方降级词法，不悬挂扫描
        abortSignal: AbortSignal.timeout(30_000),
      })
      const vectors = result.embeddings
      // 数量一致：返回向量数必须等于请求条数
      if (vectors.length !== texts.length) {
        throw new Error(
          `embedding 返回数量不匹配：请求 ${texts.length} 条，返回 ${vectors.length} 条`,
        )
      }
      // 维度与数值校验：每条维度必须与配置一致，且所有分量有限（非 NaN/Infinity）
      for (const v of vectors) {
        if (v.length !== env.EMBEDDING_DIM) {
          throw new Error(
            `embedding 维度不匹配：模型输出 ${v.length}，配置 EMBEDDING_DIM=${env.EMBEDDING_DIM}；请调整配置并重建索引`,
          )
        }
        for (const x of v) {
          if (!Number.isFinite(x)) {
            throw new Error('embedding 分量包含非有限数值（NaN/Infinity），拒绝使用该向量')
          }
        }
      }
      const usageTokens = result.usage?.tokens
      return {
        vectors,
        model: status.embeddingModel!,
        dim: env.EMBEDDING_DIM,
        usageTokens: typeof usageTokens === 'number' && Number.isFinite(usageTokens) ? usageTokens : null,
      }
    },
  }
  return cached
}

/**
 * 带日额度的嵌入调用（A03）：调用前按输入估算原子预留；日额度不足时
 * 返回 daily_budget_exceeded（不发起付费请求）；成功按实测 token 结算
 * （未知回退保守估算，不按零计费）；失败释放预留并原样抛错（调用方降级词法）。
 */
export async function embedWithDailyBudget(
  sql: postgres.Sql,
  texts: string[],
  opts?: { adapter?: EmbeddingAdapter | null },
): Promise<
  | { status: 'ok'; vectors: number[][]; model: string; dim: number }
  | { status: 'unavailable' }
  | { status: 'daily_budget_exceeded' }
> {
  const adapter = opts?.adapter !== undefined ? opts.adapter : getEmbeddingAdapter()
  if (!adapter) return { status: 'unavailable' }
  const inputEstimate = Budget.estimate(texts.join('\n'))
  const reservation = await reserveDailyTokens(sql, inputEstimate)
  if (!reservation) return { status: 'daily_budget_exceeded' }
  try {
    const result = await adapter.embed(texts)
    await settleDailyReservation(sql, reservation, result.usageTokens ?? inputEstimate, 0)
    return { status: 'ok', vectors: result.vectors, model: result.model, dim: result.dim }
  } catch (err) {
    await releaseDailyReservation(sql, reservation).catch(() => undefined)
    throw err
  }
}

/** 测试用：重置缓存 */
export function resetEmbeddingAdapterCache(): void {
  cached = undefined
}

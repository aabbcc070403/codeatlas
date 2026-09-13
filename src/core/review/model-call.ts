import postgres from 'postgres'
import type { ModelMessage } from 'ai'
import type { ChatProvider, ProviderResult, ToolSpec } from './provider'
import { Budget } from './budget'
import {
  reserveDailyTokens,
  settleDailyReservation,
  releaseDailyReservation,
  type DailyTokenReservation,
} from './daily-budget'

/**
 * 统一模型调用包装（A03）：orchestrator / 追问 / 补丁共用同一预算合同——
 * 1. 调用前按「本次输入估算 + 输出上限」做单扫描余量校验，并收缩 maxOutputTokens；
 * 2. 真实 provider 走日额度原子预留，预留量 = 输入估算 + 收缩后的输出上限
 *    （与传给 provider 的 maxOutputTokens 一致）；Mock 完全跳过日额度操作（A04）；
 * 3. 单请求超时与整体墙钟剩余时间取更短者（接近 deadline 时中止在途调用），
 *    并与外部取消/失租信号合并；
 * 4. 结算实测优先、缺省回退保守估算（含工具调用载荷，不按零计费）；
 * 5. 调用失败仅释放预留；重试/修复轮也是新的模型请求，同样计入请求上限。
 */

export interface ModelCallOptions {
  sql: postgres.Sql
  budget: Budget
  provider: ChatProvider
  system: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  /** 期望输出上限：实际取 min(期望, 剩余输出额度)，同时用于日额度预留 */
  desiredOutputTokens: number
  perCallTimeoutMs: number
  /** 取消/失租信号（与超时合并） */
  signal?: AbortSignal
}

export type ModelCallOutcome =
  | { kind: 'ok'; result: ProviderResult }
  /** 单扫描预算不足：本次输入 + 输出上限放不进剩余额度 */
  | { kind: 'scan_budget_exhausted' }
  /** 日额度预留失败 */
  | { kind: 'daily_budget_exceeded' }
  /** 外部取消/失租信号中止 */
  | { kind: 'cancelled' }
  /** 单请求超时或整体墙钟到期（中止在途调用） */
  | { kind: 'timeout' }
  /** 其他错误（原样抛给调用方分类） */
  | { kind: 'error'; error: unknown }

export async function callModelWithBudget(opts: ModelCallOptions): Promise<ModelCallOutcome> {
  const inputEstimate =
    Budget.estimate(opts.messages.map((m) => JSON.stringify(m)).join('')) +
    Budget.estimate(opts.system)
  const prepared = opts.budget.prepareModelCall(inputEstimate, opts.desiredOutputTokens)
  if (!prepared.ok) return { kind: 'scan_budget_exhausted' }

  let reservation: DailyTokenReservation | null = null
  if (!opts.provider.isMock) {
    reservation = await reserveDailyTokens(opts.sql, inputEstimate + prepared.maxOutputTokens)
    if (!reservation) {
      opts.budget.exhaustedReason = 'daily_budget_exceeded'
      return { kind: 'daily_budget_exceeded' }
    }
  }

  // 单请求超时 ∩ 整体墙钟剩余（A03：接近 deadline 的在途调用被中止）∪ 外部取消/失租
  const callTimeoutMs = Math.max(1, Math.min(opts.perCallTimeoutMs, opts.budget.remainingWallMs()))
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), callTimeoutMs)
  const signal = AbortSignal.any(
    opts.signal ? [timeoutController.signal, opts.signal] : [timeoutController.signal],
  )
  try {
    const result = await opts.provider.chat({
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      maxOutputTokens: prepared.maxOutputTokens,
      abortSignal: signal,
    })
    // 结算：实测优先，缺省回退保守估算（输出估算含工具调用载荷，不按零计费）
    const outputEstimate = Budget.estimateOutput(result.text, result.toolCalls)
    if (reservation) {
      await settleDailyReservation(
        opts.sql,
        reservation,
        result.usage.inputTokens ?? inputEstimate,
        result.usage.outputTokens ?? outputEstimate,
      )
    }
    opts.budget.recordModelCall(inputEstimate, outputEstimate, {
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
    })
    return { kind: 'ok', result }
  } catch (err) {
    if (reservation) {
      await releaseDailyReservation(opts.sql, reservation).catch(() => undefined)
    }
    if (opts.signal?.aborted) return { kind: 'cancelled' }
    if (timeoutController.signal.aborted) return { kind: 'timeout' }
    return { kind: 'error', error: err }
  } finally {
    clearTimeout(timer)
  }
}

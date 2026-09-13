import { describe, it, expect, vi, afterEach } from 'vitest'
import type postgres from 'postgres'
import { Budget } from '../../src/core/review/budget'
import { callModelWithBudget } from '../../src/core/review/model-call'
import type { ChatProvider, ProviderChatOptions, ProviderResult } from '../../src/core/review/provider'

/**
 * A03 统一模型调用包装（Mock provider 路径：不触碰日额度，无需数据库）：
 * 本次预留校验、输出收缩、在途调用按整体墙钟中止、取消分类。
 */

const fakeSql = null as unknown as postgres.Sql

function mockProvider(
  chat: (opts: ProviderChatOptions) => Promise<ProviderResult>,
): ChatProvider {
  return { id: 'mock-test', isMock: true, ready: true, chat }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('A03 callModelWithBudget（统一调用包装）', () => {
  it('剩余输入不足：不调用 provider，返回 scan_budget_exhausted', async () => {
    let called = 0
    const provider = mockProvider(async () => {
      called++
      return { text: 'x', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const budget = new Budget({ maxInputTokens: 10 })
    const outcome = await callModelWithBudget({
      sql: fakeSql,
      budget,
      provider,
      system: 's',
      messages: [{ role: 'user', content: 'x'.repeat(200) }],
      tools: [],
      desiredOutputTokens: 100,
      perCallTimeoutMs: 1000,
    })
    expect(outcome.kind).toBe('scan_budget_exhausted')
    expect(called).toBe(0)
    expect(budget.snapshot().modelCalls).toBe(0)
  })

  it('输出上限收缩：provider 收到 min(期望, 剩余输出额度)', async () => {
    const received: number[] = []
    const provider = mockProvider(async (opts) => {
      received.push(opts.maxOutputTokens)
      return { text: 'x', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const budget = new Budget({ maxOutputTokens: 300 })
    const outcome = await callModelWithBudget({
      sql: fakeSql,
      budget,
      provider,
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      desiredOutputTokens: 2000,
      perCallTimeoutMs: 1000,
    })
    expect(outcome.kind).toBe('ok')
    expect(received[0]).toBe(300)
  })

  it('成功调用按保守估算记账（Mock 无实测输出时含工具载荷，不按零计费）', async () => {
    const provider = mockProvider(async () => ({
      text: '',
      toolCalls: [{ id: 'c1', name: 'read_file', args: { padding: 'x'.repeat(400) } }],
      usage: { inputTokens: 100, outputTokens: null }, // 输出未知 → 回退含载荷估算
    }))
    const budget = new Budget()
    const outcome = await callModelWithBudget({
      sql: fakeSql,
      budget,
      provider,
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      desiredOutputTokens: 2000,
      perCallTimeoutMs: 1000,
    })
    expect(outcome.kind).toBe('ok')
    const snap = budget.snapshot()
    expect(snap.modelCalls).toBe(1)
    expect(snap.inputTokensMeasured).toBe(100)
    expect(snap.outputTokensMeasured).toBeNull() // 未知不虚构
    expect(snap.outputTokensEstimated).toBeGreaterThanOrEqual(100) // 含工具载荷
  })

  it('接近整体 deadline 的在途调用被中止：单请求 30s 超时收缩为剩余墙钟', async () => {
    vi.useFakeTimers()
    const provider = mockProvider(
      (opts) =>
        new Promise<ProviderResult>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('late')), 30_000)
          opts.abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    const budget = new Budget({ wallMs: 1000 })
    const pending = callModelWithBudget({
      sql: fakeSql,
      budget,
      provider,
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      desiredOutputTokens: 100,
      perCallTimeoutMs: 30_000, // 远大于整体墙钟：须以剩余墙钟为准
    })
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await pending
    expect(outcome.kind).toBe('timeout')
    expect(budget.snapshot().modelCalls).toBe(0) // 未完成不计数
  })

  it('外部取消信号中止：分类为 cancelled', async () => {
    const controller = new AbortController()
    controller.abort() // 进入调用前已取消（失租/用户取消）
    const provider = mockProvider((opts) => {
      if (opts.abortSignal?.aborted) return Promise.reject(new Error('aborted'))
      return Promise.resolve({ text: 'x', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } })
    })
    const budget = new Budget()
    const outcome = await callModelWithBudget({
      sql: fakeSql,
      budget,
      provider,
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      desiredOutputTokens: 100,
      perCallTimeoutMs: 1000,
      signal: controller.signal,
    })
    expect(outcome.kind).toBe('cancelled')
    expect(budget.snapshot().modelCalls).toBe(0)
  })
})

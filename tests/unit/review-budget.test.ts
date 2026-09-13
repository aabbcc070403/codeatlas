import { describe, it, expect } from 'vitest'
import { Budget, DEFAULT_BUDGET } from '../../src/core/review/budget'

describe('R04 预算估算', () => {
  it('中文按 ~1 token/字（比 4 字符/token 保守）', () => {
    const cjk = '审查结论'.repeat(25) // 100 个汉字
    expect(Budget.estimate(cjk)).toBe(100)
    expect(Budget.estimate(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 4))
  })

  it('英文按 4 字符/token', () => {
    expect(Budget.estimate('abcdefgh')).toBe(2)
    expect(Budget.estimate('ab')).toBe(1)
  })

  it('混合文本：中日韩按字计、其余按字符比', () => {
    // 2 汉字 + 8 英文字符：2 + ceil(8/4) = 4
    expect(Budget.estimate('代码abcdefgh')).toBe(4)
  })

  it('全角形式按宽字符计', () => {
    expect(Budget.estimate('（）')).toBe(2)
  })
})

describe('R04 单扫描预算上限', () => {
  it('默认配置为规格值（12 次模型请求 / 180 秒墙钟）', () => {
    expect(DEFAULT_BUDGET.maxModelCalls).toBe(12)
    expect(DEFAULT_BUDGET.maxToolCalls).toBe(30)
    expect(DEFAULT_BUDGET.maxInputTokens).toBe(60_000)
    expect(DEFAULT_BUDGET.maxOutputTokens).toBe(8_000)
    expect(DEFAULT_BUDGET.wallMs).toBe(180_000)
  })

  it('模型请求次数达到上限后拒绝并记录原因', () => {
    const b = new Budget({ maxModelCalls: 2 })
    expect(b.canModelCall()).toBe(true)
    b.recordModelCall(100, 50)
    expect(b.canModelCall()).toBe(true)
    b.recordModelCall(100, 50)
    expect(b.canModelCall()).toBe(false)
    expect(b.exhaustedReason).toContain('模型请求次数达到上限 2')
  })

  it('输入 token 估算达到上限后拒绝', () => {
    const b = new Budget({ maxInputTokens: 1000 })
    b.recordModelCall(600, 0)
    expect(b.canModelCall()).toBe(true)
    b.recordModelCall(500, 0)
    expect(b.canModelCall()).toBe(false)
    expect(b.exhaustedReason).toContain('输入 token 估算达到上限 1000')
  })

  it('输出 token 估算达到上限后拒绝', () => {
    const b = new Budget({ maxOutputTokens: 500 })
    b.recordModelCall(0, 300)
    b.recordModelCall(0, 300)
    expect(b.canModelCall()).toBe(false)
    expect(b.exhaustedReason).toContain('输出 token 估算达到上限 500')
  })

  it('实测与估算分列累计；快照字段完整', () => {
    const b = new Budget()
    b.recordModelCall(100, 50, { input: 120, output: 60 })
    b.recordModelCall(100, 50, { input: 80 })
    const snap = b.snapshot()
    expect(snap.modelCalls).toBe(2)
    expect(snap.inputTokensEstimated).toBe(200)
    expect(snap.outputTokensEstimated).toBe(100)
    expect(snap.inputTokensMeasured).toBe(200)
    expect(snap.outputTokensMeasured).toBe(60) // 缺失不虚构
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('工具调用上限：达到后拒绝且状态记录 budget_exceeded 语义由调用方处理', () => {
    const b = new Budget({ maxToolCalls: 1 })
    expect(b.canToolCall()).toBe(true)
    expect(b.canToolCall()).toBe(true) // 检查不递增，由调用方在执行后计数
    b.toolCalls = 1
    expect(b.canToolCall()).toBe(false)
    expect(b.exhaustedReason).toContain('工具调用次数达到上限 1')
  })

  it('耗尽后 canToolCall 也拒绝（预算全局生效）', () => {
    const b = new Budget({ maxModelCalls: 1 })
    b.recordModelCall(1, 1)
    b.canModelCall()
    expect(b.canToolCall()).toBe(false)
  })
})

describe('A03 预算执行：实测优先、本次预留、输出收缩', () => {
  it('实测输出超上限后 canModelCall 拒绝（measured 参与上限）', () => {
    const b = new Budget({ maxOutputTokens: 10 })
    b.recordModelCall(0, 0, { output: 1000 })
    expect(b.canModelCall()).toBe(false)
    expect(b.exhaustedReason).toContain('输出 token')
  })

  it('实测输入超上限后拒绝', () => {
    const b = new Budget({ maxInputTokens: 100 })
    b.recordModelCall(0, 0, { input: 101 })
    expect(b.canModelCall()).toBe(false)
    expect(b.exhaustedReason).toContain('输入 token')
  })

  it('实测超估算时以实测为准（不被低估算绕过）', () => {
    const b = new Budget({ maxInputTokens: 100, maxOutputTokens: 100 })
    b.recordModelCall(10, 10, { input: 500, output: 500 }) // 实测远超估算
    expect(b.canModelCall()).toBe(false)
  })

  it('未知消耗（无实测）不默认为零：沿用累计估算', () => {
    const b = new Budget({ maxInputTokens: 100, maxOutputTokens: 100 })
    b.recordModelCall(60, 60) // 无 measured
    b.recordModelCall(60, 60) // 无 measured
    expect(b.canModelCall()).toBe(false)
  })

  it('剩余输入不足：prepareModelCall 按「本次输入」预留拒绝（拒绝即锁定）', () => {
    const b = new Budget({ maxInputTokens: 100, maxOutputTokens: 1000 })
    b.recordModelCall(50, 0, { input: 50 })
    // 剩余输入 50：本次输入 51 放不下
    expect(b.prepareModelCall(51, 10).ok).toBe(false)
    expect(b.prepareModelCall(1, 10).ok).toBe(false) // 拒绝后锁定（与 canModelCall 同语义）
    // 恰好放满允许（独立预算实例）
    const b2 = new Budget({ maxInputTokens: 100, maxOutputTokens: 1000 })
    b2.recordModelCall(50, 0, { input: 50 })
    expect(b2.prepareModelCall(50, 10).ok).toBe(true)
  })

  it('prepareModelCall 收缩输出上限至剩余输出额度', () => {
    const b = new Budget({ maxOutputTokens: 1000 })
    b.recordModelCall(0, 700, { output: 700 })
    const prepared = b.prepareModelCall(0, 2000)
    expect(prepared.ok).toBe(true)
    if (prepared.ok) expect(prepared.maxOutputTokens).toBe(300)
    // 输出耗尽后拒绝
    b.recordModelCall(0, 300, { output: 300 })
    expect(b.prepareModelCall(0, 100).ok).toBe(false)
  })

  it('prepareModelCall 拒绝后记录耗尽原因（跨请求共享上限）', () => {
    const b = new Budget({ maxModelCalls: 2 })
    b.recordModelCall(1, 1)
    b.recordModelCall(1, 1)
    expect(b.prepareModelCall(1, 1).ok).toBe(false)
    expect(b.canModelCall()).toBe(false)
    expect(b.exhaustedReason).toContain('模型请求次数达到上限 2')
  })

  it('estimateOutput 包含工具调用载荷（text 为空也不漏算）', () => {
    const empty = Budget.estimateOutput('', [])
    expect(empty).toBe(0)
    const withPayload = Budget.estimateOutput('', [
      { id: 'c1', name: 'read_file', args: { padding: 'x'.repeat(400) } } as never,
    ])
    expect(withPayload).toBeGreaterThanOrEqual(100)
    const textOnly = Budget.estimateOutput('abcdefgh', [])
    expect(textOnly).toBe(2)
  })
})

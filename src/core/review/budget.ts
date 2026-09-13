/**
 * 扫描预算（规格 9.2）：单扫描默认至多 12 次模型请求、30 次工具调用、
 * 60,000 输入 token、8,000 输出 token、180 秒墙钟预算。
 * 估算与实测分列；达到任一限制保存已有有效结果并标 partial。
 *
 * A03：上限判定实测优先（measured ≥ estimated 时以实测为准），且每次调用前
 * 按「本次输入估算 + 输出上限」校验余量并收缩 maxOutputTokens；
 * 输出估算必须包含工具调用载荷（参数是模型生成的 completion token）。
 */

export interface BudgetConfig {
  maxModelCalls: number
  maxToolCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  wallMs: number
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxModelCalls: 12,
  maxToolCalls: 30,
  maxInputTokens: 60_000,
  maxOutputTokens: 8_000,
  wallMs: 180_000,
}

export class Budget {
  readonly config: BudgetConfig
  private readonly startedAt = Date.now()
  modelCalls = 0
  toolCalls = 0
  inputTokensEstimated = 0
  outputTokensEstimated = 0
  inputTokensMeasured: number | null = null
  outputTokensMeasured: number | null = null
  exhaustedReason: string | null = null

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config }
  }

  /**
   * 保守 token 估算（R04）：中日韩字符按 ~1 token/字（实际约 0.6-1.1），
   * 其余按 4 字符/token；混合文本偏保守，防止低估消耗绕过预算。
   */
  static estimate(text: string): number {
    let wide = 0
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0
      if (
        (code >= 0x2e80 && code <= 0x9fff) || // CJK
        (code >= 0xac00 && code <= 0xd7af) || // Hangul
        (code >= 0xff00 && code <= 0xffef) // 全角形式
      ) {
        wide++
      }
    }
    return Math.ceil(wide + (text.length - wide) / 4)
  }

  /**
   * 输出估算（A03）：必须包含工具调用载荷——工具参数是模型生成的输出
   * （计入 completion token），只看 result.text 会漏算大参数调用。
   */
  static estimateOutput(
    text: string,
    toolCalls: Array<{ args: unknown }>,
  ): number {
    return (
      Budget.estimate(text) +
      (toolCalls.length > 0
        ? Budget.estimate(toolCalls.map((c) => JSON.stringify(c)).join(''))
        : 0)
    )
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  /** 整体墙钟剩余毫秒（A03：在途调用的超时须与其取更短者） */
  remainingWallMs(): number {
    return Math.max(0, this.config.wallMs - this.elapsedMs)
  }

  /** 已消耗输入：实测优先（未知消耗不默认为零，无实测时用累计估算） */
  private consumedInput(): number {
    return Math.max(this.inputTokensEstimated, this.inputTokensMeasured ?? 0)
  }

  /** 已消耗输出：实测优先 */
  private consumedOutput(): number {
    return Math.max(this.outputTokensEstimated, this.outputTokensMeasured ?? 0)
  }

  canModelCall(): boolean {
    if (this.exhaustedReason) return false
    if (this.modelCalls >= this.config.maxModelCalls) {
      this.exhaustedReason = `模型请求次数达到上限 ${this.config.maxModelCalls}`
      return false
    }
    if (this.consumedInput() >= this.config.maxInputTokens) {
      this.exhaustedReason = `输入 token 估算达到上限 ${this.config.maxInputTokens}`
      return false
    }
    if (this.consumedOutput() >= this.config.maxOutputTokens) {
      this.exhaustedReason = `输出 token 估算达到上限 ${this.config.maxOutputTokens}`
      return false
    }
    if (this.elapsedMs >= this.config.wallMs) {
      this.exhaustedReason = `AI 墙钟预算达到上限 ${this.config.wallMs / 1000}s`
      return false
    }
    return true
  }

  /**
   * 本次调用的余量校验与输出上限收缩（A03）：调用前按「本次输入估算 +
   * 期望输出上限」预留校验；余量不足返回 { ok: false }（并记录耗尽原因），
   * 通过时返回收缩后的 maxOutputTokens（≤ 期望值，且 ≤ 剩余输出额度）。
   * 该值同时用于日额度预留与传给 provider 的 maxOutputTokens——两者必须一致。
   */
  prepareModelCall(
    inputEstimate: number,
    desiredOutputTokens: number,
  ): { ok: true; maxOutputTokens: number } | { ok: false } {
    if (this.exhaustedReason) return { ok: false }
    if (this.modelCalls >= this.config.maxModelCalls) {
      this.exhaustedReason = `模型请求次数达到上限 ${this.config.maxModelCalls}`
      return { ok: false }
    }
    if (this.consumedInput() + inputEstimate > this.config.maxInputTokens) {
      this.exhaustedReason = `输入 token 估算达到上限 ${this.config.maxInputTokens}`
      return { ok: false }
    }
    const outputRemaining = this.config.maxOutputTokens - this.consumedOutput()
    if (outputRemaining <= 0) {
      this.exhaustedReason = `输出 token 估算达到上限 ${this.config.maxOutputTokens}`
      return { ok: false }
    }
    if (this.elapsedMs >= this.config.wallMs) {
      this.exhaustedReason = `AI 墙钟预算达到上限 ${this.config.wallMs / 1000}s`
      return { ok: false }
    }
    return {
      ok: true,
      maxOutputTokens: Math.max(1, Math.min(desiredOutputTokens, outputRemaining)),
    }
  }

  canToolCall(): boolean {
    if (this.exhaustedReason) return false
    if (this.toolCalls >= this.config.maxToolCalls) {
      this.exhaustedReason = `工具调用次数达到上限 ${this.config.maxToolCalls}`
      return false
    }
    return true
  }

  recordModelCall(inputEstimate: number, outputEstimate: number, measured?: { input?: number | null; output?: number | null }): void {
    this.modelCalls++
    this.inputTokensEstimated += inputEstimate
    this.outputTokensEstimated += outputEstimate
    if (measured?.input != null) {
      this.inputTokensMeasured = (this.inputTokensMeasured ?? 0) + measured.input
    }
    if (measured?.output != null) {
      this.outputTokensMeasured = (this.outputTokensMeasured ?? 0) + measured.output
    }
  }

  snapshot() {
    return {
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      inputTokensEstimated: this.inputTokensEstimated,
      outputTokensEstimated: this.outputTokensEstimated,
      inputTokensMeasured: this.inputTokensMeasured,
      outputTokensMeasured: this.outputTokensMeasured,
      elapsedMs: this.elapsedMs,
      exhaustedReason: this.exhaustedReason,
    }
  }
}

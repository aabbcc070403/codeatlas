import type { FindingDraft } from '@/core/contracts/findings'
import type {
  ChatProvider,
  MockScriptInput,
  ProviderChatOptions,
  ProviderResult,
} from '@/core/review/provider'

/**
 * 评测专用受控 Mock provider（R08）：确定性脚本 —— 读取样例文件 →（可选）检索规范 →
 * 复核提交。useRag=false 时严格不使用规范检索（llm_no_rag 消融基线）；
 * useRag=true 时调用 retrieve_guidelines 并引用返回的 chunkId（hybrid_rag 实验组）。
 * 仅用于管线验证：结果一律标注 provider=mock，不得冒充真实模型指标。
 */

interface ReadResult {
  path: string
  startLine: number
  endLine: number
  content: string
}

export interface EvaluationMockScript extends MockScriptInput {
  /** 样例文件（评测 runner 预先提供，用于构造 read_file 调用） */
  files: Array<{ path: string; content: string }>
  /** false → llm_no_rag：不调用 retrieve_guidelines、不引用规范 */
  useRag: boolean
}

export class EvaluationMockProvider implements ChatProvider {
  readonly id = 'mock'
  readonly isMock = true
  readonly ready = true
  private step = 0
  private readResults = new Map<string, ReadResult>()
  private retrievedChunkIds: string[] = []

  constructor(private readonly script: EvaluationMockScript) {}

  private toolOutputs(opts: ProviderChatOptions): Array<{ toolName: string; output: unknown }> {
    const results: Array<{ toolName: string; output: unknown }> = []
    for (const m of opts.messages) {
      if (m.role !== 'tool') continue
      for (const part of m.content) {
        if (part.type === 'tool-result') {
          results.push({
            toolName: part.toolName,
            output:
              part.output.type === 'json' || part.output.type === 'error-json'
                ? part.output.value
                : part.output.type === 'text' || part.output.type === 'error-text'
                  ? part.output.value
                  : null,
          })
        }
      }
    }
    return results
  }

  async chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    this.step++
    const inputChars = JSON.stringify(opts.messages).length + opts.system.length
    const usage = {
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: 40,
    }

    if (this.step === 1) {
      // 读取全部样例文件（read_file 单次限 200 行，样例文件均远小于该限制）
      const toolCalls = this.script.files.map((f, i) => ({
        id: `eval-mock-read-${i}`,
        name: 'read_file',
        args: { path: f.path, startLine: 1, endLine: Math.max(1, f.content.split('\n').length) },
      }))
      return { text: '', toolCalls, usage: { ...usage, outputTokens: 60 } }
    }

    if (this.step === 2 && this.script.useRag) {
      for (const r of this.toolOutputs(opts)) {
        if (r.toolName !== 'read_file') continue
        const output = r.output as { path?: string; startLine?: number; endLine?: number; content?: string }
        if (output.path && output.content !== undefined) {
          this.readResults.set(output.path, {
            path: output.path,
            startLine: output.startLine ?? 1,
            endLine: output.endLine ?? 1,
            content: output.content,
          })
        }
      }
      const query = this.script.candidateFindings
        .slice(0, 3)
        .map((t) => t.title)
        .join(' ')
      return {
        text: '',
        toolCalls: [
          { id: 'eval-mock-retrieve-1', name: 'retrieve_guidelines', args: { query: query.slice(0, 120), topK: 3 } },
        ],
        usage: { ...usage, outputTokens: 40 },
      }
    }

    // 提交轮（useRag=false 的第 2 步 / useRag=true 的第 3 步）
    for (const r of this.toolOutputs(opts)) {
      if (r.toolName === 'read_file') {
        const output = r.output as { path?: string; startLine?: number; endLine?: number; content?: string }
        if (output.path && output.content !== undefined) {
          this.readResults.set(output.path, {
            path: output.path,
            startLine: output.startLine ?? 1,
            endLine: output.endLine ?? 1,
            content: output.content,
          })
        }
      }
      if (r.toolName === 'retrieve_guidelines') {
        const output = r.output as { chunks?: Array<{ chunkId: string }> }
        this.retrievedChunkIds = (output?.chunks ?? []).map((c) => c.chunkId)
      }
    }

    const drafts = this.script.candidateFindings
      .slice(0, 10)
      .map((t) => this.buildDraft(t))
      .filter((d): d is FindingDraft => d !== null)

    return {
      text:
        drafts.length > 0
          ? `Mock 复核完成：${drafts.length} 项（Mock provider，不代表真实模型能力）`
          : 'Mock 复核完成：无充分证据，提交空结论（Mock provider）',
      // 始终提交（无候选时提交空数组）：结束工具循环，避免空转消耗模型请求预算
      toolCalls: [{ id: 'eval-mock-submit-1', name: 'submit_findings', args: { findings: drafts } }],
      usage: { ...usage, outputTokens: 120 + drafts.length * 80 },
    }
  }

  private buildDraft(t: MockScriptInput['candidateFindings'][number]): FindingDraft | null {
    const read = this.readResults.get(t.path)
    if (!read) return null
    // 引文取自真实读到的内容（逐字符一致，通过证据校验）
    const lines = read.content.split('\n')
    const quoteLines: string[] = []
    for (let line = t.startLine; line <= t.endLine; line++) {
      const text = lines[line - 1]
      if (text === undefined) return null
      quoteLines.push(text)
    }
    return {
      title: `AI 复核：${t.title}`,
      category: t.category as FindingDraft['category'],
      severity: t.severity as FindingDraft['severity'],
      confidence: 0.8,
      primary: {
        path: t.path,
        startLine: t.startLine,
        endLine: t.endLine,
        quote: quoteLines.join('\n'),
      },
      related: [],
      condition: t.condition,
      impact: t.impact,
      reasoningSummary:
        'Mock provider 基于读取的样例文件复核静态候选；此结果由 Mock 生成，不代表真实模型能力。',
      recommendation: t.recommendation,
      guidelineChunkIds: this.script.useRag ? [...this.retrievedChunkIds] : [],
    }
  }
}

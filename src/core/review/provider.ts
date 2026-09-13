import { z } from 'zod'
import { aiProviderStatus, env } from '@/server/env'
import type { Tool, ModelMessage } from 'ai'

/**
 * Chat provider 抽象：Mock（无密钥本地流程，明确标记，不冒充真实模型）
 * 与 OpenAI 兼容接口（AI SDK，Chat Completions endpoint）。
 * 工具循环由编排器手动驱动，每步都是一次模型请求，
 * 预算与取消在工具边界检查；消息结构使用 AI SDK 受类型检查的 ModelMessage。
 */

export interface ToolSpec {
  name: string
  description: string
  parameters: z.ZodTypeAny
}

export interface ProviderToolCall {
  id: string
  name: string
  args: unknown
}

export interface ProviderUsage {
  inputTokens: number | null
  outputTokens: number | null
}

export interface ProviderResult {
  text: string
  toolCalls: ProviderToolCall[]
  usage: ProviderUsage
}

export interface ProviderChatOptions {
  system: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  maxOutputTokens: number
  abortSignal?: AbortSignal
}

export interface ChatProvider {
  /** 'mock' 或真实模型 id */
  id: string
  isMock: boolean
  ready: boolean
  chat(opts: ProviderChatOptions): Promise<ProviderResult>
}

/* ---------------- Mock Provider ---------------- */

export interface MockScriptInput {
  /** 静态候选（供 mock 读取与复核） */
  candidateFindings: Array<{
    path: string
    startLine: number
    endLine: number
    title: string
    category: string
    severity: string
    condition: string
    impact: string
    recommendation: string
  }>
}

/**
 * Mock：确定性脚本 —— 读文件 → 检索规范 → 复核提交（基于真实读到的行构造引文）。
 * 不发明静态阶段未覆盖的新风险；所有输出可在界面看到 mock 标记。
 */
export class MockChatProvider implements ChatProvider {
  readonly id = 'mock'
  readonly isMock = true
  readonly ready = true
  private step = 0
  private readResults = new Map<string, { path: string; startLine: number; endLine: number; content: string }>()
  private guidelineResults: Array<{ chunkId: string; title: string; text: string }> = []

  constructor(private script: MockScriptInput) {}

  /** 从 AI SDK ModelMessage 中提取工具结果（结构化 { type:'json', value } 形式） */
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
    const usage: ProviderUsage = {
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: null,
    }

    if (this.step === 1) {
      // 读候选文件（最多 3 个，围绕命中行段）
      const targets = this.script.candidateFindings.slice(0, 3)
      const toolCalls: ProviderToolCall[] = targets.map((t, i) => ({
        id: `mock-read-${i}`,
        name: 'read_file',
        args: {
          path: t.path,
          startLine: Math.max(1, t.startLine - 5),
          endLine: Math.min(t.endLine + 5, t.endLine + 10),
        },
      }))
      return {
        text: '',
        toolCalls,
        usage: { ...usage, outputTokens: 60 },
      }
    }

    if (this.step === 2) {
      for (const r of this.toolOutputs(opts)) {
        if (r.toolName !== 'read_file') continue
        const output = r.output as {
          path?: string
          startLine?: number
          endLine?: number
          content?: string
        }
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
          {
            id: 'mock-retrieve-1',
            name: 'retrieve_guidelines',
            args: { query: query.slice(0, 120), topK: 3 },
          },
        ],
        usage: { ...usage, outputTokens: 40 },
      }
    }

    if (this.step === 3) {
      for (const r of this.toolOutputs(opts)) {
        if (r.toolName !== 'retrieve_guidelines') continue
        const output = r.output as {
          chunks?: Array<{ chunkId: string; title: string; text: string }>
        }
        this.guidelineResults = output?.chunks ?? []
      }

      const drafts = this.script.candidateFindings
        .slice(0, 3)
        .map((t) => this.buildDraft(t))
        .filter((d): d is NonNullable<ReturnType<MockChatProvider['buildDraft']>> => d !== null)

      return {
        text:
          drafts.length > 0
            ? `Mock 复核完成：${drafts.length} 项（Mock provider，不代表真实模型能力）`
            : 'Mock 未读到足够证据，不提交结论',
        toolCalls:
          drafts.length > 0
            ? [{ id: 'mock-submit-1', name: 'submit_findings', args: { findings: drafts } }]
            : [],
        usage: { ...usage, outputTokens: 120 + drafts.length * 80 },
      }
    }

    // 结构修复轮：Mock 无法修复，直接放弃无效项
    return {
      text: 'Mock 无可修复内容',
      toolCalls: [],
      usage: { ...usage, outputTokens: 10 },
    }
  }

  private buildDraft(t: MockScriptInput['candidateFindings'][number]) {
    const read = this.readResults.get(t.path)
    if (!read) return null
    const guideline = this.guidelineResults[0]
    return {
      title: `AI 复核：${t.title}`,
      category: t.category,
      severity: t.severity,
      confidence: 0.8,
      primary: {
        path: read.path,
        startLine: read.startLine,
        endLine: read.endLine,
        quote: read.content,
      },
      related: [],
      condition: t.condition,
      impact: t.impact,
      reasoningSummary: `Mock provider 基于静态候选与读取的代码行复核；引用 ${
        guideline ? `规范「${guideline.title}」` : '无命中规范'
      }。此结果由 Mock 生成，不代表真实模型能力。`,
      recommendation: t.recommendation,
      guidelineChunkIds: this.guidelineResults.map((g) => g.chunkId),
    }
  }
}

/* ---------------- 真实 Provider（OpenAI 兼容，AI SDK） ---------------- */

class RealChatProvider implements ChatProvider {
  readonly isMock = false
  readonly ready: boolean

  constructor(
    public readonly id: string,
    private readonly init: { baseURL?: string; apiKey?: string },
  ) {
    this.ready = Boolean(init.apiKey)
  }

  async chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    const { generateText, tool: aiTool } = await import('ai')
    const { createOpenAI } = await import('@ai-sdk/openai')
    const openai = createOpenAI({ baseURL: this.init.baseURL, apiKey: this.init.apiKey })

    // Record 值类型用 Tool 默认泛型（Tool<any, any>）：inputSchema 来自 ZodTypeAny，
    // 无法逐工具静态推断 INPUT，类型层面由 generateText 的 tools 参数统一校验。
    const tools: Record<string, Tool> = {}
    for (const spec of opts.tools) {
      tools[spec.name] = aiTool({
        description: spec.description,
        inputSchema: spec.parameters,
      })
    }

    const result = await generateText({
      // 明确使用 Chat Completions endpoint（而非 Responses API）：工具消息结构
      // 与 usage 字段映射按 Chat Completions 语义处理
      model: openai.chat(this.id),
      system: opts.system,
      messages: opts.messages,
      tools,
      maxOutputTokens: opts.maxOutputTokens,
      abortSignal: opts.abortSignal,
    })

    const usage = result.usage as
      | { inputTokens?: number; outputTokens?: number; totalInputTokens?: number; totalOutputTokens?: number }
      | undefined
    return {
      text: result.text ?? '',
      toolCalls: (result.toolCalls ?? []).map((c) => ({
        id: c.toolCallId,
        name: c.toolName,
        args: c.input,
      })),
      usage: {
        inputTokens: usage?.totalInputTokens ?? usage?.inputTokens ?? null,
        outputTokens: usage?.totalOutputTokens ?? usage?.outputTokens ?? null,
      },
    }
  }
}

export function getChatProvider(mockScript?: MockScriptInput): ChatProvider {
  const status = aiProviderStatus()
  if (status.chatReady && status.chatModel) {
    return new RealChatProvider(status.chatModel, {
      baseURL: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
    })
  }
  // Mock（无密钥）：明确标记，不冒充真实模型
  return new MockChatProvider(mockScript ?? { candidateFindings: [] })
}

/**
 * 追问用：chat 已配置时返回真实 provider，否则返回 null
 * （调用方使用 ConversationMockProvider，扫描 Mock 的脚本化流程不适用于追问）。
 */
export function getRealChatProvider(): ChatProvider | null {
  const status = aiProviderStatus()
  if (status.chatReady && status.chatModel) {
    return new RealChatProvider(status.chatModel, {
      baseURL: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
    })
  }
  return null
}

export function isMockProviderActive(): boolean {
  return !aiProviderStatus().chatReady
}

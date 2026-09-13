import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createTestDb, type TestDb } from '../helpers/db'
import { buildDeflateZip } from '../helpers/zip'
import { prepareSnapshot } from '../../src/core/import'
import { persistSnapshot } from '../../src/server/snapshots'
import { runAiReviewStage } from '../../src/core/review/orchestrator'
import {
  reserveDailyTokens,
  settleDailyReservation,
  releaseDailyReservation,
} from '../../src/core/review/daily-budget'
import { seedAll } from '../../src/server/db/seed'
import type { ChatProvider, ProviderChatOptions, ProviderResult } from '../../src/core/review/provider'

/**
 * R04 可控 AI 与证据验证（故障矩阵）：
 * 日额度原子预留/结算/释放、白名单、修复轮区分、取消后无新请求、Mock 标签。
 * 全部使用受控 provider（脚本化），不调用真实模型。
 */

let db: TestDb
let storageRoot: string
let projectId: string
let snapshotId: string
/** 用真实 chunk 文本片段做检索词，保证词法命中 */
let retrievalQuery = 'eval'

const FILE_A = ['function a() {', '  return 1', '}', ''].join('\n')

const SAMPLE_FILES: Array<{ name: string; content: string }> = [
  { name: 'src/a.js', content: FILE_A },
  { name: 'package.json', content: '{"name":"t"}' },
]

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ai-review-'))
  const { env } = await import('../../src/server/env')
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })
  await seedAll(db.sql)

  const zip = await buildDeflateZip(SAMPLE_FILES)
  const prepared = await prepareSnapshot(zip)
  const project = await db.sql`insert into projects (name) values ('AI 审查测试') returning id`
  projectId = (project[0] as { id: string }).id
  const summary = await persistSnapshot(db.sql, projectId, prepared)
  snapshotId = summary.id
  // 取一条真实规范文本片段作为检索词（保证词法命中，不依赖 seed 具体措辞）
  const sample = (await db.sql`select c.text from chunks c join documents d on d.id = c.document_id
    where d.is_builtin = true limit 1`)[0] as { text: string } | undefined
  if (sample && sample.text.length > 10) retrievalQuery = sample.text.slice(0, 20)
})

afterAll(async () => {
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

/** 脚本化受控 provider：按步骤返回预设结果 */
class ScriptedProvider implements ChatProvider {
  readonly id = 'scripted-test'
  readonly isMock = false
  readonly ready = true
  private step = 0
  chatCount = 0

  constructor(private script: Array<(opts: ProviderChatOptions) => ProviderResult>) {}

  async chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    const fn = this.script[Math.min(this.step, this.script.length - 1)]!
    this.step++
    this.chatCount++
    return fn(opts)
  }
}

function toolCall(id: string, name: string, args: unknown) {
  return [{ id, name, args }]
}

const baseCtx = {
  scanId: '00000000-0000-0000-0000-0000000000aa',
  snapshotId: '',
  projectId: '',
  staticFindings: [],
  staticCandidates: [
    {
      path: 'src/a.js',
      startLine: 1,
      endLine: 3,
      title: '候选问题',
      category: 'security',
      severity: 'low',
      condition: 'c',
      impact: 'i',
      recommendation: 'r',
    },
  ],
  analyzablePaths: ['src/a.js'],
  structure: null,
  cancelRequested: async () => false,
}

/** 读取候选文件 + 检索规范 + 提交 drafts 的三步脚本 */
function readRetrieveSubmitScript(
  drafts: (retrievedChunks: Array<{ chunkId: string }>) => unknown,
): Array<(opts: ProviderChatOptions) => ProviderResult> {
  return [
    () => ({
      text: '',
      toolCalls: toolCall('s1', 'read_file', { path: 'src/a.js', startLine: 1, endLine: 3 }),
      usage: { inputTokens: 100, outputTokens: 10 },
    }),
    () => ({
      text: '',
      toolCalls: toolCall('s2', 'retrieve_guidelines', { query: retrievalQuery, topK: 3 }),
      usage: { inputTokens: 150, outputTokens: 10 },
    }),
    (opts) => {
      // 从工具结果提取检索返回的 chunkId（白名单验证用）
      let retrieved: Array<{ chunkId: string }> = []
      for (const m of opts.messages) {
        if (m.role !== 'tool') continue
        for (const part of m.content) {
          if (part.type === 'tool-result' && part.toolName === 'retrieve_guidelines') {
            const out = part.output as { type: string; value?: { chunks?: Array<{ chunkId: string }> } }
            if (out?.type === 'json' && out.value?.chunks) retrieved = out.value.chunks
          }
        }
      }
      return {
        text: 'ok',
        toolCalls: toolCall('s3', 'submit_findings', drafts(retrieved)),
        usage: { inputTokens: 200, outputTokens: 30 },
      }
    },
  ]
}

async function createScanRow(): Promise<string> {
  const rows = await db.sql`insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
    values (${snapshotId}, ${'ai-' + Math.random().toString(36).slice(2, 10)}, 'queued', 'ingest', '{"enableCloudAI":true,"mode":"standard"}'::jsonb, 'v', 'v')
    returning id`
  return (rows[0] as { id: string }).id
}

describe('R04 日额度：原子预留/结算/释放（A04 reservation 绑定）', () => {
  it('预留成功 → 结算（实测优先）→ 预留释放', async () => {
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
    const r = await reserveDailyTokens(db.sql, 100)
    expect(r).not.toBeNull()
    let row = (await db.sql`select reserved_tokens, input_tokens, output_tokens, requests from daily_usage`)[0] as unknown as {
      reserved_tokens: number
      input_tokens: number
      output_tokens: number
      requests: number
    }
    expect(row.reserved_tokens).toBe(100)

    await settleDailyReservation(db.sql, r!, 80, 20)
    row = (await db.sql`select reserved_tokens, input_tokens, output_tokens, requests from daily_usage`)[0] as unknown as typeof row
    expect(row.reserved_tokens).toBe(0)
    expect(row.input_tokens).toBe(80)
    expect(row.output_tokens).toBe(20)
    expect(row.requests).toBe(1)
  })

  it('调用失败：仅释放预留，不记账', async () => {
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
    const r = await reserveDailyTokens(db.sql, 50)
    expect(r).not.toBeNull()
    await releaseDailyReservation(db.sql, r!)
    const row = (await db.sql`select reserved_tokens, input_tokens, requests from daily_usage`)[0] as unknown as {
      reserved_tokens: number
      input_tokens: number
      requests: number
    }
    expect(row.reserved_tokens).toBe(0)
    expect(row.input_tokens).toBe(0)
    expect(row.requests).toBe(0)
  })

  it('日额度不足时预留被拒绝（used + reserved + n ≤ 限额）', async () => {
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
    // 用满大部分额度（限额默认 300000）
    await db.sql`insert into daily_usage (day, input_tokens) values (to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 299000)`
    expect(await reserveDailyTokens(db.sql, 500)).not.toBeNull() // 299000 + 500 = 299500 ≤ 300000
    expect(await reserveDailyTokens(db.sql, 500)).not.toBeNull() // 299000 + 500 + 500 = 300000 恰好达限
    expect(await reserveDailyTokens(db.sql, 1)).toBeNull() // 超限拒绝
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
  })

  it('并发预留不超限（原子条件写）；预留台账行数与授予数一致', async () => {
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
    await db.sql`insert into daily_usage (day, input_tokens) values (to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 295000)`
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveDailyTokens(db.sql, 1000)),
    )
    const granted = results.filter((r) => r !== null).length
    expect(granted).toBe(5) // 295000 + 5*1000 = 300000 封顶
    const ledger = (await db.sql`select count(*)::int as c from daily_reservations where state = 'reserved'`)[0] as unknown as { c: number }
    expect(ledger.c).toBe(5)
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
  })
})

describe('R04 AI 阶段：证据与预算故障矩阵', () => {
  it('完整链路：读取→检索→白名单引用→落库→usage（受控 provider）', async () => {
    const scanId = await createScanRow()
    const provider = new ScriptedProvider(
      readRetrieveSubmitScript((retrieved) => ({
        findings: [
          {
            title: 'AI：a 函数无返回类型注解',
            category: 'maintainability',
            severity: 'low',
            confidence: 0.9,
            primary: { path: 'src/a.js', startLine: 1, endLine: 3, quote: FILE_A.replace(/\n$/, '') },
            related: [],
            condition: 'c',
            impact: 'i',
            reasoningSummary: '基于读取行',
            recommendation: 'r',
            guidelineChunkIds: retrieved.map((c) => c.chunkId),
          },
        ],
      })),
    )
    const outcome = await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    expect(outcome.status).toBe('completed')
    expect(outcome.insertedCount).toBe(1)
    expect(outcome.usage.provider).toBe('openai') // 受控 provider 非真实模型，不冒充
    expect(outcome.usage.modelCalls).toBe(3)
    expect(outcome.usage.inputTokensMeasured).toBe(450) // 100+150+200 实测累计
    // 规范引用快照落库（引用的是本轮检索返回的 chunk）
    const citations = await db.sql`select count(*)::int as c from scan_citations where scan_id = ${scanId}`
    expect((citations[0] as { c: number }).c).toBeGreaterThan(0)
    // 白名单有效：无 invalid
    expect(outcome.invalidCount).toBe(0)
    expect(outcome.repairOutcome).toBe('not_needed')
  })

  it('伪造引文（quote 不在快照行）→ invalid，修复轮重交有效结果', async () => {
    const scanId = await createScanRow()
    // 第一轮：提交伪造引文；第二轮（修复）：提交正确引文
    const provider = new ScriptedProvider([
      ...readRetrieveSubmitScript(() => ({
        findings: [
          {
            title: '坏结论',
            category: 'security',
            severity: 'high',
            confidence: 0.9,
            primary: { path: 'src/a.js', startLine: 1, endLine: 3, quote: 'fabricated quote' },
            related: [],
            condition: 'c',
            impact: 'i',
            reasoningSummary: 'r',
            recommendation: 'm',
            guidelineChunkIds: [],
          },
        ],
      })),
      () => ({
        text: '',
        toolCalls: toolCall('fix1', 'submit_findings', {
          findings: [
            {
              title: '修正后结论',
              category: 'security',
              severity: 'low',
              confidence: 0.9,
              primary: { path: 'src/a.js', startLine: 1, endLine: 3, quote: FILE_A.replace(/\n$/, '') },
              related: [],
              condition: 'c',
              impact: 'i',
              reasoningSummary: 'r',
              recommendation: 'm',
              guidelineChunkIds: [],
            },
          ],
        }),
        usage: { inputTokens: 300, outputTokens: 40 },
      }),
    ])
    const outcome = await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    expect(outcome.repairUsed).toBe(true)
    expect(outcome.repairOutcome).toBe('resubmitted')
    expect(outcome.insertedCount).toBe(1)
    // 落库的是修正后标题
    const rows = await db.sql`select draft_json->>'title' as title from findings where scan_id = ${scanId} and source = 'ai'`
    expect((rows[0] as { title: string }).title).toBe('修正后结论')
  })

  it('修复轮未重新提交：保留前轮有效结果，标记 no_submission', async () => {
    const scanId = await createScanRow()
    const provider = new ScriptedProvider([
      // 第一轮：一条有效 + 一条伪造
      ...readRetrieveSubmitScript(() => ({
        findings: [
          {
            title: '有效结论',
            category: 'security',
            severity: 'low',
            confidence: 0.9,
            primary: { path: 'src/a.js', startLine: 1, endLine: 3, quote: FILE_A.replace(/\n$/, '') },
            related: [],
            condition: 'c',
            impact: 'i',
            reasoningSummary: 'r',
            recommendation: 'm',
            guidelineChunkIds: [],
          },
          {
            title: '伪造结论',
            category: 'security',
            severity: 'high',
            confidence: 0.9,
            primary: { path: 'src/a.js', startLine: 1, endLine: 3, quote: 'fake' },
            related: [],
            condition: 'c',
            impact: 'i',
            reasoningSummary: 'r',
            recommendation: 'm',
            guidelineChunkIds: [],
          },
        ],
      })),
      // 修复轮：纯文本，不提交
      () => ({ text: '无法修复', toolCalls: [], usage: { inputTokens: 300, outputTokens: 20 } }),
    ])
    const outcome = await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    expect(outcome.repairOutcome).toBe('no_submission')
    expect(outcome.insertedCount).toBe(1) // 前轮有效结果保留
    const rows = await db.sql`select draft_json->>'title' as title from findings where scan_id = ${scanId} and source = 'ai'`
    expect((rows[0] as { title: string }).title).toBe('有效结论')
    expect(outcome.invalidCount).toBe(1)
  })

  it('规范引用白名单：知识库中存在但本轮未检索返回的 chunk → invalid', async () => {
    const scanId = await createScanRow()
    const allChunkIds = ((await db.sql`select id from chunks`) as unknown as Array<{ id: string }>).map((r) => r.id)
    expect(allChunkIds.length).toBeGreaterThan(5)
    const provider = new ScriptedProvider(
      readRetrieveSubmitScript((retrieved) => {
        // 选一个本轮检索未返回的真实 chunk（存在但不在白名单）
        const outside = allChunkIds.find((id) => !retrieved.some((r) => r.chunkId === id))!
        return {
          findings: [
            {
              title: '白名单外引用',
              category: 'security',
              severity: 'low',
              confidence: 0.9,
              primary: { path: 'src/a.js', startLine: 1, endLine: 3, quote: FILE_A.replace(/\n$/, '') },
              related: [],
              condition: 'c',
              impact: 'i',
              reasoningSummary: 'r',
              recommendation: 'm',
              guidelineChunkIds: [outside],
            },
          ],
        }
      }),
    )
    const outcome = await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    expect(outcome.insertedCount).toBe(0) // 白名单外引用被拒
    // 原始 1 项 + 修复轮重交同样内容再 1 项（脚本耗尽后重复第 3 步）
    expect(outcome.invalidCount).toBe(2)
    expect(outcome.repairOutcome).not.toBe('not_needed') // 触发修复
  })

  it('日额度耗尽：不再发起新模型请求，终态 partial + budget 降级', async () => {
    const scanId = await createScanRow()
    await db.sql`delete from daily_usage`
    await db.sql`insert into daily_usage (day, input_tokens) values (to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 299900)`
    const provider = new ScriptedProvider(readRetrieveSubmitScript(() => ({ findings: [] })))
    const outcome = await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    expect(provider.chatCount).toBe(0) // 预留失败，未发起任何模型请求
    expect(outcome.status).toBe('partial')
    expect(outcome.coverageAi.degradedReason).toBe('budget_exceeded')
    expect(outcome.usage.modelCalls).toBe(0)
    await db.sql`delete from daily_usage`
  })

  it('取消后：不再发起新模型请求（工具边界检测）', async () => {
    const scanId = await createScanRow()
    const provider = new ScriptedProvider(
      readRetrieveSubmitScript(() => ({ findings: [] })),
    )
    const outcome = await runAiReviewStage(db.sql, {
      ...baseCtx,
      scanId,
      snapshotId,
      projectId,
      provider,
      cancelRequested: async () => false,
    })
    // 未取消时正常完成
    expect(outcome.status).toBe('completed')
    expect(provider.chatCount).toBe(3)

    // 取消场景：第一次调用后取消
    const scanId2 = await createScanRow()
    let calls = 0
    let cancel = false
    const provider2 = new ScriptedProvider([
      () => {
        calls++
        return {
          text: '',
          toolCalls: toolCall('c1', 'read_file', { path: 'src/a.js', startLine: 1, endLine: 3 }),
          usage: { inputTokens: 100, outputTokens: 10 },
        }
      },
      () => {
        calls++
        return { text: '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } }
      },
    ])
    const outcome2 = await runAiReviewStage(db.sql, {
      ...baseCtx,
      scanId: scanId2,
      snapshotId,
      projectId,
      provider: provider2,
      cancelRequested: async () => {
        if (calls >= 1) cancel = true
        return cancel
      },
    })
    expect(calls).toBe(1) // 取消后没有第二次模型请求
    expect(outcome2.status).toBe('partial') // 取消中断：不冒充完成
    expect(outcome2.insertedCount).toBe(0)
  })

  it('Mock 标签：mock provider 的 usage.provider 为 mock，不消耗日额度', async () => {
    const scanId = await createScanRow()
    await db.sql`delete from daily_usage`
    const { MockChatProvider } = await import('../../src/core/review/provider')
    const provider = new MockMockWrapper(new MockChatProvider({ candidateFindings: baseCtx.staticCandidates }))
    const outcome = await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    expect(outcome.usage.provider).toBe('mock')
    const usageRow = await db.sql`select count(*)::int as c from daily_usage`
    expect((usageRow[0] as { c: number }).c).toBe(0) // Mock 不预留不记账
  })

  it('A04 Mock 与真实混合：当天已有真实额度行时，Mock 扫描不改动该行', async () => {
    const scanId = await createScanRow()
    await db.sql`delete from daily_usage`
    await db.sql`delete from daily_reservations`
    await db.sql`insert into daily_usage (day, input_tokens, output_tokens, requests)
      values (to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 123, 45, 2)`
    const { MockChatProvider } = await import('../../src/core/review/provider')
    const provider = new MockMockWrapper(new MockChatProvider({ candidateFindings: baseCtx.staticCandidates }))
    await runAiReviewStage(db.sql, { ...baseCtx, scanId, snapshotId, projectId, provider })
    const row = (await db.sql`select input_tokens, output_tokens, requests, reserved_tokens from daily_usage`)[0] as unknown as {
      input_tokens: number
      output_tokens: number
      requests: number
      reserved_tokens: number
    }
    expect(row).toEqual({ input_tokens: 123, output_tokens: 45, requests: 2, reserved_tokens: 0 })
    const reservations = (await db.sql`select count(*)::int as c from daily_reservations`)[0] as unknown as { c: number }
    expect(reservations.c).toBe(0) // Mock 完全跳过真实额度操作
    await db.sql`delete from daily_usage`
  })
})

/** A03 单扫描预算执行：本次输入预留、输出收缩、实测超限、工具载荷、在途中止 */
describe('A03 单扫描预算：预留/收缩/实测优先/工具载荷', () => {
  it('剩余输入不足：本次输入 + 输出上限放不进剩余额度时不发起任何调用', async () => {
    const scanId = await createScanRow()
    const provider = new ScriptedProvider(readRetrieveSubmitScript(() => ({ findings: [] })))
    const outcome = await runAiReviewStage(db.sql, {
      ...baseCtx, scanId, snapshotId, projectId, provider,
      budgetConfig: { maxInputTokens: 10 },
    })
    expect(provider.chatCount).toBe(0)
    expect(outcome.status).toBe('partial')
    expect(outcome.coverageAi.degradedReason).toBe('budget_exceeded')
    expect(outcome.usage.modelCalls).toBe(0)
  })

  it('实测输出超限（measured 优先）：首次调用后不再发起后续请求', async () => {
    const scanId = await createScanRow()
    const provider = new ScriptedProvider([
      () => ({
        text: '',
        toolCalls: toolCall('m1', 'read_file', { path: 'src/a.js', startLine: 1, endLine: 3 }),
        usage: { inputTokens: 100, outputTokens: 600 }, // 实测 600 > 上限 500
      }),
    ])
    const outcome = await runAiReviewStage(db.sql, {
      ...baseCtx, scanId, snapshotId, projectId, provider,
      budgetConfig: { maxOutputTokens: 500 },
    })
    expect(provider.chatCount).toBe(1)
    expect(outcome.status).toBe('partial')
    expect(outcome.coverageAi.degradedReason).toBe('budget_exceeded')
    expect(outcome.usage.outputTokensMeasured).toBe(600)
    expect(outcome.usage.modelCalls).toBe(1)
  })

  it('工具载荷巨大但 text 为空不绕输出额度：输出估算含工具参数', async () => {
    const scanId = await createScanRow()
    const provider = new ScriptedProvider([
      () => ({
        text: '', // text 为空：旧实现只估算 text 会漏算
        toolCalls: toolCall('big1', 'read_file', {
          path: 'src/a.js',
          startLine: 1,
          endLine: 3,
          padding: 'x'.repeat(400), // 模型生成的大参数载荷（多余键由工具端忽略）
        }),
        usage: { inputTokens: 100, outputTokens: null }, // 实测未知 → 回退保守估算
      }),
    ])
    const outcome = await runAiReviewStage(db.sql, {
      ...baseCtx, scanId, snapshotId, projectId, provider,
      budgetConfig: { maxOutputTokens: 50 },
    })
    expect(provider.chatCount).toBe(1) // 含载荷的输出估算 ≥ 50 → 不再调用
    expect(outcome.status).toBe('partial')
    expect(outcome.coverageAi.degradedReason).toBe('budget_exceeded')
    expect(outcome.usage.outputTokensEstimated).toBeGreaterThanOrEqual(50)
  })

  it('输出上限收缩：provider 收到 min(期望, 剩余输出额度)，且与日额度预留一致', async () => {
    const scanId = await createScanRow()
    const received: number[] = []
    const provider = new ScriptedProvider(
      readRetrieveSubmitScript(() => ({ findings: [] })).map((step) => (opts: ProviderChatOptions) => {
        received.push(opts.maxOutputTokens)
        return step(opts)
      }),
    )
    const outcome = await runAiReviewStage(db.sql, {
      ...baseCtx, scanId, snapshotId, projectId, provider,
      budgetConfig: { maxOutputTokens: 300 },
    })
    expect(received.length).toBe(3)
    for (const cap of received) expect(cap).toBeLessThanOrEqual(300)
    // 预留与允许输出一致：成功调用结算后 reserved 归零、requests 增加
    const daily = (await db.sql`select reserved_tokens from daily_usage`)[0] as unknown as
      | { reserved_tokens: number }
      | undefined
    if (daily) expect(daily.reserved_tokens).toBe(0)
    expect(outcome.usage.modelCalls).toBe(3)
  })

  it('接近整体 deadline 的在途调用被中止：中止后预留释放、未记账', async () => {
    const scanId = await createScanRow()
    await db.sql`delete from daily_usage`
    const provider: ChatProvider = {
      id: 'hang',
      isMock: false,
      ready: true,
      chat(opts: ProviderChatOptions) {
        return new Promise<ProviderResult>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ text: 'late', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }),
            5000,
          )
          opts.abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      },
    }
    await expect(runAiReviewStage(db.sql, {
      ...baseCtx, scanId, snapshotId, projectId, provider,
      budgetConfig: { wallMs: 60 }, // 整体墙钟 60ms < 单请求 30s：在途调用须被中止
    })).rejects.toThrow()
    const daily = (await db.sql`select input_tokens, output_tokens, reserved_tokens, requests from daily_usage`)[0] as unknown as {
      input_tokens: number
      output_tokens: number
      reserved_tokens: number
      requests: number
    }
    // 未完成的调用不记账；预留已释放
    expect(daily).toEqual({ input_tokens: 0, output_tokens: 0, reserved_tokens: 0, requests: 0 })
    await db.sql`delete from daily_usage`
  })
})

/** Mock 包装：透传（保持 isMock 标记） */
class MockMockWrapper implements ChatProvider {
  readonly id: string
  readonly isMock = true
  readonly ready = true
  constructor(private inner: ChatProvider) {
    this.id = inner.id
  }
  chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    return this.inner.chat(opts)
  }
}

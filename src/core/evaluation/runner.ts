import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { prepareSnapshot } from '@/core/import'
import { persistSnapshot } from '@/server/snapshots'
import { asPgJson, asJson } from '@/server/db/json'
import { processScanJob } from '@/worker/scanner'
import { LeaseKeeper, LeaseLostError, leaseGuarded, type LeaseInfo } from '@/worker/jobs'
import { matchesQuote } from '@/core/review/validate'
import { runStaticRules } from '@/core/rules'
import {
  getChatProvider,
  type ChatProvider,
  type MockScriptInput,
  type ProviderChatOptions,
  type ProviderResult,
} from '@/core/review/provider'
import type { FindingDraft } from '@/core/contracts/findings'
import { SCAN_RULE_VERSION, PROMPT_VERSION } from '@/core/contracts/scan'
import type { UsageInfo } from '@/core/contracts/scan'
import {
  EVALUATION_DISCLAIMER,
  EVALUATION_MODE_LABELS,
  type EvaluationMetricsJson,
  type EvaluationMode,
  type EvaluationSplit,
  type MetricSummary,
} from '@/core/contracts/evaluation'
import {
  aggregateMetrics,
  computeProjectMetrics,
  percentile,
  type MetricCandidate,
} from './metrics'
import type { LoadedDataset, LoadedDatasetProject } from './dataset'
import { buildStoredZip } from './zip'
import { EvaluationMockProvider } from './mock-provider'

/**
 * 评测执行器（规格 13 / R08）：对 fixtures 逐项目执行与生产完全一致的核心扫描管线
 * （真实导入 → 六阶段扫描 → findings 落库），在隔离的预置样例范围执行，
 * 不借用任何会话快照。逐项目收集 TP/FP/FN、无效引用、延迟、token，
 * 汇总为 evaluations.metrics_json；任何展示数字可回溯到逐项目 scanId 与原始结果。
 *
 * 三模式固定配置（消融仅切换 RAG）：
 * - static_only：enableCloudAI=false，纯静态规则（确定性、无模型调用）；
 * - llm_no_rag：enableCloudAI=true + provider 不使用规范检索；
 * - hybrid_rag：enableCloudAI=true + provider 使用混合检索。
 * 无真实模型凭证时使用受控 Mock provider 并在结果中标注 provider=mock。
 */

export const EVALUATION_MODES: Record<
  EvaluationMode,
  { enableCloudAI: boolean; useRag: boolean }
> = {
  static_only: { enableCloudAI: false, useRag: false },
  llm_no_rag: { enableCloudAI: true, useRag: false },
  hybrid_rag: { enableCloudAI: true, useRag: true },
}

export type ProviderFactory = (
  script: MockScriptInput,
  files: Array<{ path: string; content: string }>,
  useRag: boolean,
) => ChatProvider

/** llm_no_rag 模式（真实 provider）：从工具清单中移除规范检索，固定其他配置 */
class NoRagProviderWrapper implements ChatProvider {
  constructor(private readonly inner: ChatProvider) {}
  get id(): string {
    return this.inner.id
  }
  get isMock(): boolean {
    return this.inner.isMock
  }
  get ready(): boolean {
    return this.inner.ready
  }
  chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    return this.inner.chat({
      ...opts,
      tools: opts.tools.filter((t) => t.name !== 'retrieve_guidelines'),
    })
  }
}

export interface RunEvaluationOptions {
  evaluationId: string
  dataset: LoadedDataset
  mode: EvaluationMode
  split: EvaluationSplit
  /** 限制执行的项目数（split 过滤后截取；e2e/集成用小子集提速，口径记录在 metrics.config） */
  projectLimit?: number
  /** 失租/中止信号（评测任务租约丢失时由 worker 触发） */
  signal?: AbortSignal
  /** 评测任务取消检查（每个项目边界调用） */
  isCancelRequested?: () => Promise<boolean>
  /** 注入 provider（测试）；缺省 chatReady ? 真实 provider : 受控 Mock（明确标注） */
  providerFactory?: ProviderFactory
  onProjectDone?: (projectId: string, index: number, total: number) => void
  /** 执行方标识（写入 config，用于区分 worker 队列任务与 CLI 直跑） */
  executor?: 'worker' | 'cli'
  /**
   * 父评测任务租约（A08）：worker 队列任务必须传入 —— evaluations 状态/指标
   * 与逐项目完成记录的全部写入都在该租约事务内条件写（失租即 LeaseLostError，
   * 旧执行器不能写回结果）。CLI 直跑无父任务，退化为普通事务。
   */
  job?: LeaseInfo
}

export interface EvaluationRunResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  metricsJson: EvaluationMetricsJson
}

interface FindingRow {
  rule_id: string | null
  draft_json: unknown
  source: string
}

function languageOf(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'ts') return 'ts'
  if (ext === 'tsx') return 'tsx'
  if (ext === 'jsx') return 'jsx'
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js'
  if (ext === 'vue') return 'vue'
  return 'json'
}

function tokensOfUsage(usage: UsageInfo | null): number {
  if (!usage) return 0
  const input = usage.inputTokensMeasured ?? usage.inputTokensEstimated
  const output = usage.outputTokensMeasured ?? usage.outputTokensEstimated
  return input + output
}

/** 默认 provider 工厂：chatReady 走真实 provider；否则受控 Mock（明确标注 mock） */
export function defaultProviderFactory(script: MockScriptInput, files: Array<{ path: string; content: string }>, useRag: boolean): ChatProvider {
  const real = getChatProvider(script)
  if (real.ready && !real.isMock) {
    return useRag ? real : new NoRagProviderWrapper(real)
  }
  return new EvaluationMockProvider({ ...script, files, useRag })
}

/**
 * 执行一次评测并写回 evaluations 行（status: pending → running → completed/partial/failed/cancelled）。
 * 单个项目失败不中断整体（记录失败、继续，终态 partial）；评测任务取消在项目边界生效。
 */
export async function runEvaluation(
  sql: postgres.Sql,
  opts: RunEvaluationOptions,
): Promise<EvaluationRunResult> {
  const { dataset, mode } = opts
  const modeConfig = EVALUATION_MODES[mode]

  let projects = dataset.projects.filter(
    (p) => opts.split === 'all' || p.split === opts.split,
  )
  if (opts.projectLimit !== undefined && opts.projectLimit > 0) {
    projects = projects.slice(0, opts.projectLimit)
  }

  const workerId = `eval-${randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()

  // A08：父评测租约参与进度/终态/逐项目记录写事务 —— worker 队列任务的全部
  // evaluations 写入都在租约事务内条件写（失租抛 LeaseLostError，旧执行器不能写回）。
  // CLI 直跑无父任务，退化为普通事务。
  const writeEvaluation = async (fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> => {
    if (opts.job) {
      await leaseGuarded(sql, opts.job, fn)
    } else {
      await sql.begin(fn)
    }
  }

  // A08 恢复：加载已保存的逐项目完成记录 —— 恢复时复用已有 scan 与指标，
  // 不重新创建样例、不重复调用模型
  const priorRows = (await sql`
    select project_id, scan_id, status, metrics_json, latency_ms, token_total, provider_is_mock, provider, model_id
    from evaluation_projects
    where evaluation_id = ${opts.evaluationId}`) as unknown as Array<{
    project_id: string
    scan_id: string
    status: string
    metrics_json: unknown
    latency_ms: number
    token_total: number
    provider_is_mock: boolean
    provider: 'mock' | 'openai'
    model_id: string | null
  }>
  const priorByProject = new Map(priorRows.map((r) => [r.project_id, r]))

  await writeEvaluation(async (tx) => {
    await tx`update evaluations set status = 'running', error_text = null where id = ${opts.evaluationId}`
  })

  const outcomes: ProjectOutcome[] = []
  const failures: Array<{ projectId: string; error: string }> = []
  let cancelledMidway = false

  for (let index = 0; index < projects.length; index++) {
    const project = projects[index]!
    // 项目边界取消检查（不再新增工作；已完成部分保留）
    if (opts.signal?.aborted) {
      cancelledMidway = true
      break
    }
    if (opts.isCancelRequested && (await opts.isCancelRequested())) {
      cancelledMidway = true
      break
    }
    const prior = priorByProject.get(project.id)
    if (prior) {
      // A08 恢复：该项目此前已完成（记录在父评测租约事务内保存）—— 复用 scan 与指标
      outcomes.push({
        projectId: project.id,
        kind: project.kind,
        categoryKey: project.categoryKey,
        split: project.split,
        scanId: prior.scan_id,
        scanStatus: prior.status,
        latencyMs: prior.latency_ms,
        metrics: asJson<MetricSummary>(prior.metrics_json),
        tokenTotal: prior.token_total,
        providerIsMock: prior.provider_is_mock,
        provider: prior.provider,
        modelId: prior.model_id,
      })
      opts.onProjectDone?.(project.id, index + 1, projects.length)
      continue
    }
    try {
      const outcome = await runSingleProject(sql, {
        evaluationId: opts.evaluationId,
        datasetVersion: dataset.info.version,
        project,
        mode,
        modeConfig,
        workerId,
        signal: opts.signal,
        providerFactory: opts.providerFactory,
      })
      outcomes.push(outcome)
      // A08：逐项目完成记录（父评测租约事务内条件写）：崩溃/失租后恢复时
      // 该项目不再重复执行，直接复用已有 scan
      await writeEvaluation(async (tx) => {
        await tx`insert into evaluation_projects
          (evaluation_id, project_id, scan_id, status, metrics_json, latency_ms, token_total, provider_is_mock, provider, model_id)
          values (${opts.evaluationId}, ${outcome.projectId}, ${outcome.scanId}, ${outcome.scanStatus},
            ${sql.json(asPgJson(outcome.metrics))}, ${outcome.latencyMs}, ${outcome.tokenTotal},
            ${outcome.providerIsMock}, ${outcome.provider}, ${outcome.modelId})
          on conflict (evaluation_id, project_id) do nothing`
      })
      opts.onProjectDone?.(project.id, index + 1, projects.length)
    } catch (err) {
      if (err instanceof LeaseLostError) throw err
      failures.push({
        projectId: project.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      })
    }
  }

  const perProjectMetrics = outcomes.map((o) => o.metrics)
  const totals = aggregateMetrics(perProjectMetrics)
  const latencies = outcomes.map((o) => o.latencyMs)
  const tokenTotal = outcomes.reduce((acc, o) => acc + o.tokenTotal, 0)
  // 无已完成项目时按保守口径标注 mock（不得冒充真实模型）
  const providerIsMock = outcomes.length > 0 ? outcomes[0]!.providerIsMock : true
  const providerLabel = outcomes.length > 0 ? outcomes[0]!.provider : 'mock'
  const modelId = outcomes.length > 0 ? outcomes[0]!.modelId : null
  const projectResults: EvaluationMetricsJson['projects'] = outcomes.map((o) => ({
    projectId: o.projectId,
    kind: o.kind,
    categoryKey: o.categoryKey,
    split: o.split,
    scanId: o.scanId,
    scanStatus: o.scanStatus,
    latencyMs: o.latencyMs,
    tokenTotal: o.tokenTotal,
    metrics: o.metrics,
  }))

  let status: EvaluationRunResult['status']
  if (projects.length === 0) {
    status = 'failed'
  } else if (cancelledMidway && projectResults.length === 0) {
    status = 'cancelled'
  } else if (failures.length > 0 || cancelledMidway) {
    status = 'partial'
  } else {
    status = 'completed'
  }

  const note =
    mode === 'static_only'
      ? '静态规则确定性结果（无模型调用）。样例集与静态规则对齐，本结果只说明管线行为，不代表真实项目表现。'
      : providerIsMock
        ? '真实模型评测未执行（无凭证）：本结果为受控 Mock 管线验证（provider=mock），不冒充真实模型指标。'
        : '真实模型运行结果（消耗预算受日额度上限约束）。'

  const metricsJson: EvaluationMetricsJson = {
    config: {
      datasetVersion: dataset.info.version,
      mode,
      modeLabel: EVALUATION_MODE_LABELS[mode],
      split: opts.split,
      ruleVersion: SCAN_RULE_VERSION,
      promptVersion: PROMPT_VERSION,
      modelId,
      provider: providerLabel,
      providerIsMock,
      ragEnabled: modeConfig.useRag,
      realModelRun: modeConfig.enableCloudAI && !providerIsMock,
      executor: opts.executor ?? 'worker',
      projectLimit: opts.projectLimit ?? null,
      projectCount: projectResults.length,
      cancelled: cancelledMidway,
      executedAt: startedAt,
      note,
    },
    totals,
    latency: {
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      samples: latencies.length,
    },
    tokens: {
      total: tokenTotal,
      perProject:
        projectResults.length > 0 ? tokenTotal / projectResults.length : null,
      inputEstimated: 0,
      outputEstimated: 0,
      inputMeasured: null,
      outputMeasured: null,
    },
    projects: projectResults,
    failures,
    disclaimer: EVALUATION_DISCLAIMER,
  }

  const errorText =
    projects.length === 0
      ? `没有匹配的样例项目（split=${opts.split}）`
      : failures.length > 0
        ? `${failures.length} 个样例执行失败`
        : null

  // A08：终态/指标写回在父评测租约事务内条件写（失租即 LeaseLostError，不写任何结果）
  await writeEvaluation(async (tx) => {
    await tx`update evaluations set status = ${status},
        metrics_json = ${sql.json(asPgJson(metricsJson))},
        error_text = ${errorText},
        completed_at = now()
      where id = ${opts.evaluationId}`
  })

  return { status, metricsJson }
}

interface SingleProjectOptions {
  evaluationId: string
  datasetVersion: string
  project: LoadedDatasetProject
  mode: EvaluationMode
  modeConfig: { enableCloudAI: boolean; useRag: boolean }
  workerId: string
  signal?: AbortSignal
  providerFactory?: ProviderFactory
}

interface ProjectOutcome {
  projectId: string
  kind: 'defect' | 'control'
  categoryKey: string
  split: 'dev' | 'holdout'
  scanId: string
  scanStatus: string
  latencyMs: number
  metrics: MetricSummary
  tokenTotal: number
  providerIsMock: boolean
  provider: 'mock' | 'openai'
  modelId: string | null
}

/** 单项目：真实导入（ZIP → prepareSnapshot → persistSnapshot）→ 六阶段扫描 → 指标 */
async function runSingleProject(
  sql: postgres.Sql,
  opts: SingleProjectOptions,
): Promise<ProjectOutcome> {
  const t0 = Date.now()
  const project = opts.project

  // 1. 隔离的预置样例项目（不属于任何会话；保留供结果回溯）
  const projectRows = (await sql`
    insert into projects (name, is_preset)
    values (${`[评测] ${opts.datasetVersion} ${project.id}`}, true)
    returning id`) as unknown as Array<{ id: string }>
  const projectId = projectRows[0]!.id

  // 2. 与用户上传完全一致的导入管线
  const zip = buildStoredZip(project.files.map((f) => ({ name: f.path, content: f.content })))
  const prepared = await prepareSnapshot(zip)
  const snapshot = await persistSnapshot(sql, projectId, prepared)

  // 3. 扫描 + 任务（available_at 后移 1 小时：由评测执行器直接领取，常规 worker 不抢占；
  //    评测执行器崩溃时任务仍可在租约过期后由常规 worker 接管完成）
  const scanRows = (await sql`
    insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
    values (${snapshot.id}, ${'eval-' + opts.evaluationId}, 'queued', 'ingest',
      ${sql.json(asPgJson({ enableCloudAI: opts.modeConfig.enableCloudAI, mode: 'standard' as const }))},
      ${SCAN_RULE_VERSION}, ${PROMPT_VERSION})
    returning id`) as unknown as Array<{ id: string }>
  const scanId = scanRows[0]!.id
  const jobRows = (await sql`
    insert into jobs (kind, target_id, available_at)
    values ('scan', ${scanId}, now() + interval '1 hour')
    returning id`) as unknown as Array<{ id: string }>
  const jobId = jobRows[0]!.id

  // 4. 直接领取扫描任务（评测执行器持有租约）
  const claimed = (await sql`
    update jobs set state = 'running', lease_owner = ${opts.workerId},
      lease_generation = jobs.lease_generation + 1,
      lease_until = now() + interval '30 seconds',
      attempt = jobs.attempt + 1, updated_at = now()
    where id = ${jobId} and state = 'queued'
    returning lease_generation, attempt`) as unknown as Array<{ lease_generation: number; attempt: number }>
  if (claimed.length === 0) {
    throw new Error('无法领取样例扫描任务（已被其他 worker 领取）')
  }
  const lease: LeaseInfo = {
    id: jobId,
    lease_owner: opts.workerId,
    lease_generation: claimed[0]!.lease_generation,
    attempt: claimed[0]!.attempt,
  }

  // 5. AI 模式：预计算静态候选作为受控脚本输入；无凭证 → 受控 Mock
  let provider: ChatProvider | undefined
  if (opts.modeConfig.enableCloudAI) {
    const pre = runStaticRules(
      project.files.map((f) => ({
        path: f.path,
        content: f.content,
        language: languageOf(f.path),
        parseOk: true,
        redactedRanges: [],
      })),
    )
    const script: MockScriptInput = {
      candidateFindings: pre.findings.map((f) => ({
        path: f.primary.path,
        startLine: f.primary.startLine,
        endLine: f.primary.endLine,
        title: f.title,
        category: f.category,
        severity: f.severity,
        condition: f.condition,
        impact: f.impact,
        recommendation: f.recommendation,
      })),
    }
    provider = opts.providerFactory
      ? opts.providerFactory(script, project.files, opts.modeConfig.useRag)
      : defaultProviderFactory(script, project.files, opts.modeConfig.useRag)
  }

  // 6. 核心扫描管线（与生产同一函数；租约续租期间保持）
  const controller = new AbortController()
  if (opts.signal) {
    const onAbort = () => controller.abort(opts.signal!.reason)
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const keeper = new LeaseKeeper(sql, lease, () => controller.abort())
  keeper.start(10_000)
  let scanStatus = 'failed'
  try {
    const result = await processScanJob(sql, {
      scanId,
      job: lease,
      signal: controller.signal,
      aiProvider: provider,
    })
    scanStatus = result.status
  } finally {
    keeper.stop()
  }

  // 7. 原始候选台账（A06）= 落库 findings（runner 复核引文）+ finding.invalid 事件
  //    （AI 验证阶段落库前丢弃的草稿 + validate 阶段删除的落库记录）。
  //    全部原始候选（含丢弃）纳入指标输入，一次性计算全部派生指标（不事后修字段）。
  const findingRows = (await sql`
    select rule_id, draft_json, source from findings where scan_id = ${scanId}`) as unknown as FindingRow[]
  const contentByPath = new Map(project.files.map((f) => [f.path, f.content]))
  const candidates: MetricCandidate[] = findingRows.map((row) => {
    const draft = asJson<FindingDraft>(row.draft_json)
    const content = contentByPath.get(draft.primary.path)
    let invalid = true
    if (content !== undefined) {
      try {
        invalid = !matchesQuote(content, draft.primary.startLine, draft.primary.endLine, draft.primary.quote)
      } catch {
        invalid = true
      }
    }
    return {
      path: draft.primary.path,
      category: draft.category,
      startLine: draft.primary.startLine,
      endLine: draft.primary.endLine,
      ruleId: row.rule_id,
      source: row.source,
      invalidCitation: invalid,
    }
  })
  const invalidEventRows = (await sql`
    select payload_json from scan_events
    where scan_id = ${scanId} and event_type = 'finding.invalid'`) as unknown as Array<{ payload_json: unknown }>
  for (const row of invalidEventRows) {
    const payload = asJson<{
      path?: string
      category?: FindingDraft['category']
      startLine?: number
      endLine?: number
    }>(row.payload_json)
    candidates.push({
      path: payload?.path ?? '',
      category: payload?.category ?? 'maintainability',
      startLine: payload?.startLine ?? 0,
      endLine: payload?.endLine ?? 0,
      ruleId: null,
      source: 'ai',
      invalidCitation: true,
    })
  }

  const metrics = computeProjectMetrics(project.annotations, candidates)

  const scanMeta = (await sql`select status, usage_json from scans where id = ${scanId}`)[0] as
    | { status: string; usage_json: unknown }
    | undefined
  const usage = scanMeta ? asJson<UsageInfo | null>(scanMeta.usage_json) : null
  const tokenTotal = tokensOfUsage(usage)

  return {
    projectId: project.id,
    kind: project.kind,
    categoryKey: project.categoryKey,
    split: project.split,
    scanId,
    scanStatus: scanMeta?.status ?? scanStatus,
    latencyMs: Date.now() - t0,
    metrics,
    tokenTotal,
    providerIsMock: provider ? provider.isMock : true,
    provider: provider && !provider.isMock ? 'openai' : 'mock',
    modelId: provider ? provider.id : null,
  }
}

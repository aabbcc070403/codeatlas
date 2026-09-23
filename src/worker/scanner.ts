import postgres from 'postgres'
import { emitScanEvent } from './events'
import {
  completeJob,
  isCancelRequested,
  leaseGuarded,
  assertLease,
  LeaseLostError,
  type LeaseInfo,
} from './jobs'
import { runStaticRules } from '@/core/rules'
import { computeRisk } from '@/core/report/risk'
import { SCAN_RULE_VERSION, PROMPT_VERSION } from '@/core/contracts/scan'
import type { CoverageInfo, ScanConfig, UsageInfo } from '@/core/contracts/scan'
import type { FindingDraft } from '@/core/contracts/findings'
import { readSnapshotFile } from '@/server/storage'
import { asJson, asPgJson } from '@/server/db/json'
import { runAiReviewStage } from '@/core/review/orchestrator'
import { matchesQuote } from '@/core/review/validate'
import type { ChatProvider } from '@/core/review/provider'

export type { LeaseInfo } from './jobs'
export { LeaseLostError } from './jobs'

interface ScanRow {
  id: string
  snapshot_id: string
  status: string
  stage: string
  config_json: unknown
  model_id: string | null
}

interface FileRow {
  path: string
  language: string
  line_count: number
  parse_status: string
  storage_key: string
  redacted_ranges: unknown
  content_hash: string
}

export interface ScanRunResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  findingCount: number
}

/**
 * 扫描管线（规格 9.1 / R03）：ingest → index → static → ai → validate → report。
 * - 阶段推进、取消落实、最终终态均在事务内确认租约（owner/generation/未过期），失租不能写结果；
 * - 恢复点：重试从已持久化的 scan.stage 继续，已发送过的阶段事件不重复发送；
 * - 失败区分：失租（LeaseLostError）不写任何状态；可重试异常不提前写终态，
 *   由 failJob 在尝试上限耗尽时与任务一致终结。
 */
export async function processScanJob(
  sql: postgres.Sql,
  opts: { scanId: string; job: LeaseInfo; aiProvider?: ChatProvider; signal?: AbortSignal },
): Promise<ScanRunResult> {
  const { scanId, job } = opts
  const scanRows = await sql`select id, snapshot_id, status, stage, config_json, model_id
    from scans where id = ${scanId}`
  if (scanRows.length === 0) {
    // 扫描已不存在（项目被删）：直接完结任务
    await completeJob(sql, job)
    return { status: 'cancelled', findingCount: 0 }
  }
  const scan = scanRows[0] as unknown as ScanRow
  if (['completed', 'partial', 'failed', 'cancelled'].includes(scan.status)) {
    // 崩溃恢复：终态已写入，不重复报告
    await completeJob(sql, job)
    return { status: scan.status as ScanRunResult['status'], findingCount: 0 }
  }
  const config = asJson<ScanConfig>(scan.config_json)

  const snapshotRows = await sql`select s.id, s.project_id, s.file_count, s.skipped_count
    from snapshots s where s.id = ${scan.snapshot_id}`
  const snapshot = snapshotRows[0] as unknown as {
    id: string
    project_id: string
    file_count: number
    skipped_count: number
  }

  // 恢复点（R03）：本次是新任务（queued）还是中断后的重试（running）
  const isResume = scan.status === 'running'
  // 已发送过的阶段事件（重试时不重复发送）
  const sentStages = new Set<string>()
  if (isResume) {
    const priorEvents = (await sql`select event_type, payload_json->>'stage' as stage
      from scan_events where scan_id = ${scanId}
        and event_type in ('stage.started', 'stage.completed')`) as unknown as Array<{
      event_type: string
      stage: string | null
    }>
    for (const e of priorEvents) {
      if (e.stage) sentStages.add(`${e.event_type}:${e.stage}`)
    }
  }
  /** 阶段事件仅首次发送（幂等），且在租约事务内写入（失租不能写事件） */
  const stageEvent = async (type: 'stage.started' | 'stage.completed', stage: string, payload: Record<string, unknown>) => {
    const key = `${type}:${stage}`
    if (sentStages.has(key)) return
    await leaseGuarded(sql, job, async (tx) => {
      await tx`insert into scan_events (scan_id, event_type, payload_json)
        values (${scanId}, ${type}, ${sql.json({ stage, ...payload } as unknown as postgres.JSONValue)})`
    })
    sentStages.add(key)
  }

  // 标记开始（首次）：租约事务内推进状态；scan.started 事件按持久化结果去重
  // （中断后接管：若上一 worker 未发过 started 事件则补发）
  const hasScanStarted =
    (await sql`select 1 from scan_events where scan_id = ${scanId} and event_type = 'scan.started' limit 1`).length > 0
  if (!hasScanStarted) {
    await leaseGuarded(sql, job, async (tx) => {
      await tx`update scans set status = 'running', stage = 'ingest', started_at = now()
        where id = ${scanId} and status in ('queued', 'running')`
    })
    await emitScanEvent(sql, scanId, 'scan.started', { snapshotId: snapshot.id })
  }

  const cancelled = async (): Promise<boolean> => {
    if (opts.signal?.aborted) throw new LeaseLostError()
    if (!(await isCancelRequested(sql, job))) return false
    // 取消落实：终态 + 最终事件 + 任务取消 同一事务（条件写）
    await leaseGuarded(sql, job, async (tx) => {
      const updated = await tx`update scans set status = 'cancelled', completed_at = now()
        where id = ${scanId} and status = 'running'
        returning id`
      if (updated.length === 0) throw new LeaseLostError()
      await tx`insert into scan_events (scan_id, event_type, payload_json)
        values (${scanId}, 'scan.finished', ${sql.json({ status: 'cancelled' } as unknown as postgres.JSONValue)})`
      await tx`update jobs set state = 'cancelled', lease_until = null, updated_at = now()
        where id = ${job.id}
          and lease_owner = ${job.lease_owner}
          and lease_generation = ${job.lease_generation}
          and state = 'running'`
    })
    return true
  }

  /** 阶段推进（租约事务内）：stage 更新 + stage.started 事件 */
  const stageBegin = async (stage: string): Promise<void> => {
    await leaseGuarded(sql, job, async (tx) => {
      await tx`update scans set stage = ${stage} where id = ${scanId} and status = 'running'`
    })
    await stageEvent('stage.started', stage, {})
  }

  /** 长阶段前的租约确认（AI 阶段期间由 LeaseKeeper 持续续租） */
  const ensureLease = async (): Promise<void> => {
    if (opts.signal?.aborted) throw new LeaseLostError()
    if (!(await assertLease(sql, job))) throw new LeaseLostError()
  }

  try {
    /* ---- ingest（导入时已完成，这里汇报统计） ---- */
    await stageEvent('stage.started', 'ingest', {})
    await stageEvent('stage.completed', 'ingest', {
      fileCount: snapshot.file_count,
      skippedCount: snapshot.skipped_count,
    })
    if (await cancelled()) return { status: 'cancelled', findingCount: 0 }

    /* ---- index ---- */
    await stageBegin('index')
    const fileRows = (await sql`select path, language, line_count, parse_status, storage_key, redacted_ranges, content_hash
      from files where snapshot_id = ${snapshot.id} order by path`) as unknown as FileRow[]
    const analyzable = fileRows.filter(
      (f) => ['js', 'ts', 'jsx', 'tsx', 'vue'].includes(f.language),
    )
    const parseFailed = analyzable.filter((f) => f.parse_status === 'parse_error')
    await stageEvent('stage.completed', 'index', {
      totalFiles: fileRows.length,
      analyzableFiles: analyzable.length,
      parseFailedFiles: parseFailed.length,
    })
    if (await cancelled()) return { status: 'cancelled', findingCount: 0 }

    /* ---- static ---- */
    await stageBegin('static')
    const staticInputs = []
    for (const f of analyzable) {
      if (f.parse_status !== 'ok') continue
      const content = await readSnapshotFile(snapshot.project_id, snapshot.id, f.storage_key)
      staticInputs.push({
        path: f.path,
        content,
        language: f.language,
        parseOk: true,
        redactedRanges: asJson<Array<{ line: number; start: number; end: number }>>(
          f.redacted_ranges,
        ),
      })
    }
    await ensureLease()
    const staticResult = runStaticRules(staticInputs)

    let findingCount = 0
    for (const f of staticResult.findings) {
      const draft: FindingDraft = {
        title: f.title,
        category: f.category,
        severity: f.severity,
        confidence: f.confidence,
        primary: f.primary,
        related: f.related,
        condition: f.condition,
        impact: f.impact,
        reasoningSummary: f.reasoningSummary,
        recommendation: f.recommendation,
        guidelineChunkIds: f.guidelineChunkIds,
        symbol: f.symbol,
      }
      const inserted = await sql`
        insert into findings (scan_id, rule_id, fingerprint, draft_json, source, evidence_status)
        values (${scanId}, ${f.ruleId}, ${f.fingerprint}, ${sql.json(asPgJson(draft))}, 'static',
          ${f.needsReview ? 'needs_review' : 'valid'})
        on conflict (scan_id, fingerprint) do nothing
        returning id`
      if (inserted.length > 0) {
        findingCount++
        await emitScanEvent(sql, scanId, 'finding.created', {
          findingId: (inserted[0] as { id: string }).id,
          ruleId: f.ruleId,
          title: f.title,
          severity: f.severity,
          path: f.primary.path,
          startLine: f.primary.startLine,
          source: 'static',
          evidenceStatus: f.needsReview ? 'needs_review' : 'valid',
        })
      }
    }
    await stageEvent('stage.completed', 'static', {
      checkedFiles: staticResult.checkedFileCount,
      findingCount,
    })
    if (await cancelled()) return { status: 'cancelled', findingCount: 0 }

    /* ---- ai ---- */
    await stageBegin('ai')
    let aiInfo: CoverageInfo['ai']
    let usage: UsageInfo = {
      provider: 'mock',
      modelId: null,
      modelCalls: 0,
      toolCalls: 0,
      inputTokensEstimated: 0,
      outputTokensEstimated: 0,
      inputTokensMeasured: null,
      outputTokensMeasured: null,
      aiElapsedMs: 0,
    }
    let aiStatus: 'completed' | 'partial' | 'skipped' = 'skipped'
    if (config?.enableCloudAI) {
      // 静态结果摘要（供 AI 选择与复核）
      const staticRows = (await sql`select id, rule_id, fingerprint, draft_json
        from findings where scan_id = ${scanId}`) as unknown as Array<{
        id: string
        rule_id: string | null
        fingerprint: string
        draft_json: unknown
      }>
      const staticFindings: import('@/core/review/dedupe').ExistingStaticFinding[] = []
      const staticCandidates: Parameters<typeof runAiReviewStage>[1]['staticCandidates'] = []
      for (const row of staticRows) {
        const d = asJson<FindingDraft>(row.draft_json)
        staticFindings.push({
          findingId: row.id,
          ruleId: row.rule_id,
          fingerprint: row.fingerprint,
          path: d.primary.path,
          startLine: d.primary.startLine,
          endLine: d.primary.endLine,
          category: d.category,
        })
        staticCandidates.push({
          path: d.primary.path,
          startLine: d.primary.startLine,
          endLine: d.primary.endLine,
          title: d.title,
          category: d.category,
          severity: d.severity,
          condition: d.condition,
          impact: d.impact,
          recommendation: d.recommendation,
        })
      }
      const structureRow = (await sql`select structure_json from snapshots where id = ${snapshot.id}`)[0] as
        | { structure_json: unknown }
        | undefined
      const structure = structureRow
        ? asJson<import('@/server/db/schema').StructureStats | null>(structureRow.structure_json)
        : null
      try {
        const outcome = await runAiReviewStage(sql, {
          scanId,
          snapshotId: snapshot.id,
          projectId: snapshot.project_id,
          staticFindings,
          staticCandidates,
          analyzablePaths: analyzable.map((f) => f.path),
          structure,
          cancelRequested: () => isCancelRequested(sql, job),
          provider: opts.aiProvider,
          signal: opts.signal,
        })
        aiInfo = outcome.coverageAi
        usage = outcome.usage
        aiStatus = outcome.status
        // A06：AI 验证阶段落库前丢弃的原始候选台账 —— 逐候选 finding.invalid 事件
        // （含修复轮信息），评测据此将丢弃候选计入 FP/无效引用（不遗漏、不美化）
        for (const dropped of outcome.invalidDropped) {
          await emitScanEvent(sql, scanId, 'finding.invalid', {
            phase: 'ai',
            path: dropped.path,
            category: dropped.category,
            startLine: dropped.startLine,
            endLine: dropped.endLine,
            round: dropped.round,
            errors: dropped.errors.slice(0, 3),
          })
        }
        await stageEvent('stage.completed', 'ai', {
          provider: outcome.usage.provider,
          modelId: outcome.usage.modelId,
          insertedCount: outcome.insertedCount,
          mergedCount: outcome.mergedCount,
          invalidCount: outcome.invalidCount,
          degradedReason: outcome.degradedReason,
        })
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        // AI 阶段异常：保留静态结果，标记降级
        aiInfo = {
          enabled: true,
          completed: false,
          degradedReason: 'ai_stage_error',
          selectedFiles: [],
          readFiles: [],
          readLineRanges: {},
          notReadCount: analyzable.length,
          selectionBasis: 'AI 阶段异常，未完成选择',
        }
        await stageEvent('stage.completed', 'ai', {
          skipped: true,
          reason: `AI 阶段错误：${err instanceof Error ? err.message.slice(0, 150) : '未知'}`,
        })
      }
    } else {
      aiInfo = {
        enabled: false,
        completed: false,
        degradedReason: null,
        selectedFiles: [],
        readFiles: [],
        readLineRanges: {},
        notReadCount: analyzable.length,
        selectionBasis: '用户未启用云端 AI，仅执行本地静态规则',
      }
      await stageEvent('stage.completed', 'ai', {
        skipped: true,
        reason: '未启用云端 AI',
      })
    }
    if (await cancelled()) return { status: 'cancelled', findingCount: 0 }

    /* ---- validate：校验全部 finding 引文与真实快照行一致 ---- */
    await stageBegin('validate')
    const allFindings = (await sql`select id, draft_json, evidence_status from findings
      where scan_id = ${scanId}`) as unknown as Array<{
      id: string
      draft_json: unknown
      evidence_status: string
    }>
    const contentCache = new Map<string, string>()
    let invalidCount = 0
    for (const row of allFindings) {
      const draft = asJson<FindingDraft>(row.draft_json)
      let valid = true
      try {
        let content = contentCache.get(draft.primary.path)
        if (content === undefined) {
          const fileRow = fileRows.find((f) => f.path === draft.primary.path)
          if (!fileRow) {
            valid = false
          } else {
            content = await readSnapshotFile(
              snapshot.project_id,
              snapshot.id,
              fileRow.storage_key,
            )
            contentCache.set(draft.primary.path, content)
          }
        }
        // 与 AI 侧 validator 共用严格校验（统一 LF 后逐字符比较）
        if (valid && content !== undefined) {
          valid = matchesQuote(content, draft.primary.startLine, draft.primary.endLine, draft.primary.quote)
        }
      } catch {
        valid = false
      }
      if (!valid) {
        invalidCount++
        const draft = asJson<FindingDraft>(row.draft_json)
        // A06：validate 阶段删除的落库候选同样逐候选入台账（finding.invalid 事件），
        // 评测将其与 AI 丢弃候选一并计入 FP/无效引用
        await emitScanEvent(sql, scanId, 'finding.invalid', {
          phase: 'validate',
          path: draft.primary.path,
          category: draft.category,
          startLine: draft.primary.startLine,
          endLine: draft.primary.endLine,
        })
        await sql`delete from findings where id = ${row.id}`
      }
    }
    await stageEvent('stage.completed', 'validate', {
      validFindings: allFindings.length - invalidCount,
      invalidFindings: invalidCount,
    })
    if (await cancelled()) return { status: 'cancelled', findingCount: 0 }

    /* ---- report：终态 + 最终事件 + 任务完成 同一租约事务 ---- */
    await leaseGuarded(sql, job, async (tx) => {
      await tx`update scans set stage = 'report' where id = ${scanId} and status = 'running'`
    })
    await stageEvent('stage.started', 'report', {})
    const finalFindings = (await sql`select (draft_json->>'severity') as severity,
      evidence_status as "evidenceStatus", feedback
      from findings where scan_id = ${scanId}`) as unknown as Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
      evidenceStatus: 'valid' | 'needs_review'
      feedback: 'unreviewed' | 'confirmed' | 'false_positive'
    }>
    const risk = computeRisk(finalFindings)
    const coverage: CoverageInfo = {
      totalFiles: fileRows.length,
      analyzableFiles: analyzable.length,
      ignoredFiles: snapshot.skipped_count,
      parseFailedFiles: parseFailed.length,
      staticCheckedFiles: staticResult.checkedFileCount,
      ai: aiInfo,
    }
    // 终态（R01）：纯静态 completed；云端阶段未被预算/取消/错误打断即 completed
    // （证据门丢弃无效引文属护栏生效，单独计数不降级，规格 193）；
    // 失败、预算耗尽、未配置或未完成 → partial（cancelled 已在阶段边界单独处理）
    const finalStatus: 'completed' | 'partial' = config?.enableCloudAI
      ? aiStatus === 'completed'
        ? 'completed'
        : 'partial'
      : 'completed'
    // 终态 + stage.completed + scan.finished + 任务完成 同一事务（失租不能写结果）
    await leaseGuarded(sql, job, async (tx) => {
      const updated = await tx`
        update scans set
          status = ${finalStatus},
          coverage_json = ${sql.json(asPgJson(coverage))},
          usage_json = ${sql.json(asPgJson(usage))},
          risk_json = ${sql.json(asPgJson(risk))},
          rule_version = ${SCAN_RULE_VERSION},
          prompt_version = ${PROMPT_VERSION},
          completed_at = now()
        where id = ${scanId} and status = 'running'
        returning id`
      if (updated.length === 0) throw new LeaseLostError()
      await tx`insert into scan_events (scan_id, event_type, payload_json)
        values (${scanId}, 'stage.completed', ${sql.json({ stage: 'report' } as unknown as postgres.JSONValue)})`
      await tx`insert into scan_events (scan_id, event_type, payload_json)
        values (${scanId}, 'scan.finished', ${sql.json({
          status: finalStatus,
          riskIndex: risk.riskIndex,
          counts: risk.counts,
          needsReview: risk.needsReview,
        } as unknown as postgres.JSONValue)})`
      await tx`update jobs set state = 'completed', lease_until = null, updated_at = now()
        where id = ${job.id}
          and lease_owner = ${job.lease_owner}
          and lease_generation = ${job.lease_generation}
          and state = 'running'`
    })
    return {
      status: finalStatus,
      findingCount: finalFindings.length,
    }
  } catch (err) {
    if (err instanceof LeaseLostError) {
      // 失租：不写任何结果（可能已被接管），停止本 worker 的全部后续工作
      throw err
    }
    // 可重试异常：不提前写扫描终态（恢复点=当前 stage，由下次尝试续跑）；
    // 仅发诊断事件。上限耗尽时由 failJob 与任务一致终结。
    const message = err instanceof Error ? err.message : String(err)
    await emitScanEvent(sql, scanId, 'error', { message: message.slice(0, 200) })
      .catch(() => undefined)
    throw err
  }
}

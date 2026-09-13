import postgres from 'postgres'
import { asJson } from '@/server/db/json'
import type { EvaluationRunConfig } from '@/core/contracts/evaluation'
import { loadDataset, resolveFixturesDir, DatasetNotFoundError } from '@/core/evaluation/dataset'
import { runEvaluation, type ProviderFactory } from '@/core/evaluation/runner'
import { completeJob, cancelJob, isCancelRequested, leaseGuarded, type LeaseInfo } from './jobs'

/**
 * 评测任务处理（规格 11/13 / R08）：领取 kind=evaluation 任务，
 * 在租约内调用评测执行器（隔离的预置样例范围，复用核心扫描管线与 R03 生命周期），
 * 写入状态/指标/错误文本；取消在项目边界生效（不再新增工作）。
 * A08：evaluations 的全部写入都通过父评测任务租约条件写（runEvaluation 传入 job），
 * 失租后旧执行器不能写回结果；逐项目完成记录使恢复复用已有 scan、不重复执行。
 */

export interface ProcessEvaluationOptions {
  evaluationId: string
  job: LeaseInfo
  signal?: AbortSignal
  /** 测试注入 provider 工厂；缺省 chatReady ? 真实 provider : 受控 Mock（明确标注） */
  providerFactory?: ProviderFactory
}

export async function processEvaluationJob(
  sql: postgres.Sql,
  opts: ProcessEvaluationOptions,
): Promise<void> {
  const rows = (await sql`select dataset_version, config_json, status from evaluations
    where id = ${opts.evaluationId}`) as unknown as Array<{
    dataset_version: string
    config_json: unknown
    status: string
  }>
  if (rows.length === 0) {
    // 评测记录已不存在（被清理）：直接完结任务
    await completeJob(sql, opts.job)
    return
  }
  const evaluation = rows[0]!
  if (['completed', 'partial', 'failed', 'cancelled'].includes(evaluation.status)) {
    // 崩溃恢复：终态已写入，不重复执行
    await completeJob(sql, opts.job)
    return
  }

  const config = asJson<Partial<EvaluationRunConfig>>(evaluation.config_json) ?? {}
  const mode = config.mode ?? 'static_only'
  const split = config.split ?? 'all'
  // 小子集口径（e2e/集成提速）：EVAL_PROJECT_LIMIT 限制单次执行的项目数，记录在 metrics.config.projectLimit
  const limitEnv = process.env.EVAL_PROJECT_LIMIT
  const envLimit = limitEnv && /^\d+$/.test(limitEnv) ? parseInt(limitEnv, 10) : undefined
  const projectLimit = config.projectLimit ?? envLimit

  try {
    const dataset = await loadDataset(resolveFixturesDir())
    if (dataset.info.version !== evaluation.dataset_version) {
      // 父评测租约事务内条件写（A08：失租不能写终态）
      await leaseGuarded(sql, opts.job, async (tx) => {
        await tx`update evaluations set status = 'failed',
            error_text = ${`数据集版本不一致：任务记录 ${evaluation.dataset_version}，磁盘数据集 ${dataset.info.version}。请重新运行 pnpm fixtures:generate 后再次发起评测`},
            completed_at = now()
          where id = ${opts.evaluationId}`
      })
      await completeJob(sql, opts.job)
      return
    }

    const result = await runEvaluation(sql, {
      evaluationId: opts.evaluationId,
      dataset,
      mode,
      split,
      projectLimit,
      signal: opts.signal,
      isCancelRequested: () => isCancelRequested(sql, opts.job),
      providerFactory: opts.providerFactory,
      executor: 'worker',
      job: opts.job,
    })

    if (result.status === 'cancelled') {
      // 取消落实：评测任务取消终态（条件写）
      await cancelJob(sql, opts.job)
    } else {
      await completeJob(sql, opts.job)
    }
  } catch (err) {
    if (err instanceof DatasetNotFoundError) {
      // 数据缺失不可重试：评测一致终结（父评测租约事务内条件写），任务完结
      await leaseGuarded(sql, opts.job, async (tx) => {
        await tx`update evaluations set status = 'failed',
            error_text = ${err.message.slice(0, 500)},
            completed_at = now()
          where id = ${opts.evaluationId}`
      })
      await completeJob(sql, opts.job)
      return
    }
    // 其余异常：抛回 worker（failJob 重试；上限耗尽时 evaluations.status='failed' 一致终结）
    throw err
  }
}

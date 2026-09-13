/**
 * 评测 CLI（规格 13 / R08）：读取 fixtures manifests，直接调用评测执行器（不经 HTTP），
 * 汇总表输出到 stdout 并写入 evaluations 表。真实模型评测默认通过本 CLI 执行，
 * 消耗预算受 AI_DAILY_TOKEN_LIMIT 约束；本地无凭证时 llm 模式走受控 Mock 管线并明确标注。
 *
 * 用法：
 *   pnpm eval -- --dataset v1-xxxxxxxx --mode static_only --split dev
 *   pnpm eval -- --mode hybrid_rag --split holdout --limit 8
 */
import postgres from 'postgres'
import { loadDotEnv, env } from '../src/server/env'
import {
  evaluationModeSchema,
  evaluationSplitSchema,
  type EvaluationMode,
  type EvaluationSplit,
} from '../src/core/contracts/evaluation'
import { loadDataset, resolveFixturesDir } from '../src/core/evaluation/dataset'
import { runEvaluation } from '../src/core/evaluation/runner'
import { EVALUATION_MODE_LABELS } from '../src/core/contracts/evaluation'

loadDotEnv()

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

function fmt(value: number | null, digits = 3): string {
  if (value === null) return 'N/A'
  return value.toFixed(digits)
}

async function main(): Promise<void> {
  // 数据库可达性检查：给出明确提示，而不是连接错误堆栈
  const sql = postgres(env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 })
  try {
    await sql`select 1`
  } catch {
    console.error('无法连接数据库（DATABASE_URL）。请先启动本地数据库：pnpm db:dev（PGlite socket，默认端口 5433）')
    await sql.end().catch(() => undefined)
    process.exit(1)
  }

  const modeArg = arg('mode') ?? 'static_only'
  const mode = evaluationModeSchema.safeParse(modeArg)
  if (!mode.success) {
    console.error(`--mode 不合法：${modeArg}（可选 static_only | llm_no_rag | hybrid_rag）`)
    await sql.end()
    process.exit(1)
  }
  const splitArg = arg('split') ?? 'all'
  const split = evaluationSplitSchema.safeParse(splitArg)
  if (!split.success) {
    console.error(`--split 不合法：${splitArg}（可选 dev | holdout | all）`)
    await sql.end()
    process.exit(1)
  }
  const limitArg = arg('limit')
  const projectLimit = limitArg && /^\d+$/.test(limitArg) ? parseInt(limitArg, 10) : undefined

  let dataset
  try {
    dataset = await loadDataset(resolveFixturesDir())
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    await sql.end()
    process.exit(1)
  }
  const datasetVersion = arg('dataset')
  if (datasetVersion && datasetVersion !== dataset.info.version) {
    console.error(
      `--dataset 与磁盘数据集不一致：请求 ${datasetVersion}，当前 ${dataset.info.version}。如数据集内容已变化，请重新运行 pnpm fixtures:generate`,
    )
    await sql.end()
    process.exit(1)
  }

  console.log(`评测模式：${EVALUATION_MODE_LABELS[mode.data as EvaluationMode]}`)
  console.log(`数据集：${dataset.info.version}（${dataset.info.projectCount} 项目） · 划分：${split.data}`)
  if (projectLimit !== undefined) console.log(`项目数限制：${projectLimit}`)

  const rows = (await sql`
    insert into evaluations (dataset_version, config_json, status)
    values (${dataset.info.version}, ${sql.json({
      mode: mode.data,
      split: split.data,
      executor: 'cli',
      requestedAt: new Date().toISOString(),
      ...(projectLimit !== undefined ? { projectLimit } : {}),
    })}, 'pending')
    returning id`) as unknown as Array<{ id: string }>
  const evaluationId = rows[0]!.id
  console.log(`评测记录：${evaluationId}`)

  const t0 = Date.now()
  const result = await runEvaluation(sql, {
    evaluationId,
    dataset,
    mode: mode.data as EvaluationMode,
    split: split.data as EvaluationSplit,
    projectLimit,
    isCancelRequested: async () => false,
    executor: 'cli',
  })

  // 汇总表（stdout；数字可回溯到 evaluations.metrics_json 与逐项目 scanId）
  const m = result.metricsJson
  console.log('\n=== 逐项目结果 ===')
  console.log(
    [
      '项目'.padEnd(16),
      '类型'.padEnd(4),
      '标注'.padStart(4),
      'TP'.padStart(4),
      'FP'.padStart(4),
      'FN'.padStart(4),
      'P'.padStart(8),
      'R'.padStart(8),
      '延迟'.padStart(10),
      'token'.padStart(8),
    ].join(' '),
  )
  for (const p of m.projects) {
    console.log(
      [
        p.projectId.padEnd(16),
        (p.kind === 'defect' ? '缺陷' : '对照').padEnd(4),
        String(p.metrics.annotationCount).padStart(4),
        String(p.metrics.tp).padStart(4),
        String(p.metrics.fp).padStart(4),
        String(p.metrics.fn).padStart(4),
        fmt(p.metrics.precision).padStart(8),
        fmt(p.metrics.recall).padStart(8),
        `${Math.round(p.latencyMs)}ms`.padStart(10),
        String(p.tokenTotal).padStart(8),
      ].join(' '),
    )
  }
  for (const f of m.failures) {
    console.log(`[失败] ${f.projectId}: ${f.error}`)
  }

  console.log('\n=== 汇总 ===')
  console.log(`状态：${result.status}（模式 ${m.config.mode}，划分 ${m.config.split}，执行项目 ${m.config.projectCount}）`)
  console.log(
    m.config.mode === 'static_only'
      ? 'provider：无（纯静态规则，无模型调用）'
      : `provider：${m.config.provider}${m.config.providerIsMock ? '（Mock 管线，非真实模型）' : ''}`,
  )
  console.log(`Precision：${fmt(m.totals.precision)}（TP ${m.totals.tp} / TP+FP ${m.totals.tp + m.totals.fp}）`)
  console.log(`Recall：${fmt(m.totals.recall)}（TP ${m.totals.tp} / TP+FN ${m.totals.tp + m.totals.fn}）`)
  console.log(`F1：${fmt(m.totals.f1)}`)
  console.log(`证据有效率：${m.totals.evidenceValidRate === null ? 'N/A（无候选）' : `${(m.totals.evidenceValidRate * 100).toFixed(1)}%`}（无效引用 ${m.totals.invalidCitations}，计入 FP）`)
  console.log(`重复报警：${m.totals.duplicates}（额外计 FP）`)
  console.log(`延迟 p50/p95：${m.latency.p50Ms === null ? 'N/A' : Math.round(m.latency.p50Ms)}ms / ${m.latency.p95Ms === null ? 'N/A' : Math.round(m.latency.p95Ms)}ms`)
  console.log(`token/项目：${m.tokens.perProject === null ? 'N/A' : m.tokens.perProject.toFixed(0)}（合计 ${m.tokens.total}）`)
  console.log(`总耗时：${Math.round((Date.now() - t0) / 100) / 10}s`)
  console.log(m.config.note)
  console.log(m.disclaimer)
  console.log(`（逐项目 scanId 与完整结果见 evaluations.metrics_json：${evaluationId}）`)

  await sql.end()
  process.exit(result.status === 'failed' ? 1 : 0)
}

void main().catch((err) => {
  console.error('评测执行失败:', err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * 独立 worker（R03）：领取任务、执行扫描/索引/评测、租约续租、过期收割、删除清理。
 * 不持有任何 shell 工具；不执行上传内容。
 */
import postgres from 'postgres'
import { env } from '../src/server/env'
import {
  claimJob,
  failJob,
  newWorkerId,
  reapExhaustedJobs,
  LeaseKeeper,
  LeaseLostError,
  type JobRow,
} from '../src/worker/jobs'
import { processScanJob } from '../src/worker/scanner'
import { cleanupDeletingProjects, expireStaleSessions } from '../src/worker/cleanup'

const sql = postgres(env.DATABASE_URL, { max: 2, prepare: false })
const workerId = newWorkerId()
let running = true

/** 单个任务的执行上下文：LeaseKeeper 持续续租，失租触发 abort */
async function processJob(job: JobRow): Promise<void> {
  const controller = new AbortController()
  const lease = {
    id: job.id,
    lease_owner: job.lease_owner!,
    lease_generation: job.lease_generation,
    attempt: job.attempt,
  }
  const keeper = new LeaseKeeper(sql, lease, () => controller.abort())
  keeper.start()
  try {
    if (job.kind === 'scan') {
      await processScanJob(sql, { scanId: job.target_id, job: lease, signal: controller.signal })
      return
    }
    if (job.kind === 'document_index') {
      const { processDocumentIndexJob } = await import('../src/worker/document-index')
      await processDocumentIndexJob(sql, { documentId: job.target_id, job: lease })
      return
    }
    if (job.kind === 'evaluation') {
      const { processEvaluationJob } = await import('../src/worker/evaluation')
      // A08：统一 abort —— 父评测租约失租时中止在途模型调用/扫描，旧执行器不能写回结果
      await processEvaluationJob(sql, { evaluationId: job.target_id, job: lease, signal: controller.signal })
      return
    }
    throw new Error(`未知任务类型: ${job.kind}`)
  } finally {
    keeper.stop()
  }
}

async function main(): Promise<void> {
  console.log(`[worker:${workerId}] 启动，数据库 ${env.DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`)
  let lastTtlCleanup = 0
  let lastDeleteSweep = 0
  while (running) {
    try {
      const now = Date.now()
      // TTL 会话过期：每小时标记（预置项目不受影响）
      if (now - lastTtlCleanup > 60 * 60 * 1000) {
        lastTtlCleanup = now
        const marked = await expireStaleSessions(sql)
        if (marked > 0) console.log(`[worker:${workerId}] TTL：标记过期会话项目 ${marked} 个`)
      }
      // deleting 项目清理：每 15 秒（等活动租约退出/到期）
      if (now - lastDeleteSweep > 15_000) {
        lastDeleteSweep = now
        const cleaned = await cleanupDeletingProjects(sql)
        if (cleaned > 0) console.log(`[worker:${workerId}] 清理删除中项目 ${cleaned} 个`)
      }
      // 收割过期且尝试耗尽的 running 任务（与目标状态一致终结）
      const reaped = await reapExhaustedJobs(sql)
      if (reaped > 0) console.log(`[worker:${workerId}] 收割耗尽任务 ${reaped} 个`)

      const job = await claimJob(sql, workerId)
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      console.log(`[worker:${workerId}] 领取 ${job.kind} ${job.target_id} (attempt ${job.attempt})`)
      try {
        await processJob(job)
      } catch (err) {
        if (err instanceof LeaseLostError) {
          // 失租：任务已被接管或项目删除中，不做任何写入（failJob 条件写同样不生效）
          console.log(`[worker:${workerId}] 任务 ${job.target_id} 失去租约，停止处理`)
          continue
        }
        console.error(`[worker:${workerId}] 任务失败 ${job.target_id}:`, err)
        await failJob(
          sql,
          {
            id: job.id,
            kind: job.kind,
            target_id: job.target_id,
            lease_owner: job.lease_owner!,
            lease_generation: job.lease_generation,
            attempt: job.attempt,
          },
          err instanceof Error ? err.message : String(err),
        )
      }
    } catch (err) {
      console.error('[worker] 循环异常:', err)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  await sql.end()
}

process.on('SIGINT', () => {
  console.log('[worker] 收到 SIGINT，退出')
  running = false
})
process.on('SIGTERM', () => {
  console.log('[worker] 收到 SIGTERM，退出')
  running = false
})

main().catch((err) => {
  console.error('[worker] 致命错误:', err)
  process.exit(1)
})

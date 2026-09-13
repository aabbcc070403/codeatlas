import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { createTestDb, type TestDb } from '../helpers/db'
import * as sessionRoute from '../../src/app/api/session/route'
import * as evaluationsRoute from '../../src/app/api/evaluations/route'
import * as evaluationDetailRoute from '../../src/app/api/evaluations/[id]/route'
import { env } from '../../src/server/env'
import { seedAll } from '../../src/server/db/seed'
import { generateDataset } from '../../src/core/evaluation/fixtures'
import { claimJob, requestCancel, failJob, newWorkerId, type LeaseInfo } from '../../src/worker/jobs'
import { processEvaluationJob } from '../../src/worker/evaluation'
import { runEvaluation } from '../../src/core/evaluation/runner'
import { loadDataset } from '../../src/core/evaluation/dataset'
import { asJson } from '../../src/server/db/json'
import type { EvaluationMetricsJson } from '../../src/core/contracts/evaluation'

/**
 * 评测集成测试（R08）：admin 触发 202 / demo 403 / 未登录 401；
 * evaluation worker 端到端（static_only 小子集：状态 completed、metrics_json 可解析、逐项目结果落库）；
 * 取消语义（取消后 partial/cancelled，不再新增工作）；无凭证时 llm 模式 Mock 标注。
 * 小 fixture 集（EVAL_PROJECT_LIMIT / projectLimit）避免全量 24 项目拖慢。
 */

let db: TestDb
let storageRoot: string
let fixturesDir: string
let adminCookie = ''
let demoCookie = ''

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-storage-'))
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })
  fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-fixtures-'))
  generateDataset(fixturesDir)
  process.env.EVAL_FIXTURES_DIR = fixturesDir
  delete process.env.EVAL_PROJECT_LIMIT
  // 预置规范（hybrid_rag 检索路径需要 chunks；无 embedding 时词法降级可用）
  await seedAll(db.sql)
  adminCookie = await login(env.ADMIN_ACCESS_CODE)
  demoCookie = await login(env.DEMO_ACCESS_CODE)
}, 120_000)

afterAll(async () => {
  const { resetDb } = await import('../../src/server/db/client')
  await resetDb()
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
  fs.rmSync(fixturesDir, { recursive: true, force: true })
  delete process.env.EVAL_FIXTURES_DIR
})

function makeJsonReq(
  urlPath: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers['cookie'] = opts.cookie
  return new NextRequest(`http://localhost:3100${urlPath}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

function extractCookie(res: Response): string {
  const setCookies = res.headers.getSetCookie()
  const target = setCookies.find((c) => c.startsWith('ca_session='))
  if (!target) throw new Error('未发现会话 cookie')
  return target.split(';')[0]!
}

async function loginAs(code: string): Promise<Response> {
  return sessionRoute.POST(
    makeJsonReq('/api/session', { method: 'POST', body: { accessCode: code } }),
  )
}

async function login(code: string): Promise<string> {
  const res = await loginAs(code)
  expect(res.status).toBe(200)
  return extractCookie(res)
}

async function datasetVersion(): Promise<string> {
  const dataset = await loadDataset(fixturesDir)
  return dataset.info.version
}

async function claimEvaluationJob(evaluationId: string): Promise<{ lease: LeaseInfo; jobId: string }> {
  const workerId = newWorkerId()
  const job = await claimJob(db.sql, workerId, ['evaluation'])
  expect(job).not.toBeNull()
  expect(job!.target_id).toBe(evaluationId)
  return {
    jobId: job!.id,
    lease: {
      id: job!.id,
      lease_owner: job!.lease_owner!,
      lease_generation: job!.lease_generation,
      attempt: job!.attempt,
    },
  }
}

describe('POST /api/evaluations 权限与校验', () => {
  it('未登录 401', async () => {
    const res = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', { method: 'POST', body: { datasetVersion: 'v1', mode: 'static_only' } }),
    )
    expect(res.status).toBe(401)
  })

  it('demo 会话 403（无权限，不创建评测记录）', async () => {
    const version = await datasetVersion()
    const res = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only' },
        cookie: demoCookie,
      }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('forbidden')
    const count = await db.sql`select count(*)::int as c from evaluations`
    expect((count[0] as { c: number }).c).toBe(0)
  })

  it('admin 会话 202：创建 evaluations(pending) 与 kind=evaluation 任务；重复运行创建新记录', async () => {
    const version = await datasetVersion()
    const res1 = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only', split: 'dev' },
        cookie: adminCookie,
      }),
    )
    expect(res1.status).toBe(202)
    const body1 = (await res1.json()) as { id: string; status: string }
    expect(body1.status).toBe('queued')
    const res2 = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only', split: 'dev' },
        cookie: adminCookie,
      }),
    )
    expect(res2.status).toBe(202)
    const body2 = (await res2.json()) as { id: string }
    expect(body2.id).not.toBe(body1.id)

    for (const id of [body1.id, body2.id]) {
      const rows = await db.sql`select status, config_json from evaluations where id = ${id}`
      expect(rows.length).toBe(1)
      expect((rows[0] as { status: string }).status).toBe('pending')
      const config = asJson<{ mode: string; split: string }>((rows[0] as { config_json: unknown }).config_json)
      expect(config?.mode).toBe('static_only')
      expect(config?.split).toBe('dev')
      const jobs = await db.sql`select kind, state from jobs where target_id = ${id}`
      expect((jobs[0] as { kind: string }).kind).toBe('evaluation')
    }
    // 清理本测试创建的排队任务，避免影响后续 worker 端到端测试的任务领取
    for (const id of [body1.id, body2.id]) {
      await db.sql`delete from jobs where kind = 'evaluation' and target_id = ${id}`
      await db.sql`delete from evaluations where id = ${id}`
    }
  })

  it('datasetVersion 与磁盘数据集不一致 → 400', async () => {
    const res = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: 'v999-deadbeef', mode: 'static_only' },
        cookie: adminCookie,
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_request')
  })

  it('数据集未生成 → 409', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-empty-'))
    process.env.EVAL_FIXTURES_DIR = emptyDir
    try {
      const res = await evaluationsRoute.POST(
        makeJsonReq('/api/evaluations', {
          method: 'POST',
          body: { datasetVersion: 'v1-aaaaaaaa', mode: 'static_only' },
          cookie: adminCookie,
        }),
      )
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toContain('fixtures:generate')
    } finally {
      process.env.EVAL_FIXTURES_DIR = fixturesDir
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('GET 列表与详情：已登录会话可读（评测素材只读公开）', async () => {
    const version = await datasetVersion()
    const create = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only' },
        cookie: adminCookie,
      }),
    )
    const created = (await create.json()) as { id: string }

    const listRes = await evaluationsRoute.GET(makeJsonReq('/api/evaluations', { cookie: demoCookie }))
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as {
      items: Array<{ id: string; datasetVersion: string }>
      dataset: { version: string; projectCount: number; devCount: number; holdoutCount: number } | null
    }
    expect(list.items.some((i) => i.id === created.id)).toBe(true)
    expect(list.dataset?.version).toBe(version)
    expect(list.dataset?.projectCount).toBe(24)
    expect(list.dataset?.devCount).toBe(16)
    expect(list.dataset?.holdoutCount).toBe(8)

    const detailRes = await evaluationDetailRoute.GET(
      makeJsonReq(`/api/evaluations/${created.id}`, { cookie: demoCookie }),
      { params: Promise.resolve({ id: created.id }) },
    )
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as { evaluation: { id: string } }
    expect(detail.evaluation.id).toBe(created.id)

    // 未登录 401、不存在 404
    const anonRes = await evaluationsRoute.GET(makeJsonReq('/api/evaluations'))
    expect(anonRes.status).toBe(401)
    const missingRes = await evaluationDetailRoute.GET(
      makeJsonReq(`/api/evaluations/00000000-0000-4000-8000-000000000000`, { cookie: adminCookie }),
      { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }) },
    )
    expect(missingRes.status).toBe(404)

    // 清理本测试创建的排队任务，避免影响后续 worker 端到端测试的任务领取
    await db.sql`delete from jobs where kind = 'evaluation' and target_id = ${created.id}`
    await db.sql`delete from evaluations where id = ${created.id}`
  })
})

describe('evaluation worker 端到端', () => {
  it('static_only 小子集（dev × 6）：completed、metrics_json 可解析、逐项目结果落库、static P=R=1', async () => {
    process.env.EVAL_PROJECT_LIMIT = '6'
    const version = await datasetVersion()
    const create = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only', split: 'dev' },
        cookie: adminCookie,
      }),
    )
    const evaluationId = ((await create.json()) as { id: string }).id
    const { lease } = await claimEvaluationJob(evaluationId)
    await processEvaluationJob(db.sql, { evaluationId, job: lease })

    const rows = await db.sql`select status, metrics_json, completed_at from evaluations where id = ${evaluationId}`
    const row = rows[0] as { status: string; metrics_json: unknown; completed_at: string | null }
    expect(row.status).toBe('completed')
    expect(row.completed_at).not.toBeNull()

    const metrics = asJson<EvaluationMetricsJson>(row.metrics_json)
    expect(metrics).not.toBeNull()
    expect(metrics!.config.mode).toBe('static_only')
    expect(metrics!.config.split).toBe('dev')
    expect(metrics!.config.projectCount).toBe(6)
    expect(metrics!.config.realModelRun).toBe(false)
    expect(metrics!.config.executor).toBe('worker')
    // 数据集与静态规则对齐：确定性规则在本样例集上应全部命中且无误报
    expect(metrics!.totals.tp).toBeGreaterThan(0)
    expect(metrics!.totals.fp).toBe(0)
    expect(metrics!.totals.fn).toBe(0)
    expect(metrics!.totals.precision).toBe(1)
    expect(metrics!.totals.recall).toBe(1)
    expect(metrics!.totals.f1).toBe(1)
    expect(metrics!.projects.length).toBe(6)
    expect(metrics!.disclaimer).toContain('小样本')

    for (const p of metrics!.projects) {
      const scan = await db.sql`select id, status, snapshot_id from scans where id = ${p.scanId}`
      expect(scan.length).toBe(1)
      expect((scan[0] as { status: string }).status).toBe('completed')
      // 逐项目结果可回溯：快照确实存在且为隔离预置项目
      const snapshotId = (scan[0] as { snapshot_id: string }).snapshot_id
      const snap = await db.sql`select s.id, pr.is_preset from snapshots s join projects pr on pr.id = s.project_id where s.id = ${snapshotId}`
      expect((snap[0] as { is_preset: boolean }).is_preset).toBe(true)
      const findings = await db.sql`select count(*)::int as c from findings where scan_id = ${p.scanId}`
      expect((findings[0] as { c: number }).c).toBe(p.metrics.candidateCount)
    }
    // 任务终态 completed
    const jobRow = await db.sql`select state from jobs where kind = 'evaluation' and target_id = ${evaluationId}`
    expect((jobRow[0] as { state: string }).state).toBe('completed')
    delete process.env.EVAL_PROJECT_LIMIT
  }, 180_000)

  it('holdout 划分（8 项目全跑）：completed 且逐项目 split=holdout', async () => {
    const version = await datasetVersion()
    const create = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only', split: 'holdout' },
        cookie: adminCookie,
      }),
    )
    const evaluationId = ((await create.json()) as { id: string }).id
    const { lease } = await claimEvaluationJob(evaluationId)
    await processEvaluationJob(db.sql, { evaluationId, job: lease })

    const rows = await db.sql`select status, metrics_json from evaluations where id = ${evaluationId}`
    expect((rows[0] as { status: string }).status).toBe('completed')
    const metrics = asJson<EvaluationMetricsJson>((rows[0] as { metrics_json: unknown }).metrics_json)!
    expect(metrics.projects.length).toBe(8)
    for (const p of metrics.projects) expect(p.split).toBe('holdout')
    expect(metrics.totals.precision).toBe(1)
  }, 180_000)

  it('llm_no_rag 与 hybrid_rag：无凭证 → provider=mock 标注、token 记录、RAG 开关生效', async () => {
    const version = await datasetVersion()
    const citationsByMode: Record<string, number> = { llm_no_rag: 0, hybrid_rag: 0 }
    for (const mode of ['llm_no_rag', 'hybrid_rag'] as const) {
      process.env.EVAL_PROJECT_LIMIT = '2'
      const create = await evaluationsRoute.POST(
        makeJsonReq('/api/evaluations', {
          method: 'POST',
          body: { datasetVersion: version, mode, split: 'dev' },
          cookie: adminCookie,
        }),
      )
      const evaluationId = ((await create.json()) as { id: string }).id
      const { lease } = await claimEvaluationJob(evaluationId)
      await processEvaluationJob(db.sql, { evaluationId, job: lease })

      const rows = await db.sql`select status, metrics_json from evaluations where id = ${evaluationId}`
      expect((rows[0] as { status: string }).status).toBe('completed')
      const metrics = asJson<EvaluationMetricsJson>((rows[0] as { metrics_json: unknown }).metrics_json)!
      expect(metrics.config.mode).toBe(mode)
      expect(metrics.config.providerIsMock).toBe(true)
      expect(metrics.config.provider).toBe('mock')
      expect(metrics.config.realModelRun).toBe(false)
      expect(metrics.config.note).toContain('真实模型评测未执行')
      expect(metrics.projects.length).toBe(2)
      // Mock 管线产生真实调用记录：token > 0、模型请求 > 0
      expect(metrics.tokens.total).toBeGreaterThan(0)
      for (const p of metrics.projects) {
        const scan = await db.sql`select usage_json from scans where id = ${p.scanId}`
        const usage = asJson<{ modelCalls: number; provider: string }>((scan[0] as { usage_json: unknown }).usage_json)
        expect(usage?.provider).toBe('mock')
        expect(usage?.modelCalls).toBeGreaterThan(0)
        const citations = await db.sql`select count(*)::int as c from scan_citations where scan_id = ${p.scanId}`
        citationsByMode[mode] += (citations[0] as { c: number }).c
        if (p.kind === 'defect') {
          // 缺陷项目：AI 复核与静态候选合并（combined）或作为 AI 发现插入
          const sources = await db.sql`select distinct source from findings where scan_id = ${p.scanId}`
          const sourceList = sources.map((s) => (s as { source: string }).source)
          expect(sourceList.some((s) => s === 'combined' || s === 'ai')).toBe(true)
        } else {
          // 对照项目：无标注缺陷 → AI 无可复核候选，不产生 AI 发现
          const sources = await db.sql`select distinct source from findings where scan_id = ${p.scanId}`
          const sourceList = sources.map((s) => (s as { source: string }).source)
          expect(sourceList.some((s) => s === 'ai')).toBe(false)
        }
      }
    }
    // 消融开关：hybrid_rag 出现规范引用快照；llm_no_rag 严格无引用
    expect(citationsByMode.hybrid_rag).toBeGreaterThan(0)
    expect(citationsByMode.llm_no_rag).toBe(0)
    delete process.env.EVAL_PROJECT_LIMIT
  }, 240_000)
})

describe('取消与失败语义', () => {
  it('取消在项目边界生效：处理前请求取消 → cancelled，无扫描创建', async () => {
    const version = await datasetVersion()
    const create = await evaluationsRoute.POST(
      makeJsonReq('/api/evaluations', {
        method: 'POST',
        body: { datasetVersion: version, mode: 'static_only', split: 'dev' },
        cookie: adminCookie,
      }),
    )
    const evaluationId = ((await create.json()) as { id: string }).id
    const { lease } = await claimEvaluationJob(evaluationId)
    // 取消前已存在的评测样例项目数（此前测试创建），取消后不得新增
    const beforeRows = (await db.sql`select count(*)::int as c from projects where name like ${'[评测]%'}`) as unknown as Array<{ c: number }>
    await requestCancel(db.sql, lease.id)
    await processEvaluationJob(db.sql, { evaluationId, job: lease })

    const rows = await db.sql`select status from evaluations where id = ${evaluationId}`
    expect((rows[0] as { status: string }).status).toBe('cancelled')
    const jobRow = await db.sql`select state from jobs where kind = 'evaluation' and target_id = ${evaluationId}`
    expect((jobRow[0] as { state: string }).state).toBe('cancelled')
    const afterRows = (await db.sql`select count(*)::int as c from projects where name like ${'[评测]%'}`) as unknown as Array<{ c: number }>
    expect(afterRows[0]!.c).toBe(beforeRows[0]!.c)
  }, 120_000)

  it('中途取消：已完成项目保留（partial），不再新增工作', async () => {
    const dataset = await loadDataset(fixturesDir)
    const create = await db.sql`
      insert into evaluations (dataset_version, config_json, status)
      values (${dataset.info.version}, ${db.sql.json({ mode: 'static_only', split: 'all', executor: 'worker', requestedAt: new Date().toISOString() })}, 'pending')
      returning id`
    const evaluationId = (create[0] as { id: string }).id
    // 第 2 个项目边界之后请求取消
    let calls = 0
    const result = await runEvaluation(db.sql, {
      evaluationId,
      dataset,
      mode: 'static_only',
      split: 'all',
      projectLimit: 4,
      isCancelRequested: async () => {
        calls++
        return calls > 1
      },
    })
    expect(result.status).toBe('partial')
    expect(result.metricsJson.config.cancelled).toBe(true)
    expect(result.metricsJson.config.projectCount).toBe(1)
    expect(result.metricsJson.projects.length).toBe(1)
  }, 120_000)

  it('重试上限耗尽：任务失败时 evaluations 一致终结为 failed', async () => {
    const create = await db.sql`
      insert into evaluations (dataset_version, config_json, status)
      values (${await datasetVersion()}, ${db.sql.json({ mode: 'static_only', split: 'all', executor: 'worker', requestedAt: new Date().toISOString() })}, 'pending')
      returning id`
    const evaluationId = (create[0] as { id: string }).id
    await db.sql`insert into jobs (kind, target_id) values ('evaluation', ${evaluationId})`

    // 第一次失败（attempt=1 → 未达上限，回队）
    const job1 = await claimJob(db.sql, newWorkerId(), ['evaluation'])
    expect(job1).not.toBeNull()
    expect(job1!.target_id).toBe(evaluationId)
    await failJob(
      db.sql,
      {
        id: job1!.id,
        kind: 'evaluation',
        target_id: job1!.target_id,
        lease_owner: job1!.lease_owner!,
        lease_generation: job1!.lease_generation,
        attempt: job1!.attempt,
      },
      '第一次执行错误',
    )
    const afterFirst = await db.sql`select status from evaluations where id = ${evaluationId}`
    expect((afterFirst[0] as { status: string }).status).toBe('pending')

    // 第二次失败（attempt=2 = 上限 → 任务与评测一致终结）
    await db.sql`update jobs set available_at = now() where id = ${job1!.id}`
    const job2 = await claimJob(db.sql, newWorkerId(), ['evaluation'])
    expect(job2).not.toBeNull()
    expect(job2!.id).toBe(job1!.id)
    expect(job2!.attempt).toBe(2)
    await failJob(
      db.sql,
      {
        id: job2!.id,
        kind: 'evaluation',
        target_id: job2!.target_id,
        lease_owner: job2!.lease_owner!,
        lease_generation: job2!.lease_generation,
        attempt: job2!.attempt,
      },
      '第二次执行错误',
    )
    const rows = await db.sql`select status, error_text from evaluations where id = ${evaluationId}`
    expect((rows[0] as { status: string }).status).toBe('failed')
    expect((rows[0] as { error_text: string }).error_text).toContain('重试次数耗尽')
    // 耗尽任务不再被领取
    const job3 = await claimJob(db.sql, newWorkerId(), ['evaluation'])
    expect(job3).toBeNull()
  }, 120_000)
})

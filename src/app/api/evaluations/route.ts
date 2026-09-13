import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonOk, toErrorResponse, HttpError } from '@/server/api/http'
import { requireSession } from '@/server/auth/guard'
import { asPgJson } from '@/server/db/json'
import {
  evaluationModeSchema,
  evaluationSplitSchema,
  type EvaluationRunConfig,
} from '@/core/contracts/evaluation'
import { readDatasetInfo, resolveFixturesDir } from '@/core/evaluation/dataset'

export const runtime = 'nodejs'

/**
 * 评测中心 API（规格 11 / F11 / R08）：
 * - POST：仅管理员访问码会话（sessions.role='admin'）可运行；重复运行创建新记录；202。
 * - GET：已登录会话可读（评测素材只读公开），返回运行列表与数据集概况。
 */

const createBodySchema = z.object({
  datasetVersion: z.string().min(1).max(100),
  mode: evaluationModeSchema,
  split: evaluationSplitSchema.default('all'),
})

export async function GET(req: NextRequest) {
  try {
    const sql = getDb()
    await requireSession(sql, req)
    const limitParam = req.nextUrl.searchParams.get('limit')
    const limit = Math.min(Math.max(parseInt(limitParam ?? '20', 10) || 20, 1), 100)
    const items = (await sql`
      select id, dataset_version as "datasetVersion", config_json as "configJson", status,
        metrics_json as "metricsJson", error_text as "errorText",
        created_at as "createdAt", completed_at as "completedAt"
      from evaluations order by created_at desc limit ${limit}`) as unknown as Array<{
      id: string
      datasetVersion: string
      configJson: unknown
      status: string
      metricsJson: unknown
      errorText: string | null
      createdAt: string
      completedAt: string | null
    }>
    const dataset = readDatasetInfo(resolveFixturesDir())
    return jsonOk({
      items,
      nextCursor: null,
      dataset: dataset
        ? {
            version: dataset.version,
            revision: dataset.revision,
            projectCount: dataset.projectCount,
            defectCount: dataset.defectCount,
            controlCount: dataset.controlCount,
            devCount: dataset.split.dev.length,
            holdoutCount: dataset.split.holdout.length,
            categories: dataset.categories,
          }
        : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req)
    const sql = getDb()
    const session = await requireSession(sql, req)
    // 规格 11：管理员访问码对应角色才可运行评测（demo 会话 403）
    if (session.role !== 'admin') {
      throw new HttpError(403, 'forbidden', '运行评测需要管理员访问码会话：当前会话无权限（HTTP 403）')
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new HttpError(400, 'invalid_request', '请求体必须是 JSON')
    }
    const parsed = createBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        `参数不合法：${parsed.error.issues.slice(0, 3).map((i) => i.message).join('；')}`,
      )
    }

    const dataset = readDatasetInfo(resolveFixturesDir())
    if (!dataset) {
      throw new HttpError(409, 'conflict', '评测数据集未生成：请先运行 pnpm fixtures:generate')
    }
    if (dataset.version !== parsed.data.datasetVersion) {
      throw new HttpError(
        400,
        'invalid_request',
        `datasetVersion 与当前数据集不一致（当前：${dataset.version}）`,
      )
    }

    const config: EvaluationRunConfig = {
      mode: parsed.data.mode,
      split: parsed.data.split,
      executor: 'worker',
      requestedAt: new Date().toISOString(),
    }
    const rows = (await sql`
      insert into evaluations (dataset_version, config_json, status)
      values (${dataset.version}, ${sql.json(asPgJson(config))}, 'pending')
      returning id`) as unknown as Array<{ id: string }>
    const evaluationId = rows[0]!.id
    await sql`insert into jobs (kind, target_id) values ('evaluation', ${evaluationId})`

    return jsonOk({ id: evaluationId, status: 'queued' }, 202)
  } catch (err) {
    return toErrorResponse(err)
  }
}

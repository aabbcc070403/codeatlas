/**
 * 真实模型（DeepSeek）追问 + 补丁冒烟脚本（2026-09-19）：
 * - 复用评测冒烟产生的真实扫描 finding（hybrid_rag holdout fx-msg-02），
 *   在本人会话项目下重建同构快照后原样拷贝该 finding；
 * - 不注入 provider：askFindingQuestion / proposePatchForFinding 缺省走真实
 *   provider 工厂（chatReady → OpenAI 兼容 DeepSeek）；
 * - 记录回答、引用、diff、token 与延迟，输出到 stdout（供交付报告引用）。
 *
 * 用法：pnpm db:dev 起库后 `npx tsx scripts/smoke-real-ai.ts`
 */
import crypto from 'node:crypto'
import postgres from 'postgres'
import { loadDotEnv, env } from '../src/server/env'
import { loadDataset, resolveFixturesDir } from '../src/core/evaluation/dataset'
import { buildStoredZip } from '../src/core/evaluation/zip'
import { prepareSnapshot } from '../src/core/import'
import { persistSnapshot } from '../src/server/snapshots'
import { askFindingQuestion } from '../src/core/review/conversation'
import { proposePatchForFinding } from '../src/core/patch/propose'

loadDotEnv()

/** 评测冒烟产生的真实扫描（hybrid_rag holdout fx-msg-02，DeepSeek） */
const SOURCE_SCAN_ID = '02b9dfec-9a72-40fd-9403-bfdd8e1da8c8'
const SOURCE_PROJECT_ID = 'fx-msg-02'

const QUESTION =
  '攻击者要从恶意页面触发这里的问题，需要满足什么前提？event.data 里的 theme 值会流向哪里？请引用具体代码行说明。'

async function main(): Promise<void> {
  const sql = postgres(env.DATABASE_URL, { max: 2, prepare: false })

  // 0. 起始日额度（评测冒烟已消耗部分）
  const dailyBefore = (await sql`select input_tokens, output_tokens from daily_usage
    where day = to_char(now() at time zone 'UTC', 'YYYY-MM-DD')`) as unknown as Array<{
    input_tokens: number
    output_tokens: number
  }>
  console.log('[0] 起始 daily_usage:', JSON.stringify(dailyBefore[0] ?? null))

  // 1. 会话 + 本人项目 + 真实导入管线快照（与评测/生产同构）
  const token = crypto.randomBytes(24).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const sessionRows = (await sql`insert into sessions (token_hash, role, expires_at)
    values (${tokenHash}, 'demo', now() + interval '1 day') returning id`) as unknown as Array<{ id: string }>
  const sessionId = sessionRows[0]!.id

  const dataset = await loadDataset(resolveFixturesDir())
  const project = dataset.projects.find((p) => p.id === SOURCE_PROJECT_ID)
  if (!project) throw new Error(`fixtures 中找不到 ${SOURCE_PROJECT_ID}`)

  const projectRows = (await sql`insert into projects (session_id, name)
    values (${sessionId}, ${'smoke-real-ai ' + new Date().toISOString()}) returning id`) as unknown as Array<{
    id: string
  }>
  const projectId = projectRows[0]!.id
  const zip = buildStoredZip(project.files.map((f) => ({ name: f.path, content: f.content })))
  const snapshot = await persistSnapshot(sql, projectId, await prepareSnapshot(zip))
  console.log(`[1] 会话/项目/快照就绪: projectId=${projectId} snapshotId=${snapshot.id}（${snapshot.fileCount} 文件）`)

  // 2. 扫描行 + 拷贝评测真实扫描的 finding（draft 原样，fingerprint 加 smoke 前缀避免碰撞）
  const scanRows = (await sql`insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
    values (${snapshot.id}, ${'smoke-' + crypto.randomUUID()}, 'completed', 'report',
      '{"enableCloudAI":true,"mode":"standard"}'::jsonb, 'v', 'v') returning id`) as unknown as Array<{ id: string }>
  const scanId = scanRows[0]!.id
  const srcFindings = (await sql`select rule_id, fingerprint, draft_json, source, evidence_status
    from findings where scan_id = ${SOURCE_SCAN_ID} limit 1`) as unknown as Array<{
    rule_id: string | null
    fingerprint: string
    draft_json: unknown
    source: string
    evidence_status: string
  }>
  const src = srcFindings[0]
  if (!src) throw new Error('源扫描没有 finding，无法冒烟')
  const findingRows = (await sql`insert into findings (scan_id, rule_id, fingerprint, draft_json, source, evidence_status)
    values (${scanId}, ${src.rule_id}, ${'smoke:' + src.fingerprint}, ${sql.json(src.draft_json as never)},
      ${src.source}, ${src.evidence_status}) returning id`) as unknown as Array<{ id: string }>
  const findingId = findingRows[0]!.id
  const draft = src.draft_json as { title: string }
  console.log(`[2] 拷贝真实 finding: ${findingId}（${draft.title}，source=${src.source}）`)

  // 3. 追问（不注入 provider → 真实 DeepSeek）
  const tAsk = Date.now()
  const ask = await askFindingQuestion(sql, { sessionId, findingId, text: QUESTION })
  const askWall = Date.now() - tAsk
  console.log('\n=== 追问冒烟（真实 provider） ===')
  console.log(`status: ${ask.status} | degradedReason: ${ask.degradedReason}`)
  console.log(`answer: ${(ask.answer ?? '(null)').slice(0, 1200)}`)
  console.log(`citations: ${JSON.stringify(ask.citations.map((c) => ({ path: c.path, lines: `${c.startLine}-${c.endLine}` })))}`)
  console.log(`guidelineChunkIds: ${ask.guidelineChunkIds.length} 个 | 无效引用: ${ask.invalidCitationCount} | 丢弃 chunk: ${ask.droppedChunkIdCount}`)
  console.log(`usage: ${JSON.stringify(ask.usage)}`)
  console.log(`墙钟: ${askWall}ms`)

  // 4. 补丁（不注入 provider → 真实 DeepSeek）
  const tPatch = Date.now()
  const patch = await proposePatchForFinding(sql, { sessionId, findingId })
  const patchWall = Date.now() - tPatch
  console.log('\n=== 补丁冒烟（真实 provider） ===')
  console.log(`status: ${patch.status} | patchId: ${patch.patchId}`)
  console.log(`validation: ${JSON.stringify(patch.validation)}`)
  console.log(`note: ${patch.note ?? '(null)'}`)
  console.log(`diff:\n${patch.diffText ?? '(null)'}`)
  console.log(`usage: ${JSON.stringify(patch.usage)}`)
  console.log(`墙钟: ${patchWall}ms`)

  // 5. 汇总 token
  const dailyAfter = (await sql`select input_tokens, output_tokens from daily_usage
    where day = to_char(now() at time zone 'UTC', 'YYYY-MM-DD')`) as unknown as Array<{
    input_tokens: number
    output_tokens: number
  }>
  const before = dailyBefore[0] ?? { input_tokens: 0, output_tokens: 0 }
  const after = dailyAfter[0] ?? { input_tokens: 0, output_tokens: 0 }
  console.log('\n=== token 汇总 ===')
  console.log(
    `本次冒烟增量: input ${after.input_tokens - before.input_tokens} + output ${after.output_tokens - before.output_tokens} = ${after.input_tokens - before.input_tokens + after.output_tokens - before.output_tokens}`,
  )
  console.log(`当前 daily_usage: ${JSON.stringify(after)}`)

  await sql.end()
}

void main().catch((err) => {
  console.error('冒烟失败:', err instanceof Error ? err.stack : err)
  process.exit(1)
})

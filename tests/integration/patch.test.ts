import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPatch } from 'diff'
import { createTestDb, type TestDb } from '../helpers/db'
import { buildDeflateZip } from '../helpers/zip'
import { prepareSnapshot } from '../../src/core/import'
import { persistSnapshot } from '../../src/server/snapshots'
import { seedAll } from '../../src/server/db/seed'
import { readSnapshotFile } from '../../src/server/storage'
import { asPgJson } from '../../src/server/db/json'
import { proposePatchForFinding, type ProposePatchInput } from '../../src/core/patch/propose'
import { sha256OfContent } from '../../src/core/patch/edits'
import type {
  ChatProvider,
  ProviderChatOptions,
  ProviderResult,
} from '../../src/core/review/provider'
import type { PatchEdit } from '../../src/core/contracts/patch'
import * as patchRoute from '../../src/app/api/findings/[id]/patch/route'
import * as downloadRoute from '../../src/app/api/patches/[id]/download/route'
import * as sessionRoute from '../../src/app/api/session/route'

/**
 * R06 补丁提案集成测试：脚本化受控 provider 生成有效提案 → 落库 → 可下载且
 * 内容与 diff 一致、可应用回原始文件；伪造编辑（旧文本不匹配/越界/脱敏）被拒；
 * 语法退化提案不可下载 409；快照文件字节不变；跨会话 404；Mock 标签；
 * 重复 POST 返回既有提案 / 基线失效重提；HTTP 合同（401/404/409）。
 * 全部使用受控 provider 或确定性 Mock，不调用真实模型。
 */

const FILE_LINES = [
  'export function send(msg: string) {',
  '  window.postMessage(msg, "*")',
  '  return true',
  '}',
  'export const VERSION = 1',
]
const FILE = FILE_LINES.join('\n')
const SAMPLE_FILES = [
  { name: 'src/a.ts', content: FILE },
  { name: 'data.json', content: '{"name":"t"}\n' },
  { name: 'package.json', content: '{"name":"t"}' },
]

let db: TestDb
let storageRoot: string
let projectId = ''
let snapshotId = ''
let storageKey = ''
let fileContentHash = ''
let findingId = ''
let presetFindingId = ''
let cookieA = ''
let cookieB = ''
let ownerSessionId = ''

/* ---------------- 基础设施 ---------------- */

function makeReq(
  urlPath: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
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
  const target = res.headers.getSetCookie().find((c) => c.startsWith('ca_session='))
  if (!target) throw new Error('未发现会话 cookie')
  return `ca_session=${target.split(';')[0]!.split('=').slice(1).join('=')}`
}

async function loginAs(code: string): Promise<string> {
  const res = await sessionRoute.POST(
    makeReq('/api/session', { method: 'POST', body: { accessCode: code } }),
  )
  expect(res.status).toBe(200)
  return extractCookie(res)
}

async function sessionIdFromCookie(cookie: string): Promise<string> {
  const token = cookie.split('=')[1]!
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  const rows = (await db.sql`select id from sessions where token_hash = ${hash}`) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

/** 脚本化受控 provider：每步一个脚本函数，忽略输入消息（除需要 file hash 的场景） */
class ScriptedProvider implements ChatProvider {
  readonly id = 'scripted-test'
  readonly isMock = false
  readonly ready = true
  chatCount = 0
  constructor(private steps: Array<(opts: ProviderChatOptions) => ProviderResult>) {}
  async chat(opts: ProviderChatOptions): Promise<ProviderResult> {
    const step = this.steps[Math.min(this.chatCount, this.steps.length - 1)]!
    this.chatCount++
    return step(opts)
  }
}

/** 读快照文件哈希（供脚本化 provider 构造合法编辑） */
async function currentFileHash(): Promise<string> {
  if (!fileContentHash) {
    const rows = (await db.sql`select content_hash, storage_key from files
      where snapshot_id = ${snapshotId} and path = 'src/a.ts'`) as unknown as Array<{
      content_hash: string
      storage_key: string
    }>
    fileContentHash = rows[0]!.content_hash
    storageKey = rows[0]!.storage_key
  }
  return fileContentHash
}

function submitPatch(id: string, edits: PatchEdit[], note?: string): ProviderResult {
  return {
    text: '',
    toolCalls: [{ id, name: 'submit_patch', args: { edits, ...(note ? { note } : {}) } }],
    usage: { inputTokens: 150, outputTokens: 40 },
  }
}

/** 合法编辑：把第 2 行替换为修正文本 */
async function validEdit(replacement = '  window.postMessage(msg, "https://example.com")'): Promise<PatchEdit> {
  return {
    path: 'src/a.ts',
    baseFileHash: await currentFileHash(),
    startLine: 2,
    endLine: 2,
    expectedOldText: FILE_LINES[1]!,
    replacementText: replacement,
  }
}

function findingDraft() {
  return {
    title: 'postMessage 目标源未约束',
    category: 'security',
    severity: 'high',
    confidence: 0.9,
    primary: { path: 'src/a.ts', startLine: 1, endLine: 3, quote: FILE_LINES.slice(0, 3).join('\n') },
    related: [],
    condition: 'message 目标源为通配符字符串',
    impact: '消息可能发送到任意窗口',
    reasoningSummary: '静态命中 postMessage 通配目标',
    recommendation: '使用具体目标源',
    guidelineChunkIds: [],
  }
}

async function createScanRow(snapshotIdValue: string): Promise<string> {
  const rows = (await db.sql`
    insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
    values (${snapshotIdValue}, ${'patch-' + Math.random().toString(36).slice(2, 10)}, 'completed', 'report',
      '{"enableCloudAI":false,"mode":"standard"}'::jsonb, 'v', 'v')
    returning id`) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

async function createFinding(opts: { draft?: Record<string, unknown> } = {}): Promise<string> {
  const rows = (await db.sql`
    insert into findings (scan_id, rule_id, fingerprint, draft_json, source, evidence_status)
    values (${await createScanRow(snapshotId)}, 'postmessage-target', ${'fp-' + Math.random().toString(36).slice(2, 8)},
      ${db.sql.json(asPgJson(opts.draft ?? findingDraft()))}, 'static', 'valid')
    returning id`) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

function propose(input: Partial<ProposePatchInput>) {
  return proposePatchForFinding(db.sql, {
    sessionId: ownerSessionId,
    findingId,
    ...input,
  } as ProposePatchInput)
}

/** 直接读存储文件字节（快照原件不可变断言用） */
async function storedFileBytes(): Promise<{ text: string; hash: string }> {
  const text = await readSnapshotFile(projectId, snapshotId, storageKey)
  return { text, hash: sha256OfContent(text) }
}

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-patch-'))
  const { env } = await import('../../src/server/env')
  Object.defineProperty(env, 'storageRoot', { value: storageRoot })
  await seedAll(db.sql)

  const zip = await buildDeflateZip(SAMPLE_FILES)
  const prepared = await prepareSnapshot(zip)

  cookieA = await loginAs('codeatlas-demo')
  cookieB = await loginAs('codeatlas-demo')
  ownerSessionId = await sessionIdFromCookie(cookieA)
  const project = (await db.sql`
    insert into projects (session_id, name) values (${ownerSessionId}, '补丁测试') returning id`)[0] as {
    id: string
  }
  projectId = project.id
  const summary = await persistSnapshot(db.sql, projectId, prepared)
  snapshotId = summary.id

  const fileRows = (await db.sql`select content_hash, storage_key from files
    where snapshot_id = ${snapshotId} and path = 'src/a.ts'`) as unknown as Array<{
    content_hash: string
    storage_key: string
  }>
  fileContentHash = fileRows[0]!.content_hash
  storageKey = fileRows[0]!.storage_key

  findingId = await createFinding()

  // 预置项目 finding（跨会话只读 → 404）
  const presetProject = (await db.sql`
    insert into projects (name, is_preset) values ('预置', true) returning id`)[0] as { id: string }
  const presetZip = await buildDeflateZip([{ name: 'src/a.ts', content: FILE }])
  const presetSnapshot = await persistSnapshot(db.sql, presetProject.id, await prepareSnapshot(presetZip))
  const presetScan = await createScanRow(presetSnapshot.id)
  const presetFinding = (await db.sql`
    insert into findings (scan_id, rule_id, fingerprint, draft_json, source, evidence_status)
    values (${presetScan}, 'postmessage-target', 'preset-fp', ${JSON.stringify(findingDraft())}, 'static', 'valid')
    returning id`)[0] as { id: string }
  presetFindingId = presetFinding.id
})

afterAll(async () => {
  await db.dispose()
  fs.rmSync(storageRoot, { recursive: true, force: true })
})

/* ---------------- 有效提案闭环 ---------------- */

describe('R06 有效提案：生成 → 落库 → 下载 → 应用回原文件', () => {
  it('受控 provider 有效提案：validation 三项分开、diff 与下载一致、可应用回原始文件、快照字节不变', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const scripted = new ScriptedProvider([
      () => submitPatch('s1', [edit], '收窄 postMessage 目标源'),
    ])
    const before = await storedFileBytes()
    const outcome = await propose({ findingId: fid, provider: scripted })
    expect(outcome.status).toBe('proposed')
    expect(scripted.chatCount).toBe(1)
    expect(outcome.patchId).not.toBeNull()
    expect(outcome.validation).toMatchObject({
      applicable: true,
      syntax: 'pass',
      tests: 'not_run',
      provider: 'openai',
    })
    expect(outcome.validation!.baselineSyntaxErrors).toBe(0)
    expect(outcome.validation!.patchedSyntaxErrors).toBe(0)
    expect(outcome.diffText).toContain('-' + FILE_LINES[1])
    expect(outcome.diffText).toContain('+  window.postMessage(msg, "https://example.com")')
    // 修复轮未触发：单次调用即成功
    expect(outcome.usage.modelCalls).toBe(1)
    // 落库
    const rows = (await db.sql`select diff_text, validation_json, status, base_file_hash from patches
      where finding_id = ${fid}`) as unknown as Array<{
      diff_text: string
      validation_json: unknown
      status: string
      base_file_hash: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('proposed')
    expect(rows[0]!.diff_text).toBe(outcome.diffText)
    expect(rows[0]!.base_file_hash).toBe(await currentFileHash())
    // 快照文件字节不变
    const after = await storedFileBytes()
    expect(after).toEqual(before)
    // 导出的 patch 可应用回原始脱敏样例文件
    const applied = applyPatch(before.text, outcome.diffText!)
    if (applied === false) throw new Error('导出的 patch 无法应用回原文件')
    expect(applied).toContain('window.postMessage(msg, "https://example.com")')
    expect(applied.split('\n').length).toBe(before.text.split('\n').length)
  })

  it('下载：内容与 diff 一致、Content-Disposition .patch 附件', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const outcome = await propose({ findingId: fid, provider: new ScriptedProvider([() => submitPatch('s1', [edit])]) })
    expect(outcome.patchId).not.toBeNull()
    const res = await downloadRoute.GET(
      makeReq(`/api/patches/${outcome.patchId}/download`, { cookie: cookieA }),
      { params: Promise.resolve({ id: outcome.patchId! }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/x-diff')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="codeatlas-patch-[0-9a-f]+\.patch"$/)
    const text = await res.text()
    expect(text).toBe(outcome.diffText)
  })

  it('GET /api/findings/:id/patch 恢复既有提案（刷新恢复）', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    await propose({ findingId: fid, provider: new ScriptedProvider([() => submitPatch('s1', [edit])]) })
    const res = await patchRoute.GET(
      makeReq(`/api/findings/${fid}/patch`, { cookie: cookieA }),
      { params: Promise.resolve({ id: fid }) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patch: { id: string; diffText: string; status: string } | null }
    expect(body.patch).not.toBeNull()
    expect(body.patch!.status).toBe('proposed')
    expect(body.patch!.diffText).toContain('https://example.com')
  })
})

describe('A03 补丁预算：预留与允许输出一致、输出上限收缩', () => {
  it('provider 收到的 maxOutputTokens 与预留量一致（默认 1500，不再预留 1500 / 传 2000）', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const received: number[] = []
    const scripted = new ScriptedProvider([
      (opts) => {
        received.push(opts.maxOutputTokens)
        return submitPatch('a03a', [edit])
      },
    ])
    const outcome = await propose({ findingId: fid, provider: scripted })
    expect(outcome.status).toBe('proposed')
    expect(received).toEqual([1500])
    // 成功调用结算后预留归零（A04 reservation 绑定）
    const daily = (await db.sql`select reserved_tokens from daily_usage`)[0] as unknown as
      | { reserved_tokens: number }
      | undefined
    expect(daily?.reserved_tokens ?? 0).toBe(0)
  })

  it('输出预算收缩：剩余输出额度 300 时 provider 收到 maxOutputTokens=300', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const received: number[] = []
    const scripted = new ScriptedProvider([
      (opts) => {
        received.push(opts.maxOutputTokens)
        return submitPatch('a03b', [edit])
      },
    ])
    const outcome = await propose({
      findingId: fid,
      provider: scripted,
      budgetConfig: { maxOutputTokens: 300 },
    })
    expect(outcome.status).toBe('proposed')
    expect(received).toEqual([300])
  })
})

/* ---------------- 校验链拒绝 ---------------- */

describe('R06 伪造编辑：校验链拒绝（含修复轮后仍拒绝 → invalid 提案不可下载）', () => {
  it.each([
    {
      name: '旧文本不匹配',
      build: async () => [
        {
          path: 'src/a.ts',
          baseFileHash: await currentFileHash(),
          startLine: 2,
          endLine: 2,
          expectedOldText: '  window.postMessage(msg, other)',
          replacementText: '  x',
        },
      ],
      reason: '旧文本',
    },
    {
      name: '行段越界',
      build: async () => [
        {
          path: 'src/a.ts',
          baseFileHash: await currentFileHash(),
          startLine: 4,
          endLine: 9,
          expectedOldText: FILE_LINES.slice(3, 9).join('\n'),
          replacementText: '  x',
        },
      ],
      reason: '越界',
    },
    {
      name: '过期基线 hash',
      build: async () => [
        {
          path: 'src/a.ts',
          baseFileHash: 'f'.repeat(64),
          startLine: 2,
          endLine: 2,
          expectedOldText: FILE_LINES[1]!,
          replacementText: '  x',
        },
      ],
      reason: 'baseFileHash',
    },
  ])('$name → invalid 提案（applicable=false），下载 409，快照字节不变', async ({ build, reason }) => {
    const fid = await createFinding()
    const edits = await build()
    const scripted = new ScriptedProvider([() => submitPatch('s1', edits)])
    const before = await storedFileBytes()
    const outcome = await propose({ findingId: fid, provider: scripted })
    // 修复轮触发（第 2 次调用重复同样坏编辑）→ 仍拒绝
    expect(scripted.chatCount).toBe(2)
    expect(outcome.status).toBe('invalid')
    expect(outcome.validation!.applicable).toBe(false)
    expect(outcome.validation!.reasons.join('\n')).toContain(reason)
    expect(outcome.validation!.tests).toBe('not_run')
    expect(outcome.diffText).toBeNull()
    const after = await storedFileBytes()
    expect(after).toEqual(before)
    const res = await downloadRoute.GET(
      makeReq(`/api/patches/${outcome.patchId}/download`, { cookie: cookieA }),
      { params: Promise.resolve({ id: outcome.patchId! }) },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('conflict')
  })

  it('命中脱敏区间的编辑拒绝（redactedRanges 直接入库构造）', async () => {
    const fid = await createFinding()
    await db.sql`update files set redacted_ranges = '[{"line":2,"start":0,"end":5}]'::jsonb
      where snapshot_id = ${snapshotId} and path = 'src/a.ts'`
    try {
      const edit = await validEdit()
      const scripted = new ScriptedProvider([() => submitPatch('s1', [edit])])
      const outcome = await propose({ findingId: fid, provider: scripted })
      expect(outcome.status).toBe('invalid')
      expect(outcome.validation!.reasons.join('\n')).toContain('脱敏')
    } finally {
      await db.sql`update files set redacted_ranges = '[]'::jsonb
        where snapshot_id = ${snapshotId} and path = 'src/a.ts'`
    }
  })

  it('多文件编辑：Zod 合同拒绝（无提案入库，409）', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const other: PatchEdit = { ...edit, path: 'data.json' }
    const scripted = new ScriptedProvider([() => submitPatch('s1', [edit, other])])
    const outcome = await propose({ findingId: fid, provider: scripted })
    expect(outcome.status).toBe('no_proposal')
    expect(outcome.patchId).toBeNull()
    // 结构不合法经修复轮后仍不合法
    expect(scripted.chatCount).toBe(2)
  })

  it('语法退化提案：可应用但引入新语法错误 → status=invalid，下载 409', async () => {
    const fid = await createFinding()
    const edit = await validEdit('  const const const  // broken')
    const scripted = new ScriptedProvider([() => submitPatch('s1', [edit])])
    const outcome = await propose({ findingId: fid, provider: scripted })
    expect(outcome.status).toBe('invalid')
    expect(outcome.validation).toMatchObject({ applicable: true, syntax: 'fail', tests: 'not_run' })
    expect(outcome.validation!.patchedSyntaxErrors).toBeGreaterThan(outcome.validation!.baselineSyntaxErrors)
    expect(outcome.reasons.join('\n')).toContain('语法')
    const res = await downloadRoute.GET(
      makeReq(`/api/patches/${outcome.patchId}/download`, { cookie: cookieA }),
      { params: Promise.resolve({ id: outcome.patchId! }) },
    )
    expect(res.status).toBe(409)
  })

  it('不支持解析的语言（json）拒绝生成提案', async () => {
    const draft = findingDraft()
    draft.primary = { path: 'data.json', startLine: 1, endLine: 1, quote: '{"name":"t"}' }
    const fid = await createFinding({ draft })
    const scripted = new ScriptedProvider([() => submitPatch('s1', [])])
    const outcome = await propose({ findingId: fid, provider: scripted })
    expect(outcome.status).toBe('unsupported_file')
    expect(scripted.chatCount).toBe(0)
    expect(outcome.patchId).toBeNull()
  })
})

/* ---------------- Mock / 重复 POST / 权限 / HTTP ---------------- */

describe('R06 Mock 提案与重复 POST', () => {
  it('Mock 提案：默认 provider（chat 未配置）生成 Mock 示例提案，标签持久化，可下载', async () => {
    const fid = await createFinding()
    // 日额度按增量断言（daily_usage 为按天全局行，可能被其他受控用例结算过）
    const dailyBefore = (await db.sql`select coalesce(sum(input_tokens + output_tokens), 0)::int as t
      from daily_usage`)[0] as unknown as { t: number } | undefined
    const outcome = await propose({ findingId: fid })
    expect(outcome.status).toBe('proposed')
    expect(outcome.usage.provider).toBe('mock')
    expect(outcome.note).toContain('Mock 示例提案，非真实 AI 修复')
    expect(outcome.diffText).toContain('Mock 示例提案，非真实 AI 修复')
    expect(outcome.validation!.provider).toBe('mock')
    expect(outcome.validation!.syntax).toBe('pass')
    // Mock 不消耗日额度：调用前后记账不变
    const dailyAfter = (await db.sql`select coalesce(sum(input_tokens + output_tokens), 0)::int as t
      from daily_usage`)[0] as unknown as { t: number } | undefined
    expect(dailyAfter?.t ?? 0).toBe(dailyBefore?.t ?? 0)
    // 可下载
    const res = await downloadRoute.GET(
      makeReq(`/api/patches/${outcome.patchId}/download`, { cookie: cookieA }),
      { params: Promise.resolve({ id: outcome.patchId! }) },
    )
    expect(res.status).toBe(200)
  })

  it('重复 POST：已有同基线提案直接返回既有（不重复调用模型）', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const scripted = new ScriptedProvider([() => submitPatch('s1', [edit])])
    const first = await propose({ findingId: fid, provider: scripted })
    expect(first.status).toBe('proposed')
    const second = await propose({ findingId: fid, provider: scripted })
    expect(second.status).toBe('existing')
    expect(second.patchId).toBe(first.patchId)
    expect(scripted.chatCount).toBe(1)
  })

  it('基线失效：旧提案标记 superseded 后重新生成新提案', async () => {
    const fid = await createFinding()
    const edit = await validEdit()
    const scripted = new ScriptedProvider([() => submitPatch('s1', [edit])])
    const first = await propose({ findingId: fid, provider: scripted })
    expect(first.status).toBe('proposed')
    // 人为使提案基线失效（快照不可变，此为合同行为验证）
    await db.sql`update patches set base_file_hash = ${'0'.repeat(64)} where id = ${first.patchId}`
    const second = await propose({ findingId: fid, provider: scripted })
    expect(second.status).toBe('proposed')
    expect(second.patchId).not.toBe(first.patchId)
    const rows = (await db.sql`select status from patches where finding_id = ${fid}
      order by created_at asc`) as unknown as Array<{ status: string }>
    expect(rows[0]!.status).toBe('superseded')
    expect(rows[1]!.status).toBe('proposed')
  })
})

describe('R06 权限与 HTTP 合同', () => {
  it('跨会话：POST / GET patch / download 一律 404（预置项目只读同样 404）', async () => {
    const post = await patchRoute.POST(
      makeReq(`/api/findings/${findingId}/patch`, { method: 'POST', cookie: cookieB }),
      { params: Promise.resolve({ id: findingId }) },
    )
    expect(post.status).toBe(404)
    const get = await patchRoute.GET(
      makeReq(`/api/findings/${findingId}/patch`, { cookie: cookieB }),
      { params: Promise.resolve({ id: findingId }) },
    )
    expect(get.status).toBe(404)
    const preset = await patchRoute.POST(
      makeReq(`/api/findings/${presetFindingId}/patch`, { method: 'POST', cookie: cookieA }),
      { params: Promise.resolve({ id: presetFindingId }) },
    )
    expect(preset.status).toBe(404)
  })

  it('未登录 POST/GET → 401', async () => {
    const post = await patchRoute.POST(
      makeReq(`/api/findings/${findingId}/patch`, { method: 'POST' }),
      { params: Promise.resolve({ id: findingId }) },
    )
    expect(post.status).toBe(401)
    const get = await patchRoute.GET(
      makeReq(`/api/findings/${findingId}/patch`),
      { params: Promise.resolve({ id: findingId }) },
    )
    expect(get.status).toBe(401)
  })

  it('download：跨会话 404、不存在 404、非法 UUID 404', async () => {
    const edit = await validEdit()
    const outcome = await propose({ findingId, provider: new ScriptedProvider([() => submitPatch('s1', [edit])]) })
    expect(outcome.patchId).not.toBeNull()
    const cross = await downloadRoute.GET(
      makeReq(`/api/patches/${outcome.patchId}/download`, { cookie: cookieB }),
      { params: Promise.resolve({ id: outcome.patchId! }) },
    )
    expect(cross.status).toBe(404)
    const missing = await downloadRoute.GET(
      makeReq(`/api/patches/00000000-0000-0000-0000-000000000000/download`, { cookie: cookieA }),
      { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) },
    )
    expect(missing.status).toBe(404)
    const malformed = await downloadRoute.GET(
      makeReq(`/api/patches/not-a-uuid/download`, { cookie: cookieA }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    )
    expect(malformed.status).toBe(404)
  })

  it('HTTP POST（Mock 默认 provider）→ 200 + usage；同 finding 第二次 POST → status=existing', async () => {
    const fid = await createFinding()
    const post = await patchRoute.POST(
      makeReq(`/api/findings/${fid}/patch`, { method: 'POST', cookie: cookieA }),
      { params: Promise.resolve({ id: fid }) },
    )
    expect(post.status).toBe(200)
    const body = (await post.json()) as {
      status: string
      patch: { id: string; validation: { provider: string; tests: string } }
      usage: { provider: string; modelCalls: number }
    }
    expect(body.status).toBe('proposed')
    expect(body.patch.validation.provider).toBe('mock')
    expect(body.patch.validation.tests).toBe('not_run')
    expect(body.usage.provider).toBe('mock')
    const post2 = await patchRoute.POST(
      makeReq(`/api/findings/${fid}/patch`, { method: 'POST', cookie: cookieA }),
      { params: Promise.resolve({ id: fid }) },
    )
    const body2 = (await post2.json()) as { status: string; patch: { id: string } }
    expect(body2.status).toBe('existing')
    expect(body2.patch.id).toBe(body.patch.id)
  })
})

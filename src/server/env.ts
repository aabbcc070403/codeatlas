import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * 轻量 .env 加载器：Next.js 会自行加载 .env，但 worker 和 scripts 需要手动加载。
 * 已存在于 process.env 的值优先。
 */
export function loadDotEnv(root: string = process.cwd()): void {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadDotEnv()

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default('postgres://codeatlas:local@127.0.0.1:5433/codeatlas'),
  STORAGE_ROOT: z.string().default('.data/storage'),
  DB_DATA_DIR: z.string().default('.data/pglite'),
  DB_PORT: z.coerce.number().int().default(5433),
  SESSION_SECRET: z.string().default('dev-secret-change-me'),
  DEMO_ACCESS_CODE: z.string().default('codeatlas-demo'),
  ADMIN_ACCESS_CODE: z.string().default('codeatlas-admin'),
  AI_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_CHAT_MODEL: z.string().optional(),
  AI_EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIM: z.coerce.number().int().default(1536),
  AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().default(300_000),
  /** 追问轮预算的可选覆盖（优化策略）；未设置时用规格默认 4/8/60s */
  AI_ASK_MAX_MODEL_CALLS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  AI_ASK_MAX_TOOL_CALLS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  AI_ASK_WALL_MS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  DATA_TTL_HOURS: z.coerce.number().default(24),
  APP_ORIGIN: z.string().optional(),
})

const parsed = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  STORAGE_ROOT: process.env.STORAGE_ROOT,
  DB_DATA_DIR: process.env.DB_DATA_DIR,
  DB_PORT: process.env.DB_PORT,
  SESSION_SECRET: process.env.SESSION_SECRET,
  DEMO_ACCESS_CODE: process.env.DEMO_ACCESS_CODE,
  ADMIN_ACCESS_CODE: process.env.ADMIN_ACCESS_CODE,
  AI_PROVIDER: process.env.AI_PROVIDER,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_CHAT_MODEL: process.env.AI_CHAT_MODEL,
  AI_EMBEDDING_MODEL: process.env.AI_EMBEDDING_MODEL,
  EMBEDDING_DIM: process.env.EMBEDDING_DIM,
  AI_DAILY_TOKEN_LIMIT: process.env.AI_DAILY_TOKEN_LIMIT,
  AI_ASK_MAX_MODEL_CALLS: process.env.AI_ASK_MAX_MODEL_CALLS,
  AI_ASK_MAX_TOOL_CALLS: process.env.AI_ASK_MAX_TOOL_CALLS,
  AI_ASK_WALL_MS: process.env.AI_ASK_WALL_MS,
  DATA_TTL_HOURS: process.env.DATA_TTL_HOURS,
  APP_ORIGIN: process.env.APP_ORIGIN,
})

export const env = {
  ...parsed,
  isProduction: process.env.NODE_ENV === 'production',
  get storageRoot(): string {
    return path.isAbsolute(parsed.STORAGE_ROOT)
      ? parsed.STORAGE_ROOT
      : path.resolve(process.cwd(), parsed.STORAGE_ROOT)
  },
}

/**
 * AI 供应商配置是否满足真实调用条件（不读取密钥值之外的信息）。
 * chat 与 embedding 的 readiness 相互独立（R04）：只配置其中之一时另一路不可用，
 * 不互相依赖——embedding 不可用仅降级为词法检索，chat 不可用仅跳过 AI 阶段。
 */
export function aiProviderStatus(): {
  provider: 'mock' | 'openai'
  /** 基础就绪（密钥与 baseURL，provider=openai） */
  ready: boolean
  missing: string[]
  /** chat 模型是否可用（ready + AI_CHAT_MODEL） */
  chatReady: boolean
  /** embedding 模型是否可用（ready + AI_EMBEDDING_MODEL） */
  embeddingReady: boolean
  chatModel: string | null
  embeddingModel: string | null
} {
  const missing: string[] = []
  if (parsed.AI_PROVIDER === 'openai') {
    if (!parsed.AI_API_KEY) missing.push('AI_API_KEY')
    if (!parsed.AI_BASE_URL) missing.push('AI_BASE_URL')
  }
  const ready = parsed.AI_PROVIDER === 'openai' && missing.length === 0
  const chatModel = parsed.AI_CHAT_MODEL ?? null
  const embeddingModel = parsed.AI_EMBEDDING_MODEL ?? null
  return {
    provider: parsed.AI_PROVIDER,
    ready,
    missing,
    chatReady: ready && chatModel !== null,
    embeddingReady: ready && embeddingModel !== null,
    chatModel,
    embeddingModel,
  }
}

import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import type {
  Category,
  EvidenceStatus,
  Feedback,
  FindingDraft,
  MessageUsage,
  PatchEdit,
  PatchValidation,
  RiskInfo,
  ScanConfig,
  SourceLabel,
  UsageInfo,
} from '@/core/contracts'
import type { CoverageInfo } from '@/core/contracts/scan'

/* ---------- 会话与项目 ---------- */

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    role: text('role').notNull().default('demo'), // demo | admin
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('sessions_token_hash_key').on(t.tokenHash)],
)

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'cascade',
    }), // 预置演示项目为空
    name: text('name').notNull(),
    isPreset: boolean('is_preset').notNull().default(false),
    /** R03：异步删除标记。非空=已请求删除（等待活动任务退出后由清理服务删除） */
    deletingAt: timestamp('deleting_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('projects_session_id_idx').on(t.sessionId)],
)

/* ---------- 快照与文件 ---------- */

export interface SkippedEntry {
  path: string
  reason: string
}

export interface StructureStats {
  languageCounts: Record<string, number>
  dependencyFiles: Array<{ path: string; declared: string[] }>
  lockFiles: string[]
  importEdges: Array<{ from: string; to: string; resolved: boolean }>
  unresolvedImports: Array<{ from: string; specifier: string }>
}

export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull().default('ready'),
    fileCount: integer('file_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    structureJson: jsonb('structure_json').$type<StructureStats | null>(),
    skippedJson: jsonb('skipped_json').$type<SkippedEntry[]>().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('snapshots_project_id_idx').on(t.projectId)],
)

export interface RedactedRange {
  line: number
  start: number
  end: number
}

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => snapshots.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    contentHash: text('content_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    language: text('language').notNull(), // js|ts|jsx|tsx|vue|json|md|css|html
    lineCount: integer('line_count').notNull().default(0),
    parseStatus: text('parse_status').notNull().default('pending'), // pending|ok|parse_error
    redactedRanges: jsonb('redacted_ranges')
      .$type<RedactedRange[]>()
      .notNull()
      .default([]),
  },
  (t) => [
    uniqueIndex('files_snapshot_path_key').on(t.snapshotId, t.path),
    index('files_snapshot_id_idx').on(t.snapshotId),
  ],
)

/* ---------- 扫描 ---------- */

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => snapshots.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('queued'),
    stage: text('stage').notNull().default('ingest'),
    configJson: jsonb('config_json').$type<ScanConfig>().notNull(),
    ruleVersion: text('rule_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    modelId: text('model_id'),
    coverageJson: jsonb('coverage_json').$type<CoverageInfo | null>(),
    usageJson: jsonb('usage_json').$type<UsageInfo | null>(),
    riskJson: jsonb('risk_json').$type<RiskInfo | null>(),
    errorText: text('error_text'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('scans_snapshot_idempotency_key').on(
      t.snapshotId,
      t.idempotencyKey,
    ),
    index('scans_snapshot_id_idx').on(t.snapshotId),
  ],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // scan | document_index | evaluation
    targetId: uuid('target_id').notNull(),
    state: text('state').notNull().default('queued'),
    leaseOwner: text('lease_owner'),
    leaseGeneration: integer('lease_generation').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempt: integer('attempt').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    lastError: text('last_error'),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('jobs_kind_target_key').on(t.kind, t.targetId),
    index('jobs_state_available_idx').on(t.state, t.availableAt),
  ],
)

/** 全局递增事件 ID 作为 SSE 游标（规格 10） */
export const scanEvents = pgTable(
  'scan_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('scan_events_scan_id_idx').on(t.scanId, t.id)],
)

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id'),
    fingerprint: text('fingerprint').notNull(),
    draftJson: jsonb('draft_json').$type<FindingDraft>().notNull(),
    source: text('source').$type<SourceLabel>().notNull(),
    evidenceStatus: text('evidence_status')
      .$type<EvidenceStatus>()
      .notNull()
      .default('valid'),
    feedback: text('feedback').$type<Feedback>().notNull().default('unreviewed'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('findings_scan_fingerprint_key').on(t.scanId, t.fingerprint),
    index('findings_scan_id_idx').on(t.scanId),
  ],
)

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    toolName: text('tool_name').notNull(),
    inputSummary: text('input_summary').notNull(),
    resultSummary: text('result_summary').notNull(),
    elapsedMs: integer('elapsed_ms').notNull().default(0),
    status: text('status').notNull().default('ok'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('tool_calls_scan_id_idx').on(t.scanId)],
)

/* ---------- 规范知识库 ---------- */

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }), // 预置规范为空
    builtinKey: text('builtin_key'), // 预置条目稳定标识（如 SEC-001）
    version: integer('version').notNull().default(1),
    contentHash: text('content_hash').notNull(),
    sourceUrl: text('source_url'),
    title: text('title').notNull(),
    category: text('category').$type<Category>().notNull(),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    indexStatus: text('index_status').notNull().default('pending'), // pending|indexing|ready|failed|lexical_only
    indexError: text('index_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('documents_builtin_key_key').on(t.builtinKey),
    index('documents_project_id_idx').on(t.projectId),
    index('documents_is_builtin_idx').on(t.isBuiltin),
  ],
)

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    heading: text('heading').notNull().default(''),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddingModel: text('embedding_model'),
    indexVersion: integer('index_version').notNull().default(1),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('chunks_document_id_idx').on(t.documentId)],
)

export const scanCitations = pgTable(
  'scan_citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id'),
    version: integer('version').notNull(),
    textSnapshot: text('text_snapshot').notNull(),
    sourceUrl: text('source_url'),
    title: text('title').notNull(),
  },
  (t) => [index('scan_citations_scan_id_idx').on(t.scanId)],
)

/* ---------- 补丁与追问 ---------- */

export const patches = pgTable(
  'patches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    findingId: uuid('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    baseFileHash: text('base_file_hash').notNull(),
    editsJson: jsonb('edits_json').$type<PatchEdit[]>().notNull(),
    diffText: text('diff_text').notNull(),
    validationJson: jsonb('validation_json').$type<PatchValidation>().notNull(),
    status: text('status').notNull().default('proposed'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('patches_finding_id_idx').on(t.findingId)],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    findingId: uuid('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant
    text: text('text').notNull(),
    citationsJson: jsonb('citations_json')
      .$type<
        Array<{
          path: string
          startLine: number
          endLine: number
          quote: string
        }>
      >()
      .default([]),
    usageJson: jsonb('usage_json').$type<MessageUsage | null>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('messages_finding_id_idx').on(t.findingId)],
)

/* ---------- 评测 ---------- */

export const evaluations = pgTable('evaluations', {
  id: uuid('id').primaryKey().defaultRandom(),
  datasetVersion: text('dataset_version').notNull(),
  configJson: jsonb('config_json').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'),
  metricsJson: jsonb('metrics_json').$type<Record<string, unknown> | null>(),
  artifactPath: text('artifact_path'),
  errorText: text('error_text'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

/**
 * 评测逐项目完成记录（A08）：项目完成后保存（父评测租约事务内），
 * 任务恢复时复用已有 scan/指标 —— 不重复执行已完成项目、不重复调用模型。
 */
export const evaluationProjects = pgTable(
  'evaluation_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),
    /** 数据集项目 id（manifest id，非 uuid） */
    projectId: text('project_id').notNull(),
    /** 本项目使用的扫描（结果可回溯；恢复时直接复用） */
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    /** 扫描终态（completed/partial/...） */
    status: text('status').notNull(),
    /** 本项目单项目指标（MetricSummary 结构化形态） */
    metricsJson: jsonb('metrics_json').$type<Record<string, unknown>>().notNull(),
    latencyMs: integer('latency_ms').notNull(),
    tokenTotal: integer('token_total').notNull(),
    providerIsMock: boolean('provider_is_mock').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('evaluation_projects_eval_project_key').on(t.evaluationId, t.projectId),
    index('evaluation_projects_scan_id_idx').on(t.scanId),
  ],
)

/* ---------- AI 日预算 ---------- */

export const dailyUsage = pgTable('daily_usage', {
  day: text('day').primaryKey(), // YYYY-MM-DD (UTC)
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  requests: integer('requests').notNull().default(0),
  /** R04：调用前原子预留、结算时释放（used + reserved ≤ 日限额） */
  reservedTokens: integer('reserved_tokens').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
})

/**
 * 日额度预留台账（A04）：每次预留一行，settle/release 按唯一 ID 做
 * 状态迁移（reserved → settled / released），保证结算/释放幂等且绑定
 * 预留发生的 UTC 日期（跨日结算不更新新日期行）。
 */
export const dailyReservations = pgTable('daily_reservations', {
  id: text('id').primaryKey(),
  day: text('day').notNull(), // YYYY-MM-DD (UTC)
  tokens: integer('tokens').notNull(),
  /** reserved | settled | released */
  state: text('state').notNull().default('reserved'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
})

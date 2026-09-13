# CodeAtlas 架构说明

本文基于磁盘上的真实实现（R01–R09 之后的代码）编写，描述模块结构、数据流、安全边界与关键合同。规格理想态与实现差异处均以实测行为为准。执行进度与验证证据见 `docs/progress.md`。

## 1. 总体模块图

```text
浏览器（React 客户端组件 + 服务端组件首屏）
   │  HttpOnly cookie 会话（服务端仅存 SHA-256 token 哈希）
   ▼
Next.js 15 App Router（端口 3100）
   ├─ 页面（服务端组件）：/login /projects /projects/[id] /projects/[id]/compare
   │                      /scans/[id] /scans/[id]/findings/[findingId] /knowledge /evaluation
   ├─ API 路由（src/app/api/**，guard：requireSession / requireReadableXxx）
   ├─ 查询层（src/server/queries/**）：API 路由与服务端页面共用同一 DTO/SQL
   └─ 会话/权限（src/server/auth）＋ 环境配置（src/server/env.ts）
   ▼
PostgreSQL 协议数据库（postgres.js 驱动 + Drizzle schema）
   ├─ 本地开发：PGlite 0.5.8（嵌入式 Postgres + pgvector）经自研 socket 服务暴露（scripts/db-server.ts，端口 5433）
   └─ 生产：PostgreSQL 16 + pgvector（compose.yaml 的 db 服务；本机未验证）

独立 worker（scripts/worker.ts，无 shell 工具）
   ├─ jobs.ts：FOR UPDATE SKIP LOCKED 原子领取、30s 租约 / 10s 续租、失租条件写、上限 2 次尝试
   ├─ scanner.ts：六阶段扫描管线（ingest→index→static→ai→validate→report）
   ├─ document-index.ts：项目 Markdown 切块 + 嵌入索引
   ├─ evaluation.ts：评测任务执行（调 runner.ts）
   └─ cleanup.ts：项目异步删除、TTL 过期清理（预置样例不受影响）
```

数据库是唯一的协调点：web 只创建任务行并读取状态/结果，worker 持久化执行；不引入 Redis，不用 Serverless 承载长扫描。

## 2. 数据流

### 2.1 导入（ingest）

1. `POST /api/projects/:id/snapshots` 接收 multipart ZIP，yauzl 流式读取；实际解压字节限额（压缩 20MiB / 解压 80MiB / 2000 条目 / 单文件 512KiB）。
2. 路径校验（`src/core/import/paths.ts`）：穿越 / 绝对路径 / 盘符 / UNC / 保留设备名 / ADS 冒号 / NUL / 大小写冲突全拒绝，`/` 与 `\` 双分隔符识别；ZIP 内嵌 ZIP 不递归。
3. 脱敏（`redact.ts`）：疑似密钥（赋值密钥 / AKIA / ghp_ / sk- / AIza / JWT / PEM 块）等长遮盖并记录 `redactedRanges`；`.env`、私钥等文件拒绝收录。
4. 生成不可变快照：文件内容哈希、CRLF→LF 与 BOM 标准化、UTF-8 严格解码、语言分布 / 依赖声明 / 相对导入图等结构统计；原始字节经 `storageKey` 写入 `STORAGE_ROOT`。
5. 忽略策略（node_modules / dist / .git / 二进制 / 大文件等）逐条记录原因，界面展示。

### 2.2 扫描管线（worker，六阶段）

事件全部持久化到 `scan_events`（id 为全局递增 bigint，即 SSE 游标）：

```text
ingest（快照核对）→ index（TS Compiler API 内存 AST，自有程序，不加载项目插件；
                    Vue SFC script 块抽取 + 原始行号映射）
→ static（9 条确定性规则，候选标 needs_review；行重叠去重）
→ ai（用户勾选云端 AI 且 chat 就绪时；风险优先抽样 + 受限工具循环 + 修复轮）
→ validate（全部 finding 引文与快照真实行严格比对，无效删除并计数 finding.invalid）
→ report（结果、风险指数、覆盖、usage 同事务终态化）
```

事件类型：`scan.started` / `stage.started` / `stage.completed` / `tool.completed` / `finding.created` / `finding.invalid` / `scan.finished`。取消在阶段边界检查；崩溃恢复从已持久化的 `scan.stage` 继续，已发事件按 `scan_events` 查重不重发，findings 按 fingerprint 幂等。

### 2.3 租约与生命周期（R03 合同）

- 领取：`FOR UPDATE SKIP LOCKED` 原子领取，`attempt < 2` 过滤（MAX_ATTEMPTS=2，与规格一致）。
- 续租：`LeaseKeeper` 每 10s 续 30s 租约；DB 连续异常 3 次才判定失租（防抖动），失租触发 AbortController。
- 写入：阶段推进、事件、终态全部在 `leaseGuarded` 事务内（`for update` 锁 job 行并校验 owner / generation / running / 未过期）；**失租不能写任何结果**。
- 接管：租约过期后新 worker 接管（attempt+1）；上限耗尽时任务与目标（scan/evaluation）状态一致终结（failed + error_text + scan.finished 同事务），`reapExhaustedJobs` 收割崩溃残留。
- 删除：项目 DELETE 先请求取消相关任务并写 `projects.deleting_at`（新迁移 0001）；无活动租约同步清理返回 204，否则 202 由 worker 轮询清理（**先删存储再删 DB 行**，杜绝「完成但文件仍在」）。
- TTL：worker 每小时清理过期会话（默认 `DATA_TTL_HOURS=24`），预置样例不受影响。

### 2.4 SSE 与轮询

`GET /api/scans/:id/events` 支持断线后从 `Last-Event-ID` 续传持久化事件，15s 心跳，终态排空后 3s 关闭。客户端（`scan-events.ts`）连续失败时降级为 2s 起步逐次退避至 10s 封顶的轮询，并周期性携带游标重建 EventSource；恢复后停止轮询。刷新页面从持久化结果恢复，不依赖内存状态。

### 2.5 AI 审查与证据校验（R04 合同）

```text
风险优先抽样（静态候选 → 直接依赖 → 相对路径补足） + 有限工具循环
   工具仅四件（read_file ≤200 行 / search_code 字面量 ≤20 命中 / list_imports / retrieve_guidelines topK≤8）
   ↓
submit_findings（结构化 FindingDraft：主引用 + related + 规范引用）
   ↓ 证据校验（validator 与 scanner validate 阶段共用同一实现）
   - 引文：统一 LF 后逐字符严格匹配 + mergeRanges 后「完整读取覆盖」检查
     （读过 10–12 行不能引用 1–100 行——R04 修复的核心漏洞）
   - 规范引用：只能引用本轮 retrieve_guidelines 实际返回的 chunkId（retrievedChunkIds 白名单）
   - 无效 primary/related/规范引用记录原因不静默认可；结构坏最多 1 次修复轮后丢弃
```

预算（调用**前**原子预留，达到上限保存已有结果标 partial）：

| 维度 | 扫描 | 追问 | 补丁 |
|---|---|---|---|
| 模型请求 | ≤12（含修复与重试） | ≤4 | ≤2 |
| 工具调用 | ≤30 | ≤8 | —（submit_patch 工具不计） |
| token | 输入 ≤60,000 / 输出 ≤8,000 | — | — |
| 墙钟 | 180s | 60s | 60s |
| 单请求超时 | 30s | 30s | 30s |

日额度（`daily_usage.reserved_tokens`，迁移 0002）：`reserveDailyTokens` 单条原子条件 UPDATE（used + reserved + n ≤ `AI_DAILY_TOKEN_LIMIT`），并发安全；实测优先结算、缺失回退保守估算（中日韩 ~1 token/字，其余 4 字符/token），调用失败回收预留。**Mock provider 不预留、不记账**。

### 2.6 RAG（F05）

- 预置 30 条自写规范摘要（`src/core/knowledge/builtin.ts`，MDN / OWASP / react.dev 来源 + 版本 + contentHash），seed 幂等（builtinKey + contentHash，内容变化版本 +1）。
- 项目 Markdown 按标题 / 段落切块（约 400–800 字符），保留文档名、标题、起止行。
- 双路检索：pgvector 余弦 Top-N + Unicode 字符二元组词法 Top-N，RRF（k=60）融合取前 5；向量查询按 `embedding_model = 当前查询模型` 筛选（不同模型 / 维度的旧向量不混用语义空间）。
- 嵌入不可用降级为词法检索并标注 `lexical_only`；chat 与 embedding readiness 互相独立。
- 每条 finding 的规范引用同时写入 `scan_citations`（版本 + textSnapshot + sourceUrl），知识库变更后旧报告仍可解释来源。

### 2.7 追问、补丁、报告、对比、评测

- **追问**（R05）：`askFindingQuestion` 归属 guard（跨会话 / 预置项目一律 404）；用户消息先持久化；同 2.5 证据校验；证据不足显式返回 `insufficient_evidence`；消息按 `(created_at, id)` 复合游标分页（消息 id 为随机 UUID，不作时间序）。无终端 / 联网 / 写文件工具。
- **补丁**（R06）：模型经 `submit_patch` 工具提交单文件编辑；校验链（baseFileHash 一致 / expectedOldText 严格匹配 / 行范围合法 / 互不重叠 / ≤200 行 / 命中脱敏区间拒绝 / 禁锁文件与多文件）全部服务端；内存副本应用生成 unified diff；语法比较只标「是否引入新错误」（TS Compiler API / @vue/compiler-sfc），tests 恒为 `not_run`；无效提案 409 不可下载；快照原件字节不变（集成测试断言）。
- **报告**（R07）：UI / JSON / Markdown / HTML 消费同一 `buildReportModel`；HTML 全动态内容 escapeHtml 白名单净化，Markdown 用户内容全转义防注入；浏览器打印另存 PDF，无服务端 PDF 引擎。
- **对比**（R07）：匹配键 = 规则/类别 + 规范化路径 + 符号名 + 去空白局部代码哈希（纯 JS 双路 64 位确定哈希，不依赖行号，客户端可复用）；未覆盖文件归入不可比较（不得算未再检出）；「未再检出 ≠ 已验证修复」固定说明。
- **评测**（R08）：24 个 fixture 项目走与生产完全一致的导入 / 扫描管线（真实 ZIP → prepareSnapshot → 扫描任务 → 领取执行）；一对一匹配、重复报警计 FP、无效引文计 FP 不丢弃；详见 `docs/evaluation.md`。

## 3. 安全边界

- **不执行上传内容**：不运行 npm install / 构建 / 测试脚本 / 仓库 ESLint 配置 / Git hooks；分析用自有内存 TS 程序；worker 无 shell 工具；不挂载 Docker socket、非 root 运行（Dockerfile USER node）。
- **会话与隔离**：访问码（demo / admin 两级，timing-safe 比较）→ 随机 HttpOnly + SameSite=Lax cookie（生产 Secure）；服务端仅存 SHA-256 token 哈希；写请求 Origin 校验；访问码失败限流（每 IP 每 10 分钟 10 次）；跨会话对象一律 404（不泄露存在性）；每会话最多一个活动扫描（409）。
- **不可信数据**：代码注释、README、规范文档、用户问题均按待审数据处理——系统提示明确禁止指令注入扩大工具权限；工具参数服务端验证；模型输出经 Zod 校验；界面全部纯文本渲染（无 innerHTML / dangerouslySetInnerHTML）。
- **秘密处理**：`.env` 不收录进快照；疑似密钥等长遮盖后参与向量化与外发；命中脱敏区间的补丁拒绝导出；原始源码与完整 prompt 不进日志；API 密钥只存在于服务端进程（messages 集成测试断言泄漏防护）。
- **标签诚实**：static / ai / combined 来源分列；valid 只代表引文有效不代表漏洞证实；Mock（非真实模型）标注贯穿审查 / 追问 / 补丁 / 评测；补丁 tests 恒为 not_run；「未再检出 ≠ 已验证修复」。

## 4. 数据库合同（规格第 10 节的落地）

16 张业务表 + `daily_usage` 预算表，Drizzle schema（`src/server/db/schema.ts`）；关键唯一约束：`files(snapshotId,path)`、`jobs(kind,targetId)`、`scans(snapshotId,idempotencyKey)`、`findings(scanId,fingerprint)`。三条迁移（0000 基础 / 0001 `projects.deleting_at` / 0002 `daily_usage.reserved_tokens`），自研迁移器 journal + 内容哈希幂等、单事务 + advisory 锁；**不改写已应用迁移**。

实测差异点（相对规格理想态）：

- **PGlite 本地 / PostgreSQL 生产**：本地开发数据库是 PGlite（嵌入式 Postgres 18.3 + 真实 pgvector 扩展）经自研 Postgres 线协议 socket 服务（`scripts/db-server.ts`）暴露。不使用 `@electric-sql/pglite-socket` 官方包——其按「单条协议消息」跨连接排队，两个客户端的 Parse/Bind 交错会互相覆盖共享 unnamed prepared statement（实测 2000 次并发 475 次报错）；自研实现以「完整查询批次」为最小执行单元并为 unnamed statement 分配会话独占名（pgbouncer 同款方案），修复后 6 客户端 3000+ 混合查询零错误。**PGlite 不承载生产并发语义**，租约 / 额度原子性测试在生产 PostgreSQL 上重跑属首次部署验证项。
- **jsonb 兼容**：pglite-socket 层不透传列类型 OID，jsonb 读回为字符串——`asJson` / `asPgJson` 助手统一兼容；postgres.js 对 jsonb 参数需传对象或 `sql.json()`。
- **复合游标**：消息分页用 `(created_at, id)` 复合游标（消息 id 为 UUID 非时序）；findings / 项目列表用各自的 cursor 方案。
- **`tool.completed` 的 elapsedMs** 来自工具执行真实计时（R01 修复了固定写 0 的问题）。

## 5. 构建与部署实测细节

- **`outputFileTracingExcludes` 坑**：Next 15.5.25 内置 nft 对 `@vue/compiler-sfc/dist/compiler-sfc.cjs.js` 静态求值时把 mock 的 `path.join` 当 thenable 调用导致 build 崩溃（最小复现确认仅该文件触发）。已在 `next.config.mjs` 的 `outputFileTracingExcludes['next-server']` 排除该依赖。代价：`output:'standalone'` 产物的 trace 清单不含它，需自行携带——因此 **Dockerfile 采用完整 node_modules + `next start` 部署**，不用 standalone（若将来改 standalone 必须显式补回该依赖）。
- Windows 本机直接 `pnpm build` 可能因环境残留崩溃：规程为先杀本项目遗留 node 进程，再以项目专用 `APPDATA` / `LOCALAPPDATA`（`.appdata-build`）隔离构建，结束后删除该目录。
- e2e（`playwright.config.ts` + `scripts/e2e-server.ts`）：独立 distDir（`.next-e2e`）、临时 PGlite / 存储 / fixtures、生产构建 `next start` + worker，`AI_PROVIDER=mock`，与开发端口（3100/5433）隔离。
- Docker / Compose：见 `Dockerfile`、`compose.yaml`（多阶段、Node 22、非 root、无 Docker socket；**本机无 Docker 未验证**）。

## 6. 目录导览

```text
src/
  app/
    (app)/                 # 登录后的工作台布局与页面
      projects/[id]/compare/  # 快照对比页
      scans/[id]/findings/[findingId]/  # 扫描工作台与问题详情
      knowledge/ evaluation/
    api/                   # session/projects/snapshots/scans/findings/patches/
                           # knowledge/evaluations/status 全部 REST 路由
    login/
  components/              # review（工作台/证据/追问/补丁）、projects、evaluation、knowledge、ui
  core/                    # 纯领域层（无 HTTP 依赖，可单测/复用）
    import/                #   路径校验、ZIP 流式读取、脱敏
    index/                 #   TS/Vue AST 分析
    rules/                 #   9 条确定性静态规则
    review/                #   AI 编排、工具、预算、证据校验、日额度、追问
    knowledge/             #   规范、切块、嵌入、双路检索
    patch/                 #   编辑校验、应用、语法比较、diff、提案
    report/                #   风险指数、报告模型、导出、对比
    evaluation/            #   fixtures 定义/生成、指标、runner、Mock provider
    contracts/             #   Zod 合同（findings/patch/scan/conversation/evaluation/api）
  server/                  # env、auth、storage、queries（共享查询层）、db（schema/迁移/seed）
  worker/                  # jobs（租约）、scanner、document-index、evaluation、cleanup、events
scripts/                   # db-server / migrate / seed / doctor / worker / e2e-server /
                           # generate-fixtures / evaluate / capture-screenshots
tests/                     # unit（12 文件 166 项）/ integration（11 文件 103 项）/ e2e（8 项）
fixtures/                  # 评测数据集产物（24 项目，版本 v1-cd06ca6f）
docs/                      # progress.md（全部执行记录）、architecture、evaluation、demo-script
migrations → src/server/db/migrations   # 三条迁移 + journal
```

## 7. 页面与状态合同（规格第 5 节落地）

| 路由 | 实现要点 |
|---|---|
| `/login` | 访问码输入；错误 / 限流（429 + Retry-After）/ 提交中状态 |
| `/projects` | 项目列表、新建、上传入口；空态 / 加载 / 失败 |
| `/projects/[id]` | 快照卡片（结构 chips、文件浏览器、脱敏高亮）、扫描记录、≥2 扫描出现「快照对比」入口、删除项目（202 等待活动任务） |
| `/scans/[id]` | 风险指数（公式与口径提示）、静态/AI 覆盖、阶段进度、工具轨迹（真实 elapsedMs/状态，无思维链）、问题筛选、导出报告三格式 |
| `/scans/[id]/findings/[findingId]` | 只读代码（行号 1 起始、primary 高亮、点击定位）、证据面板（触发条件/影响/依据/建议 + 引用快照）、追问面板、补丁提案；1024px 以下右栏进入「问题/代码/解释」标签 |
| `/projects/[id]/compare` | 双扫描选择器、可比性提示、四类变化列表、固定 disclaimer |
| `/knowledge` | 规范条目 / 版本 / 来源、Markdown 上传与索引状态 |
| `/evaluation` | 配置（admin 才可运行）、运行列表、指标卡（N/A 规则）、消融对比、逐项目回溯（scanId 链接）、小样本口径声明 |

优先保证 1440×900 / 1024×768 / 390×844 三个视口；代码横向滚动不撑破页面（截图脚本 `scripts/capture-screenshots.ts` 产出三视口验证图）。

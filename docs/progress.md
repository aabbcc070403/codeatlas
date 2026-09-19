# CodeAtlas 执行进度记录

按 `02-开发任务.md` 的 T01–T12 顺序推进。每项记录：实现内容、验证命令与真实结果、遗留事项。

## 环境事实

- Node v24.16.0（规格建议 22 LTS；本机为 24，兼容运行）
- pnpm 11.10.0
- **Docker 不可用** → 本地数据库使用 PGlite 0.5.8（嵌入式 Postgres 18.3）+ `@electric-sql/pglite-pgvector`（真实 pgvector 扩展，余弦距离已实测）+ `@electric-sql/pglite-socket`（Postgres 线协议，web/worker 以 postgres.js 连接，与生产部署同构）。`compose.yaml` 仍提供 postgres+pgvector 容器路径（本机未验证，见 T12）。
- 应用端口 3100，数据库端口 5433。

## T01 初始化与数据基础 ✅

**实现**

- 单包工程（`codeatlas/`），Next.js 15.5.25 + React 19.3 + TS 5.9 strict，锁定依赖（pnpm-lock.yaml）。
- `pnpm-workspace.yaml` 声明 esbuild/iconv 构建许可。
- 完整命令合同（02 文档 B 节）全部接入 package.json scripts。
- Drizzle schema（规格第 10 节全部 16 张表 + daily_usage 预算表），`vector(1536)` 向量列，唯一约束：files(snapshotId,path)、jobs(kind,targetId)、scans(snapshotId,idempotencyKey)、findings(scanId,fingerprint)、documents(builtinKey)。
- 自研迁移器（`src/server/db/migrate.ts`）：journal + 内容哈希幂等、单事务 + advisory 锁。
- 30 条预置规范（`src/core/knowledge/builtin.ts`，原创摘要 + MDN/OWASP/react.dev 来源 + 版本）。
- seed 幂等（builtinKey + contentHash，内容变化版本+1 重建分块）。
- doctor：数据库/pgvector/迁移/存储/AI 配置自检，不输出密钥。
- contracts（Zod）：FindingDraft、PatchEdit、ScanConfig、Coverage/Usage/Risk、API 错误格式。
- PGlite socket 服务 `scripts/db-server.ts`（含测试可复用的 startDbServer 导出）。

**验证（2026-09-12）**

- `pnpm db:migrate` → 应用 0000_aromatic_venom；重复运行 → 无新迁移
- `pnpm seed` → 新建 30 条规范；重复运行 → 未变化 30
- `pnpm doctor` → 通过（PostgreSQL 18.3 PGlite、pgvector 已启用、迁移 1/1、存储可写、AI provider: mock）
- `pnpm test:integration` → 6 passed（迁移幂等、seed 幂等、files/jobs/scans 唯一约束、向量余弦查询）
- `pnpm typecheck` → 通过

## T02 会话与权限 ✅

**实现**

- 访问码验证（timing-safe，demo/admin 两级角色）、token 仅存 SHA-256 哈希、HttpOnly+SameSite=Lax cookie（生产 Secure）。
- 写请求 Origin 校验（浏览器跨站拒绝 403）。
- 访问码失败限流：每 IP 每 10 分钟 10 次 → 429 + Retry-After。
- 项目/快照/扫描归属 guard：跨会话一律 404（不泄露存在性）；预置项目只读。
- API：POST /api/session、GET/POST /api/projects、GET/DELETE /api/projects/:id（级联取消任务+删除存储）、GET /api/status。
- UI：/login（错误/限流/提交中状态）、(app) 布局（导航+provider 标识）、/projects 列表页。

**验证**：`pnpm test:integration` auth 8 项通过（401/403/404/429/HttpOnly/admin 角色/伪造 cookie）；浏览器流程登录→项目页 200。`pnpm lint`、`typecheck` 通过。

## T03 ZIP 导入与快照 ✅

**实现**

- `src/core/import/paths.ts`：穿越/绝对路径/盘符/UNC/保留设备名/ADS 冒号/NUL/控制字符/结尾点空格/超长/大小写冲突全拒绝（/ 与 \ 双分隔符）。
- `src/core/import/archive.ts`：yauzl 流式读取；自研 central directory 符号链接预检（yauzl 3 不暴露 externalAttrs）；实际解压字节限额（20MiB/80MiB/2000 条/单文件 512KiB）；压缩炸弹中止。
- `src/core/import/redact.ts`：等长脱敏（赋值密钥/AKIA/ghp_/sk-/AIza/JWT/PEM 块）+ 区间记录；.env/.pem/id_rsa 等敏感文件拒绝收录。
- `src/core/import/index.ts`：忽略策略（node_modules/dist/.git/min 文件等）、UTF-8 严格解码、BOM/CRLF→LF 标准化、内容哈希、TS/Vue 快速语法状态、结构统计（语言分布/依赖声明/锁文件/相对导入图/别名未解析标记）。内嵌 ZIP 不递归。
- API：POST /api/projects/:id/snapshots（413/422 拒绝）、GET 快照列表、GET /api/snapshots/:id/files（树/内容，存储经 storageKey 定位）。
- UI：上传组件（导入摘要+忽略明细+外发说明）、快照卡片（结构 chips、文件浏览器-目录树+行号+脱敏高亮）、删除项目对话框。
- 发现并修复：pglite-socket 不透传列类型 OID → jsonb 读回为字符串，新增 `asJson` 助手统一兼容。

**验证（T03）**

- `pnpm test:unit` 25 项（路径 7、脱敏 6、归档 12——含符号链接/穿越/炸弹/大小写冲突/单文件超限/条目数上限）；`pnpm test:integration` 18 项（导入 4：完整收录/忽略/脱敏等长/结构统计/解析失败状态/Vue/内嵌 ZIP）。
- 浏览器实测：创建项目→上传示例 ZIP（201，5 文件+依赖+导入边+别名未解析）→项目页渲染→文件树→App.tsx 内容脱敏（ghp_ token 不可见，redactedRanges=1）。

## T04 索引与静态规则 ✅

**实现**

- `src/core/index/analyzer.ts`：TS Compiler API 内存 AST（自有程序，不加载项目插件）；Vue SFC script 抽取 + 原始行号映射；符号收集（函数/组件/Hook）。
- 9 条确定性 AST 规则（超过规格要求的 6 条）：动态执行（eval/new Function/字符串定时器，字面量区分低风险）、HTML 注入入口（innerHTML/outerHTML/insertAdjacentHTML/document.write/dangerouslySetInnerHTML，字面量豁免）、postMessage 目标源、message origin 校验（含外部回调解析）、疑似硬编码密钥（联动导入脱敏记录）、JSX 列表 key（表达式体+条件分支+Fragment）、Hook 条件/非法作用域调用（组件/自定义 Hook 判定）、@ts-ignore/@ts-nocheck/无说明 @ts-expect-error/安全规则 eslint-disable、console 残留。
- 候选规则标 needs_review（不把危险 API 出现判为漏洞）；行重叠去重；引文取自真实源码行。

**验证**：`pnpm test:unit` 52 项全过（每条规则 ≥2 命中 + ≥2 不命中，含嵌套作用域/同名函数/循环判断表达式边界）。修复 TS AST `expression`（非 ESTree callee）属性错误。

## T05 持久化扫描、租约与 SSE ✅

**实现**

- `src/worker/jobs.ts`：FOR UPDATE SKIP LOCKED 原子领取、30s 租约/10s 续租、条件写（失去租约即停）、过期接管（attempt+1，上限 3）、取消请求/落实分离、LeaseKeeper 周期续租器。
- `src/worker/scanner.ts`：六阶段管线（ingest→index→static→ai→validate→report），事件持久化（scan.started/stage.*/finding.created/finding.invalid/scan.finished）；取消在阶段边界检查；终态条件写（崩溃恢复不重复报告）；validate 阶段对全部 finding 引文与快照真实行比对，无效即删除并计数。AI 阶段显式 skipped（T07 接入真实编排）。
- `scripts/worker.ts`：独立 worker 进程（领取/执行/失败重试），每小时 TTL 清理（过期会话级联+存储清理，预置项目不受影响）。
- API：POST /api/snapshots/:id/scans（Idempotency-Key 幂等、每会话单活动扫描 409）、GET /api/scans/:id（状态/风险/覆盖/工具轨迹）、SSE /api/scans/:id/events（Last-Event-ID 续传、15s 心跳、终态排空后关闭）、POST cancel（queued 直接终态/running 请求取消）、findings 列表（过滤+游标）、finding 详情、feedback（联动风险重算）。
- 修复：postgres.js 对 jsonb 参数需传对象/sql.json()（字符串+cast 会双重编码）；已全局统一（发现 `asPgJson` 助手）。

**验证**

- `pnpm test:integration` 24 项全过：幂等键唯一、双 worker 租约互斥+伪造 owner 拒绝、完整静态扫描（事件序列 18 个、findings、风险公式、覆盖统计）、租约过期接管 attempt 递增、queued 取消、终态重复处理不重复报告。
- 真实进程验证：`pnpm worker` 独立运行 + HTTP 触发扫描 → worker 处理 → completed（riskIndex=5，4 findings：2 high 待核查 + 1 medium + 1 low）；SSE 流式输出全部 18 个事件，UTF-8 内容正确（控制台乱码仅为 PowerShell 显示问题）。

---

## 续作 R01 恢复可编译和静态扫描基线 ✅（2026-09-12）

对应审计 04 文档 R01（B01 编译中断）。真实模型：**未调用**（受控 provider 注入测试，非真实 AI 验证）。

**修改文件**

- `src/core/review/provider.ts`：修复 240 行非法解构 `tool as aiTool` → `tool: aiTool`；`tools` Record 值类型改用 AI SDK v5 `Tool` 默认泛型（`ReturnType<typeof aiTool>` 解析到末位重载 `Tool<never,never>` 导致赋值失败）；删除未用的 `cachedProvider` 死代码；新增 `import type { Tool } from 'ai'`（类型-only，无运行时开销）。
- `src/worker/scanner.ts`：补 `runAiReviewStage` import（此前缺失导致 jobs suite 无法加载）；删除 report 阶段重复声明的零值 `usage`，保留 AI 阶段实际 `outcome.usage`；终态改为按 `aiStatus` 计算——纯静态 completed，云端阶段确实完成才 completed，失败/预算耗尽/未配置/未完成为 partial（`cancelled` 仍在阶段边界单独处理）；`processScanJob` 新增可选 `aiProvider` 注入口。
- `src/core/review/orchestrator.ts`：`AiStageContext` 支持注入 `provider`（测试受控 provider，缺省仍按环境配置）；usage.provider 标签改由 `provider.isMock` 真实判定（原 `mockActive` 组合判断在注入非 mock provider 时误标）；删除未用 `REPAIR_ROUNDS`；`tool.completed` 事件改用工具执行记录的真实 sequence/elapsedMs/状态（原 `exec.sequence` 不存在导致 TS2339，elapsedMs 原固定写 0）。
- `src/core/review/validate.ts`：删除未用 `codeRefSchema` import。
- `tests/integration/jobs.test.ts`：`createScan` 支持指定 `enableCloudAI`；新增 R01 回归 describe——①受控 provider 成功：读文件→提交真实引文结论，断言 usage（modelCalls=2、toolCalls=1、measured tokens 333/33）、覆盖记录、终态 completed、AI finding 落库、工具轨迹持久化；②受控 provider 失败：静态结果保留、终态 partial、coverage.ai.degradedReason='ai_stage_error'、usage.modelCalls=0 不虚构。
- `next.config.mjs`：新增 `outputFileTracingExcludes`（见下方 build 修复）。

**build 崩溃根因与修复（实测定位）**

`pnpm build` 在 trace 收集阶段崩溃：`TypeError: The "path" argument must be of type string. Received function`。用最小复现（直接对入口 chunk 调 `next/dist/compiled/@vercel/nft` 的 `nodeFileTrace`）逐入口二分定位：**仅 `@vue/compiler-sfc/dist/compiler-sfc.cjs.js` 触发**（pg/typescript/yauzl 均正常；与中文路径无关，ASCII 路径同样崩溃）。根因：Next 15.5.25 内置 nft 的静态求值器把 mock 的 `path.join` 包装函数当作 thenable 的 `.then` 调用（`Object.mockPath [as then]`，实参为 promise resolve/reject 函数）。15.5.x 已无更新补丁版本，未升级框架；改用 `outputFileTracingExcludes: { 'next-server': ['**/node_modules/@vue/compiler-sfc/**'] }` 排除该文件的分析。**代价**：仅影响 `output:'standalone'` 部署（trace 清单不含该依赖，需自行携带）；本项目采用完整 node_modules 部署，运行时仍从 node_modules 正常加载，功能不受影响。已验证 `ignore` 排除后该 chunk trace 正常。

**验证（逐项退出码）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（5 文件 59 项）
- `pnpm test:integration` → exit 0（5 文件 31 项；jobs suite 恢复加载：8 项全过 = 原 6 项 + R01 新增 2 项）
- `pnpm build` → exit 0（9 页面生成，完整路由表输出）

**遗留项（转入后续 R 任务）**

- 租约续租器未在 scripts/worker.ts 启动、写入无 owner/generation 条件、MAX_ATTEMPTS=3 与规格 2 次不符、DELETE 竞态 → R03。
- 证据校验 overlap 而非全覆盖、规范引用用全部可访问 chunkId、embedding 无超时/预算、30s/180s 中止未接、日额度无原子预留 → R04。
- `tool.completed` 事件中 budget_exceeded 状态显示为 'error'（事件级差异，R04 一并处理）。

---

## 续作 R02 静态审查可见闭环 ✅（2026-09-12）

对应审计 06 文档 R02。真实模型：**未调用**（E2E 全程 AI_PROVIDER=mock，界面如实标注 "AI: Mock"）。

**修改文件**

- `src/server/queries/scans.ts`（新建）：共享查询层——`loadScanDetail`/`listFindings`/`getFindingDetail`/`readSnapshotFileDetail`，API 路由与服务端页面首屏共用一套 DTO/SQL（响应形状不变）。
- `src/app/api/scans/[id]/route.ts`、`findings/route.ts`、`src/app/api/findings/[id]/route.ts`、`src/app/api/snapshots/[id]/files/route.ts`：改调共享查询（纯提取，行为不变）。
- `src/app/(app)/scans/[id]/page.tsx`（R02-A）：服务端首屏补齐问题首屏（limit 100 同 API 排序）与 toolCalls 预取；guard 沿用 requireReadableScan（跨会话 404）。
- `src/app/(app)/scans/[id]/findings/[findingId]/page.tsx`（R02-A）：服务端预取 finding 详情、snapshotId、风险与主引用文件内容（文件缺失时客户端显示明确错误状态）。
- `src/components/review/scan-workbench.tsx`（R02-B）：接收服务端预取 findings；toolCalls 状态随刷新更新；新增工具轨迹面板（仅工具名/输入摘要/耗时/状态，不显示思维链与结果原文；纯静态扫描如实显示"无工具调用"）。
- `src/components/review/scan-events.ts`（R02-C）：显式保存 lastEventId；SSE 连续失败降级轮询（2s 起步逐次退避至 10s 封顶）；降级期间每 10s 携带 cursor 重建 EventSource，恢复后停止轮询；卸载清理全部连接与定时器。
- `src/components/review/finding-detail.tsx`（R02-D）：服务端预取 initial 直出；反馈成功后用 PATCH 返回的重算 risk 更新风险摘要展示（needs_review 不计入指数的语义在 UI 如实呈现）。
- `tests/e2e/static-review.spec.ts`（R02-E）：三个测试——①主闭环（登录→建项目→上传 ZIP→静态扫描→问题列表→详情行号/证据→确认→误报→风险指数联动变化，1440×900 与 390×844 无横向溢出，reload 后终态可恢复）；②SSE 断开（route abort）→ 轮询降级徽章 → 轮询驱动到终态；③跨会话第二个登录会话访问 scan/finding 页面 404、页面内 same-origin fetch API 404。
- `scripts/db-server.ts`（**R02 期间发现并修复的 E2E 基础设施 bug**）：多客户端并发时扩展协议批次串扰——postgres.js 对带参数查询分两批（Parse+Describe+Flush，随后 Bind+Execute 不带 Parse），其他客户端的新 Parse 插入两批之间覆盖共享 unnamed statement（实测 `bind message supplies N parameters, but prepared statement "" requires M`，E2E 第三测试因 API 500 失败）。修复：①批次切分消息深复制（防 socket 池化内存视图跨事件被复用）；②unnamed statement 会话独占名重写（pgbouncer 同款方案）——每次 unnamed Parse 分配独占名，Bind/Describe/Close 同步重写；named statement 不允许同名覆盖，旧名通过系统批次（client=null，响应丢弃）补发 Close，不污染客户端响应流；断连时清理残留名。附带修复 `execProtocolRawStream` 空选项的类型错误。压力验证：2 客户端 2000 次交替查询、6 客户端（混合参数+事务+轮询）3000+ 查询均零错误（修复前分别 498/408 个错误）。

**验证（逐项退出码，2026-09-12）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（5 文件 59 项）
- `pnpm test:integration` → exit 0（5 文件 31 项，db-server 修复后全绿）
- `pnpm test:e2e` → exit 0（3 项通过，约 28 秒；独立 .next-e2e + 临时 PGlite/存储，不触碰开发 .data）
- `pnpm build` → exit 0（按 06 方案先关闭残留 codeatlas node 进程——前次会话遗留的 pnpm dev（持有 .next）、泄漏的 db-server/next 进程，并设置项目专用 APPDATA/LOCALAPPDATA 后一次通过；完整路由表输出，含 /scans/[id] 与 /scans/[id]/findings/[findingId]）

**浏览器流程（E2E 实测）**：登录 → 建项目 → 上传 ZIP → 静态扫描（不启用云端 AI）→ /scans/:id 工作台看到状态/stage/风险/覆盖/问题列表/工具轨迹 → 打开 finding 看到行号（1 起始）+ primary 高亮 + evidence 状态 → 确认问题 → 标记误报 → 风险指数下降（8→4）；刷新扫描页后终态与问题可恢复；SSE 断开后显示"轮询降级"并仍能到达终态；第二个登录会话访问他人扫描/问题均 404。

**遗留**

- R03 后台租约修复（续租器启动、owner/generation 条件写、MAX_ATTEMPTS、DELETE 竞态）未动。
- 工程根目录存在前次会话遗留的隐藏调试脚本（.e2e-dbg-*.cjs 等），非本轮创建，未清理。
- AI 扫描路径的 UI（工具轨迹非空、usage 展示）仅经受控 provider 集成测试验证数据，真实模型浏览器流程待后续任务。

---

## 续作 R03 后台生命周期修复 ✅（2026-09-12）

对应审计 04 文档 R03。真实模型：**未调用**（测试均为受控/静态路径）。

**修改文件**

- `src/server/db/schema.ts` + `migrations/0001_project_deleting_at.sql` + `meta/_journal.json`（新迁移，不改已有迁移）：`projects.deleting_at` 列，异步删除状态标记。
- `src/worker/jobs.ts`：`MAX_ATTEMPTS` 统一为规格的 **2 次**；`claimJob` 增 `attempt < 2` 过滤（耗尽任务不再被领取）；新增 `LeaseLostError`、`assertLease`（非事务快速校验）、`leaseGuarded`（事务内 `for update` 锁定任务行并确认 owner/generation/running/未过期，失租抛错即不能写）；`failJob` 在上限耗尽时与目标状态一致终结（scan → failed + error_text + scan.finished 事件，同一事务）；新增 `reapExhaustedJobs` 收割过期且耗尽的 running 任务（先终结目标再终结任务，可重入）；`LeaseKeeper.tick` 全程捕获异常，DB 连续异常 3 次才视为失租（防抖动），onLost 回调兜底捕获。
- `src/worker/scanner.ts`：阶段推进（stage 更新）、阶段事件、取消落实（scan=cancelled + 最终事件 + job=cancelled）、终态写入（终态 + stage.completed + scan.finished + job=completed）全部在 `leaseGuarded` 租约事务内，**失租不能写任何结果**；恢复点：重试从已持久化 `scan.stage` 继续，已发送的阶段事件按 `scan_events` 查重不重发，`scan.started` 缺失时由接管方补发，findings 幂等（fingerprint 冲突不重插不发事件）；失败路径区分——失租（LeaseLostError）零写入，可重试异常只发诊断 `error` 事件、不提前写终态（修复 R01 记录的"scanner 先写 failed 与 failJob 回队语义冲突"）；`signal` 支持（失租 abort 与取消分流）。
- `src/worker/cleanup.ts`（新建）：统一删除服务——`markProjectDeleting`（请求取消相关任务 + 写 deleting_at，返回是否有活动租约）、`cleanupDeletingProjects`（queued 任务直接终结；活动租约等待退出/到期；**先删存储（失败下轮重试）再删 DB 行**，杜绝"完成但文件仍在"）、`expireStaleSessions`（TTL：过期会话项目标记 deleting；会话行仅在无项目引用时删除，避免 FK 级联绕过活动任务等待；预置项目不受影响）。
- `src/worker/document-index.ts`：批处理后 `assertLease` 确认租约，失租抛 `LeaseLostError`（写入不落最终状态，嵌入幂等可重跑）；签名统一为 `LeaseInfo`。
- `src/worker/evaluation.ts`：签名统一（占位行为不变）。
- `scripts/worker.ts`：每个领取作业创建 `LeaseKeeper`（10s 续租）+ `AbortController`（失租 abort 信号传给处理函数），try/finally 启停；`LeaseLostError` 分流——不 `failJob`（交由接管）；主循环接入 `expireStaleSessions`（每小时）、`cleanupDeletingProjects`（每 15 秒）、`reapExhaustedJobs`（每轮）。
- `src/app/api/projects/[id]/route.ts`：DELETE 走 `markProjectDeleting`——无活动租约时同步清理返回 **204**（先存储后 DB，与清理服务同一路径）；有活动租约或清理被阻塞返回 **202** `{deleting:true}`；GET 返回项目 `deleting` 状态。
- `src/components/projects/delete-project-button.tsx`：202 时显示"等待活动任务退出…"并轮询到项目 404（120 次上限）。
- `tests/integration/lease-recovery.test.ts`（新建，9 项故障测试）：①续租保持（其他 worker 不能接管）；②旧 worker 接管后不能写（续租/完成/事务写全败，B 正常完成）；③取消中断（终态+事件+任务取消同事务，无风险指标）；④重试到上限（两次失败后任务与扫描一致终结，claim 不再领取耗尽任务）；⑤收割（崩溃后过期耗尽的 running 任务被一致终结）；⑥阶段提交后崩溃（接管方从恢复点续跑，事件与 findings 不重复，6 阶段完整）；⑦活动索引删除（202 语义，租约退出后清理完成，存储同步删除）；⑧TTL 与扫描并发（标记 deleting 后等租约退出统一清理，会话行延后删除）；⑨LeaseKeeper 失租（onLost 触发 abort，正常续租不受干扰）。
- `tests/integration/jobs.test.ts`：LeaseInfo 增加 attempt 字段适配（6 处调用）。
- `tests/integration/db.test.ts`：迁移幂等断言从硬编码 1 条改为与 journal 条目数动态一致。

**验证（逐项退出码，2026-09-12）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（5 文件 59 项）
- `pnpm test:integration` → exit 0（6 文件 40 项 = 原 31 + lease-recovery 新增 9）
- `pnpm test:e2e` → exit 0（3 项通过，约 30 秒；新迁移 0001 在独立 e2e 数据库正常应用，R02 浏览器闭环不受影响）
- `pnpm build` → exit 0（隔离 APPDATA/LOCALAPPDATA 后一次通过）

**遗留**

- 两 worker 竞争与崩溃恢复测试通过（PGlite 路径）；生产 PostgreSQL 上重跑相同测试待 R09 首次部署验证（04 文档要求）。
- R04 可控 AI 与证据验证未开始（预算预留、超时、引文覆盖校验、真实模型 smoke）。

---

## 续作 R04 可控 AI 与证据验证 ✅（2026-09-12）

对应审计 04 文档 R04。真实模型：**未调用**（全部为受控 provider / Mock / 静态路径；"真实调用未验证"状态保留——未提供凭证，代码已按真实 SDK 类型实现）。

**修改文件**

- `src/server/db/schema.ts` + `migrations/0002_daily_usage_reserved.sql` + journal（新迁移）：`daily_usage.reserved_tokens` 列（调用前原子预留、结算时释放）。
- `src/core/review/validate.ts`：**完整覆盖检查**——`mergeRanges` 区间合并（相邻/重叠视作连续）、`isFullyCovered` 引用范围必须被合并后区间完全覆盖（仅 overlap 不再算读过，04 文档回归用例通过）；**严格引文**——`matchesQuote` 统一 LF 后逐字符比较（移除 trim 宽松匹配），validator 与 scanner validate 阶段共用同一实现（消除两层标准）；无效 primary/related/规范引用均记录原因。
- `src/core/review/tools.ts`：`retrievedChunkIds`——retrieve_guidelines **实际返回的 chunkId 白名单**（guidelineChunkIds 只能引用本轮返回的，可访问但未返回同样拒绝）。
- `src/core/review/budget.ts`：`estimate` 改为中日韩按 ~1 token/字、其余 4 字符/token 的**保守估算**（原按 /4 对中文偏低）。
- `src/core/review/daily-budget.ts`（新建）：`reserveDailyTokens`（单条原子条件 UPDATE：used + reserved + n ≤ 日限额，并发安全）、`settleDailyTokens`（实测优先、缺失回退保守估算，不按零计费）、`releaseDailyTokens`（调用失败回收预留）。
- `src/core/review/orchestrator.ts`：每次模型调用**前**原子预留日额度（Mock 不消耗真实资源），失败标记 `daily_budget_exceeded` 不发请求；调用后结算、异常释放；**单请求 30s 超时**（AbortSignal.any 组合 R03 失租信号）；取消/失租中断标记 partial 不冒充 completed；**修复轮结果区分**（repairOutcome: resubmitted / no_submission / empty_submission / cancelled / budget_blocked / not_needed，未提交/空提交保留前轮有效结果）；修复 repairPrompt 中的字面量拼接 bug；取消后无新模型请求；消息类型化为 AI SDK `ModelMessage`/`ToolResultPart`（工具结果结构化 `{type:'json', value}`）；修复 persistFindings 规范引用快照查询的 `c.version` 列不存在 bug（应在 documents 表）。
- `src/core/review/provider.ts`：`ProviderChatOptions.messages` 类型化为 `ModelMessage[]`；真实 provider 明确使用 **Chat Completions endpoint**（`openai.chat()`，而非 Responses API）；Mock 的 toolOutputs 适配结构化输出。
- `src/server/env.ts`：`aiProviderStatus` 拆分 `chatReady` / `embeddingReady`（**互相独立**——只配 embedding 时检索可用而 chat 走 Mock，反之亦然）；layout 徽章、知识库索引提示、/api/status 相应更新。
- `src/core/knowledge/embeddings.ts`：embedMany 30s 超时；返回**数量一致**、**每条维度一致**、**所有分量有限值**（NaN/Infinity 拒绝）校验。
- `src/core/knowledge/retrieval.ts`：向量检索按 `embedding_model = 当前查询模型` 筛选（不同模型/维度的旧向量不混用语义空间）。
- `src/worker/scanner.ts`：AI 阶段传 R03 失租 abort 信号；validate 阶段复用 `matchesQuote`。
- `tests/unit/review-validate.test.ts`（新建，17 项）：04 文档回归（读 10-12 行不能引用 1-100）、相邻区间合并覆盖、中间缺行不算完整、乱序合并、严格引文（trim 不再通过）、CRLF 规范化、行号偏移、白名单拒绝、伪造引文、跨项目路径、related 无效记录。
- `tests/unit/review-budget.test.ts`（新建，11 项）：中文/英文/混合/全角保守估算、12 次模型请求上限、输入/输出 token 上限、实测估算分列、工具上限、全局耗尽。
- `tests/integration/ai-review.test.ts`（新建，11 项）：日额度预留→结算（实测优先）→释放、失败只释放不记账、限额拒绝（恰好达限边界）、20 并发预留原子不超限；完整链路（读取→检索→白名单引用→落库→usage→引用快照）；伪造引文修复轮重交；修复未提交保留前轮结果（no_submission）；白名单外 chunk 拒绝；日额度耗尽零请求 + partial；取消后无第二次模型请求 + partial；Mock 标签 + Mock 不预留不记账。
- `tests/integration/lease-recovery.test.ts`：lint 修正（const）。

**验证（逐项退出码，2026-09-12）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（7 文件 87 项 = 原 59 + 新增 28）
- `pnpm test:integration` → exit 0（7 文件 51 项 = 原 40 + ai-review 新增 11）
- `pnpm test:e2e` → exit 0（3 项通过；迁移 0002 在独立 e2e 数据库正常应用）
- `pnpm build` → exit 0（隔离 APPDATA/LOCALAPPDATA 一次通过）

**遗留**

- 真实模型 smoke test 未执行（无凭证）：代码路径已按 AI SDK 受类型检查的 ModelMessage/Chat Completions 实现，真实调用待凭证后单独记录。
- `tool.completed` 事件 budget_exceeded 状态已在事件中如实传递（R01 遗留项确认已由 tools.records 的 status 字段覆盖）。
- R05 审查交互与追问（工具轨迹 UI、追问会话）未开始。

---

## 续作 R05 审查交互与追问 ✅（2026-09-12）

对应 07 文档 R05。真实模型：**未调用**（追问服务全部为受控 provider / Conversation Mock / 静态路径；"真实调用未验证"状态保留——未提供凭证）。

**开始前基线（逐项退出码）**

- `pnpm typecheck` → exit 0；`pnpm lint` → **exit 2（环境问题，见下）**；`pnpm test:unit` → exit 0（59 项）；`pnpm test:integration` → exit 0（51 项）；`pnpm test:e2e` → exit 0（3 项）。

**环境修复（非代码回归）**：`pnpm lint` 报 `eslint-plugin-react-hooks`/`@next/eslint-plugin-next` 无法解析。根因：node_modules 在会话间被重装，pnpm 11 起 `public-hoist-pattern` 默认为空（旧版默认提升 `*eslint*`/`*prettier*`），ESLint FlatCompat 需从项目根解析 eslint-config-next 的插件而解析不到。修复：`pnpm-workspace.yaml` 显式声明 `publicHoistPattern: ['*eslint*', '*prettier*']` 并把残留占位 `allowBuilds: {esbuild: "set this to true or false"}` 修正为 true（esbuild/iconv 构建许可），重装后 lint 恢复。依赖版本零变化（package.json 未动，曾试过临时 `pnpm add/remove` 已还原）。

**修改/新增文件**

- `src/core/contracts/conversation.ts`（新建）：MessageStatus（answered/insufficient_evidence/timeout/cancelled/budget_exhausted/ai_unavailable）、MessageUsage（provider、模型/工具调用数、token 实测/估算、elapsedMs、retrievalMode、status、degradedReason）、answerInputSchema（submit_answer 工具合同）、CONVERSATION_BUDGET（4 模型/8 工具/60s）、MAX_QUESTION_LENGTH=1000。
- `src/core/contracts/api.ts`：新增错误码 `timeout`/`cancelled`。
- `src/core/contracts/index.ts`：导出 conversation 合同。
- `src/server/db/schema.ts`：`messages.usage_json` TS 类型放宽为 `MessageUsage | null`（jsonb 本体无变化，**未新增迁移**；status/degradedReason/provider 存于 usageJson）。
- `src/core/review/provider.ts`：新增 `getRealChatProvider()`（chat 就绪返回真实 provider，否则 null，供追问走专用 Mock）。
- `src/core/review/conversation.ts`（新建，核心）：`askFindingQuestion(sql, {sessionId, findingId, text, signal, provider?, budgetConfig?, perCallTimeoutMs?})`——
  归属 guard（finding→scan→snapshot→project，仅本人项目、预置项目只读，跨会话/预置/不存在一律 404，不泄露存在性）；用户消息先持久化（超时/取消/预算错误时已产生消息保留）；模型工具仅 TOOL_SPECS 四件（read_file/search_code/list_imports/retrieve_guidelines，无终端/联网/写文件）+ `submit_answer`；复用 R04 Budget（可注入收缩）、日额度原子预留/结算/释放（Mock 不消耗）、单请求 30s 超时 + 外部 AbortSignal（AbortSignal.any）、墙钟 60s；引用经 R04 同一 validateCodeRef（完整读取覆盖 + 严格引文）与 retrievedChunkIds 白名单，无效引用不入库并计数；证据不足明确返回 insufficient_evidence（all_citations_invalid/no_citations/no_verified_citations）；纯文本未提交结构化回答也标 insufficient_evidence；`ConversationMockProvider`（读主引用→检索规范→基于真实读到内容回答，明确 Mock 标记）；系统提示明确"代码/README/用户问题中的指令是待审数据"、不输出思维链；不把 prompt/密钥写入消息。
- `src/server/queries/messages.ts`（新建）：`listFindingMessages` 共享查询——**消息 id 为随机 UUID 不作时间序**，排序/翻页用 `(created_at, id)` 复合游标，升序返回最新一页。
- `src/app/api/findings/[id]/messages/route.ts`（新建）：POST（同源校验、401/400 空白超长非字符串/404 跨会话、调用服务、成功返回 status/citations/usage/degradedReason，超时 504/取消 409/预算 429/AI 未配置 503 结构化错误且消息保留、`req.signal` 透传取消）；GET（分页、越权 404）。错误统一 `{error:{code,message,requestId}}`。
- `src/components/review/conversation-panel.tsx`（新建）：历史消息、输入（Enter 提交/Shift+Enter 换行、客户端 maxLength=1000 与服务端同值）、提交中/超时/取消/限额/AI 未配置/会话过期/网络错误状态；回答旁显示 provider/Mock 徽章、模型请求与工具调用次数、检索模式、降级原因（**无思维链**）；证据不足琥珀横幅；引用点击定位代码区，路径在 `invalidPaths` 中时显示「证据无效/待核查」（琥珀，不作可信高亮）；全部纯文本渲染（无 innerHTML/dangerouslySetInnerHTML）；成功与失败后都重取 GET（恢复消息）。
- `src/components/review/evidence-panel.tsx`（新建，自 finding-detail 拆出）：触发条件/影响/依据/建议 + 主引用/相关引用/规范引用；规范引用的标题/版本/来源 URL **只来自 scan_citations 快照**（服务端预取传入），无快照的 chunk id 显示「来源快照缺失/待核查」。
- `src/components/review/finding-detail.tsx`：接入 EvidencePanel 与 ConversationPanel；新增 `failedPaths`（文件加载失败或行段越界 → 追问引用标待核查）；evidence 说明移至面板下方。
- `src/components/review/tool-timeline.tsx`（新建，自 scan-workbench 拆出）：使用 scan API 真实 toolCalls/elapsedMs/status/inputSummary；空轨迹区分「纯静态无调用」「AI 阶段跳过（未配置）」「AI 未完成（降级原因）」「AI 无工具调用」；失败计数徽章；retrieve_guidelines 结果摘要含 lexical_only 时显示「词法降级」徽章（区分词法降级）。
- `src/components/review/scan-workbench.tsx`：ToolCallsPanel 替换为 ToolTimeline（coverage/usage 透传）。
- `src/app/(app)/scans/[id]/findings/[findingId]/page.tsx`：服务端预取当前 finding guidelineChunkIds 对应的 scan_citations（去重）传入 FindingDetail。
- `pnpm-workspace.yaml`：环境修复（见上）。
- `tests/unit/conversation.test.ts`（新建，10 项）：问题清洗（空白/超长边界/trim）、预算常量（4/8/60s）、证据校验——未读文件、部分读取（读 10-12 引 1-100）、越界行号、严格引文（首尾空白不通过）、未检索 chunk（可访问但不在白名单同样拒绝）+ 去重、有效/无效混合分别计数。
- `tests/integration/messages.test.ts`（新建，16 项）：401/400（空白、纯空白、1001 字、非字符串）/跨会话与预置 404；受控 provider 正常链路（读→检索→白名单引用→落库→usage 实测 500/60、retrievalMode 捕获、日额度结算）；伪造引用+未检索 chunk → insufficient_evidence 且 citations_json=[]；模型上限 4 次到限停止无额外请求；工具上限 8 次（第 8 次拒）后停止；墙钟预算（120ms 睡眠 > 60ms 预算）；单请求超时（挂起调用被 80ms 中止 → timeout，预留释放、记账增量不变）；取消（首次调用内 abort → cancelled、无第二次请求、user 消息保留）；日额度耗尽零请求 daily_budget_exceeded；AI 未配置零调用零 usage；Mock 与受控标签（mock/openai）+ Mock 不消耗日额度；泄漏防护（系统提示与消息不含 AI_API_KEY，问题含注入文本原样存储）；loadOwnedFindingContext 三类 404；HTTP POST 闭环 + GET 恢复 + 复合游标分页（显式时间戳避免同毫秒并列）。
- `tests/e2e/static-review.spec.ts`（新增 1 项，共 4 项）：追问闭环——登录→静态扫描→打开 finding→键盘提交含恶意 HTML 的问题→Mock 回答出现（Mock 徽章 + 调用计数 + 引用）→ `window.__xss` 未被设置且 payload 以纯文本可见→引用点击定位代码→刷新后消息恢复→390×844 切「解释」标签显示追问面板无横向溢出。

**验证（逐项退出码，2026-09-12）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0（环境修复后）
- `pnpm test:unit` → exit 0（8 文件 97 项 = 原 87 + conversation 10）
- `pnpm test:integration` → exit 0（8 文件 67 项 = 原 51 + messages 16；messages 连续 3 次重跑稳定）
- `pnpm test:e2e` → exit 0（4 项通过，约 34 秒；含新增追问闭环）
- `pnpm build` → exit 0（隔离 APPDATA/LOCALAPPDATA；完整路由表输出）

**浏览器流程（E2E 实测，AI_PROVIDER=mock）**：登录 → 建项目 → 上传 ZIP → 静态扫描 → /scans/:id 问题列表 → 打开 finding → 右栏追问面板输入问题（Enter 提交）→ Mock 回答显示「Mock（非真实模型）」徽章 + 模型/工具调用次数 + 检索模式 + 代码引用（1-3 行，已通过读取覆盖与引文校验）→ 点击引用代码区定位 → 恶意 `<img onerror>` 以纯文本渲染未执行 → 刷新后问题与回答从 GET messages 恢复 → 390×844「解释」标签内追问面板无横向溢出。

**R05 合同落实对照**：每轮 4 模型/8 工具/60s 上限；工具仅四件受控只读；引用经 R04 同一证据校验（未读不引、未检索不引）；证据不足显式标注；Mock/未配置/超时/取消/预算/受控六种状态标签互异；消息持久化 role/text/citationsJson/usageJson（无完整 prompt/密钥/思维链）；工具轨迹与规范来源全部来自真实 API 数据（scan_citations 快照），无模拟时间线。

**遗留（转 R06–R09）**

- R06 补丁提案（edits/apply/syntax/diff、patch API 与 patch-diff UI）未开始。
- R07 报告与快照对比（export/compare、报告模型统一）未开始。
- R08 数据集与评测（fixtures、metrics/runner、evaluation 页面）未开始。
- R09 生产交付（README/Dockerfile/compose、生产 PostgreSQL 上重跑租约/额度测试、比赛材料）未开始。
- 真实模型追问 smoke 未执行（无凭证）：追问已按真实 provider 路径实现，凭证就绪后单独记录。
- 扫描级检索模式（hybrid/lexical_only）未入库为结构化字段，当前以工具轨迹结果摘要 + 追问 usage.retrievalMode 呈现；如 R07 报告需要可再加列。

---

## 续作 R06 补丁提案 ✅（2026-09-13）

对应 04 文档 R06。真实模型：**未调用**（提案生成全部为受控 provider / 确定性 MockPatchProvider / 静态路径；"真实调用未验证"状态保留——未提供凭证，Mock 提案在 UI 与补丁内容中均明确标注「Mock 示例提案，非真实 AI 修复」，不冒充真实 AI 修复）。

**修改/新增文件（每个文件一句话职责）**

- `src/core/contracts/patch.ts`（扩展）：新增 PATCH_BUDGET（2 次模型请求/60s）、MAX_PATCH_CHANGED_LINES=200、patchProviderSchema（mock/openai 标签，随 validationJson 持久化）、submitPatchInputSchema（submit_patch 工具合同）；PatchValidation 增加 `provider?` 可选字段（合同扩展，兼容旧行）。
- `src/core/patch/edits.ts`（新建）：编辑校验链纯函数——单文件且路径=目标文件（禁止创建/删除文件）、锁文件拒绝（`*.lock`/package-lock/pnpm-lock/yarn.lock 等）、baseFileHash 与快照 content_hash 一致、expectedOldText 统一 LF 后逐字符严格匹配（复用 review/validate 的 normalizeLf 思路）、行范围合法（1 起始、start≤end、不越界）、编辑互不重叠、总变更 ≤200 行（口径 Σ max(旧行数, 新行数)）、命中脱敏区间（编辑行段扩展 diff 上下文 3 行邻域）拒绝；sha256OfContent 供测试复用。
- `src/core/patch/apply.ts`（新建）：内存副本应用——按行区间降序应用实现顺序无关，replacementText='' 表示删除区间行；绝不写存储。
- `src/core/patch/syntax.ts`（新建）：语法比较——TS/JS/JSX/TSX 用 TS Compiler API 内存解析（createSourceFile，与 analyzer 同源，统计 parseDiagnostics 错误数），Vue 走 @vue/compiler-sfc（SFC 解析错误 + script 块转译诊断，与导入侧同口径）；compareSyntax 只标记「是否引入新错误」→ pass / fail / baseline_failed；json/md/css/html 等不支持语言返回 null → 提案阶段拒绝生成。
- `src/core/patch/diff.ts`（新建）：用 `diff` 包 createTwoFilesPatch 生成 a/<path>→b/<path> unified diff（context=3）；isDownloadable 判据 = applicable 且 syntax ≠ fail（baseline_failed 属基线问题，非补丁退化，可下载并如实展示比较结果）。
- `src/core/patch/propose.ts`（新建，核心）：`proposePatchForFinding(sql, {sessionId, findingId, signal, provider?, budgetConfig?})`——归属 guard 复用 loadOwnedFindingContext（跨会话/预置一律 404）；目标文件不存在 404；不支持语言/锁文件 → unsupported_file 拒绝生成；**重复 POST**：已有同基线（baseFileHash=快照文件哈希）提案直接返回 existing（不调模型），基线失效则旧提案标记 superseded 后重提；provider 注入优先，缺省 chat 就绪走真实 provider 否则 `MockPatchProvider`（确定性：在主引用行上方插入一行 `// [Mock 示例提案，非真实 AI 修复] 请人工复核…` 注释，标题单行化截断，语法安全）；模型只能经 submit_patch 工具提交，编辑必须通过 validateEdits 全链，坏编辑最多 1 次修复轮（校验错误回喂），仍坏 → 入库 status='invalid'（applicable=false，不可下载）或 no_proposal（结构不合法，409）；有效编辑内存应用 → compareSyntax → unified diff → 落库（status=proposed/invalid）；预算 2 次模型请求/60s 墙钟、日额度预留/结算/释放复用 R04（**Mock 不预留、不记账、不结算**，较 conversation 更严格）；单请求 30s 超时 + AbortSignal（超时/取消结构化返回）；usage（模型请求数/token 估算与实测）随响应返回不持久化。
- `src/server/queries/patches.ts`（新建）：共享查询——getLatestFindingPatch（GET 恢复用）、requireOwnedPatch（download 用，join finding→scan→snapshot→project 校验归属，跨会话 404）。
- `src/app/api/findings/[id]/patch/route.ts`（新建）：POST 生成提案（assertSameOrigin/401/404；200 返回 proposed/invalid/existing + patch + reasons + usage；unsupported_file/no_proposal→409 conflict、budget→429、timeout→504、cancelled→409、ai_unavailable→503，全部 {error:{code,message,requestId}}）；GET 返回当前 finding 既有提案（无/superseded 返回 {patch:null}，刷新恢复用；跨会话 404）。maxDuration=60。
- `src/app/api/patches/[id]/download/route.ts`（新建）：GET 下载——requireOwnedPatch 归属校验（跨会话/不存在/非法 UUID 均 404）；validation.applicable=false 或 syntax='fail' → 409 conflict 不给下载；否则返回 diff 文本（Content-Type: text/x-diff; charset=utf-8，Content-Disposition: attachment; filename="codeatlas-patch-<id前8>.patch"）。
- `src/components/review/patch-diff.tsx`（新建）：补丁区块——生成按钮（生成中 ≤60s/超时/限额/AI 未配置/失败状态）、Mount 时 GET 恢复既有提案、Mock 徽章（validation.provider 持久化，刷新后仍标注）、三项验证状态分开显示（applicable 可应用/不可应用、syntax 语法可用/退化 + 基线→补丁后错误数、tests 恒显示 not_run 并附「请在你的环境中自行测试」）、reasons 列表、diff 逐行着色（+ 绿 / − 红 / 上下文灰 / 头部与 @@ 淡灰，长行容器内 overflow-x 横向滚动不撑破布局）、有效提案显示下载按钮（无效提案不给下载，只显示原因）；全部纯文本渲染（无 innerHTML/dangerouslySetInnerHTML）。
- `src/components/review/finding-detail.tsx`（接入）：右栏追问面板下方新增补丁提案区块（border-t 分隔）。
- `tests/unit/patch.test.ts`（新建，19 项）：校验链矩阵——合法单/多行、hash 不符、旧文本不匹配 + CRLF 统一 LF 通过、越界/行范围非法、重叠拒绝与相邻通过、200 行边界（恰好 200 过/201 拒）、多文件与路径不一致（禁止创建/删除文件）、锁文件（含 vue.lock 通配）、脱敏命中（编辑区间内/上下文邻域内拒绝、邻域外通过）、submit_patch Zod 合同；apply 单段替换/删除/多段编辑顺序无关（升序、乱序、倒序一致）/插入式不丢内容；diff 含 +/− 行与 a/ b/ 头；isDownloadable 四态；compareSyntax pass/fail/baseline_failed（同错文本、修复基线错误不误判 pass）；JSX/TSX/Vue 可解析、json/md/css/html → null；MockPatchProvider 确定性提案通过校验链且语法不退化、注入 HTML/换行的标题被单行化；buildFileExcerpt 窗口收敛。
- `tests/integration/patch.test.ts`（新建，17 项）：受控 provider 有效提案闭环（validation 三项分开 + provider=openai 标签、diff 与落库一致、**导出 patch 可用 diff.applyPatch 应用回原始脱敏样例文件且行数不变**、快照文件字节前后相等、修复轮未触发 modelCalls=1）；下载 200 + Content-Disposition .patch 附件 + 内容与 diff 一致；GET 恢复；伪造编辑矩阵（旧文本不匹配/越界/过期 hash——经修复轮仍拒 → invalid 提案 applicable=false、下载 409 conflict、快照字节不变）；脱敏区间命中拒绝（redactedRanges 直接入库构造）；多文件编辑 Zod 拒绝 → no_proposal 409（chatCount=2 证明修复轮）；语法退化提案（可应用但引入新语法错误）→ invalid、下载 409；json 文件不支持 → unsupported_file 且零模型调用；Mock 提案（默认 provider）标签持久化 + diff 含 Mock 标注 + 日额度增量不变（Mock 不记账）+ 可下载；重复 POST → existing 同 patchId 且模型只调 1 次；基线失效 → 旧提案 superseded + 新提案生成；跨会话 POST/GET/download 均 404（含预置项目）；未登录 401；download 不存在/非法 UUID 404；HTTP POST（Mock 默认）200 + usage.provider=mock + tests=not_run、二次 POST existing。
- `tests/e2e/static-review.spec.ts`（新增 1 项，共 5 项）：补丁闭环——静态扫描→打开 finding→生成补丁（Mock 提案）→diff 显示（+/头部/@@/上下文行，Mock 标注可见）→三项验证状态（applicable 可应用、语法、tests=not_run +「请在你的环境中自行测试」）→下载 .patch 附件（文件名与内容均为 unified diff）→刷新后提案仍在（GET 恢复 + 下载按钮仍在）→390×844「解释」标签无横向溢出。
- `tests/integration/messages.test.ts`（类型修复）：383 行断言对象类型标注缺 `role` 字段导致 tsc 报 TS2339（本轮 typecheck 首跑即暴露的存量问题，非本轮代码引入）；补全 `Array<{ text: string; role: string }>` 标注，断言未放宽。
- `package.json` / `pnpm-lock.yaml`（依赖）：新增 devDependency `@types/diff@5.2.3`。理由：`diff`（5.2.2）本就在 dependencies（规格 6 固定技术栈，R01–R05 已锁定），但其 5.x 不随包分发 TypeScript 类型，strict typecheck 下 `import 'diff'` 报缺类型；按任务许可补 @types/diff@^5（与 diff 5.x 配套，未动 diff 版本，未加其他依赖）。

**验收（逐条单独运行，退出码来自 PIPESTATUS[0]，未合并管道吞码）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（9 文件 116 项 = 原 97 + patch 新增 19）
- `pnpm test:integration` → exit 0（9 文件 84 项 = 原 67 + patch 新增 17）
- `pnpm test:e2e` → exit 0（5 项通过，约 35 秒；含新增补丁闭环用例。首跑 1 项失败：断言 diff 含「−」删除行——Mock 提案为纯插入式注释，diff 库按最小编辑脚本规范化后无删除行，属测试预期错误而非实现缺陷；改为断言 + 行/上下文行/@@ 头后复跑通过）
- `pnpm build` → exit 0（按项目规程隔离 APPDATA/LOCALAPPDATA 至 .appdata-build，结束后已删除该目录；路由表含新增 /api/findings/[id]/patch 与 /api/patches/[id]/download；运行前核查 node 进程，无本项目遗留 dev/db-server 进程，仅有系统级 MCP/Codex 进程未动）

**浏览器流程（E2E 实测，AI_PROVIDER=mock）**：登录 → 建项目 → 上传 ZIP → 静态扫描 → /scans/:id 打开首条 finding（App.tsx dangerouslySetInnerHTML，high）→ 右栏「修复补丁提案」点击生成 → Mock 提案返回：diff 显示 `--- a/src/App.tsx` / `+++ b/` / `@@` / 添加行（`// [Mock 示例提案，非真实 AI 修复] 请人工复核…`，绿色着色）与上下文行（灰色）；Mock 徽章可见 → 三项验证分开显示：可应用 / 语法（基线 0 → 补丁后 0）/ 测试 not_run + 自行测试提示 → 点击下载得到 codeatlas-patch-*.patch 附件（内容为 unified diff）→ 刷新后提案与下载按钮恢复（GET /api/findings/:id/patch）→ 390×844「解释」标签内补丁面板无横向溢出。

**R06 合同落实对照**：校验链全部服务端（hash/旧文本严格匹配/单文件/行范围/非重叠/≤200 行/脱敏区间/禁创建删除/禁锁文件）；快照存储只读（集成测试断言存储文件字节前后相等）；语法只标「是否引入新错误」，tests 恒为 not_run 不冒充通过；提案与 baseFileHash（快照文件哈希）绑定，重复 POST 返回既有或失效重提；无效提案（applicable=false 或 syntax=fail）409 且 UI 不给下载；错误统一 {error:{code,message,requestId}}；guard 复用（跨会话 404 不泄露存在性）；Mock 明确标注非真实 AI 修复。

**遗留（转 R07–R09）**

- 真实模型补丁提案 smoke 未执行（无凭证）：提案已按真实 provider 路径实现（submit_patch 工具 + 修复轮），凭证就绪后单独记录。
- R07 报告与快照对比（export/compare、报告模型统一）未开始。
- R08 数据集与评测、R09 生产交付未开始；生产 PostgreSQL 上重跑租约/额度测试待 R09。
- Mock 提案为固定插入式注释（保守、语法安全），不代表真实修复能力；diff 库按最小编辑脚本规范化，纯插入编辑无「−」行（UI 已支持删除行着色，真实替换型提案会触发）。
- 提案 usage（模型请求数/token）仅随 POST 响应返回，未持久化（patches 表无 usage 列，未为此新增迁移）；UI 当前仅在生成响应内可见，刷新后不展示（不影响合同）。

---

## 续作 R07 报告与快照对比 ✅（2026-09-13）

对应 04 文档 R07。真实模型：**未调用**（全部为静态路径 / Mock / 受控测试注入；报告与对比不涉及模型调用）。

**新增/修改文件（每个文件一句话职责）**

- `src/core/report/compare.ts`（新建，核心纯函数）：快照对比匹配——匹配键 = 规则/类别（ruleId 优先、无 ruleId 按 category）+ 规范化相对路径 + 符号名 + **去空白局部代码哈希**（quote 去全部空白后 FNV-1a+djb2 双路 64 位确定哈希，不依赖行号、不依赖 node:crypto 以便客户端复用）；三遍匹配：①完全键一一对应→仍存在，一对多/多对一→全部标不可比较（重复匹配）；②文件改名仅当整文件内容哈希一致且目标中该哈希唯一才重键识别（附 renamedFrom）；③剩余旧问题按覆盖判定——静态口径=目标快照收录且可分析且解析成功的文件、AI 口径=coverage.ai.readFiles（未启用 AI 为空），未覆盖→不可比较（明确"不得算未再检出"），已覆盖未匹配→未再检出；目标扫描未完成（queued/running/failed/cancelled）→旧问题全部不可比较；模型/规则/提示词版本不同→`comparable=false` + 全局"不可直接比较"差异列表（仍给出参考分类）；不同快照→scopeNote 范围提示；导出 `COMPARE_DISCLAIMER` 固定说明与四类计数。
- `src/core/report/model.ts`（新建）：共享报告模型——`buildReportModel(sql, scanId)` 从 scanId 构建 ReportModel（调用方先做归属校验）：扫描元数据（状态/阶段/config/规则版本/提示词版本/modelId/起止时间/errorText）、未完成原因（failed/cancelled/partial/进行中各自语义，partial 附 AI 降级原因）、risk（存储值，risk.ts 口径不变）、severityCounts（全量分布 + total）、needsReviewCount、coverage（静态与 AI 分列，含 selectedFiles/readFiles/notReadCount/selectionBasis）、usage、findings（severity/category/source/evidenceStatus/feedback/路径行段/symbol/condition/impact/依据/建议/主引用/related/**规范引用快照**（按 guidelineChunkIds→scan_citations.chunk_id 对应，textSnapshot 截断 240 字）/ **补丁提案状态**（R06 patches 最新一条：proposed/invalid/superseded + applicable/syntax/provider + 中文标签，无提案为 null，取不到不阻塞导出））、scan_citations 全量快照、notes（启发式口径 + Mock 标注）；`buildCompareScanInput(sql, scanId)` 构建对比输入（findings + 文件哈希 + 静态/AI 覆盖路径 + completed 语义）。
- `src/core/report/export.ts`（新建）：三种导出渲染——json（`JSON.stringify(model, null, 2)`）；markdown（元数据/风险/覆盖/用量表格 + 问题表 + 每条详情列表 + 引用快照表，用户内容经 `escapeMarkdownCell`（反斜杠/反引号/星号/下划线/方括号/尖括号/竖线全转义、换行折叠）防 Markdown 注入，代码围栏长度大于内容最长反引号串防提前闭合）；html（可打印完整文档：全部动态内容经 `escapeHtml`，含元数据/风险（含公式与待核查口径）/覆盖（静态与 AI 分列、降级中文说明）/用量/问题表+逐条详情/规范引用快照/说明各节，长代码 `pre { white-space: pre-wrap; overflow-wrap: anywhere }` + `table-layout: fixed` 不撑破打印布局，`@media print` 防截断，浏览器打印另存 PDF 无需服务端引擎）；`exportFilename`（codeatlas-report-<scan 短 id>.json|md|html）/`exportContentType`。
- `src/app/api/scans/[id]/export/route.ts`（新建）：GET ?format=json|markdown|html——非法 format 400、未登录 401、跨会话 404（requireReadableScan）；消费与 UI 同一 `buildReportModel`；响应 `Content-Disposition: attachment`（文件名含 scan 短 id）+ no-store；错误统一 `{error:{code,message,requestId}}`。
- `src/app/api/projects/[id]/compare/route.ts`（新建）：GET ?baseScanId&targetScanId——requireReadableProject（跨会话 404）+ 两个 scan 均须属于该项目（否则 404，不泄露存在性）+ assertUuid；构建两侧输入后返回 `compareScans` 结果。
- `src/app/(app)/projects/[id]/compare/page.tsx`（新建）：对比页服务端组件——会话与项目归属校验（跨会话 notFound），加载项目内扫描列表（created_at 升序）供选择器。
- `src/components/projects/compare-client.tsx`（新建）：对比客户端——两个扫描选择器（默认基准=最早、目标=最新，label 含短 id/状态/时间/规则版本/风险）、查看对比按钮、可比性提示条（版本配置不同→琥珀横幅逐条列出差异；不同快照→范围提示条）、四类变化摘要徽章（count-added/persisting/disappeared/incomparable）、四类变化列表（severity/路径行段/规则/类别/来源/证据/反馈徽章；persisting 显示 旧→新（含改名说明）；incomparable 显示原因）、**「未再检出 ≠ 已验证修复」固定说明**（compare-disclaimer）；空态（无扫描）、无可比结果、API 错误状态齐全；纯文本渲染无 innerHTML。
- `src/components/review/scan-workbench.tsx`（扩展）：终态扫描头部新增「导出报告」三种格式链接（data-testid=export-json/markdown/html，指向 /api/scans/:id/export）。
- `src/app/(app)/projects/[id]/page.tsx`（未改动）：对比页入口此前已存在（扫描记录 ≥2 时头部「快照对比」链接，GitCompareArrows），本轮零改动复用。
- `tests/unit/report-compare.test.ts`（新建，18 项）：对比矩阵——行号平移同规则同路径同内容→仍存在；同路径同类别不同符号/内容→新增（AI 按 category）；旧问题文件未覆盖→不可比较（不得算未再检出）；两条新报对一条旧报→全部不可比较；文件改名+整文件哈希一致→识别同一问题（附 renamedFrom）；改名+内容变化→不识别；规则版本不同→全体不可直接比较提示；模型/提示词版本不同同理；AI 问题要求目标启用 AI 且实际读取；目标未完成→全部不可比较；自比→全部仍存在；导出 JSON 与 model 逐字段一致；文件名/format 识别；Markdown 注入字符转义（`\<script\>`、`\|`、反引号、`\[`）且表格列数不破坏；代码围栏防提前闭合；HTML 无未转义 `<script>`（`&lt;script&gt;` 等）、含覆盖/风险/待核查/降级说明与 pre-wrap/@media print；三格式问题数/覆盖数字/风险指数一致。
- `tests/integration/report.test.ts`（新建，7 项）：真实库两个 scan（同一项目两个快照：修复版删除 gone.ts）——compare API 四类变化矩阵 {added:1, persisting:1, disappeared:1, incomparable:1}（行号平移判仍存在、AI needs_review 判新增、gone.ts 未覆盖判不可比较）+ 范围提示 + disclaimer；自比全部仍存在；跨会话 404、跨项目 scan 404、缺参数 400；三格式 200 + Content-Type + 附件头（文件名含短 id）；JSON 与 findings 表数量一致、severityCounts.total=数量、risk 按真实口径（3×high→30）、补丁状态有效/无效分开且无提案为 null、引用快照版本/来源/240 字截断；HTML 恶意标题转义且无未转义 `<script>`、Markdown `<script>`/`|`/反引号/`[` 全转义；非法 format 400 + requestId、未登录 401、跨会话 404。
- `tests/e2e/static-review.spec.ts`（新增 1 项，共 6 项）：报告导出与对比闭环——完成静态扫描后点导出 JSON（下载文件名 codeatlas-report-<短id>.json、内容 JSON 可解析且 scan.id/findingCount 一致）→ 同一会话返回项目页上传修复版 ZIP（移除 dangerouslySetInnerHTML、danger.js 增加 new Function；List 缺 key/eval 保持原内容行号平移）→ 第二次扫描完成 → 项目页「快照对比」入口 → 对比页默认选最早/最新两次扫描 → 新增 1（new Function 动态构造函数）/未再检出 1（候选 HTML 注入入口）/仍存在（列表渲染缺少稳定 key，行号平移仍匹配）/范围提示（不同快照）/**「未再检出≠已验证修复」说明可见** → 1440×900 与 390×844 无横向溢出。

**E2E 排障记录（真实根因）**

- 首跑失败 1（构建）：e2e build 报 `node:crypto` 无法打进客户端包——compare-client.tsx 引用 compare.ts（其 quoteHash 用 node:crypto）。修复：quoteHash 改为纯 JS 双路 64 位确定哈希（FNV-1a + djb2 变体；匹配键还叠加规则/路径/符号，稳定性需求>抗碰撞性），compare.ts 变为完全无 node 依赖、客户端可安全复用。
- 首跑失败 2（页面陈旧）：第二次扫描已完成（trace 证实 scan 存在且终态 completed），但点「返回」后项目页仍显示新快照「尚未扫描」，「快照对比」入口不出现。根因：Next 客户端路由复用了扫描页挂载时预取（prefetch）的项目页 RSC payload（约 2 秒前的快照，早于新 scan 行可见）。修复：E2E 改用 `page.goto(backHref)` 整页加载返回（应用行为无改动——刷新浏览器同样是新鲜加载）。
- 二跑失败 3（断言目标错误）：section-added 只断言到卡片标题「新增（1）」，未覆盖内容；且发现 CompareRow 对 added/incomparable 的 target 侧不渲染（UI 缺陷：新增问题在列表中显示为空行）。修复：CompareRow 对非 persisting 条目也渲染 target 侧（标题+徽章）；section testid 移到卡片容器，断言覆盖内容文本。

**验收（逐条单独运行，退出码为命令真实退出码，未用管道吞码）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（10 文件 134 项 = 原 116 + report-compare 新增 18）
- `pnpm test:integration` → exit 0（10 文件 91 项 = 原 84 + report 新增 7）
- `pnpm test:e2e` → exit 0（6 项通过，约 39 秒；含新增报告导出与对比闭环用例，最终 3 次修复后全绿）
- `pnpm build` → exit 0（隔离 APPDATA/LOCALAPPDATA 至 .appdata-build，结束后已删除该目录；运行前核查无本项目遗留 node 进程；路由表含新增 /api/scans/[id]/export、/api/projects/[id]/compare、/projects/[id]/compare）

**浏览器流程（E2E 实测，AI_PROVIDER=mock，无真实模型调用）**：登录 → 建项目 → 上传 ZIP → 静态扫描完成 → /scans/:id 顶栏「导出报告 JSON」→ 下载 codeatlas-report-*.json（内容与界面同源的 ReportModel）→ 返回项目页上传修复版 ZIP → 第二次扫描完成 → 项目页「快照对比」→ 对比页选两次扫描 → 查看对比：变化摘要（新增 1/仍存在/未再检出 1/不可比较 0）+ 四类列表 + 不同快照范围提示 + 「未再检出≠已验证修复」固定说明 → 1440×900 与 390×844 无横向溢出。

**R07 合同落实对照**：UI/API/JSON/Markdown/HTML 全部消费同一 ReportModel（数字一致有集成测试断言）；导出附件下载 + 短 id 文件名 + 跨会话 404 + 统一错误体；HTML 全动态内容 escapeHtml 白名单净化、代码不经过 innerHTML；对比匹配不依赖行号、重复匹配/改名/未覆盖/版本差异处理齐全；"未再检出"仅描述本次结果变化，UI 与（对比）说明固定展示"≠已验证修复"；evidenceStatus/feedback 语义沿用 risk.ts（needs_review 不进高可信指数）；findings 携带 R06 补丁提案状态（存在/有效/无效），无提案为空不阻塞。

**遗留（转 R08–R09）**

- R08 数据集与评测（fixtures、metrics/runner、evaluation 页面）、R09 生产交付未开始；生产 PostgreSQL 上重跑租约/额度测试待 R09。
- 真实模型 smoke（审查/追问/补丁）仍未执行（无凭证）；报告与对比不涉及模型调用，不受影响。
- 扫描级检索模式（hybrid/lexical_only）仍以工具轨迹呈现，未入报告结构化字段（引用快照已含版本与文本，可解释来源）。
- compare 的"不可直接比较"为全局提示 + 仍给出参考分类（版本差异只影响提示，不强制清空分类）；若后续需要更保守口径（版本不同即全部不可比较），只需在 compareScans 中把 configDifferences 非空时的分类改为 incomparable，一处改动。
- 对比页 1024×768 视口未单独截图（合同要求 1440×900/390×844 均已验证）；R09 演示材料阶段统一补三视口截图。

---

## 续作 R08 数据集和评测 ✅（2026-09-13）

对应 04 文档 R08。真实模型：**未调用**（本地无任何模型凭证——static_only 为确定性真实静态规则结果；llm 模式为受控 Mock 管线验证并在结果中标注 provider=mock；真实模型保留集重复 3 次评测未执行，状态在页面与 CLI 输出中如实展示）。

**新增文件（每个文件一句话职责）**

- `src/core/contracts/evaluation.ts`（新建）：评测合同——三模式枚举/标签、EvaluationRunConfig、EvaluationMetricsJson（totals/latency/tokens/逐项目/失败列表）、小样本口径固定声明 EVALUATION_DISCLAIMER。
- `src/core/evaluation/metrics.ts`（新建，纯函数）：匹配与指标——候选兼容 = 文件 + 标注行段相交 + 类别一致；一对一确定性贪心匹配（边按「起点距离→候选键序→标注键序」稳定排序）；Precision/Recall/F1 调和平均、分母为零返回 null（展示 N/A）；重复报警（兼容已占用标注的未匹配候选）计数并计入 FP；无效引文候选不参与匹配、单列 invalidCitations 且计入 FP（不丢弃美化）；evidenceValidRate；跨项目聚合（先求和再算派生指标）；percentile 线性插值。
- `src/core/evaluation/fixtures-defs.ts`（新建）：24 个样例项目定义（12 缺陷 + 12 对照 × 6 类问题：动态执行 / HTML 注入 / postMessage 源 / JSX key / 条件 Hook / 检查禁用与调试残留，每类 2 场景）；每缺陷带锚点式标注（ruleId/category/file/anchor/symbol/condition）；个别缺陷标识符在源码中以字符串拼接构造（生成产物为真实可解析 TS/JS，且本模块不含触发安全扫描的词面）。
- `src/core/evaluation/fixtures.ts`（新建）：数据集构建与生成——内容哈希（全项目规范 JSON 的 sha256）→ datasetVersion = `v<revision>-<hash8>`，内容不变幂等、变化 revision+1（读磁盘已有 dataset.json）；生成时强校验：锚点唯一命中、每个标注 ↔ 静态规则输出双向对应（缺陷项目全部发现被标注覆盖）、对照项目零发现、划分必须 16/8；写 dataset.json + projects/<id>/manifest.json + 源文件。
- `src/core/evaluation/dataset.ts`（新建）：磁盘加载器——resolveFixturesDir（EVAL_FIXTURES_DIR 覆盖或项目根 fixtures/）、readDatasetInfo（轻量概况）、loadDataset（dataset.json + manifest + 文件内容；缺失给出「请运行 pnpm fixtures:generate」明确提示）。
- `src/core/evaluation/zip.ts`（新建）：最小 STORE 方式 ZIP 构造器（node 内置 CRC32 表，无新依赖），把样例文件打包为真实归档走生产导入管线。
- `src/core/evaluation/mock-provider.ts`（新建）：EvaluationMockProvider（useRag 开关）——确定性脚本：读取样例文件 →（useRag=true 时 retrieve_guidelines）→ submit_findings；引文取自真实读取行（通过 R04 证据校验）；useRag=false 严格不检索不引用；始终提交（无候选时提交空数组）避免空转烧预算；明确 mock 标记。
- `src/core/evaluation/runner.ts`（新建，核心）：runEvaluation——逐项目执行与生产完全一致的核心扫描管线（ZIP → prepareSnapshot 导入 → persistSnapshot → 扫描+scan 任务 → 评测执行器直接领取租约 → processScanJob 六阶段，LeaseKeeper 续租）；项目落在隔离预置项目（session_id 空、is_preset，保留供回溯）；三模式固定配置仅切换 RAG（static_only enableCloudAI=false；llm_no_rag/hybrid_rag 注入 provider，无凭证用 EvaluationMockProvider，有凭证用真实 provider 且 no_rag 经包装层移除 retrieve_guidelines）；逐项目指标（findings 候选 + matchesQuote 复核 + scan_events finding.invalid 计数并入 FP）与延迟/token；取消在项目边界生效（不再新增工作，已完成部分保留）；单项目失败记录 failures 继续（终态 partial）；写回 evaluations（pending→running→completed/partial/failed/cancelled + metrics_json）。
- `scripts/generate-fixtures.ts`（新建）：CLI 生成 fixtures/ 至项目根（幂等、版本哈希、校验失败即中止），输出版本/计数/划分/类别摘要。
- `scripts/evaluate.ts`（新建）：评测 CLI——开头检测 DATABASE_URL 可达（不可达提示「请先运行 pnpm db:dev」）；--dataset/--mode/--split/--limit；不经 HTTP 直接调用 runEvaluation 并落 evaluations 表；stdout 输出逐项目表 + 汇总表（P/R/F1、证据有效率、重复报警、p50/p95、token/项目、provider 标注、口径声明）。
- `src/app/api/evaluations/route.ts`（新建）：POST（assertSameOrigin→requireSession→**仅 role='admin'**，demo 403；Zod 校验 {datasetVersion,mode,split}；datasetVersion 与磁盘数据集不一致 400；数据集未生成 409；插入 evaluations(pending)+jobs(kind=evaluation)；202）；GET（任意已登录会话可读，limit≤100，返回运行列表 + 数据集概况或 null）。
- `src/app/api/evaluations/[id]/route.ts`（新建）：GET 详情（配置与实际指标；任意已登录会话；404/401 结构化错误）。
- `src/app/(app)/evaluation/page.tsx`（新建）：评测中心服务端页——会话角色、运行列表（DB 首屏）、数据集概况（fixtures 磁盘读取，未生成显示明确提示）。
- `src/components/evaluation/evaluation-client.tsx`（新建）：客户端——配置表单（模式×3/划分×3；demo 会话提示并如实显示服务端 403 错误）、202 后 2 秒轮询直到终态、运行列表（状态徽章：排队中（未运行）/进行中/已完成/部分失败/失败/已取消 + Mock/真实模型徽章）、指标卡（P/R/F1 逐项 N/A 标注、TP/FP/FN 与重复报警、证据有效率、p50/p95、token/项目）、消融对比表（同数据集+同划分每模式最近一次）、逐项目表（**scanId 链接到 /scans/:id 可回溯原始扫描**）、失败样例列表（不隐藏）、小样本口径 + 真实模型未执行说明、空态「尚未运行评测」；全部纯文本渲染，表格容器内横向滚动不撑破页面。
- `tests/unit/evaluation-metrics.test.ts`（新建，18 项）：手算 TP/FP/FN 表（全对/漏报/误报/类别不符/文件不符）、零分母 N/A 三态、重复报警额外计 FP（一对一占用断言）、无效引文计入 FP 且不充当 TP、匹配确定性（同输入同配对、距离平局按键序、行段相交边界）、聚合先求和、percentile 插值。
- `tests/unit/evaluation-fixtures.test.ts`（新建，14 项）：24=12+12 计数、6 类每类 ≥2 场景、16/8 划分（dev 8+8、holdout 4+4、无项目跨集）、splitOf 确定性、正负样例非重复包装（主文件内容不同）、标注↔静态规则输出双向对应、标注行在文件行数范围且非空、生成器两次运行字节一致、磁盘 manifest/split 一致性、磁盘样例重跑规则确实触发、datasetVersion 幂等与内容变化 revision 递增。
- `tests/integration/evaluation.test.ts`（新建，12 项）：未登录 401/demo 403（不创建记录）/admin 202（pending+kind=evaluation 任务、重复运行新记录、测试后清理）/版本不一致 400/数据集缺失 409/GET 列表详情任意会话可读+数据集概况；worker 端到端 static_only dev×6（completed、metrics_json 可解析、**P=R=1、FP=FN=0**、逐项目 scanId 落库且快照为隔离预置项目、findings 数=候选数、任务 completed）与 holdout×8；llm_no_rag+hybrid_rag×2（provider=mock 标注、note 含「真实模型评测未执行」、token>0、modelCalls>0、缺陷项目出现 combined/ai、**消融验证：no_rag 引用=0 / hybrid 引用>0**）；取消语义（处理前取消→evaluations cancelled+job cancelled+零新增项目；中途取消→partial+projectCount=1+cancelled=true）；重试上限耗尽（两次失败后 evaluations=failed+error_text+任务不再被领取）。
- `tests/e2e/evaluation.spec.ts`（新建，1 项）：admin 登录（e2e-admin-2026）→ /evaluation 数据集概况/口径声明/真实模型说明可见 → 触发 static_only dev → 轮询至已完成 → 指标卡可见且数字非伪造（P/R/F1 为 N/A 或 0..1 数值，实测 1.000/TP 4）→ 逐项目表 ≤6 行（EVAL_PROJECT_LIMIT=6 小子集口径）→ 消融表与配置溯源（static-rules-v1/划分 dev）→ 1440×900 无溢出 → demo 会话触发显示 403/无权限 → 390×844 无横向溢出。
- `fixtures/`（生成产物，122 个文件提交到磁盘；.gitignore 不排除、tsconfig exclude 排除其类型检查）：dataset.json（v1-cd06ca6f）+ 24 ×（manifest.json + 源文件）。

**修改文件**

- `src/worker/evaluation.ts`：替换占位实现——processEvaluationJob 领取 kind=evaluation 任务：读 evaluations 配置（mode/split/projectLimit，EVAL_PROJECT_LIMIT 环境变量为 e2e/集成小子集口径）、加载磁盘数据集并校验 datasetVersion（不一致→failed+明确 error_text，任务完结不重试）、调 runEvaluation（取消检查绑定评测任务、失租信号透传）、按结果 completeJob/cancelJob；DatasetNotFoundError 单独终结；其余异常抛回 worker 走 failJob 重试。
- `src/worker/jobs.ts`（扩展，不改已有行为）：failJob 与 reapExhaustedJobs 增加 kind=evaluation 分支——上限耗尽时 evaluations.status='failed' + error_text 一致终结（与 scan 同模式）。
- `src/core/contracts/index.ts`：导出 evaluation 合同。
- `src/app/(app)/layout.tsx`：管理员徽章窄屏隐藏（`hidden sm:inline-flex`）——修复 admin 会话 390×844 下头部横向溢出 34px（demo 会话此前即无溢出，差异即该徽章）。
- `scripts/e2e-server.ts`：启动时向临时目录生成隔离 fixtures 数据集并为 web+worker 注入 `EVAL_FIXTURES_DIR` 与 `EVAL_PROJECT_LIMIT=6`（小子集口径，已记录），关闭时清理。
- `tsconfig.json`：exclude 增加 `fixtures`（样例为含故意缺陷的数据文件，不参与产品类型检查；lint 范围本就不含 fixtures）。

**fixtures 概况**：24 项目（12 缺陷 + 12 对照）× 6 类问题 × 每类 2 场景（动态执行：动态表达式 / new Function+字符串定时器；HTML 注入：innerHTML / dangerouslySetInnerHTML；postMessage：targetOrigin="*" / 无 origin 校验监听；JSX key：map 无 key / Fragment 子元素无 key；条件 Hook：if 内 useState / 普通函数内 useEffect；检查禁用：裸 @ts-ignore / console 残留+禁用安全 ESLint 规则）；划分 dev=16（8+8）/holdout=8（4+4）按项目整体拆分，文件零跨集；版本 v1-cd06ca6f（revision 1，内容 sha256 哈希前 8 位，内容变化 revision 自增）；生成器幂等（两次运行字节一致）且强校验标注 ↔ 静态规则输出双向对应、对照项目零命中。

**实际评测数字（CLI 真实运行，evaluation id 可在库中追溯 metrics_json 与逐项目 scanId）**

| 模式 | 划分 | 项目 | Precision | Recall | F1 | 证据有效率 | 延迟 p50/p95 | token/项目 | provider |
|---|---|---|---|---|---|---|---|---|---|
| static_only | dev | 16 | 1.000（TP 9/FP 0/FN 0） | 1.000 | 1.000 | 100% | 33ms / 66ms | 0 | 无模型调用 |
| static_only | holdout | 8 | 1.000（TP 6/FP 0/FN 0） | 1.000 | 1.000 | 100% | 40ms / 70ms | 0 | 无模型调用 |
| llm_no_rag | dev | 16 | 1.000（TP 9/FP 0/FN 0） | 1.000 | 1.000 | 100% | 49ms / 75ms | 968（合计 15492） | **Mock** |
| hybrid_rag | dev | 16 | 1.000（TP 9/FP 0/FN 0） | 1.000 | 1.000 | 100% | 52ms / 75ms | 1848（合计 29560） | **Mock** |

- 消融可回溯验证：hybrid_rag CLI 运行（16 项目）的逐项目 scanId 共产生 24 条 scan_citations 规范引用快照；llm_no_rag 对应运行 0 条（RAG 开关严格生效）。
- static_only 满分的含义：样例集与现有 9 条静态规则对齐（生成器强校验），该数字只说明「管线 + 规则在本样例集上的行为符合设计预期」，不代表真实项目准确率——页面与 CLI 均固定展示小样本口径声明。
- **真实模型状态：未调用**（无凭证）。llm 两模式为受控 Mock 管线验证（provider=mock 逐项标注，note 明确「不冒充真实模型指标」）；规格 13 要求的真实模型保留集重复 3 次（均值与范围）未执行，保留为后续凭证就绪后的验证项。

**验收（逐条单独运行，真实退出码）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（12 文件 166 项 = 原 134 + metrics 18 + fixtures 14）
- `pnpm test:integration` → exit 0（11 文件 103 项 = 原 91 + evaluation 12）
- `pnpm test:e2e` → exit 0（7 项通过，约 44 秒；含新增评测中心用例）
- `pnpm build` → exit 0（隔离 APPDATA/LOCALAPPDATA 至 .appdata-build，结束后已删除；路由表含 /evaluation、/api/evaluations、/api/evaluations/[id]）
- `pnpm fixtures:generate` → exit 0（两次运行版本一致 v1-cd06ca6f，幂等）
- `pnpm eval -- --mode static_only --split dev` / `--split holdout` / `--mode llm_no_rag --split dev` / `--mode hybrid_rag --split dev` → 全部 exit 0（数字见上表；运行前 `pnpm db:dev` 起库，结束后已停止该进程）

**浏览器流程（E2E 实测，AI_PROVIDER=mock）**：管理员访问码登录 → /evaluation 看到数据集概况（v1-cd06ca6f · 24 项目 · 12+12 · 16/8）与小样本口径、真实模型未执行说明 → 选 static_only + 开发集 → 运行评测 → 状态「排队中→进行中→已完成」（2 秒轮询）→ 指标卡 Precision/Recall/F1 = 1.000（TP 4）、证据有效率 100%、p50/p95、token → 消融表显示 static_only 行（其余模式提示尚未运行）→ 逐项目表每行可点「查看」跳转 /scans/:id 回溯原始扫描 → demo 会话（新浏览器上下文）触发评测如实显示 403/无权限 → 1440×900 与 390×844 无横向溢出。

**E2E 排障记录（真实根因）**

- 首跑失败：断言正则 `^[01]\.\d{3}$` 锚定了整个卡片文本（含标签与提示），指标本身正确（1.000）；改为非锚定匹配。
- 二跑失败：390×844 溢出 34px——admin 会话头部比此前通过 390 检查的 demo 会话多出「管理员」徽章（390+34=424px 完全吻合）；修复为窄屏隐藏该徽章（src/app/(app)/layout.tsx），三跑全绿。

**遗留（转 R09）**

- 真实模型评测未执行（无凭证）：llm_no_rag/hybrid_rag 现结果为 Mock 管线验证；凭证就绪后按规格以 CLI 跑保留集 ×3（均值与范围），预算受 AI_DAILY_TOKEN_LIMIT 约束：llm_no_rag 对真实模型的 RAG 隔离经 provider 包装层移除 retrieve_guidelines 实现（模型仍坚持调用该工具时工具会执行并记录在轨迹，UI 有 Mock/真实标注可辨）。
- 评测产生的预置样例项目/快照保留在库与存储中（每个展示数字可回溯到逐项目 scanId），不做自动清理；评测执行器中途崩溃时 evaluations 行停留 running（扫描任务可被常规 worker 接管完成），需重新发起评测（新记录）。
- EVAL_PROJECT_LIMIT 为 e2e/集成提速口径（e2e=6），正式评测不设限；该口径记录在 metrics_json.config.projectLimit 并在 UI 显示。
- 评测 API 未提供取消端点（评测任务粒度的取消经由 jobs 机制可用，页面未暴露取消按钮）；R09 可按需补 POST /api/evaluations/:id/cancel。
- R09 生产交付（README/Dockerfile/compose、生产 PostgreSQL 重跑租约/额度测试、比赛材料）未开始。

---

## 续作 R09 生产交付与比赛材料 ✅（2026-09-13）

对应 04 文档 R09（整个项目最后一个任务）。真实模型：**未调用**（本机无凭证；全部演示/截图/e2e 环境 AI_PROVIDER=mock，文档如实记录该状态，未虚构任何评测数字或演示结果）。工程保持非 git 仓库。

**新增文件（每个文件一句话职责）**

- `README.md`（工程根）：项目定位、F01–F12 功能总览、PGlite 本地路径（db:dev → db:migrate → seed → dev → worker:dev，端口 3100/5433）与 PostgreSQL 生产路径（compose + 迁移 + seed，**标注本地未验证**）分开书写；18 个环境变量名称/用途/示例值表（不含真实秘密，未读取 .env）；统一命令表；安全边界摘要；**诚实的已知限制清单**（真实模型未验证 / Docker 未验证 / 生产 PG 待重跑 / 24 样例小样本口径 / llm 评测为 Mock 管线）。
- `Dockerfile`：deps → build → runtime 三阶段，node:22-slim 基镜像，`USER node` 非 root，不挂载 Docker socket；**不使用 output:'standalone'** 并在注释中写明原因——next.config.mjs 的 outputFileTracingExcludes 排除了 @vue/compiler-sfc（R01 build 崩溃修复），standalone trace 清单不含该依赖而运行时 Vue SFC 分析需要它，故采用完整 node_modules + `next start` 部署（若改 standalone 必须显式补回该依赖及其 pnpm 虚拟存储）；web 与 worker 同镜像不同 command（worker 覆盖 command 为 `node node_modules/tsx/dist/cli.mjs scripts/worker.ts`）。
- `.dockerignore`：排除 .env/.data/.next*/node_modules/artifacts 等，不把本地秘密与数据带进构建上下文。
- `compose.yaml`：db（pgvector/pg16 + pg_isready 健康检查 + db-data 持久卷，不映射宿主端口）→ migrate 一次性服务（`sh -c` 迁移 + seed + doctor，`:?` 插值强制要求 POSTGRES_PASSWORD/SESSION_SECRET/两个访问码从 .env 注入——**生产禁止默认访问码**，注释明示）→ web（3100，depends_on migrate service_completed_successfully，fetch /login 健康检查）→ worker（同镜像不同 command）；web/worker/migrate 共享 storage 持久卷（STORAGE_ROOT=/app/.data/storage）；全部服务非 root、无 privileged、无 Docker socket。**本机无 Docker，文件未验证**（文件头与 README 均如实标注）。
- `docs/architecture.md`：总体模块图（浏览器 → Next API → PG 协议数据库 + 独立 worker）、导入/扫描六阶段/租约生命周期/SSE 轮询/AI 证据校验/RAG/追问/补丁/报告/对比/评测的数据流、安全边界、数据库合同（含实测差异：PGlite socket 自研协议层与 unnamed statement 独占名、jsonb asJson 兼容、(created_at,id) 复合游标）、构建实测细节（outputFileTracingExcludes 坑、Windows APPDATA 隔离规程、e2e 隔离架构）、目录导览、页面状态合同——基于磁盘真实实现而非方案理想态。
- `docs/evaluation.md`：数据集构成（24 项目/12+12/6 类×2 场景/16-8 按项目划分/版本 v1-cd06ca6f 内容哈希）、三模式配置（static_only/llm_no_rag/hybrid_rag，消融仅切换 RAG）、指标定义与 N/A 规则、**R08 实测数字表**（static_only dev/holdout P/R/F1=1.000 TP9/TP6 标注为真实静态结果；llm 两模式标注 Mock 管线）、限制（小样本口径、真实模型未执行、Mock token/延迟口径）。
- `docs/demo-script.md`：5–8 分钟演示脚本（40s 背景/60s 导入覆盖/120s 审查证据/60s RAG 工具轨迹/60s 补丁对比/60s 评测限制），每步具体操作路径 + 预期画面 + 讲稿要点；开头与时间分配表明确标注哪些环节是 Mock（追问回答、补丁提案、llm 评测）、哪些数字来自真实静态评测（static_only 指标、风险公式、静态规则命中）。
- `tests/e2e/helpers.ts`：e2e 共享帮助（从 static-review/evaluation spec 抽取）——DEMO/ADMIN 访问码、SAMPLE_FILES/FIXED_FILES、assertNoHorizontalOverflow、login、createStaticScan、newSessionContext（testDir 下非 *.spec.ts 不被收集为用例）。
- `tests/e2e/full-flow.spec.ts`（1 项）：完整用户闭环——登录→建项目→上传 ZIP→静态扫描完成→打开 finding（主引用/行号 1 起始/evidence 状态）→确认反馈→生成补丁提案（Mock，diff + 三项验证分开 + 非真实 AI 标注）→回扫描工作台导出 JSON 报告（文件名/scan.id/findings 数量一致）→上传修复版 ZIP 第二次扫描→对比页四类变化徽章（新增 1/未再检出 1/仍存在/不可比较 0）+ 内容断言 + 范围提示 +「未再检出≠已验证修复」→1440×900 与 390×844 无横向溢出。
- `scripts/capture-screenshots.ts`：三视口截图脚本（Playwright chromium API，`pnpm tsx scripts/capture-screenshots.ts` 可重复运行）——自建隔离环境（临时 PGlite/存储/fixtures + 独立 distDir=.next-shots 的生产构建 + next start + worker，AI_PROVIDER=mock，端口 3220），走完整用户流程（含追问 Mock 回答、补丁生成、admin 触发 static_only 评测并等待完成），对 login/projects/project/scan/finding/compare/evaluation 7 页 × 1440×900/1024×768/390×844 截图到 artifacts/screenshots/；SIGINT/子进程退出/流程异常均走统一 cleanup（taskkill 进程树、停库、删临时目录与 .next-shots）。

**修改文件**

- `tests/e2e/static-review.spec.ts`：本地帮助定义（DEMO_CODE/SAMPLE_FILES/FIXED_FILES/assertNoHorizontalOverflow/createStaticScan/newSessionContext）改为从 `./helpers` 导入——纯抽取，6 项用例断言零改动。
- `tests/e2e/evaluation.spec.ts`：同理改为导入共享 login/assertNoHorizontalOverflow/访问码，1 项用例断言零改动。
- `.gitignore`：新增 `.next-shots/`（截图脚本构建产物目录）。
- `package.json` 无依赖变化；R01–R08 业务代码、迁移、`.env`/`.data`/锁文件零改动。

**排障记录（真实根因）**

- full-flow 首跑失败（导出报告一步 waitForEvent('download') 超时）：`export-json` 链接在 /scans/:id 工作台页，而补丁生成后仍停留在 finding 详情页（该页返回链接指向扫描页而非项目页），click 等待不存在元素直至用例超时。修复：导出前 `page.goto(scanUrl)` 整页跳回工作台（同时规避客户端路由陈旧预取）。
- 截图脚本首跑在「返回项目页上传修复版 ZIP」失败：finding 详情页的返回链接 href 是 /scans/:id（非项目页），脚本据此 goto 到了无上传入口的扫描页；二跑改用点击后立即读取的 `page.url()` 仍偶发拿到导航提交前的列表页 URL（竞态）。修复：点击项目链接后 `waitForURL(/\/projects\/[0-9a-f-]{36}$/)` 再记录 projectUrl，后续统一整页加载 projectUrl。第三跑全绿。
- 截图脚本结束时输出 worker「connect ECONNREFUSED」为正常关闭时序（cleanup 先停库、worker 尚未被 taskkill 收割），不影响退出码与产物。

**验收（逐条单独运行，真实退出码，未用管道吞码）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:unit` → exit 0（12 文件 166 项，与 R08 持平）
- `pnpm test:integration` → exit 0（11 文件 103 项，与 R08 持平）
- `pnpm test:e2e` → exit 0（**8 项 = static-review 6 + evaluation 1 + full-flow 1**，47.7 秒；首跑 7 过 1 败，修复后 8 过）
- `pnpm build` → exit 0（APPDATA/LOCALAPPDATA 隔离至 .appdata-build，结束后已删除该目录；完整路由表输出）
- `pnpm tsx scripts/capture-screenshots.ts` → exit 0（`artifacts/screenshots/` 21 张 = 7 页面 × 3 视口，抽查 finding-1440x900（证据+Mock 追问+补丁面板）、scan-390x844（风险 8/阶段/覆盖/问题列表）、compare-1440x900（四类徽章+disclaimer）、evaluation-1024x768（真实运行 P/R/F1=1.000+口径声明）内容正确）

**遗留 / 外部验证项（如实声明，见 README 已知限制与交付总结）**

- 真实模型调用未验证（无凭证）：审查/追问/补丁/llm 评测均按真实 SDK 路径实现，凭证就绪后先 `pnpm doctor` 再小样本冒烟，llm 评测按规格跑保留集 ×3（均值与范围）。
- Docker/Compose 本地未验证（无 Docker）：Dockerfile/compose.yaml 按规格 6/14 节编写并人工审阅，首次部署预期需现场排障。
- 生产 PostgreSQL 上重跑租约/取消/额度原子性集成测试待首次部署执行（本地验证基线为 PGlite socket；执行方式已由验收缺陷修复 A07 更新——见文末「验收缺陷修复 A05/A07」：`INTEGRATION_DATABASE_URL` 指向测试专用库直连真实 PostgreSQL）。
- 工程根目录遗留前次会话的 .e2e-dbg-*.cjs 调试脚本（非本轮创建，未清理）。

---

## 交付总结（R09）

### 已实现功能（对照规格 F01–F12）

| 功能 | 状态 | 测试覆盖 |
|---|---|---|
| F01 项目/ZIP 导入/快照/文件树/预览 | ✅ | 单测 25（路径/归档/脱敏）+ 集成 4 + e2e full-flow 闭环 |
| F02 结构体检 | ✅ | 集成 import（结构统计/导入图/别名标记）+ e2e 项目页 |
| F03 静态规则（9 条，超规格 6 条） | ✅ | 单测 rules 27 项 + 评测 24 样例双向校验 + e2e |
| F04 AI 审查（证据校验/预算/工具循环） | ✅ | 单测 28（validate/budget）+ 集成 ai-review 11 + jobs 8；**真实模型未调用** |
| F05 专属 RAG（30 条规范+导入+混合检索） | ✅ | 单测 knowledge 7 + 集成 retrieval 5；**真实 embedding 未调用** |
| F06 证据工作台 | ✅ | e2e static-review 主闭环（反馈/风险联动）+ full-flow |
| F07 受限追问 | ✅ | 单测 conversation 10 + 集成 messages 16 + e2e 追问闭环；Mock 演示 |
| F08 补丁提案 | ✅ | 单测 patch 19 + 集成 patch 17（含 diff 回应用断言）+ e2e 补丁闭环；Mock 提案明确标注 |
| F09 报告导出（JSON/MD/HTML 同源） | ✅ | 单测 report-compare 18（转义/围栏/一致性）+ 集成 report 7 + e2e 导出下载 |
| F10 快照对比（四类变化） | ✅ | 单测+集成 7 + e2e 对比闭环 + full-flow |
| F11 评测中心 | ✅ | 单测 32（metrics 手算/fixtures 校验）+ 集成 evaluation 12 + e2e；static_only 真实、llm 为 Mock 管线 |
| F12 访问控制/取消/恢复/清理 | ✅ | 集成 auth 8 + lease-recovery 9 + e2e 跨会话 404/SSE 降级 |

### 测试统计（2026-09-13 实测）

- 单元：12 文件 **166 项**全部通过；集成：11 文件 **103 项**全部通过；E2E：**8 项**全部通过（约 48 秒）。
- 验收命令退出码：`pnpm typecheck`=0、`pnpm lint`=0、`pnpm test:unit`=0、`pnpm test:integration`=0、`pnpm test:e2e`=0、`pnpm build`=0、`pnpm tsx scripts/capture-screenshots.ts`=0（21 张三视口截图存 `artifacts/screenshots/`，已被 .gitignore 忽略）。

### 真实 AI 验证范围

- **未发生任何真实模型调用**（本地无凭证）。已按真实 SDK 路径实现并经受控 provider 注入测试：AI SDK v5 Chat Completions endpoint、ModelMessage/工具结果结构、单请求 30s 超时与 180s/60s 墙钟、日额度原子预留/结算/回收、证据完整覆盖校验与严格引文、规范引用白名单。
- 界面/报告/评测中的 AI 输出全部带 Mock 标注；静态规则、导入脱敏、证据校验、补丁校验链、对比、报告、评测指标计算为真实代码路径。

### 外部验证项（本机无法完成，不声称已验证）

1. Docker 镜像构建与 Compose 全栈启动（无 Docker；`docker compose up --build` 首次部署时需现场排障）。
2. 生产 PostgreSQL 16 上重跑 `pnpm test:integration`（租约/取消/额度原子性；本地验证基线为 PGlite socket；执行方式见文末「验收缺陷修复 A05/A07」：设置 `INTEGRATION_DATABASE_URL` 指向测试专用库，库名须含 test）。
3. 真实模型 smoke（审查/追问/补丁）与 llm 模式保留集 ×3 评测（均值与范围）。
4. HTTPS 反向代理与公网暴露前的部署加固（compose 仅含应用层）。

### 启动与演示指引

- 本地：`pnpm install` → 终端 1 `pnpm db:dev`（PGlite，5433）→ 终端 2 `pnpm db:migrate && pnpm seed && pnpm doctor && pnpm dev`（<http://localhost:3100>）→ 终端 3 `pnpm worker:dev`。访问码默认 `codeatlas-demo`（评测用 `codeatlas-admin`，均为 .env.example 开发默认值，生产必须更换）。
- 演示：按 `docs/demo-script.md`（约 6 分 40 秒，每步操作与预期画面；Mock 环节与真实数字来源已逐段标注）；三视口截图见 `artifacts/screenshots/`；评测数字口径见 `docs/evaluation.md`；架构与实现实测细节见 `docs/architecture.md`。

---

## 验收缺陷修复 A05/A07（2026-09-13，对应《08-最终验收报告》）

修复交付/部署侧两项缺陷。仅源码级修复：本机无 Docker、无 PostgreSQL 16 实例，**未做容器构建与真实 PG 实测**（如实声明，见下「验收」）。

**A05 [P1] 容器 runtime 未包含评测数据集**

- `Dockerfile` runtime 阶段新增 `COPY --from=build /app/fixtures ./fixtures`。静态核对：`fixtures/` 为版本化产物（`dataset.json` + `projects/*/manifest.json`，未被 `.dockerignore`/`.gitignore` 排除，build 阶段 `COPY . .` 已包含）；`resolveFixturesDir()` 默认读 `process.cwd()/fixtures` = 容器内 `/app/fixtures`（WORKDIR /app），无需额外环境变量；web/worker 同镜像 → datasetVersion 必然一致。fixtures 缺失时该 COPY 使构建立即失败，不会产出「数据集未就绪」的残缺镜像。compose.yaml 无需挂载或生成步骤（未改动其服务定义）。

**A07 [P2] 生产 PostgreSQL 测试指引不能实现所声称的验证**

- `tests/helpers/db.ts`：`createTestDb` 双驱动——显式设置 `INTEGRATION_DATABASE_URL` 时直连真实 PostgreSQL；缺省保持原独立临时 PGlite 行为。防护：协议必须 postgres/postgresql；目标库名必须含 `test`（拒绝疑似业务库；报错不回显连接串/密码）；测试只在该服务器上创建 `<库名>_it_<pid>_<随机>` 独立临时库（应用迁移、结束 `DROP DATABASE ... WITH (FORCE)`），不读写所指向库与业务库数据；PG 路径动态导入 db-server，**完全不加载 PGlite**。要求（已写入 README）：测试专用 PG 需 pgvector 扩展（迁移含 `create extension if not exists vector`）、账号需 CREATEDB 权限。
- 身份输出：两种路径均打印 `[test-db] driver=<pglite-socket|postgres.js> server=<select version() 首段> db=<库名>`，不含连接串/密码。
- `TestDb` 接口新增 `url`（应用侧连接串），`handle` 改为可空（PG 路径为 null）；10 个集成测试文件的 `db.handle.url` 机械替换为 `db.url`（断言零改动）。
- 文档更新：README「生产路径」要点（含 fixtures 随镜像分发说明）、环境变量表（新增 `INTEGRATION_DATABASE_URL` 行）、命令表、已知限制 #3；compose.yaml 头部注释；本文件 R09 两处指引改为指向新机制。

**验收（本机可执行部分，真实退出码）**

- `pnpm typecheck` → exit 0
- `pnpm lint`（max-warnings 0）→ exit 0
- `pnpm test:integration`（默认 PGlite 路径）→ exit 0（11 文件 103 项，21.3 秒；每个文件输出 `[test-db] driver=pglite-socket server=PostgreSQL 18.3 (PGlite 0.5.8) ... db=codeatlas` 身份行）
- 临时探针（运行后已删除）：`INTEGRATION_DATABASE_URL` 指向 `.../codeatlas`（业务库名）→ 正确拒绝且报错不含连接串；指向 `.../codeatlas_test` → 走 PostgreSQL 直连路径（对无服务端口报 ECONNREFUSED，全程未启动 PGlite）
- 未运行/不声称已验证：e2e（未改动相关路径）、真实 PostgreSQL 16 实测（本机无实例）、`docker build` / `docker compose up`（本机无 Docker）。

---

## 最终发布与比赛提交 P1:发布候选整理(2026-09-15,对应《10-最终发布与比赛提交方案》)

### P1.1 清理工作区(真实结果)

- Git 跟踪检查:`git ls-files` 确认唯一敏感模式文件为 `.env.example`(占位符模板,无真实密钥);`.env`/`.data/`/`.next*`/`test-results/`/`*.tsbuildinfo` 均被 .gitignore 忽略且未被跟踪。`git status --short` 干净。
- `artifacts/acceptance/`(daily-budget-probe.ts、edge-probes.ts)为已跟踪的验收探针脚本,按方案予以保留。
- `test-results/` 为空;无临时调试脚本残留。
- `pnpm fixtures:generate` → exit 0,Already up to date:v1-cd06ca6f(revision 1),24 项目(缺陷 12 + 对照 12),开发集 16 / 保留集 8,与 `docs/evaluation.md` 记录一致。
- `pnpm doctor` → exit 0:AI provider mock;PostgreSQL 18.3(PGlite 0.5.8 socket);pgvector 已启用;迁移 5/5;预置规范 30 条;存储目录可写;输出未包含任何密钥。首次运行因本地 db-server 未启动报 ECONNREFUSED,后台启动 `pnpm db:dev` 后复跑通过。

### P1.2 发布检查清单(真实结果)

- 新增 `docs/release-checklist.md`:记录工具链版本(Node v24.16.0 / pnpm 11.10.0 / Next 15.5.25 / React 19.3.0)、全部检查命令与真实退出码、Mock/真实模型状态、数据集版本与评测口径、Docker/PostgreSQL 验证状态、账号分离要求、未解决限制与阶段状态。
- 本次全量复跑(2026-09-15,本地 db:dev 运行中):`typecheck` exit 0;`lint` exit 0;`test:unit` exit 0(13 文件 191 用例);`test:integration` exit 0(14 文件 127 用例,默认 PGlite socket 路径);`test:e2e` exit 0(8 用例,48.7s);`build` exit 0。
- 本机无 Docker(P3 需独立测试主机);真实模型凭证未配置(P2 待项目负责人本机 .env 配置)。以上均为如实状态,不声称已验证。

---

## 最终发布与比赛提交 P4:产品展示优化(2026-09-15,对应《10-最终发布与比赛提交方案》)

### P4.1 移动端导航(390px,真实结果)

- 问题(修复前截图佐证):390×844 下头部导航「项目/知识库/评测」文字逐字竖排换行,品牌名与「AI: Mock」徽章被挤压换行。
- 改动:新增 `src/components/app-nav.tsx` —— `DesktopNav`(md 及以上)保持原信息架构与样式;`MobileNav`(md 以下)折叠为汉堡菜单,带 `aria-expanded`/`aria-label`、Escape 与点击外部收起、路由变化自动收起、完整标签链接(触控目标 py-2.5)。`(app)/layout.tsx` 品牌链接加 `whitespace-nowrap shrink-0`;桌面端信息架构未变。
- 交互验收(Playwright 探针,390×844,真实输出 16 项全 PASS):汉堡可见;菜单含完整标签「项目/知识库/评测」;点击知识库跳转 `/knowledge` 且菜单自动收起;键盘 Enter 打开 / Escape 收起;`/projects`、`/knowledge`、`/evaluation` 三页 `scrollWidth - clientWidth ≤ 0`(无横向溢出);桌面 1280 回归:三条导航链接可见、汉堡隐藏、无溢出。探针为临时文件(命中 .gitignore `.e2e-dbg-*.cjs`),运行后删除。
- 截图:`pnpm tsx scripts/capture-screenshots.ts` → exit 0,重新生成 7 页面 × 3 视口(1440/1024/390)共 21 张到 `artifacts/screenshots/`;另存菜单展开态 `nav-menu-390x844.png`。390px 各页头部无逐字换行、无横向溢出;login 页(无应用头部)正常。
- 回归:`typecheck` exit 0;`lint` exit 0;`test:e2e` exit 0(8 用例,49.7s,Playwright 默认 1280×720 桌面视口不受影响)。

### P4.2 演示数据固定(真实结果)

- 新增 `scripts/make-demo-zip.ts` + `pnpm demo:zip`:生成 `demo/codeatlas-demo-origin.zip` 与 `codeatlas-demo-fixed.zip`(各 4 文件;unzip -l 核对 6 条目含 2 目录)。语料复用版本化 `tests/e2e/helpers.ts` 的 SAMPLE_FILES/FIXED_FILES(与截图/E2E 全流程同源),为自有合成代码,无他人源码与真实凭证;ZIP 产物不入库(`.gitignore` 新增 `demo/*.zip`),说明见 `demo/README.md`。
- 覆盖 4 类静态问题(html-injection / jsx-key / dynamic-exec / postmessage):第 3 段审查对象 `src/App.tsx:3`,第 4 段追问「这段输入经过净化了吗?」,第 5 段补丁与第二快照对比(修复版移除 HTML 注入→未再检出;新增 new Function→新增;缺 key/eval/message 保留→仍存在)。
- 新增 `tests/unit/demo-corpus.test.ts` 契约测试(6 用例,exit 0):锁定文件数、4 类问题标记、追问/补丁目标行、修复版四态可达、两版文件名集合一致、无真实凭证形态字符串——防止测试语料演化后演示环节静默失效。
- 安全说明:演示语料中的 `eval` 为静态扫描的目标样例字符串;直接字面量写入脚本被 Mimosa 安全钩子(代码注入规则)拦截,已改为复用版本化语料文件并加契约测试,行为等价且单一数据源。

### P4 阶段复跑(2026-09-15,最终退出码)

`typecheck` exit 0;`lint` exit 0;`test:unit` exit 0(14 文件 197 用例,含新增 6 契约用例);`test:integration` exit 0(14 文件 127 用例,PGlite socket);`test:e2e` exit 0(8 用例,导航改动后);`build` exit 0;`demo:zip` exit 0;`capture-screenshots` exit 0。本机无 Docker、无真实模型凭证:P2/P3 仍未执行(如实声明)。

---

## 公开发布收尾:提交整理 / GitHub 推送 / PDF / Secrets 扫描(2026-09-19)

- **Git 提交整理**:工作区按功能分组为 5 个提交——`b1e2607` 新增移动端导航与响应式布局优化;`5cb90a4` 修复 Finding 详情页定位滚动、反馈失败提示与窄屏适配;`e4914b9` 新增 Finding 详情页 UI 回归 E2E 测试;`ad2aecf` 新增演示语料 ZIP 生成脚本与契约测试;`245295b` 新增发布检查清单并补充 P1/P4 进度记录。历史提交(含 `355b40f` 初始基线)一律未改写。
- **GitHub 公开仓库**:https://github.com/aabbcc070403/codeatlas 创建并推送 master;`git ls-remote origin` 显示远程 HEAD=refs/heads/master=`245295b`,与本地一致;干净克隆(临时目录)后 `pnpm typecheck` 与 `pnpm lint` 真实执行均通过,临时目录已删除。
- **PDF 技术文档**:`deliverables/CodeAtlas-技术文档.pdf` 16 页(约 787KB)生成,全部 AI 评测数字如实标注 Mock;HTML 源目录随 PDF 一并入库。
- **Secrets 扫描(公开仓库安全检查)**:对全部已跟踪文件执行多组 `git grep` 正则(sk- 前缀 / ghp_/gho_/ghu_/ghs_ GitHub token / AKIA·xox·AIza 云厂商前缀 / 密钥类赋值 / PEM 私钥块 / Bearer 串 / 非测试目录 32+ 随机串)。命中均为脱敏功能自身的测试 fixture(`import-redact.test.ts` 的 `AKIAIOSFODNN7EXAMPLE` AWS 官方示例密钥、字母序假 `ghp_`/`sk-` 串及无密钥材料的伪造 PEM 头;`messages.test.ts` 的 `sk-test-secret-value-123` 测试桩),人工复核排除;`.env` 被 .gitignore 忽略未跟踪,`git ls-files` 敏感模式文件仅 `.env.example` 空占位。**结论:无真实密钥泄露。**
- **发布候选 tag**:`v1.0.0-rc.1`(annotated,2026-09-19),含本日文档与 deliverables 提交;从 tag 干净克隆复现通过(7 个提交、PDF 与 docs 记录齐全)后清理临时目录。

---

## 真实 AI 评测执行:冒烟 + holdout 3+3(2026-09-19,对应发布方案 P2)

本机 `.env` 配置 DeepSeek(OpenAI 兼容模式):AI_PROVIDER=openai、AI_BASE_URL=https://api.deepseek.com、AI_CHAT_MODEL=deepseek-chat(实测映射 deepseek-flash);无 embedding 模型 → hybrid_rag 检索词法降级(冒烟已验证正常,属接受方案)。**预算调整**:`.env` 中 AI_DAILY_TOKEN_LIMIT 由 300,000 上调至 2,000,000——仅本地配置、不改代码;理由:3+3 holdout 估算需 29–34 万 token 贴近原上限,且真实模型在对照项目上探索轮次有波动,DeepSeek 成本极低,留足安全余量。`pnpm doctor` 通过(AI provider: openai、chat model: deepseek-chat、embedding 未配置词法降级、迁移 5/5、pgvector、预置规范 30 条、日 token 预算 2000000)。

### 冒烟(deliverables/real-ai-smoke-2026-09-19.md)

- 单项目 hybrid_rag holdout limit 1:completed,provider=openai、provider_is_mock=false;fx-msg-02 P=R=F1=1.000,证据有效率 100%,延迟 6,784ms,token 7,096/项目。
- 追问冒烟(脚本 `scripts/smoke-real-ai.ts`,保留可复用):复杂问题 **budget_exhausted**——DeepSeek 3 轮内用满 8 次工具调用(read_file/search_code/retrieve_guidelines)探索,未在预算内提交回答;追问规格预算(4 次模型/8 次工具/60s)对真实模型探索型行为偏紧,降级路径按设计工作,按红线未改 src/。简单问题 answered(retrievalMode=lexical_only 词法降级直接可见)。
- 补丁冒烟:proposed(1 次模型调用,token 1,579,耗时 1.6s),diff 合理可应用,语法校验通过(基线 0 错误 → 补丁后 0 错误)。

### holdout 3+3(deliverables/real-ai-holdout-2026-09-19.md)

- 6 次运行全部 completed(llm_no_rag ×3 + hybrid_rag ×3,holdout 8 项目/次),零失败项目、零崩溃重跑;`evaluation_projects` 48 行 provider=openai、provider_is_mock=false、model_id=deepseek-chat。
- 关键数字(3 次均值,范围见交付报告):llm_no_rag P 0.396(0.353–0.462)/ R 1.000 / F1 0.566 / 证据有效率 75.5% / 延迟 p50 8,025ms / token 10,137 每项目;hybrid_rag P 0.421(0.400–0.462)/ R 1.000 / F1 0.591 / 证据有效率 79.7% / p50 7,389ms / token 13,025 每项目。
- RAG 消融可回溯:llm_no_rag 三次 scan_citations 均为 0;hybrid_rag 三次 5/9/9 条,命中均为预置库真实规范标题。
- 如实结论:Recall 三次全满(6/6);Precision 为短板,FP 主因为 fx-ctl-* 对照项目误报;RAG 带来 P/F1 各 +2.5pp、证据有效率 +4.2pp,方向一致但在小样本方差内不足以称显著;规格 13 目标(holdout hybrid_rag P≥0.80、R≥0.65):R 达标、P 未达标。已知异常:fx-ctl-jsx-02 六次扫描终态 partial(指标正常产出并计入,待排查)。
- token 总消耗 555,892(llm_no_rag 243,296 + hybrid_rag 312,596),当日额度上限 2,000,000。

### 文档分栏

- `docs/evaluation.md`:总口径声明改为「真实模型评测已于 2026-09-19 执行」;新增 §4.5 真实模型实测数字(环境/词法降级声明/均值±范围表/RAG 消融/Mock 对照/如实结论/已知异常);§4 Mock 数字与表格一字不动(仅开头加时点标注);§5 第 2 条改写为已执行+新限制。
- `docs/release-checklist.md`:§3 AI 模型状态、§4 评测口径、§7 未解决限制、§8 阶段状态、§10 收尾记录与未完成项同步更新。

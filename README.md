# CodeAtlas 码鉴

**证据驱动的 AI 项目体检**：上传 ZIP 代码包，运行确定性静态规则与受预算约束的 AI 审查，每条问题都带可核验的路径 / 行号 / 引文证据，支持追问、单文件补丁提案、报告导出与快照对比。面向完成课程设计、竞赛项目或首个 Web 产品的学生与小团队。

> 产品不宣称「证明代码安全」「发现全部 Bug」或「自动修复成功」。静态命中、AI 推断、语法检查与真实测试结果始终使用不同标签展示。

## 功能总览（对应规格 F01–F12）

| 功能 | 说明 |
|---|---|
| F01 项目与导入 | 项目创建、ZIP 导入（路径穿越/炸弹/符号链接防护）、快照历史、文件树、只读代码预览 |
| F02 结构体检 | 文件统计、语言分布、依赖声明概览、忽略明细、相对导入关系 |
| F03 静态规则 | 9 条确定性 AST 规则（动态执行 / HTML 注入 / postMessage 源 / JSX key / 条件 Hook / 检查禁用等），候选问题标 needs_review |
| F04 AI 审查 | 风险优先抽样 + 受限工具循环，输出带路径 / 行号 / 引文的结构化结果，全部经证据校验 |
| F05 专属 RAG | 30 条预置版本化规范 + 项目自有 Markdown 导入，pgvector + 字法双路 RRF 融合检索 |
| F06 证据工作台 | 筛选、代码行定位、来源、触发条件、影响、修复建议、确认 / 误报反馈 |
| F07 受限追问 | 围绕当前问题与快照的追问（4 次模型 / 8 次工具 / 60 秒），无终端、联网、写文件工具 |
| F08 补丁提案 | 单问题单文件 diff，校验旧文本 / 哈希 / 脱敏区间 / 语法不退化，下载 `.patch`，不写入原件 |
| F09 报告导出 | JSON / Markdown / 可打印 HTML（浏览器打印另存 PDF），三格式与界面同源 |
| F10 快照对比 | 新增 / 仍存在 / 未再检出 / 不可比较四类变化，「未再检出 ≠ 已验证修复」 |
| F11 评测中心 | 24 样例 / 6 类问题 / 16-8 划分数据集，static_only / llm_no_rag / hybrid_rag 三模式指标 |
| F12 演示保障 | 访问码（demo/admin 两级）、会话隔离、任务取消、租约恢复、TTL 过期清理、日 token 预算 |

技术栈：Next.js 15（App Router）+ React 19 + TypeScript strict + Tailwind CSS + Drizzle ORM + PostgreSQL 16 协议（本地 PGlite / 生产 PostgreSQL + pgvector）+ 独立 Node worker + AI SDK（OpenAI 兼容接口）。数据库作业通过 `FOR UPDATE SKIP LOCKED` 租约领取，不引入 Redis。

## 快速开始（本地：PGlite，无需 Docker）

本地数据库为嵌入式 PostgreSQL（PGlite 0.5.8 + pgvector 扩展），通过自实现的 Postgres 线协议 socket 服务（`scripts/db-server.ts`）暴露，web / worker / 脚本统一用 `DATABASE_URL` 访问，与生产 PostgreSQL 同构。

```bash
pnpm install

# 终端 1：本地数据库（PGlite socket，默认端口 5433）
pnpm db:dev

# 终端 2（数据库就绪后）：迁移 + 预置 30 条规范 + 自检
pnpm db:migrate
pnpm seed
pnpm doctor

# 终端 2：Web 应用（http://localhost:3100）
pnpm dev

# 终端 3：worker（扫描 / 索引 / 评测后台任务）
pnpm worker:dev
```

- 打开 <http://localhost:3100>，输入演示访问码进入工作台。
- 默认访问码（与 `.env.example` 一致，**仅供本地演示**）：`DEMO_ACCESS_CODE=codeatlas-demo`、`ADMIN_ACCESS_CODE=codeatlas-admin`（admin 才能触发评测）。生产部署必须改掉。
- 本地 AI 默认 `AI_PROVIDER=mock`：界面所有 AI 输出（审查结论 / 追问回答 / 补丁提案）都带「Mock（非真实模型）」标注，不冒充真实模型。
- 评测需要先生成数据集：`pnpm fixtures:generate`（产物在 `fixtures/`）。

## 生产路径（PostgreSQL + Docker Compose）

`compose.yaml` 提供 db（`pgvector/pgvector:pg16`）+ web + worker 三个服务与一次性迁移 / seed 流程，`Dockerfile` 为多阶段构建、非 root 运行、不挂载 Docker socket。

```bash
cp .env.example .env      # 必须修改：SESSION_SECRET、两个访问码、DATABASE_URL 密码
docker compose up --build # 本机未验证，见下方「已知限制」
```

要点（详见 `compose.yaml` 注释）：

- `db` 健康检查通过后，`migrate` 服务一次性执行迁移与 seed，随后 `web` / `worker` 启动。
- `web` 与 `worker` 使用同一镜像、不同 command；共享 `storage` 持久卷存放快照与上传文件。
- 评测数据集（`fixtures/`，版本化产物）随镜像分发：`Dockerfile` 在 runtime 阶段 COPY fixtures，web / worker 同镜像即同一 datasetVersion，不依赖宿主机目录，也无需部署时生成；fixtures 缺失会使构建直接失败而非产出「数据集未就绪」的镜像。
- 生产强制从环境变量注入 `SESSION_SECRET` 与访问码；**禁止使用默认访问码**——将 `.env.example` 的默认值原样带入生产等于把演示账号公开。
- web 公网暴露前应放置 HTTPS 反向代理（cookie 在生产 `NODE_ENV=production` 下开启 Secure）。
- 生产 PostgreSQL 验证（首次部署项）：向一台**测试专用** PostgreSQL（pgvector 扩展可用、账号有 CREATEDB 权限）设置 `INTEGRATION_DATABASE_URL=postgres://user:pass@host:5432/codeatlas_test`（**库名必须含 `test`**，防误指业务库），然后运行 `pnpm test:integration`。测试会在该服务器上为每个测试文件创建独立临时库 `<库名>_it_<pid>_<随机>`（应用迁移、结束即删除），全程不读写所指向库与业务库的数据，且该路径不启动 PGlite；输出会打印实际服务器版本与驱动（不打印连接串/密码）。不设置该变量时保持默认：独立临时 PGlite。

## 环境变量

全部变量均可在 `.env` 中配置（worker 与脚本手动加载，Next 自动加载；已有进程环境值优先）。此处只记录**名称、用途与示例值**，不存放任何真实秘密。

| 变量 | 用途 | 默认 / 示例 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串。本地指向 PGlite socket 服务，生产指向 compose 的 db | `postgres://codeatlas:local@127.0.0.1:5433/codeatlas` |
| `INTEGRATION_DATABASE_URL` | 集成测试直连真实 PostgreSQL 的连接串（**库名须含 `test`**，账号需 CREATEDB 权限、服务器需 pgvector；测试在该服务器上逐文件建/删独立临时库，不读写所指库数据）。留空则用独立临时 PGlite | 留空（示例 `postgres://user:pass@host:5432/codeatlas_test`） |
| `STORAGE_ROOT` | 快照与上传文件的持久化根目录（相对项目根或绝对路径） | `.data/storage` |
| `DB_DATA_DIR` | PGlite 数据目录（仅 `pnpm db:dev` 使用） | `.data/pglite` |
| `DB_PORT` | PGlite socket 服务端口（仅 `pnpm db:dev` 使用） | `5433` |
| `SESSION_SECRET` | 会话签名密钥。生产必须更换 | `dev-secret-change-me`（开发默认） |
| `DEMO_ACCESS_CODE` | 演示角色访问码（不能触发评测） | `codeatlas-demo`（开发默认，生产必须更换） |
| `ADMIN_ACCESS_CODE` | 管理员访问码（可运行评测） | `codeatlas-admin`（开发默认，生产必须更换） |
| `AI_PROVIDER` | 模型供应商：`mock`（本地演示）或 `openai`（OpenAI 兼容 Chat Completions） | `mock` |
| `AI_BASE_URL` | OpenAI 兼容接口地址（`AI_PROVIDER=openai` 时必填） | 留空 |
| `AI_API_KEY` | 模型密钥（`AI_PROVIDER=openai` 时必填；不写入日志与消息） | 留空 |
| `AI_CHAT_MODEL` | 审查 / 追问 / 补丁用的对话模型名 | 留空 |
| `AI_EMBEDDING_MODEL` | 规范向量化的嵌入模型名（缺省时检索降级为词法并标注 lexical_only） | 留空 |
| `EMBEDDING_DIM` | 嵌入维度（须与模型实际输出一致，默认 1536；换模型 / 维度需重建索引版本） | `1536` |
| `AI_DAILY_TOKEN_LIMIT` | 全局日 token 预算（调用前原子预留，达到上限降级静态扫描） | `300000` |
| `DATA_TTL_HOURS` | 会话与项目数据过期小时数（worker 每小时清理；预置样例不受影响） | `24` |
| `APP_ORIGIN` | 应用对外 Origin（写请求 Origin 校验；生产应显式设置） | 留空（开发按 Host 推断） |
| `EVAL_FIXTURES_DIR` | 评测数据集目录覆盖（测试 / e2e 注入；默认项目根 `fixtures/`） | 留空 |
| `EVAL_PROJECT_LIMIT` | 单次评测项目数上限（e2e / 集成小子集口径；正式评测不设限） | 留空 |

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm typecheck` | TypeScript strict 全量检查（`tsc --noEmit`） |
| `pnpm lint` | ESLint（`src scripts tests`，max-warnings 0） |
| `pnpm test:unit` | 单元测试（Vitest，`tests/unit`） |
| `pnpm test:integration` | 集成测试（默认独立临时 PGlite 实例，不触碰开发 `.data`；设置 `INTEGRATION_DATABASE_URL` 后直连真实 PostgreSQL，见「生产路径」） |
| `pnpm test:e2e` | Playwright 端到端（8 项；`scripts/e2e-server.ts` 自动起隔离数据库 / 存储 / 生产构建 / worker，AI_PROVIDER=mock，与开发端口隔离） |
| `pnpm build` | Next 生产构建 |
| `pnpm fixtures:generate` | 生成 24 个评测样例到 `fixtures/`（幂等、内容哈希版本化） |
| `pnpm eval -- --mode static_only --split dev` | 评测 CLI（`--mode static_only\|llm_no_rag\|hybrid_rag`，`--split dev\|holdout\|all`） |
| `pnpm db:dev` / `db:migrate` / `seed` / `doctor` | 本地数据库 / 迁移 / 预置规范 / 启动自检（不输出密钥） |
| `pnpm dev` / `worker:dev` / `worker` | 开发 Web（3100）/ 开发 worker / 生产式 worker |
| `pnpm tsx scripts/capture-screenshots.ts` | 三个视口自动截图到 `artifacts/screenshots/`（隔离环境，AI_PROVIDER=mock） |

## 仓库内验收辅助文件

`artifacts/acceptance/` 下的两个脚本（`edge-probes.ts`、`daily-budget-probe.ts`）是验收报告的缺陷复现探针，已断言式化：行为符合预期时 exit 0，否则打印差异并以非零退出。它们不属于应用源码，保留用于复现验收结论与回归验证：

```powershell
pnpm exec tsx artifacts/acceptance/edge-probes.ts
pnpm exec tsx artifacts/acceptance/daily-budget-probe.ts
```

`artifacts/screenshots/`（页面截图产物）与本地运行时目录（`.data/`、`.mimosa/`）不入库；临时 e2e 调试脚本（`.e2e-dbg-*.cjs`、`.e2e-debug.cjs`）已移出仓库且被 `.gitignore` 防回退。

## 安全边界

- **不执行上传内容**：不运行 npm install、构建 / 测试脚本、仓库自带 ESLint 配置或 Git hooks；TypeScript 分析用自有内存程序；worker 无 shell 工具。
- **导入防护**：拒绝路径穿越 / 绝对路径 / 盘符 / 符号链接 / 保留设备名 / 大小写冲突；按流式实际解压字节限额（压缩 20MiB、解压 80MiB、2000 条目、单文件 512KiB）；`.env`、私钥等敏感文件拒绝收录。
- **脱敏**：疑似密钥在持久化、向量化、云端发送前等长遮盖（保持行号与字符位置）；命中脱敏区间的补丁禁止导出。
- **证据校验**：AI 引文必须来自当前脱敏快照真实行段（统一 LF 后严格匹配 + 完整读取覆盖检查），规范引用只能来自本轮实际检索返回的 chunk；无效证据单列计数，不静默丢弃。
- **预算与限流**：单扫描 12 次模型 / 30 次工具 / 6 万输入 + 8 千输出 token / 180 秒；追问 4 次 / 8 次 / 60 秒；补丁 2 次 / 60 秒；全局日额度原子预留；访问码失败限流（每 IP 每 10 分钟 10 次）。
- **会话隔离**：HttpOnly + SameSite=Lax cookie（生产 Secure），服务端仅存 token 哈希；跨会话对象一律 404；每会话最多一个活动扫描。
- **可控 AI**：用户主动选择云端 AI 才发送代码片段；工具仅 read_file / search_code / list_imports / retrieve_guidelines 四件；界面如实区分 static / ai 来源与 Mock / 真实模型标签。

## 已知限制（诚实清单）

以下为本仓库**当前真实验证状态**，不虚构：

1. **真实模型调用未验证**：本机无模型凭证，全部验证基于 `AI_PROVIDER=mock` 与受控 provider 注入测试。真实 provider 代码路径（AI SDK v5、Chat Completions endpoint、ModelMessage 类型、30s 超时 / 180s 墙钟 / 日额度原子预留 / 证据校验）已按真实 SDK 实现，但**未发生过一次真实网络调用**。启用真实模型后应先跑 `pnpm doctor` 自检，再以小样本冒烟。
2. **Docker / Compose 本地未验证**：开发机无 Docker。`Dockerfile` 与 `compose.yaml` 按规格第 6/14 节编写并通过人工审阅，但**未执行过 `docker build` / `docker compose up`**；首次部署时预期需要现场排障。
3. **生产 PostgreSQL 路径已实现直连测试机制，但本机未实测**：设置 `INTEGRATION_DATABASE_URL`（指向测试专用库，名称须含 `test`；账号需 CREATEDB 权限）后，`pnpm test:integration` 在真实 PostgreSQL 上运行——逐测试文件创建/删除独立临时库、不启动 PGlite、输出服务器版本与驱动（不打印连接串）。本机无 PostgreSQL 16 实例，该路径未实际执行过，属首次部署验证项；本地验证基线仍为 PGlite socket（PGlite 不承载生产并发语义）。
4. **评测为 24 样例小样本口径**：`fixtures/` 24 个项目（12 缺陷 + 12 对照，6 类问题，16/8 划分，版本 `v1-cd06ca6f`）。当前指标（static_only P/R/F1 = 1.000）只说明「管线 + 规则在该样例集上符合设计预期」，**不能推广为真实项目准确率**。
5. **llm 模式评测为 Mock 管线**：llm_no_rag / hybrid_rag 模式的评测数字由确定性 Mock provider 产生（结果中逐项标注 provider=mock），不冒充真实模型指标；规格要求的真实模型保留集重复 3 次（均值与范围）未执行。
6. 演示脚本（`docs/demo-script.md`）中的 AI 环节均为 Mock 演示；数字类演示来自真实静态评测记录（`docs/evaluation.md`）。

## 文档导航

- `docs/architecture.md` — 模块图、数据流、安全边界、关键合同、目录导览
- `docs/evaluation.md` — 数据集构成、三模式配置、指标定义、R08 实测数字与限制
- `docs/demo-script.md` — 5–8 分钟演示脚本（每步操作路径与预期画面，标注 Mock 环节）
- `docs/progress.md` — T01–T08 与续作 R01–R09 全部执行记录（命令、退出码、实测结果）

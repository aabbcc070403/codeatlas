# CodeAtlas 发布检查清单

维护规则:每次发布候选状态变化时更新本文件。所有数字必须来自真实运行的命令输出,禁止填写未执行项的"预期值"。

- 记录日期:2026-09-15
- 当前 commit:`355b40f`(初始提交,2026-09-13 22:17 +0800),工作区干净
- 记录人:ZCode 会话(按《10-最终发布与比赛提交方案》P1 阶段执行)

## 1. 工具链版本

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| Node | v24.16.0 | `node -v` |
| pnpm | 11.10.0 | `pnpm -v` |
| Next | 15.5.25 | `node -e require('next/package.json').version`(安装版本) |
| React | 19.3.0 | 安装版本 |
| TypeScript | ^5.9.3 | package.json |
| Vitest | ^3.2.7 | package.json |
| Drizzle ORM | ^0.45.2 | package.json |
| PostgreSQL(本地) | PostgreSQL 18.3(PGlite 0.5.8 socket) | `pnpm doctor` 输出 |
| Docker | **本机未安装** | `docker --version` 失败 |

## 2. 检查命令与真实退出码(2026-09-15 本机)

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm fixtures:generate` | 0 | Already up to date;v1-cd06ca6f,24 项目(缺陷 12 + 对照 12),开发集 16 / 保留集 8 |
| `pnpm doctor` | 0 | AI provider: mock;pgvector 已启用;迁移 5/5;预置规范 30 条;存储可写;**未打印任何密钥** |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm lint`(--max-warnings 0) | 0 | 通过 |
| `pnpm test:unit` | 0 | 13 文件 / 191 用例全部通过 |
| `pnpm test:integration` | 0 | 14 文件 / 127 用例全部通过;默认 PGlite socket 路径 |
| `pnpm test:e2e` | 0 | 8 用例通过(48.7s) |
| `pnpm build` | 0 | next build 成功 |

前置条件:本地 `pnpm db:dev`(PGlite,127.0.0.1:5433)处于运行状态;单元/集成/E2E 均为本地路径,未在生产数据库上运行。

## 3. AI 模型状态

- 当前 provider:**openai 兼容(DeepSeek)**,模型 `deepseek-chat`(实测映射 deepseek-flash)——2026-09-19 起本机 `.env` 配置真实凭证。`pnpm doctor` 实测输出(2026-09-19):`AI provider: openai`、`chat model: deepseek-chat`、embedding 未配置(检索词法降级)、日 token 预算 2000000。
- 真实模型评测:**已执行**(2026-09-19,冒烟 + holdout 3+3,数字与口径见 `docs/evaluation.md` §4.5 与 `deliverables/real-ai-holdout-2026-09-19.md`;遗留限制见 §10)。
- 界面、报告、评测中的 AI 输出带 provider 标注(真实 openai / Mock);不存在把 Mock 结果描述为真实模型结果的表述。

## 4. 数据集与评测口径

- datasetVersion:**`v1-cd06ca6f`**(revision 1,内容哈希 cd06ca6f…,`fixtures/dataset.json` 与 `docs/evaluation.md` 一致,已由 `pnpm fixtures:generate` 复核无漂移)。
- ruleVersion:`static-rules-v1`。
- 划分:开发集 16 / 保留集 8。
- 评测口径:Mock 模式历史数字标注于 `docs/evaluation.md` §4(2026-09-13);真实模型(DeepSeek)holdout 3+3 数字见同文件 §4.5(2026-09-19),两套分栏并存、互不覆盖,不得引用 Mock 数字冒充真实效果。

## 5. Docker / PostgreSQL 验证状态

- Docker 镜像构建与 Compose 全栈启动:**未验证**(本机无 Docker;按方案 P3 需在安装 Docker 的独立测试主机执行,执行步骤见方案 P3.1)。
- 生产 PostgreSQL 集成测试:**未验证**。机制已就绪(A07):设置 `INTEGRATION_DATABASE_URL` 指向库名含 `test` 的专用库即可走 postgres.js 直连路径;本机当前基线为 PGlite socket。
- 部署安全检查(P3.3):未执行(依赖 P3 部署环境)。

## 6. 账号与凭证分离

- 演示访问码:本机为 `.env.example` 开发默认值(`codeatlas-demo` / `codeatlas-admin`),**仅限本地开发与演示**。
- 部署账号:尚未部署,不适用。部署时必须更换 `POSTGRES_PASSWORD`、`SESSION_SECRET`、`DEMO_ACCESS_CODE`、`ADMIN_ACCESS_CODE`(P3.1),并确认演示账号与部署/管理账号分离。
- 密钥管理:所有真实密钥仅存于本机 `.env`(被 .gitignore 忽略,未被 Git 跟踪);聊天与文档中不粘贴密钥。

## 7. 未解决限制(诚实清单)

1. 真实 AI 评测遗留(2026-09-19 执行后):embedding 未配置,hybrid_rag 向量检索路降级为纯词法(DeepSeek 无 embedding API);追问预算对真实模型偏紧(复杂问题 budget_exhausted);fx-ctl-jsx-02 六次扫描终态 partial 待排查。
2. Docker/Compose 全栈与生产 PostgreSQL 16 实测未执行(P3,需测试主机)。
3. HTTPS 反向代理与部署加固未执行(P3.3)。
4. 技术 PDF、演示视频、公开仓库(P5)未开始。
5. fixtures 仅覆盖自有脱敏样例,不代表任意代码库上的表现。

## 8. 阶段状态速览

| 阶段 | 状态 |
| --- | --- |
| P1 发布候选整理 | ✅ 本文件 + 工作区清理完成 |
| P2 真实 AI 小样本验证 | ✅ 冒烟 + holdout 3+3 + 文档分栏完成(2026-09-19;词法检索降级口径,遗留见 §7.1) |
| P3 Docker/PostgreSQL 外部验收 | ⏸ 等待测试主机 |
| P4 产品展示优化 | ✅ P4.1 移动端导航 + P4.2 演示数据固定完成(2026-09-15) |
| P5 比赛材料 | ⏸ 未开始 |
| P6 最终签收 | ⏸ 依赖 P2–P5 |

## 9. P4 记录(2026-09-15)

- **P4.1 移动端导航**:新增 `src/components/app-nav.tsx`(DesktopNav 保持原桌面信息架构;MobileNav 为 md 以下视口的折叠菜单,含 aria-expanded/aria-label、Escape 与点击外部收起、路由变化自动收起);品牌与 AI 状态标签保留并加 `whitespace-nowrap`。
- 交互验收探针(Playwright,390×844):16 项全部 PASS——汉堡可见、菜单含完整标签「项目/知识库/评测」、跳转后自动收起、键盘 Enter 打开/Escape 收起、三页无横向溢出;桌面 1280 原导航可见、汉堡隐藏、无溢出。
- 截图已重新生成(login/project/projects/scan/finding/compare/evaluation × 1440/1024/390,共 21 张 + 菜单展开存档 `nav-menu-390x844.png`),390px 无逐字换行。
- **P4.2 演示数据固定**:`pnpm demo:zip` 生成 `demo/codeatlas-demo-origin.zip` 与 `codeatlas-demo-fixed.zip`(各 4 文件,与截图/E2E 流程同源);语料契约由 `tests/unit/demo-corpus.test.ts` 锁定(6 用例);`demo/README.md` 说明与演示脚本的对应关系;ZIP 不入库(`.gitignore: demo/*.zip`),语料为版本化的自有合成代码。

## 10. 发布收尾记录(2026-09-19,公开仓库定稿)

- 记录日期:2026-09-19;记录人:ZCode 会话(公开发布前收尾)。
- **Git 提交整理**:工作区按功能分组为 5 个提交——`b1e2607`(移动端导航与响应式布局)、`5cb90a4`(Finding 详情页定位滚动/反馈失败提示/窄屏适配修复)、`e4914b9`(Finding 详情页 UI 回归 E2E)、`ad2aecf`(演示语料 ZIP 生成脚本与契约测试)、`245295b`(本清单与 P1/P4 进度记录);初始提交 `355b40f`(2026-09-13)未改写。
- **GitHub 公开仓库**:`https://github.com/aabbcc070403/codeatlas` 创建并推送 master;`git ls-remote origin` 显示远程 HEAD=refs/heads/master=`245295b`,与本地 HEAD 一致;干净克隆后 `pnpm typecheck` 与 `pnpm lint` 真实执行均通过(exit 0)。
- **PDF 技术文档**:`deliverables/CodeAtlas-技术文档.pdf`(16 页,约 787KB)生成于 `deliverables/`,所有 AI 评测数字如实标注 Mock,未冒充真实模型结果;HTML 源目录随 PDF 一并入库。
- **Secrets 扫描(2026-09-19)**:对全部已跟踪文件执行多组 `git grep` 正则(sk- 前缀 20+ 字符 / ghp_/gho_/ghu_/ghs_ GitHub token / AKIA·xox·AIza 云厂商前缀 / 密钥类赋值模式 / PEM 私钥块 / Bearer 串 / 非测试目录 32+ 随机串赋值)。命中项均为脱敏(redact)功能自身的测试 fixture——`tests/unit/import-redact.test.ts` 与 `tests/integration/import.test.ts` 中的 `sk-abcdef…`、`ghp_abcdefg…`(字母序假串,且断言导入后被脱敏)、`AKIAIOSFODNN7EXAMPLE`(AWS 官方文档标准示例密钥)、伪造 PEM 头部(无密钥材料),及 `tests/integration/messages.test.ts` 的 `sk-test-secret-value-123`(测试桩值),人工复核后全部排除,非真实凭证。`.env` 本地存在但被 .gitignore 忽略、未跟踪;`git ls-files` 中敏感模式文件仅 `.env.example`(AI_API_KEY 等均为空占位)。**结论:无真实密钥泄露。**
- **发布候选 tag**:`v1.0.0-rc.1`(annotated,2026-09-19):核心功能与比赛材料(PDF/文档/演示语料)就绪,真实 AI 评测与 Docker 验收待完成后进入 1.0.0;tag 干净克隆复现验证通过。
- **真实 AI 评测(P2,2026-09-19 完成)**:本机 `.env` 配置 DeepSeek(`deepseek-chat`,实测映射 deepseek-flash;预算 AI_DAILY_TOKEN_LIMIT 上调至 2,000,000,本地配置)后执行——①冒烟:单项目 hybrid_rag + 追问 + 补丁(追问复杂问题 budget_exhausted 如实记录,`deliverables/real-ai-smoke-2026-09-19.md`);②holdout 3+3:llm_no_rag ×3 + hybrid_rag ×3,6 次全部 completed、零失败项目,token 总消耗 555,892(`deliverables/real-ai-holdout-2026-09-19.md`);③文档分栏:`docs/evaluation.md` 新增 §4.5 真实模型实测数字(§4 Mock 数字不动)、`docs/progress.md` 追加执行记录、本清单同步更新。关键数字(3 次均值):llm_no_rag P 0.396 / R 1.000 / F1 0.566,hybrid_rag P 0.421 / R 1.000 / F1 0.591;RAG 消融可回溯(llm_no_rag scan_citations 三次均 0,hybrid_rag 三次 5/9/9)。规格 13 目标 P≥0.80 未达标、R≥0.65 达标,如实记录不粉饰。

### 未完成项(如实保持)

1. 真实 AI 评测遗留(2026-09-19 执行后):embedding 无向量路(hybrid_rag 词法降级口径)、追问预算偏紧(复杂问题 budget_exhausted)、fx-ctl-jsx-02 六次扫描终态 partial 待排查。
2. Docker/Compose 全栈与生产 PostgreSQL 16 实测(P3,需测试主机)。
3. MP4 演示视频与在线演示环境(P5 后续项)。

## 11. 产品完善与材料冲刺记录(2026-09-23)

- 记录日期:2026-09-23;本次会话新增 13 个真实提交(8e1dd4f…112562b),历史提交未改写。
- **产品**:扫描终态语义修复(fx-ctl-jsx-02 partial 根因=证据门丢弃被误计未完成)+ 提示词 v2(P 0.42→0.86 主效应,48/48 completed);安全加固(Mimosa 深审项目代码 0 高危:语料/数据集 JSON 数据化+路径穿越防御+db-server 边界);多模态截图追问(≤3 张,原图不落库);本地嵌入 local:bge-small-zh-v1.5+维度解耦迁移 0005+pnpm reindex,RAG 三路消融(检索 29/29 hybrid);追问预算 AI_ASK_* 可配置;性能实测(FCP ≤188ms,First Load JS ≤136kB)。
- **评测口径**:v2 三路消融(llm_no_rag 0.857/1.000/0.923、hybrid 词法 0.786/1.000/0.912、hybrid 向量 0.756/1.000/0.850,n=3 均值),与 v1/Mock 分栏并存,如实不夸大(`docs/evaluation.md` §4.6)。
- **材料**:README 团队信息表/技术架构速览/开发方式声明;技术文档七章重构(11 页 PDF,创新点双清单/商业潜力/AI 选型集成优化显式);演示脚本更新+多模态段;答辩 PPT 11 页+18 题问答题库;PPT 视觉核验通过。
- **最终回归**:八项命令(fixtures:generate/doctor/typecheck/lint/test:unit 204/test:integration 131/test:e2e 9/build)全部 exit 0。
- **未完成项更新**:§10-1 的三项遗留(fx-ctl-jsx-02 partial、向量路未验证、追问预算偏紧)**已全部解决**;仍开放——Docker/生产 PG 实测(需测试主机)、MP4 录制(需人工)、在线演示部署、README 团队信息补全、报名缴费与组别确认。

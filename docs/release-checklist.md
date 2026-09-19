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

- 当前 provider:**mock**(本机无真实凭证)。`pnpm doctor` 显示 `AI provider: mock(Mock,未接入真实模型)`。
- 真实模型状态:**未接入**。P2(真实 AI 小样本验证)依赖项目负责人在本机 `.env` 配置 `AI_PROVIDER=openai` 及密钥,完成后本表更新为真实 provider/model/日期。
- 界面、报告、评测中所有 AI 输出均保留 Mock 标注;不存在把 Mock 结果描述为真实模型结果的表述。

## 4. 数据集与评测口径

- datasetVersion:**`v1-cd06ca6f`**(revision 1,内容哈希 cd06ca6f…,`fixtures/dataset.json` 与 `docs/evaluation.md` 一致,已由 `pnpm fixtures:generate` 复核无漂移)。
- ruleVersion:`static-rules-v1`。
- 划分:开发集 16 / 保留集 8。
- 评测口径:全部现有数字为 **Mock 模式**结果,标注于 `docs/evaluation.md`;真实模型评测(P2.3)未执行,不得引用 Mock 数字冒充真实效果。

## 5. Docker / PostgreSQL 验证状态

- Docker 镜像构建与 Compose 全栈启动:**未验证**(本机无 Docker;按方案 P3 需在安装 Docker 的独立测试主机执行,执行步骤见方案 P3.1)。
- 生产 PostgreSQL 集成测试:**未验证**。机制已就绪(A07):设置 `INTEGRATION_DATABASE_URL` 指向库名含 `test` 的专用库即可走 postgres.js 直连路径;本机当前基线为 PGlite socket。
- 部署安全检查(P3.3):未执行(依赖 P3 部署环境)。

## 6. 账号与凭证分离

- 演示访问码:本机为 `.env.example` 开发默认值(`codeatlas-demo` / `codeatlas-admin`),**仅限本地开发与演示**。
- 部署账号:尚未部署,不适用。部署时必须更换 `POSTGRES_PASSWORD`、`SESSION_SECRET`、`DEMO_ACCESS_CODE`、`ADMIN_ACCESS_CODE`(P3.1),并确认演示账号与部署/管理账号分离。
- 密钥管理:所有真实密钥仅存于本机 `.env`(被 .gitignore 忽略,未被 Git 跟踪);聊天与文档中不粘贴密钥。

## 7. 未解决限制(诚实清单)

1. 真实模型 smoke 与保留集 ×3 评测未执行(P2,需本机凭证)。
2. Docker/Compose 全栈与生产 PostgreSQL 16 实测未执行(P3,需测试主机)。
3. HTTPS 反向代理与部署加固未执行(P3.3)。
4. 技术 PDF、演示视频、公开仓库(P5)未开始。
5. fixtures 仅覆盖自有脱敏样例,不代表任意代码库上的表现。

## 8. 阶段状态速览

| 阶段 | 状态 |
| --- | --- |
| P1 发布候选整理 | ✅ 本文件 + 工作区清理完成 |
| P2 真实 AI 小样本验证 | ⏸ 等待本机配置真实凭证 |
| P3 Docker/PostgreSQL 外部验收 | ⏸ 等待测试主机 |
| P4 产品展示优化 | ✅ P4.1 移动端导航 + P4.2 演示数据固定完成(2026-09-15) |
| P5 比赛材料 | ⏸ 未开始 |
| P6 最终签收 | ⏸ 依赖 P2–P5 |

## 9. P4 记录(2026-09-15)

- **P4.1 移动端导航**:新增 `src/components/app-nav.tsx`(DesktopNav 保持原桌面信息架构;MobileNav 为 md 以下视口的折叠菜单,含 aria-expanded/aria-label、Escape 与点击外部收起、路由变化自动收起);品牌与 AI 状态标签保留并加 `whitespace-nowrap`。
- 交互验收探针(Playwright,390×844):16 项全部 PASS——汉堡可见、菜单含完整标签「项目/知识库/评测」、跳转后自动收起、键盘 Enter 打开/Escape 收起、三页无横向溢出;桌面 1280 原导航可见、汉堡隐藏、无溢出。
- 截图已重新生成(login/project/projects/scan/finding/compare/evaluation × 1440/1024/390,共 21 张 + 菜单展开存档 `nav-menu-390x844.png`),390px 无逐字换行。
- **P4.2 演示数据固定**:`pnpm demo:zip` 生成 `demo/codeatlas-demo-origin.zip` 与 `codeatlas-demo-fixed.zip`(各 4 文件,与截图/E2E 流程同源);语料契约由 `tests/unit/demo-corpus.test.ts` 锁定(6 用例);`demo/README.md` 说明与演示脚本的对应关系;ZIP 不入库(`.gitignore: demo/*.zip`),语料为版本化的自有合成代码。

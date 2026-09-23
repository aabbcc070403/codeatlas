# CodeAtlas 评测说明

本文记录评测数据集构成、三模式配置、指标定义与 R08 实测数字。所有数字可回溯：`evaluations` 表的 `metrics_json` 与逐项目 `scanId`（评测页每行可点「查看」跳转 `/scans/:id`）。执行记录见 `docs/progress.md` R08 节。

**总口径声明（页面与 CLI 固定展示）**：24/16/8/12 等小样本的结果只称为「本样例集结果」，不能推广为所有项目准确率。**真实模型评测已于 2026-09-19 执行**（DeepSeek `deepseek-chat`，holdout 每模式重复 3 次，数字见 §4.5）；§4 的 llm 模式数字为 2026-09-13 受控 Mock 管线验证，结果中逐项标注 provider=mock——两套数字分栏并存、互不覆盖。

## 1. 数据集构成

- **24 个小型 TS/JS fixture 项目**：12 缺陷 + 12 相近对照，全部由 `src/core/evaluation/fixtures-defs.ts` 定义、`pnpm fixtures:generate` 生成到 `fixtures/`（生成器幂等：两次运行字节一致）。
- **6 类问题 × 每类 2 场景**：

| 类别 | 场景 |
|---|---|
| 动态代码执行 | 动态表达式求值 / new Function + 字符串定时器 |
| HTML 注入入口 | innerHTML / dangerouslySetInnerHTML |
| 跨窗口消息源 | targetOrigin="*" / 监听无 origin 校验 |
| JSX 列表缺失 key | map 无 key / Fragment 子元素无 key |
| Hook 条件/非法作用域调用 | if 内 useState / 普通函数内 useEffect |
| 检查禁用与调试残留 | 裸 @ts-ignore / console 残留 + 禁用安全 ESLint 规则 |

- **标注**：每个缺陷项目 manifest 记录 ruleId / category / file / 锚点 / symbol / 触发条件；生成时强校验「标注 ↔ 静态规则输出双向对应」「对照项目零发现」，校验失败即中止生成。
- **版本化**：datasetVersion = `v<revision>-<hash8>`，内容哈希为全部项目规范 JSON 的 sha256；当前版本 **`v1-cd06ca6f`**（revision 1），内容变化时 revision 自增，旧结果仍可按版本追溯。
- **划分**：开发集 16（8 缺陷 + 8 对照）/ 保留集 8（4 + 4），**按项目整体拆分**，同一项目的文件不跨集。

## 2. 三模式配置

| 模式 | 云端 AI | RAG | 说明 |
|---|---|---|---|
| `static_only` | 关闭（enableCloudAI=false） | — | 纯静态规则，无模型调用、零 token |
| `llm_no_rag` | 开启 | **经 provider 包装层移除 retrieve_guidelines** | 消融对照组：同模型 / prompt / 预算 / 工具，仅切换规范检索 |
| `hybrid_rag` | 开启 | 完整双路检索（pgvector + 词法，RRF 融合） | 完整管线 |

- 三模式固定模型 / prompt / 预算 / 工具配置，完整配置写入 `evaluations.config_json` 与 `metrics_json.config`（数据集版本、划分、规则版本 static-rules-v1、provider、projectLimit 等）。
- 评测逐项目执行**与生产完全一致的核心扫描管线**：构造真实 ZIP → 生产导入（含脱敏）→ 持久化快照 → 扫描任务 → 评测执行器直接领取租约执行（LeaseKeeper 续租）→ 六阶段。项目落在隔离的预置项目（session_id 空、is_preset），不借用其他会话快照。
- 运行入口：页面 `/evaluation`（仅 admin 角色可触发，demo 403）或 CLI（消耗预算受 `AI_DAILY_TOKEN_LIMIT` 约束）：

```bash
pnpm db:dev   # 先起本地数据库
pnpm eval -- --mode static_only --split dev
pnpm eval -- --mode hybrid_rag --split holdout
# 可选 --dataset v1-xxxxxxxx --limit N；stdout 输出逐项目表 + 汇总表
```

- `EVAL_PROJECT_LIMIT` 环境变量为 e2e / 集成提速口径（e2e=6），正式评测不设限；实际口径记录在 `metrics_json.config.projectLimit` 并在 UI 显示。

## 3. 指标定义

- **候选兼容**：文件一致 + 标注行段与报警行段相交 + 类别一致。
- **一对一匹配**：确定性贪心（边按「起点距离 → 候选键序 → 标注键序」稳定排序；同输入同配对）。重复报警（兼容但标注已被占用的未匹配候选）额外计 FP。
- **无效引文候选**：不参与匹配、单列 `invalidCitations` 且计入 FP——不通过丢弃结果美化指标。
- **Precision = TP/(TP+FP)，Recall = TP/(TP+FN)，F1 为调和平均**；分母为零时返回 null，页面显示 N/A（不显示 0 或 100%）。
- **证据有效率** = 有效引文候选 / 全部候选。
- **延迟**：逐项目扫描耗时 p50 / p95（percentile 线性插值）。
- **token/项目**：实测与估算分列（Mock 不消耗真实资源，token 为管线口径记录）。
- **聚合**：跨项目先求和（TP/FP/FN）再计算派生指标，不做宏平均。

手算表验证：`tests/unit/evaluation-metrics.test.ts` 18 项（全对 / 漏报 / 误报 / 类别不符 / 文件不符 / 零分母 N/A / 重复报警 FP / 无效引文 FP / 匹配确定性 / 聚合口径）。

## 4. R08 实测数字（2026-09-13，CLI 真实运行）

**static_only 两行为确定性真实静态规则结果；llm 两行为受控 Mock 管线（provider=mock），不冒充真实模型指标。本节为 2026-09-13 时点记录，数字保留不动；真实模型（DeepSeek）实测数字见 §4.5。**

| 模式 | 划分 | 项目数 | Precision | Recall | F1 | 证据有效率 | 延迟 p50/p95 | token/项目 | provider |
|---|---|---|---|---|---|---|---|---|---|
| static_only | dev | 16 | 1.000（TP 9 / FP 0 / FN 0） | 1.000 | 1.000 | 100% | 33ms / 66ms | 0 | 无模型调用 |
| static_only | holdout | 8 | 1.000（TP 6 / FP 0 / FN 0） | 1.000 | 1.000 | 100% | 40ms / 70ms | 0 | 无模型调用 |
| llm_no_rag | dev | 16 | 1.000（TP 9 / FP 0 / FN 0） | 1.000 | 1.000 | 100% | 49ms / 75ms | 968（合计 15,492） | **Mock** |
| hybrid_rag | dev | 16 | 1.000（TP 9 / FP 0 / FN 0） | 1.000 | 1.000 | 100% | 52ms / 75ms | 1,848（合计 29,560） | **Mock** |

- **消融可回溯验证**：hybrid_rag 运行（16 项目）逐项目 scanId 共产生 24 条 `scan_citations` 规范引用快照；llm_no_rag 对应运行 0 条——RAG 开关严格生效。
- **static_only 满分的含义**：样例集与现有 9 条静态规则对齐（生成器强校验保证标注 ↔ 规则输出双向对应），该数字只说明「管线 + 规则在本样例集上的行为符合设计预期」，**不代表真实项目准确率**。
- 评测产生的预置样例项目 / 快照保留在库与存储中（每个数字可回溯原始扫描），不做自动清理。
- 目标而非承诺（规格 13：保留集 hybrid_rag precision ≥ 0.80、recall ≥ 0.65）在真实模型评测执行前**无从评估**，不做 extrapolation。

## 4.5 真实模型实测数字（2026-09-19，DeepSeek，CLI 真实运行）

规格 13 要求的保留集重复 3 次（均值与范围）真实模型评测。6 次运行全部 completed（llm_no_rag ×3 + hybrid_rag ×3，holdout 8 项目/次），零失败项目、零崩溃重跑；`evaluation_projects` 48 行 provider=openai、provider_is_mock=false、model_id=deepseek-chat。逐次明细、6 条 evaluations 记录 ID 与逐项目 scanId 见 `deliverables/real-ai-holdout-2026-09-19.md`（冒烟记录见 `deliverables/real-ai-smoke-2026-09-19.md`）。

- **环境**：`deepseek-chat`（DeepSeek OpenAI 兼容模式，实测映射 deepseek-flash）；数据集 `v1-cd06ca6f`，划分 holdout 8 项目（4 缺陷 + 4 对照）。
- **词法检索降级声明**：DeepSeek 无 embedding API，hybrid_rag 的向量检索路降级为纯词法检索——本节数字口径为「词法检索 × 真实模型」，pgvector 混合检索的真实效果未验证。

**两模式均值 ± 范围（min–max，n=3）**：

| 指标 | llm_no_rag | hybrid_rag |
|---|---|---|
| Precision | 0.396（0.353–0.462） | 0.421（0.400–0.462） |
| Recall | 1.000（三次全满） | 1.000（三次全满） |
| F1 | 0.566（0.522–0.632） | 0.591（0.571–0.632） |
| 证据有效率 | 75.5%（69.2–82.4%） | 79.7%（73.3–92.3%） |
| 延迟 p50 / p95 | 8,025 / 10,113ms | 7,389 / 10,074ms |
| token/项目 | 10,137（9,201–11,051） | 13,025（11,561–14,787） |

- **RAG 消融可回溯**：llm_no_rag 三次 scan_citations 均为 **0 条**（RAG 隔离严格生效）；hybrid_rag 三次 **5 / 9 / 9 条**，命中的规范均为预置库真实标题（与 holdout 缺陷类别对应）。
- **与 Mock 数字分栏对照（不覆盖 §4）**：

| 维度 | Mock（§4，dev 16 项目） | 真实模型（本节，holdout 8 项目 ×3 均值） |
|---|---|---|
| llm_no_rag token/项目 | 968 | 10,137（≈10.5×） |
| hybrid_rag token/项目 | 1,848 | 13,025（≈7.0×） |
| 延迟 | 49–75ms | p50 7,389–8,025ms / p95 10,074–10,113ms |
| P / R / F1（llm 两模式） | 1.000 / 1.000 / 1.000 | P 0.396–0.421 / R 1.000 / F1 0.566–0.591 |
| scan_citations（hybrid） | 24 条/16 项目 | 23 条/3×8 项目 |
| provider | mock | openai（deepseek-chat→deepseek-flash） |

- **如实结论**：Recall 三次全满（6/6 标注全部命中）；Precision 为短板，FP 主因为 fx-ctl-* 对照项目误报（模型在「相近对照」上仍报出告警）。RAG 带来 P +2.5pp（0.396→0.421）、F1 +2.5pp、证据有效率 +4.2pp，方向一致但幅度在小样本方差内，不足以宣称显著。规格 13 目标（holdout hybrid_rag P ≥ 0.80、R ≥ 0.65）：**R 达标（1.000）、P 未达标（0.421）**——目标是目标而非承诺，如实记录，不做 extrapolation。
- **已知异常**：fx-ctl-jsx-02 六次扫描终态均为 partial（指标正常产出并计入结果，原因待排查）；无效引文每次 1–4 条，按设计计入 FP 不丢弃。
- token 总消耗 555,892（llm_no_rag 243,296 + hybrid_rag 312,596），预算上限 AI_DAILY_TOKEN_LIMIT=2,000,000。

## 4.6 提示词 v2 与 RAG 三路消融（2026-09-23，真实模型 + 真实本地嵌入）

**口径**：`review-prompt-v2`（宁缺毋滥：无确凿证据不提交，空结论为正常结果——针对 v1 对照项目误报的优化策略）；对话 `deepseek-chat`，嵌入 `local:bge-small-zh-v1.5`（transformers.js ONNX/WASM，512 维，本地推理零成本）。完整表格、9 次运行评测记录 ID 与如实结论见 `deliverables/real-embedding-ablation-2026-09-23.md`，与 §4/§4.5 分栏并存、互不覆盖。

- 三列均值（各 n=3，holdout 8）：`llm_no_rag` P 0.857 / R 1.000 / F1 0.923；`hybrid_rag` 词法降级 P 0.786 / F1 0.912；`hybrid_rag` **向量+词法 RRF** P 0.756 / F1 0.850（小样本方差内，最高单次 P 1.000）。
- **向量路闭环**：嵌入启用后 `retrieve_guidelines` 29/29 为 `hybrid`（此前唯一未验证项「pgvector 混合检索 × 真实模型」已实证）；30 条预置规范全部向量化（`pnpm reindex`）。
- **提示词 v2 是精度主效应**：FP 从 v1 的 7–11 条/次压到 0–4 条/次，Recall 跨 9 次运行全部 1.000；规格 13 目标（hybrid P ≥ 0.80、R ≥ 0.65）：R 达标，P 均值贴近目标线（0.756–0.786）。
- 如实结论：检索增强对 P/F1 的影响在 n=8 方差内，**不宣称显著提升**；RAG 的稳定增量在规范引用证据与可解释性。
- 已知异常**已修复**：fx-ctl-jsx-02 扫描终态 partial 的根因为「证据门丢弃无效引文被计为未完成」（与规格 193「丢弃并计数」不符）——终态语义已修正，v2 口径 48/48 扫描全部 completed。

## 5. 限制

1. **小样本口径**：24 项目 / 16-8 划分是设计期的最小验证集，指标方差大，只可作管线回归与演示，不可作为产品能力声明。
2. **真实模型评测已执行（2026-09-19，DeepSeek）**：规格 13 要求的 llm_no_rag / hybrid_rag 保留集重复 3 次（均值与范围）已完成（数字见 §4.5）。新限制：① DeepSeek 无 embedding API，hybrid_rag 向量检索路降级为纯词法——「pgvector 混合检索 × 真实模型」的效果未验证；② 追问预算偏紧：复杂问题下 DeepSeek 易用满 8 次工具调用导致 budget_exhausted 无回答（冒烟实测；规格值 4 次模型/8 次工具/60s 按受控行为设计）；③ fx-ctl-jsx-02 六次扫描终态均为 partial，原因待排查。llm_no_rag 对真实模型的 RAG 隔离经 provider 包装层移除 retrieve_guidelines 实现（消融可回溯验证见 §4.5）。
3. **Mock 管线语义**：llm 模式的 token / 延迟为 Mock 执行的管线口径，不反映真实模型成本与延迟。
4. 评测执行器中途崩溃时 evaluations 行停留 running（扫描任务可被常规 worker 接管），需重新发起评测（新记录）；评测 API 未提供页面级取消按钮（任务粒度取消经 jobs 机制可用）。

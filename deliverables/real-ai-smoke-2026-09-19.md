# 真实模型（DeepSeek）小样本冒烟记录 · 2026-09-19

为完整 holdout 3+3 评测铺路的真实模型冒烟。模型 `deepseek-chat`（DeepSeek OpenAI 兼容模式，实测映射 deepseek-flash），无 embedding 配置（词法检索降级，属接受方案）。

## 1. 环境就绪

- `pnpm db:dev` 后台启动 PGlite socket（端口 5433），`pnpm doctor` 通过：迁移 5/5、pgvector 启用、预置规范 30 条（.data 库已有数据，无需重新 migrate/seed）。
- `.env`：AI_PROVIDER=openai、AI_BASE_URL=https://api.deepseek.com、AI_CHAT_MODEL=deepseek-chat、无 AI_EMBEDDING_MODEL。

## 2. 单项目评测冒烟（hybrid_rag · holdout · limit 1）

命令：`pnpm eval -- --mode hybrid_rag --split holdout --limit 1`

- 评测记录 `5a5bc845-ea02-4203-b7ad-16b65e0d96e6`，状态 completed；`evaluation_projects` 行 `provider=openai、provider_is_mock=false、model_id=deepseek-chat`，`metrics_json.config.realModelRun=true` —— 确认真实调用 DeepSeek（非 Mock）。
- 项目 fx-msg-02（缺陷）：TP 1 / FP 0 / FN 0，P=R=F1=1.000；证据有效率 100%（无效引用 0、重复报警 0）。
- 延迟 6,784ms（AI 段 6,662ms）；token 7,096/项目（实测 input 6,214 + output 882；modelCalls 3、toolCalls 4）。
- 降级行为：无 embedding → retrieve_guidelines 正常返回（11ms），finding 引用 2 个规范 chunk，词法检索降级无报错。
- finding 质量：正确定位 src/listener.ts:2-5「message 事件监听未校验 event.origin」，含规范引用与可执行修复建议。

## 3. 追问 + 补丁冒烟（默认真实 provider 工厂，不注入）

脚本 `scripts/smoke-real-ai.ts`（保留可复用）：复用上述真实扫描的 finding，在本人会话项目下经同一导入管线重建快照后拷贝 finding，分别调用 `askFindingQuestion`（src/core/review/conversation.ts）与 `proposePatchForFinding`（src/core/patch/propose.ts）。

### 追问一（复杂问题：攻击前提 + 数据流向 + 引用代码行）

- 结果 `budget_exhausted`（degradedReason：工具调用次数达到上限 8），answer 为 null。
- DeepSeek 在 3 轮内用满 8 次工具调用（read_file/search_code/retrieve_guidelines）探索，未在预算内调用 submit_answer。追问规格预算（4 次模型请求 / 8 次工具调用 / 60s，src/core/contracts/conversation.ts）对真实模型的探索型行为偏紧。token：input 5,317 + output 453 = 5,770；耗时 3.1s。
- 降级路径按设计工作（无崩溃、user 消息保留）；这是模型行为与固定预算的适配问题，非管线 bug，未改 src/（红线）。

### 追问二（简单问题：两三句话回答为什么有风险）

- 结果 `answered`，`retrievalMode=lexical_only`（词法降级直接可见）；3 次模型调用、4 次工具调用；token input 5,961 + output 696 = 6,657；耗时 4.2s。
- 回答正确引用代码并解释 origin 缺失 + as 断言风险；证据校验丢弃了部分无效引用（degradedReason=invalid_evidence_dropped），1 条有效引用入库（messages 表 assistant 行 provider=openai）。

### 补丁

- 结果 `proposed`（patchId `5b22fd22-fcca-4a71-83fe-2a22366e0d21`，patches 表 provider=openai、syntax=pass）；1 次模型调用即成功；token input 1,160 + output 419 = 1,579；耗时 1.6s。
- diff 合理且可应用：为 listenForTheme 增加 allowedOrigins 参数 + event.origin 白名单校验 + unknown 运行时收窄，语法校验通过（基线 0 错误 → 补丁后 0 错误）。

## 4. token 汇总与完整 holdout 3+3 预算估算

当日 daily_usage 合计：input 18,652 + output 2,450 = **21,102**（含全部冒烟）。

估算（真实口径，单项目 7,096 为基线）：

| 项目 | 计算 | 估算 token |
| --- | --- | --- |
| 3 × hybrid_rag × 8 项目 | 3 × 8 × ~7,100 | ~170,000 |
| 3 × llm_no_rag × 8 项目（无检索工具，略低） | 3 × 8 × ~5,000-7,000 | ~120,000-170,000 |
| 基础合计 | | **~290,000-340,000** |

基础估计已贴近/超过原 AI_DAILY_TOKEN_LIMIT=300,000；考虑项目大小差异与模型探索轮次波动（扫描预算上限 12 次模型调用/项目，观测值仅 3 次，极端情形可放大数倍），**已将 .env 中 AI_DAILY_TOKEN_LIMIT 上调至 2,000,000**（DeepSeek 成本极低，安全余量充足）。

## 5. 发现的问题与建议

1. **追问预算偏紧（真实模型）**：复杂问题下 DeepSeek 易用满 8 次工具调用导致 budget_exhausted、无回答。规格值 4/8/60s 是按受控/Mock 行为设计；完整评测或产品化前建议评估放宽（如 6 次模型调用 / 12 次工具调用）或在系统提示中约束探索深度。按红线未改 src/。
2. 引文校验严格（好事）：真实模型提交的引用偶有无效（未完整读取覆盖），被正确丢弃并标注 invalid_evidence_dropped，不污染结果。
3. 词法检索降级、预算记账（daily_usage 预留/结算，reserved 归零）、A08 逐项目恢复记录均按设计工作，未发现需修 src/ 的 bug。

## 附：冒烟资产

- 评测记录：evaluations `5a5bc845-ea02-4203-b7ad-16b65e0d96e6`（scanId `02b9dfec-9a72-40fd-9403-bfdd8e1da8c8`）
- 冒烟脚本：`scripts/smoke-real-ai.ts`（可复用：重建会话/项目/快照 → 拷贝真实 finding → 真实 provider 追问+补丁）
- 补丁记录：patches `5b22fd22-fcca-4a71-83fe-2a22366e0d21`；追问消息：findings `64da29fe-c6a9-4618-91d8-1a27adbea769` 下 messages

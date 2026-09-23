# 前端性能实测与 AI 交互体验核验 · 2026-09-23

## 1. 前端性能实测（生产构建，本机）

**包体（`next build` 路由表，Next.js 自动代码分割）**：

| 路由 | 自身大小 | First Load JS |
|---|---|---|
| `/login` | 2.48 kB | 115 kB |
| `/projects` | 1.88 kB | 118 kB |
| `/projects/[id]`（工作台） | 20 kB | 136 kB |
| `/knowledge` | 3.52 kB | 116 kB |
| `/evaluation` | 6.49 kB | 135 kB |
| `/projects/[id]/compare` | 5.6 kB | 135 kB |
| 全部 API 路由 | 174 B | 102 kB |

**首屏时序（`next start` 生产服务 + Playwright Chromium 1440×900，冷加载单次）**：

| 页面 | TTFB | DOMContentLoaded | load | FCP |
|---|---|---|---|---|
| `/login` | 30ms | 44ms | 69ms | **188ms** |
| `/`（→/login） | 38ms | 43ms | 50ms | **56ms** |

口径说明：本机 loopback 生产服务测量，反映渲染与包体开销（无公网 RTT）；首载 JS 102–136 kB 处于轻量区间。

**资源优化手段（代码分割 / 懒加载 / 缓存）**：
- Next.js App Router 自动路由级代码分割（上表 Size/First Load 分列即产物证据）；
- AI 嵌入模型本地懒加载（首次调用才加载 ONNX，不进前端包）；
- 快照文件按需读取（只读代码预览按文件加载）；静态资产长缓存由 Next 产物哈希保证；
- 移动端 390px 无横向溢出（E2E 断言 `scrollWidth - clientWidth ≤ 0`，8+1 项用例含移动端用例）。

## 2. AI 交互体验三项核验（对照评分点逐项）

| 评分点 | 状态 | 证据 |
|---|---|---|
| 流式输出渲染流畅 | ✅（设计取舍见注） | 扫描进度 SSE 流式推送（`/api/scans/:id/events`：15s 心跳、断线重连、无 SSE 时 2s 轮询降级，规格 280 行；UI `scan-events.ts` 增量消费）。注：追问为**结构化提交**设计（先证据后回答、一次提交全部结论），不采用逐 token 流式——这是「证据可核验」主张的核心取舍，界面以工具轨迹与阶段进度提供过程可视化 |
| AI 思考状态可视化 | ✅ | 提交按钮「思考中（≤60s）」状态；工具轨迹逐条呈现（`tool-timeline.tsx`：工具名/输入摘要/耗时/状态，来源 `tool_calls` 真实记录）；扫描六阶段进度（stage.started/completed 事件驱动） |
| 错误边界处理优雅 | ✅ | 结构化错误映射（超时 504/取消 409/预算 429/AI 未配置 503 各有专门文案，已产生消息保留可恢复）；证据不足状态徽章 + 提示（`insufficient_evidence`）；引用定位失败显示「证据无效/待核查」不高亮误导；错误横幅统一呈现（AlertTriangle）；E2E 回归覆盖「反馈失败提示」「追问闭环含恶意文本不执行」（9 项 E2E 全绿，2026-09-23） |

## 3. 复现

```bash
pnpm build && pnpm start      # 另一终端：
node .e2e-dbg-perf-probe.cjs  # 首屏时序（临时探针，不入库；可按本文口径重测）
```

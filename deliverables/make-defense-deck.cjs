// CodeAtlas 答辩 PPT 生成脚本（可复现）：node deliverables/make-defense-deck.cjs
const pptxgen = require('pptxgenjs')

// —— 调色板（主题派生：审查/证据 = 墨绿 + 琥珀强调）——
const BG = 'F6F7F5' // 浅底
const BG_DARK = '10201D' // 深墨底（封面/收尾）
const PRIMARY = '123F38' // 墨绿（标题/结构）
const ACCENT = 'E8A33D' // 琥珀（唯一强调色）
const TEXT = '1C2B27'
const MUTED = '5E6E68'
const FONT = '微软雅黑'

const W = 13.33
const H = 7.5
const M = 0.6

const p = new pptxgen()
p.layout = 'LAYOUT_WIDE'
p.author = 'CodeAtlas 团队'
p.title = 'CodeAtlas 码鉴 · 竞赛答辩'

const makeShadow = () => ({ type: 'outer', blur: 6, offset: 2, color: '10201D', angle: 90, opacity: 0.12 })
const bu = () => ({ code: '25B8', indent: 14 })

function title(slide, text, opts = {}) {
  slide.addText(text, {
    x: M, y: 0.42, w: W - 2 * M, h: 0.72, margin: 0,
    fontFace: FONT, fontSize: 30, bold: true, color: opts.color ?? PRIMARY, align: 'left',
  })
}
function kicker(slide, text, y = 0.18, color = ACCENT) {
  slide.addText(text, {
    x: M, y, w: W - 2 * M, h: 0.3, margin: 0,
    fontFace: FONT, fontSize: 13, bold: true, color, align: 'left',
  })
}
function source(slide, text) {
  slide.addText(text, {
    x: M, y: H - 0.42, w: W - 2 * M, h: 0.28, margin: 0,
    fontFace: FONT, fontSize: 10, color: MUTED, align: 'left',
  })
}

/* —— 1. 封面（深底）—— */
{
  const s = p.addSlide()
  s.background = { color: BG_DARK }
  s.addText('CodeAtlas 码鉴', {
    x: M, y: 2.1, w: W - 2 * M, h: 1.1, margin: 0,
    fontFace: FONT, fontSize: 54, bold: true, color: 'FFFFFF', align: 'left',
  })
  s.addText('证据驱动的 AI 代码审查与项目体检工作台', {
    x: M, y: 3.2, w: W - 2 * M, h: 0.6, margin: 0,
    fontFace: FONT, fontSize: 24, color: 'D7E3DE', align: 'left',
  })
  s.addText('每一条 AI 结论，都能点击核验到代码行', {
    x: M, y: 4.0, w: 8, h: 0.5, margin: 0,
    fontFace: FONT, fontSize: 16, color: ACCENT, bold: true, align: 'left',
  })
  s.addText('AI WEB 网页开发挑战赛 · 答辩材料 · 2026.09', {
    x: M, y: H - 0.8, w: W - 2 * M, h: 0.4, margin: 0,
    fontFace: FONT, fontSize: 12, color: '9DB2AA', align: 'left',
  })
  s.addNotes('开场 20 秒：一句话定位——把企业级「证据可核验」的代码审查能力做成学生用得起的 Web 产品。')
}

/* —— 2. 痛点（行列表 + 大字焦点）—— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '问题背景')
  title(s, '三类工具，都回答不了「证据在哪」')
  s.addText('答辩现场最致命的一问：', { x: M, y: 1.35, w: 7, h: 0.4, margin: 0, fontFace: FONT, fontSize: 16, color: MUTED })
  s.addText('「你这条结论的证据在哪一行？」', {
    x: M, y: 1.75, w: 11, h: 0.8, margin: 0,
    fontFace: FONT, fontSize: 34, bold: true, color: TEXT,
  })
  const rows = [
    ['ESLint / 静态规则', '只报模式命中，不解释业务影响，不给修复验证'],
    ['通用大模型对话', '回答像专家，却会编造不存在的代码行号'],
    ['企业级审查 SaaS', '面向仓库与流水线，对课程作业既贵又重'],
  ]
  rows.forEach((r, i) => {
    const y = 2.95 + i * 1.15
    s.addText(r[0], { x: M, y, w: 3.4, h: 0.5, margin: 0, fontFace: FONT, fontSize: 18, bold: true, color: PRIMARY })
    s.addText(r[1], { x: 4.1, y: y + 0.02, w: 8.4, h: 0.5, margin: 0, fontFace: FONT, fontSize: 15, color: TEXT })
    if (i < 2) s.addShape(p.shapes.LINE, { x: M, y: y + 0.85, w: W - 2 * M, h: 0, line: { color: 'D9DEDB', width: 1 } })
  })
  source(s, '来源：技术文档 §1.1（问题背景）')
  s.addNotes('痛点讲 45 秒。强调：问题不是「找不到工具」，而是「结论不可核验」。')
}

/* —— 3. 产品与四个关键数字（stat 焦点）—— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '产品概览')
  title(s, '确定性打底 · AI 定向 · 证据收口')
  s.addText('上传 ZIP → 静态规则体检 → 受预算约束的 AI 定向审查 → 每条问题带路径 / 行号 / 引文证据，支持追问（可贴截图）、补丁提案、报告导出与快照对比。', {
    x: M, y: 1.3, w: W - 2 * M, h: 0.9, margin: 0, fontFace: FONT, fontSize: 16, color: TEXT,
  })
  const stats = [
    ['344', '项自动化测试全绿', '单元 204 · 集成 131 · E2E 9'],
    ['0.857', '真实评测 Precision', 'Recall 1.000（n=3，v2 提示词）'],
    ['9', '条确定性 AST 规则', '赛题要求 ≥6 条'],
    ['29/29', '检索调用真实 hybrid', 'pgvector + 词法 RRF'],
  ]
  stats.forEach((st, i) => {
    const x = M + i * 3.05
    s.addShape(p.shapes.RECTANGLE, { x, y: 2.7, w: 2.8, h: 2.6, fill: { color: 'FFFFFF' }, shadow: makeShadow() })
    s.addText(st[0], { x: x + 0.15, y: 2.95, w: 2.5, h: 0.9, margin: 0, fontFace: FONT, fontSize: 40, bold: true, color: i === 1 ? ACCENT : PRIMARY })
    s.addText(st[1], { x: x + 0.15, y: 3.95, w: 2.5, h: 0.5, margin: 0, fontFace: FONT, fontSize: 14, bold: true, color: TEXT })
    s.addText(st[2], { x: x + 0.15, y: 4.45, w: 2.5, h: 0.7, margin: 0, fontFace: FONT, fontSize: 11, color: MUTED })
  })
  s.addText('全程诚实标注：Mock / 真实模型、静态 / AI 来源、无效引文计入统计不美化', {
    x: M, y: 5.7, w: W - 2 * M, h: 0.4, margin: 0, fontFace: FONT, fontSize: 13, bold: true, color: PRIMARY,
  })
  source(s, '来源：技术文档 §6.1 / §6.2（2026-09-23 实测口径）')
  s.addNotes('数字页 45 秒。0.857 必接一句「24 样例小样本口径，不外推」。')
}

/* —— 4. 架构（示意图）—— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '系统架构')
  title(s, '六阶段管线 + 受限工具循环 + 证据门')
  const boxes = [
    ['浏览器 UI', '证据工作台 · SSE 进度', 0.6],
    ['API 路由', '会话/预算/限流', 3.1],
    ['AI 审查编排', '抽样→工具循环→证据门', 5.6],
    ['四件只读工具', 'read/search/imports/RAG', 8.1],
    ['PG + pgvector', '作业租约 · worker', 10.6],
  ]
  boxes.forEach((b, i) => {
    s.addShape(p.shapes.ROUNDED_RECTANGLE, {
      x: b[2], y: 2.2, w: 2.15, h: 1.5, rectRadius: 0.08,
      fill: { color: i === 2 ? ACCENT : 'FFFFFF' }, line: { color: 'D9DEDB', width: 1 }, shadow: makeShadow(),
    })
    s.addText(b[0], { x: b[2] + 0.1, y: 2.4, w: 1.95, h: 0.5, margin: 0, fontFace: FONT, fontSize: 15, bold: true, color: i === 2 ? '1C2B27' : PRIMARY, align: 'center' })
    s.addText(b[1], { x: b[2] + 0.1, y: 2.9, w: 1.95, h: 0.7, margin: 0, fontFace: FONT, fontSize: 11, color: i === 2 ? '3A2F1C' : MUTED, align: 'center' })
    if (i < 4) s.addShape(p.shapes.LINE, { x: b[2] + 2.15, y: 2.95, w: 0.35, h: 0, line: { color: PRIMARY, width: 2, endArrowType: 'triangle' } })
  })
  const notes = [
    ['静态规则零幻觉打底', '9 条 AST 规则确定性命中，无模型调用'],
    ['AI 只读、受预算', '12 次模型 / 30 次工具 / 180s；无终端/联网/写文件'],
    ['证据门收口', '引文逐字符匹配快照行段 + 读取覆盖 + 规范白名单'],
  ]
  notes.forEach((n, i) => {
    const y = 4.3 + i * 0.72
    s.addText(n[0], { x: M, y, w: 3.1, h: 0.5, margin: 0, fontFace: FONT, fontSize: 15, bold: true, color: PRIMARY })
    s.addText(n[1], { x: 3.9, y: y + 0.02, w: 8.6, h: 0.5, margin: 0, fontFace: FONT, fontSize: 13, color: TEXT })
  })
  source(s, '来源：技术文档 §3.2 / §3.3')
  s.addNotes('架构 60 秒。重点指琥珀色的编排盒：预算、工具白名单、证据门都在这一层。')
}

/* —— 5. AI 技术方案三支柱 —— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, 'AI 技术方案')
  title(s, '选型理由 · 集成方式 · 优化策略')
  const cols = [
    ['选型理由', [
      'OpenAI 兼容接入：换供应商只改环境变量（实测 DeepSeek）',
      '自研受限工具循环：可控性 > 灵活性，预算与白名单可审计',
      '向量 + 词法 RRF：短术语文本召回稳定、免调权',
      '本地 bge-small-zh 嵌入：零成本、可离线复现',
    ]],
    ['集成方式', [
      '统一调用包装：预留日额度 / 收缩输出上限 / 超时合并',
      'submit_findings 结构化提交，杜绝解析歧义',
      '图像 part 进消息序列，固定 token 计预算',
      '引用白名单 = 本轮检索实际返回集合',
    ]],
    ['优化策略', [
      '提示词 v1→v2「宁缺毋滥」：FP 7–11 → 0–4 条/次',
      '风险优先抽样：注意力花在最可能有问题的文件',
      '预算参数化（AI_ASK_*）可按场景放宽',
      '图像固定估算 + 本地嵌入免计费，成本可预期',
    ]],
  ]
  cols.forEach((c, i) => {
    const x = M + i * 4.15
    s.addText(c[0], { x, y: 1.35, w: 3.9, h: 0.5, margin: 0, fontFace: FONT, fontSize: 19, bold: true, color: i === 2 ? ACCENT : PRIMARY })
    s.addShape(p.shapes.LINE, { x, y: 1.9, w: 3.9, h: 0, line: { color: 'D9DEDB', width: 1 } })
    s.addText(
      c[1].map((t, j) => ({ text: t, options: { bullet: bu(), breakLine: j < c[1].length - 1 } })),
      { x, y: 2.1, w: 3.9, h: 4.4, margin: 0, fontFace: FONT, fontSize: 13, color: TEXT, paraSpaceAfter: 10, valign: 'top' },
    )
  })
  source(s, '来源：技术文档 §4.1–§4.3')
  s.addNotes('方案 75 秒。优化策略列是评分点「优化策略」的直接对应，必讲 v1→v2 实验。')
}

/* —— 6. 证据校验门（流程图）—— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '核心创新 · 技术')
  title(s, '证据校验门：AI 结论的三层收口')
  const steps = [
    ['AI 候选结论', '带路径/行号/引文'],
    ['① 引文逐字符匹配', '快照真实行段（统一 LF）'],
    ['② 读取覆盖检查', '引用行必须在工具读过范围'],
    ['③ 规范白名单', 'chunkId 限本轮检索返回'],
  ]
  steps.forEach((st, i) => {
    const x = 0.7 + i * 3.15
    s.addShape(p.shapes.ROUNDED_RECTANGLE, {
      x, y: 1.9, w: 2.7, h: 1.6, rectRadius: 0.08,
      fill: { color: i === 0 ? 'FFFFFF' : 'E9F0ED' }, line: { color: 'C6D4CF', width: 1 }, shadow: makeShadow(),
    })
    s.addText(st[0], { x: x + 0.12, y: 2.1, w: 2.45, h: 0.6, margin: 0, fontFace: FONT, fontSize: 15, bold: true, color: PRIMARY, align: 'center' })
    s.addText(st[1], { x: x + 0.12, y: 2.7, w: 2.45, h: 0.7, margin: 0, fontFace: FONT, fontSize: 11.5, color: MUTED, align: 'center' })
    if (i < 3) s.addShape(p.shapes.LINE, { x: x + 2.7, y: 3.05, w: 0.45, h: 0, line: { color: PRIMARY, width: 2, endArrowType: 'triangle' } })
  })
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: 3.4, y: 4.2, w: 3.1, h: 1.1, rectRadius: 0.08, fill: { color: 'FFFFFF' }, line: { color: 'C6D4CF', width: 1 } })
  s.addText('通过 → 落库', { x: 3.5, y: 4.35, w: 2.9, h: 0.4, margin: 0, fontFace: FONT, fontSize: 15, bold: true, color: PRIMARY, align: 'center' })
  s.addText('证据状态 valid / needs_review', { x: 3.5, y: 4.75, w: 2.9, h: 0.4, margin: 0, fontFace: FONT, fontSize: 11, color: MUTED, align: 'center' })
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: 7.0, y: 4.2, w: 3.4, h: 1.1, rectRadius: 0.08, fill: { color: 'FDF3E2' }, line: { color: ACCENT, width: 1 } })
  s.addText('未通过 → 丢弃并计数', { x: 7.1, y: 4.35, w: 3.2, h: 0.4, margin: 0, fontFace: FONT, fontSize: 15, bold: true, color: '8A5A16', align: 'center' })
  s.addText('计入 invalidCitations 与 FP，绝不美化指标', { x: 7.1, y: 4.75, w: 3.2, h: 0.4, margin: 0, fontFace: FONT, fontSize: 11, color: '8A5A16', align: 'center' })
  s.addText('无效候选至多 1 次结构修复；修复轮重交按身份跨轮去重', { x: M, y: 5.8, w: W - 2 * M, h: 0.4, margin: 0, fontFace: FONT, fontSize: 13, bold: true, color: PRIMARY })
  source(s, '来源：技术文档 §4.4；src/core/review/validate.ts')
  s.addNotes('核心创新 60 秒。接演示：点击引文定位代码行。')
}

/* —— 7. 提示词 v1→v2 主效应（柱状图）—— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '优化策略 · 实测')
  title(s, '提示词「宁缺毋滥」：精度主效应')
  // 形状柱状图：值标签为独立文本，跨渲染器（PowerPoint/WPS）显示一致
  const bars = [
    ['v1 llm_no_rag', 0.396, PRIMARY],
    ['v1 hybrid', 0.421, PRIMARY],
    ['v2 llm_no_rag', 0.857, ACCENT],
    ['v2 hybrid(向量)', 0.756, ACCENT],
  ]
  const baseY = 5.9
  const maxH = 3.55
  const chartX = 1.05
  const slot = 1.72
  s.addText('Precision（holdout，n=3 均值）', { x: 0.6, y: 1.45, w: 5, h: 0.35, margin: 0, fontFace: FONT, fontSize: 12, bold: true, color: MUTED })
  s.addShape(p.shapes.LINE, { x: 0.7, y: baseY, w: 7.3, h: 0, line: { color: 'C6D4CF', width: 1.25 } })
  s.addShape(p.shapes.LINE, { x: 0.7, y: baseY - maxH, w: 7.3, h: 0, line: { color: 'E2E8E6', width: 0.75, dashType: 'dash' } })
  s.addText('0', { x: 0.35, y: baseY - 0.16, w: 0.3, h: 0.3, margin: 0, fontFace: FONT, fontSize: 10, color: MUTED })
  s.addText('1.0', { x: 0.25, y: baseY - maxH - 0.16, w: 0.42, h: 0.3, margin: 0, fontFace: FONT, fontSize: 10, color: MUTED })
  bars.forEach((b, i) => {
    const h = b[1] * maxH
    const x = chartX + i * slot
    s.addShape(p.shapes.RECTANGLE, { x, y: baseY - h, w: 1.05, h, fill: { color: b[2] } })
    s.addText(b[1].toFixed(3), {
      x: x - 0.2, y: baseY - h - 0.44, w: 1.45, h: 0.38, margin: 0,
      fontFace: FONT, fontSize: 15, bold: true, align: 'center',
      color: b[2] === ACCENT ? '8A5A16' : PRIMARY,
    })
    s.addText(b[0], {
      x: x - 0.35, y: baseY + 0.1, w: 1.75, h: 0.5, margin: 0,
      fontFace: FONT, fontSize: 11, color: MUTED, align: 'center',
    })
  })
  s.addText([
    { text: '只改提示词，其余不变', options: { bold: true, breakLine: true } },
    { text: 'FP：7–11 条/次 → 0–4 条/次', options: { bullet: bu(), breakLine: true } },
    { text: 'Recall 跨 9 次运行全部 1.000', options: { bullet: bu(), breakLine: true } },
    { text: '对照项目幻觉几乎清零', options: { bullet: bu(), breakLine: true } },
    { text: 'v2：无确凿证据不提交，空结论是正常结果', options: { bullet: bu() } },
  ], { x: 8.3, y: 1.7, w: 4.4, h: 4.4, margin: 0, fontFace: FONT, fontSize: 14, color: TEXT, paraSpaceAfter: 10, valign: 'top' })
  source(s, '来源：deliverables/real-embedding-ablation-2026-09-23.md §3（holdout n=3 均值；24 样例小样本口径）')
  s.addNotes('实验设计 45 秒：同模型同数据集只改提示词的对照实验——这是「优化策略」评分点的实证。')
}

/* —— 8. 三路消融 + 诚实结论 —— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, 'RAG 消融 · 诚实结论')
  title(s, '三路消融：向量路真实生效，不夸大提升')
  const rows = [
    ['llm_no_rag（无检索）', '0.857', '1.000', '0.923', '消融基线'],
    ['hybrid_rag（词法对照）', '0.786', '1.000', '0.912', '词法降级口径'],
    ['hybrid_rag（向量+词法 RRF）', '0.756', '1.000', '0.850', '29/29 检索为 hybrid'],
  ]
  s.addTable(
    [
      [{ text: '模式（holdout，n=3 均值）', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } },
       { text: 'P', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } },
       { text: 'R', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } },
       { text: 'F1', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } },
       { text: '备注', options: { bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } }],
      ...rows.map((r) => r.map((c, i) => ({ text: c, options: i === 1 ? { bold: true, color: '8A5A16' } : {} }))),
    ],
    { x: 0.6, y: 1.4, w: 12.1, h: 2.2, colW: [4.2, 1.5, 1.5, 1.5, 3.4], fontFace: FONT, fontSize: 13, border: { pt: 0.75, color: 'D9DEDB' }, autoPage: false },
  )
  s.addText([
    { text: '如实结论', options: { bold: true, breakLine: true } },
    { text: '向量检索 29/29 调用真实 hybrid（此前唯一未验证项已闭环）', options: { bullet: bu(), breakLine: true } },
    { text: 'RAG 对 P/F1 影响在 n=8 方差内——不宣称显著提升', options: { bullet: bu(), breakLine: true } },
    { text: 'RAG 的稳定增量：规范引用证据与可解释性', options: { bullet: bu(), breakLine: true } },
    { text: '全部结果可按评测记录 ID / scanId 回溯', options: { bullet: bu() } },
  ], { x: 0.6, y: 3.9, w: 12.1, h: 2.7, margin: 0, fontFace: FONT, fontSize: 14, color: TEXT, paraSpaceAfter: 9, valign: 'top' })
  source(s, '来源：deliverables/real-embedding-ablation-2026-09-23.md；24 样例小样本口径，不外推真实项目准确率')
  s.addNotes('诚实是卖点：敢把「不显著」写进答辩。评审追问 P 为什么不追 0.9：小样本不外推 + 误报已由证据门与提示词双控。')
}

/* —— 9. 创新点双清单 —— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '创新点说明')
  title(s, '技术创新点 × 应用创新点')
  s.addText('技术创新点', { x: M, y: 1.3, w: 5.8, h: 0.5, margin: 0, fontFace: FONT, fontSize: 19, bold: true, color: PRIMARY })
  s.addText([
    { text: '证据校验门：引文硬校验 + 读取覆盖 + 规范白名单', options: { bullet: bu(), breakLine: true } },
    { text: '确定性评测口径：版本化数据集 + 无效引文计 FP 不美化', options: { bullet: bu(), breakLine: true } },
    { text: '本地嵌入 + 双路 RRF 的零成本 RAG（维度解耦迁移）', options: { bullet: bu(), breakLine: true } },
    { text: '统一预算账本：预留/结算/释放幂等，跨日绑定凭据', options: { bullet: bu() } },
  ], { x: M, y: 1.85, w: 5.8, h: 4.2, margin: 0, fontFace: FONT, fontSize: 13.5, color: TEXT, paraSpaceAfter: 10, valign: 'top' })
  s.addText('应用创新点', { x: 6.9, y: 1.3, w: 5.8, h: 0.5, margin: 0, fontFace: FONT, fontSize: 19, bold: true, color: '8A5A16' })
  s.addText([
    { text: '证据工作台：引文点击 → 代码行定位的闭环交互', options: { bullet: bu(), breakLine: true } },
    { text: '「未再检出 ≠ 已验证修复」四态快照对比语义', options: { bullet: bu(), breakLine: true } },
    { text: '可审阅补丁：不写原件、语法不退化、脱敏拒绝导出', options: { bullet: bu(), breakLine: true } },
    { text: '多模态截图追问：截图 + 代码 + 规范三源融合，原图不落库', options: { bullet: bu() } },
  ], { x: 6.9, y: 1.85, w: 5.8, h: 4.2, margin: 0, fontFace: FONT, fontSize: 13.5, color: TEXT, paraSpaceAfter: 10, valign: 'top' })
  source(s, '来源：技术文档 §7.1 / §7.2')
  s.addNotes('创新 45 秒。左右两列各选一条展开讲，其余报菜名。')
}

/* —— 10. 社会价值与商业潜力 —— */
{
  const s = p.addSlide()
  s.background = { color: BG }
  kicker(s, '价值与商业')
  title(s, '社会价值与商业潜力')
  s.addText('社会价值', { x: M, y: 1.35, w: 5.8, h: 0.5, margin: 0, fontFace: FONT, fontSize: 19, bold: true, color: PRIMARY })
  s.addText([
    { text: '企业级「证据可核验」审查能力带进高校场景', options: { bullet: bu(), breakLine: true } },
    { text: '答辩 / 评审前自查自证，降低初次工程实践质量风险', options: { bullet: bu(), breakLine: true } },
    { text: '「AI 可信性」教学案例：证据校验 / 预算控制 / 诚实评测可复现', options: { bullet: bu(), breakLine: true } },
    { text: '负责任 AI 的产品化示范', options: { bullet: bu() } },
  ], { x: M, y: 1.9, w: 5.8, h: 3.4, margin: 0, fontFace: FONT, fontSize: 14, color: TEXT, paraSpaceAfter: 10, valign: 'top' })
  s.addText('商业潜力（三层）', { x: 6.9, y: 1.35, w: 5.8, h: 0.5, margin: 0, fontFace: FONT, fontSize: 19, bold: true, color: '8A5A16' })
  s.addText([
    { text: '教育版 SaaS：按席位订阅，含专属规范库', options: { bullet: bu(), breakLine: true } },
    { text: '院校采购：私有化部署（Docker Compose 即交付）+ 教学案例包', options: { bullet: bu(), breakLine: true } },
    { text: '增值服务：竞赛冲刺体检报告、团队规范定制', options: { bullet: bu(), breakLine: true } },
    { text: '开源核心 + 云端增值；本地嵌入使毛利结构可预期', options: { bullet: bu() } },
  ], { x: 6.9, y: 1.9, w: 5.8, h: 3.4, margin: 0, fontFace: FONT, fontSize: 14, color: TEXT, paraSpaceAfter: 10, valign: 'top' })
  s.addText('目标用户：高校课程 / 毕设 / 竞赛团队 · 1–5 人前端小团队', { x: M, y: 5.7, w: W - 2 * M, h: 0.4, margin: 0, fontFace: FONT, fontSize: 13, bold: true, color: PRIMARY })
  source(s, '来源：技术文档 §7.4')
  s.addNotes('价值 40 秒。商业部分控制在 20 秒，被追问再展开定价。')
}

/* —— 11. 局限与展望 + 收尾（深底）—— */
{
  const s = p.addSlide()
  s.background = { color: BG_DARK }
  kicker(s, '诚实收尾', 0.1, ACCENT)
  title(s, '局限（如实）与展望', { color: 'FFFFFF' })
  s.addText('局限', { x: M, y: 1.5, w: 5.8, h: 0.5, margin: 0, fontFace: FONT, fontSize: 18, bold: true, color: ACCENT })
  s.addText([
    { text: '24 样例小样本口径，不外推真实项目准确率', options: { bullet: bu(), breakLine: true } },
    { text: '图像内容理解需 VL 模型（链路就绪，如实标注）', options: { bullet: bu(), breakLine: true } },
    { text: 'Docker / 生产 PG 待首次部署实测', options: { bullet: bu() } },
  ], { x: M, y: 2.0, w: 5.8, h: 2.4, margin: 0, fontFace: FONT, fontSize: 14, color: 'D7E3DE', paraSpaceAfter: 9, valign: 'top' })
  s.addText('展望', { x: 6.9, y: 1.5, w: 5.8, h: 0.5, margin: 0, fontFace: FONT, fontSize: 18, bold: true, color: ACCENT })
  s.addText([
    { text: 'MCP 工具集成：接入 IDE 与协作 Agent', options: { bullet: bu(), breakLine: true } },
    { text: '端云协同：浏览器端 WebGPU 轻量初筛', options: { bullet: bu(), breakLine: true } },
    { text: '评测扩容与更强模型对照', options: { bullet: bu(), breakLine: true } },
    { text: '团队协作：误报回流规则库、规范共享', options: { bullet: bu() } },
  ], { x: 6.9, y: 2.0, w: 5.8, h: 2.4, margin: 0, fontFace: FONT, fontSize: 14, color: 'D7E3DE', paraSpaceAfter: 9, valign: 'top' })
  s.addText('谢谢 · 代码与全部实测记录见 github.com/aabbcc070403/codeatlas', {
    x: M, y: 5.3, w: W - 2 * M, h: 0.6, margin: 0, fontFace: FONT, fontSize: 20, bold: true, color: 'FFFFFF',
  })
  s.addText('不虚构数字 · 不冒充结果 · 未验证即如实标注', {
    x: M, y: 5.95, w: W - 2 * M, h: 0.4, margin: 0, fontFace: FONT, fontSize: 13, color: ACCENT,
  })
  s.addNotes('收尾 20 秒：用「诚实」收束全篇——这是产品主张，也是答辩策略。')
}

p.writeFile({ fileName: 'deliverables/CodeAtlas-答辩PPT.pptx' }).then(() => console.log('done: deliverables/CodeAtlas-答辩PPT.pptx'))

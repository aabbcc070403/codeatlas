import type { ReportFinding, ReportModel } from './model'
import { scanStatusLabel } from './model'

/**
 * 三种导出（R07，规格 F09 / 第 11 节）：
 * - json：结构化 ReportModel（与 UI 同一模型，数字一致）；
 * - markdown：表格 + 列表，用户内容按 Markdown 转义防注入；
 * - html：可打印 HTML（白名单：全部动态内容经 escapeHtml，代码不通过 innerHTML 渲染到页面 UI），
 *   长代码 pre-wrap 不撑破打印布局；浏览器打印可另存 PDF，无需服务端 PDF 引擎。
 */

export const EXPORT_FORMATS = ['json', 'markdown', 'html'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

export function exportContentType(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8'
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    case 'html':
      return 'text/html; charset=utf-8'
  }
}

function extensionOf(format: ExportFormat): string {
  return format === 'markdown' ? 'md' : format
}

/** 附件文件名：含 scan 短 id（规格 11） */
export function exportFilename(scanId: string, format: ExportFormat): string {
  return `codeatlas-report-${scanId.slice(0, 8)}.${extensionOf(format)}`
}

/* ---------------- 转义 ---------------- */

/** HTML 转义：所有动态内容必须经过该函数（& < > " '） */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Markdown 转义（表格单元格 / 列表行）：反斜杠、反引号、星号、下划线、方括号、
 * 尖括号、竖线全部转义，换行折叠为空格——防止表格破坏与 Markdown/HTML 注入。
 */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ')
}

/* ---------------- JSON ---------------- */

export function reportToJson(model: ReportModel): string {
  return JSON.stringify(model, null, 2)
}

/* ---------------- 公共小节 ---------------- */

const SEVERITY_LABEL: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
}
const CATEGORY_LABEL: Record<string, string> = {
  security: '安全',
  correctness: '正确性',
  performance: '性能',
  maintainability: '可维护性',
}
const SOURCE_LABEL: Record<string, string> = {
  static: '静态规则',
  ai: 'AI 审查',
  combined: '静态+AI',
}
const EVIDENCE_LABEL: Record<string, string> = {
  valid: '证据有效',
  needs_review: '待核查',
}
const FEEDBACK_LABEL: Record<string, string> = {
  unreviewed: '未复核',
  confirmed: '已确认',
  false_positive: '误报',
}
const AI_DEGRADED_LABEL: Record<string, string> = {
  ai_unavailable: 'AI 服务不可用，已降级为静态扫描',
  ai_stage_error: 'AI 阶段出错，已保留静态结果',
  budget_exceeded: '预算耗尽，已保留已有结果',
  daily_budget_exceeded: '日额度耗尽，已降级为静态扫描',
  lexical_only: '嵌入不可用，规范检索退化为词法匹配',
  invalid_evidence_dropped: '部分引文校验未通过，已丢弃并计入统计（不影响完成状态）',
  not_configured: '未配置云端 AI',
}

function aiDegradedText(reason: string | null): string {
  if (!reason) return ''
  return AI_DEGRADED_LABEL[reason] ?? reason
}

/**
 * 代码围栏：围栏长度必须大于内容中最长的反引号串（CommonMark 规则），
 * 防止引用代码中的 ``` 提前闭合围栏造成 Markdown 注入。
 */
function codeFence(content: string): string {
  const longestRun = (content.match(/`+/g) ?? []).reduce((max, s) => Math.max(max, s.length), 0)
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function locationText(f: ReportFinding): string {
  return `${f.path}:${f.startLine}-${f.endLine}`
}

function metaRows(model: ReportModel): Array<[string, string]> {
  const scan = model.scan
  return [
    ['项目', scan.projectName],
    ['快照', scan.snapshotId],
    ['扫描 ID', scan.id],
    ['状态', `${scanStatusLabel(scan.status)}（stage: ${scan.stage}）`],
    ['规则版本', scan.ruleVersion],
    ['提示词版本', scan.promptVersion],
    ['模型', scan.modelId ?? '未启用云端 AI'],
    ['开始时间', scan.startedAt ?? '—'],
    ['完成时间', scan.completedAt ?? '—'],
    ['报告生成时间', model.generatedAt],
  ]
}

/* ---------------- Markdown ---------------- */

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((cells) => `| ${cells.map(escapeMarkdownCell).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

function mdKeyValueTable(rows: Array<[string, string]>): string {
  return mdTable(['项目', '值'], rows)
}

export function reportToMarkdown(model: ReportModel): string {
  const scan = model.scan
  const lines: string[] = []
  lines.push(`# CodeAtlas 审查报告（扫描 ${scan.id.slice(0, 8)}）`)
  lines.push('')
  lines.push(mdKeyValueTable(metaRows(model)))
  lines.push('')

  if (scan.incompleteReason) {
    lines.push(`> **未完成说明**：${escapeMarkdownCell(scan.incompleteReason)}`)
    lines.push('')
  }

  lines.push('## 风险指标')
  lines.push('')
  if (model.risk) {
    const counts = model.risk.counts
    lines.push(
      mdTable(['风险指数', '严重', '高', '中', '低', '提示（不计分）', '计入指数', '待核查（不计入）', '误报（已剔除）'], [
        [
          String(model.risk.riskIndex),
          String(counts.critical ?? 0),
          String(counts.high ?? 0),
          String(counts.medium ?? 0),
          String(counts.low ?? 0),
          String(counts.info ?? 0),
          String(model.risk.countedFindings),
          String(model.risk.needsReview),
          String(model.risk.falsePositives),
        ],
      ]),
    )
    lines.push('')
    lines.push(`- 公式：\`${escapeMarkdownCell(model.risk.formula)}\``)
    lines.push(`- 口径：${escapeMarkdownCell(model.risk.note)}`)
  } else {
    lines.push('风险指标尚未生成（扫描未完成）。')
  }
  lines.push('')

  lines.push('## 覆盖')
  lines.push('')
  const coverage = model.coverage
  if (coverage) {
    lines.push(
      mdTable(['文件总数', '可分析', '静态已检查', '忽略', '解析失败'], [
        [
          String(coverage.totalFiles),
          String(coverage.analyzableFiles),
          String(coverage.staticCheckedFiles),
          String(coverage.ignoredFiles),
          String(coverage.parseFailedFiles),
        ],
      ]),
    )
    lines.push('')
    const ai = coverage.ai
    lines.push(
      mdTable(
        ['AI 审查', '完成状态', '降级原因', '选中文件', '实际读取', '未读取'],
        [
          [
            ai.enabled ? '已启用' : '未启用（仅本地静态规则）',
            ai.enabled ? (ai.completed ? '完成' : '未完成') : '—',
            ai.enabled ? (aiDegradedText(ai.degradedReason) || '无') : '—',
            String(ai.selectedFiles.length),
            String(ai.readFiles.length),
            String(ai.notReadCount),
          ],
        ],
      ),
    )
    lines.push('')
    lines.push(`- 选择依据：${escapeMarkdownCell(ai.selectionBasis)}`)
    if (ai.enabled && ai.selectedFiles.length > 0) {
      lines.push(`- 选中文件：${escapeMarkdownCell(ai.selectedFiles.join(', '))}`)
      lines.push(`- 实际读取文件：${ai.readFiles.length > 0 ? escapeMarkdownCell(ai.readFiles.join(', ')) : '无'}`)
    }
  } else {
    lines.push('覆盖统计尚未生成。')
  }
  lines.push('')

  lines.push('## 模型用量')
  lines.push('')
  const usage = model.usage
  if (usage) {
    lines.push(
      mdTable(['Provider', '模型请求', '工具调用', '输入 token（估算）', '输出 token（估算）', '输入 token（实测）', '输出 token（实测）', 'AI 耗时'], [
        [
          usage.provider === 'mock' ? 'mock（非真实模型）' : usage.provider,
          String(usage.modelCalls),
          String(usage.toolCalls),
          String(usage.inputTokensEstimated),
          String(usage.outputTokensEstimated),
          usage.inputTokensMeasured === null ? '—' : String(usage.inputTokensMeasured),
          usage.outputTokensMeasured === null ? '—' : String(usage.outputTokensMeasured),
          `${usage.aiElapsedMs} ms`,
        ],
      ]),
    )
  } else {
    lines.push('无用量记录（纯静态扫描或未完成）。')
  }
  lines.push('')

  lines.push(`## 问题（${model.findingCount} 条，其中待核查 ${model.needsReviewCount} 条）`)
  lines.push('')
  if (model.findings.length === 0) {
    lines.push('本次扫描未报告问题。注意：静态规则与 AI 均为启发式检查，未检出问题不代表代码安全。')
  } else {
    lines.push(
      mdTable(
        ['严重度', '类别', '来源', '证据状态', '人工反馈', '位置', '标题'],
        model.findings.map((f) => [
          SEVERITY_LABEL[f.severity] ?? f.severity,
          CATEGORY_LABEL[f.category] ?? f.category,
          SOURCE_LABEL[f.source] ?? f.source,
          EVIDENCE_LABEL[f.evidenceStatus] ?? f.evidenceStatus,
          FEEDBACK_LABEL[f.feedback] ?? f.feedback,
          locationText(f),
          f.title,
        ]),
      ),
    )
    lines.push('')
    for (const f of model.findings) {
      lines.push(`### ${escapeMarkdownCell(f.title)}`)
      lines.push('')
      lines.push(`- 位置：\`${escapeMarkdownCell(locationText(f))}\``)
      if (f.symbol) lines.push(`- 符号：${escapeMarkdownCell(f.symbol)}`)
      lines.push(`- 规则：${escapeMarkdownCell(f.ruleId ?? '无（AI 结果按类别归组）')} · 置信度（模型自评）${f.confidence}`)
      if (f.condition) lines.push(`- 触发条件：${escapeMarkdownCell(f.condition)}`)
      if (f.impact) lines.push(`- 影响：${escapeMarkdownCell(f.impact)}`)
      if (f.reasoningSummary) lines.push(`- 风险依据：${escapeMarkdownCell(f.reasoningSummary)}`)
      if (f.recommendation) lines.push(`- 修复建议：${escapeMarkdownCell(f.recommendation)}`)
      if (f.primaryQuote) {
        const fence = codeFence(f.primaryQuote)
        lines.push(`- 主引用代码：${fence}\n${f.primaryQuote}\n${fence}`)
      }
      if (f.patch) lines.push(`- 补丁提案：${escapeMarkdownCell(f.patch.label)}（状态 ${f.patch.status}）`)
      if (f.citations.length > 0) {
        for (const c of f.citations) {
          lines.push(
            `- 规范引用：${escapeMarkdownCell(c.title)}（版本 ${c.version}${c.sourceUrl ? `，来源 ${escapeMarkdownCell(c.sourceUrl)}` : ''}）`,
          )
        }
      }
      lines.push('')
    }
  }

  lines.push(`## 规范引用快照（${model.citations.length} 条）`)
  lines.push('')
  if (model.citations.length === 0) {
    lines.push('本次扫描未记录规范引用（纯静态扫描或未命中规范检索）。')
  } else {
    lines.push(
      mdTable(
        ['标题', '版本', '来源', '文本快照（截断）'],
        model.citations.map((c) => [c.title, String(c.version), c.sourceUrl ?? '—', c.textSnapshot]),
      ),
    )
  }
  lines.push('')

  lines.push('## 说明')
  lines.push('')
  for (const note of model.notes) {
    lines.push(`- ${escapeMarkdownCell(note)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/* ---------------- HTML ---------------- */

function htmlTable(headers: string[], rows: string[][]): string {
  const head = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`
  const body = `<tbody>${rows
    .map(
      (cells) =>
        `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody>`
  return `<table>${head}${body}</table>`
}

function htmlKeyValue(rows: Array<[string, string]>): string {
  return `<dl class="meta">${rows
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('')}</dl>`
}

function findingDetailHtml(f: ReportFinding): string {
  const rows: Array<[string, string]> = [['位置', locationText(f)]]
  if (f.symbol) rows.push(['符号', f.symbol])
  rows.push([
    '规则',
    `${f.ruleId ?? '无（AI 结果按类别归组）'}（来源 ${SOURCE_LABEL[f.source] ?? f.source}，证据 ${EVIDENCE_LABEL[f.evidenceStatus] ?? f.evidenceStatus}，反馈 ${FEEDBACK_LABEL[f.feedback] ?? f.feedback}，置信度 ${f.confidence} 为模型自评）`,
  ])
  if (f.condition) rows.push(['触发条件', f.condition])
  if (f.impact) rows.push(['影响', f.impact])
  if (f.reasoningSummary) rows.push(['风险依据', f.reasoningSummary])
  if (f.recommendation) rows.push(['修复建议', f.recommendation])
  if (f.patch) rows.push(['补丁提案', `${f.patch.label}（状态 ${f.patch.status}）`])
  const citationList = f.citations
    .map(
      (c) =>
        `<li>${escapeHtml(c.title)}（版本 ${c.version}${c.sourceUrl ? `，<span class="url">${escapeHtml(c.sourceUrl)}</span>` : ''}）</li>`,
    )
    .join('')
  const relatedList = f.related
    .map(
      (r) =>
        `<li><code>${escapeHtml(`${r.path}:${r.startLine}-${r.endLine}`)}</code><pre>${escapeHtml(r.quote)}</pre></li>`,
    )
    .join('')
  return [
    `<section class="finding severity-${escapeHtml(f.severity)}">`,
    `<h3>${escapeHtml(f.title)}</h3>`,
    htmlKeyValue(rows),
    f.primaryQuote ? `<p class="label">主引用代码</p><pre>${escapeHtml(f.primaryQuote)}</pre>` : '',
    relatedList ? `<p class="label">相关引用</p><ul>${relatedList}</ul>` : '',
    citationList ? `<p class="label">规范引用快照</p><ul>${citationList}</ul>` : '',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n')
}

export function reportToHtml(model: ReportModel): string {
  const scan = model.scan
  const coverage = model.coverage
  const usage = model.usage
  const risk = model.risk

  const coverageHtml = coverage
    ? [
        htmlTable(
          ['文件总数', '可分析', '静态已检查', '忽略', '解析失败'],
          [[
            String(coverage.totalFiles),
            String(coverage.analyzableFiles),
            String(coverage.staticCheckedFiles),
            String(coverage.ignoredFiles),
            String(coverage.parseFailedFiles),
          ]],
        ),
        htmlTable(
          ['AI 审查', '完成状态', '降级原因', '选中文件', '实际读取', '未读取'],
          [[
            coverage.ai.enabled ? '已启用' : '未启用（仅本地静态规则，未外发代码）',
            coverage.ai.enabled ? (coverage.ai.completed ? '完成' : '未完成') : '—',
            coverage.ai.enabled ? (aiDegradedText(coverage.ai.degradedReason) || '无') : '—',
            String(coverage.ai.selectedFiles.length),
            String(coverage.ai.readFiles.length),
            String(coverage.ai.notReadCount),
          ]],
        ),
        `<p class="muted">选择依据：${escapeHtml(coverage.ai.selectionBasis)}</p>`,
      ].join('\n')
    : '<p class="muted">覆盖统计尚未生成。</p>'

  const usageHtml = usage
    ? htmlTable(
        ['Provider', '模型请求', '工具调用', '输入 token（估算）', '输出 token（估算）', '输入 token（实测）', '输出 token（实测）', 'AI 耗时'],
        [[
          usage.provider === 'mock' ? 'mock（非真实模型）' : usage.provider,
          String(usage.modelCalls),
          String(usage.toolCalls),
          String(usage.inputTokensEstimated),
          String(usage.outputTokensEstimated),
          usage.inputTokensMeasured === null ? '—' : String(usage.inputTokensMeasured),
          usage.outputTokensMeasured === null ? '—' : String(usage.outputTokensMeasured),
          `${usage.aiElapsedMs} ms`,
        ]],
      )
    : '<p class="muted">无用量记录（纯静态扫描或未完成）。</p>'

  const riskHtml = risk
    ? [
        `<p class="risk-index">风险指数 <strong>${risk.riskIndex}</strong><span class="muted">（${escapeHtml(risk.formula)}）</span></p>`,
        htmlTable(
          ['严重', '高', '中', '低', '提示（不计分）', '计入指数', '待核查（不计入）', '误报（已剔除）'],
          [[
            String(risk.counts.critical ?? 0),
            String(risk.counts.high ?? 0),
            String(risk.counts.medium ?? 0),
            String(risk.counts.low ?? 0),
            String(risk.counts.info ?? 0),
            String(risk.countedFindings),
            String(risk.needsReview),
            String(risk.falsePositives),
          ]],
        ),
        `<p class="muted">口径：${escapeHtml(risk.note)}</p>`,
      ].join('\n')
    : '<p class="muted">风险指标尚未生成（扫描未完成）。</p>'

  const findingsHtml =
    model.findings.length === 0
      ? '<p class="muted">本次扫描未报告问题。注意：静态规则与 AI 均为启发式检查，未检出问题不代表代码安全。</p>'
      : [
          htmlTable(
            ['严重度', '类别', '来源', '证据状态', '人工反馈', '位置', '标题'],
            model.findings.map((f) => [
              SEVERITY_LABEL[f.severity] ?? f.severity,
              CATEGORY_LABEL[f.category] ?? f.category,
              SOURCE_LABEL[f.source] ?? f.source,
              EVIDENCE_LABEL[f.evidenceStatus] ?? f.evidenceStatus,
              FEEDBACK_LABEL[f.feedback] ?? f.feedback,
              locationText(f),
              f.title,
            ]),
          ),
          ...model.findings.map(findingDetailHtml),
        ].join('\n')

  const citationsHtml =
    model.citations.length === 0
      ? '<p class="muted">本次扫描未记录规范引用（纯静态扫描或未命中规范检索）。</p>'
      : htmlTable(
          ['标题', '版本', '来源', '文本快照（截断）'],
          model.citations.map((c) => [c.title, String(c.version), c.sourceUrl ?? '—', c.textSnapshot]),
        )

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeAtlas 审查报告（扫描 ${escapeHtml(scan.id.slice(0, 8))}）</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2937; margin: 0; padding: 24px; background: #fff; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 8px 0; font-size: 13px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
  th { background: #f3f4f6; }
  dl.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 4px 16px; margin: 8px 0; font-size: 13px; }
  dl.meta > div { display: flex; gap: 6px; }
  dl.meta dt { color: #6b7280; white-space: nowrap; }
  dl.meta dd { margin: 0; overflow-wrap: anywhere; }
  pre { background: #f8f9fb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; font-size: 12px;
        white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; margin: 4px 0 10px; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
  .risk-index strong { font-size: 26px; margin: 0 6px; }
  .muted { color: #6b7280; font-size: 12.5px; }
  .label { font-weight: 600; margin: 8px 0 2px; font-size: 13px; }
  .incomplete { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 10px 12px; font-size: 13px; }
  .finding { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; margin: 10px 0; break-inside: avoid; }
  .finding h3 { margin-top: 0; }
  ul { margin: 4px 0; padding-left: 20px; font-size: 13px; }
  footer { margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 10px; }
  @media print {
    body { padding: 0; font-size: 12px; }
    h2 { break-after: avoid; }
    .finding, table { break-inside: avoid; }
    pre { max-height: none; }
  }
</style>
</head>
<body>
<main>
  <h1>CodeAtlas 审查报告</h1>
  <p class="muted">扫描 ${escapeHtml(scan.id.slice(0, 8))} · 状态 ${escapeHtml(scanStatusLabel(scan.status))}（stage: ${escapeHtml(scan.stage)}）</p>
  ${scan.incompleteReason ? `<p class="incomplete"><strong>未完成说明</strong>：${escapeHtml(scan.incompleteReason)}</p>` : ''}
  <h2>元数据</h2>
  ${htmlKeyValue(metaRows(model))}
  <h2>风险指标</h2>
  ${riskHtml}
  <h2>覆盖</h2>
  ${coverageHtml}
  <h2>模型用量</h2>
  ${usageHtml}
  <h2>问题（${model.findingCount} 条，其中待核查 ${model.needsReviewCount} 条）</h2>
  ${findingsHtml}
  <h2>规范引用快照（${model.citations.length} 条）</h2>
  ${citationsHtml}
  <footer>
    <h2>说明</h2>
    <ul>${model.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
    <p class="muted">本报告为浏览器打印友好的 HTML：使用浏览器「打印 → 另存为 PDF」即可导出 PDF，无需服务端 PDF 引擎。</p>
  </footer>
</main>
</body>
</html>
`
}

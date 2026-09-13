import { describe, it, expect } from 'vitest'
import { compareScans, COMPARE_DISCLAIMER } from '../../src/core/report/compare'
import type { CompareFindingInput, CompareScanInput } from '../../src/core/report/compare'
import {
  exportFilename,
  isExportFormat,
  reportToHtml,
  reportToJson,
  reportToMarkdown,
} from '../../src/core/report/export'
import type { ReportFinding, ReportModel } from '../../src/core/report/model'

/**
 * R07 单测（无 DB）：对比匹配矩阵（行号变化/同名不同问题/未覆盖/重复匹配/改名/
 * 规则与模型版本变化）+ A01 回归（AI 覆盖按问题行段完整覆盖判定：不同读取行段/
 * 完整覆盖/部分重叠/快照变化/combined 来源/模型规则变化）+ 三种导出的转义与结构
 * （Markdown/HTML 注入防护、JSON 一致性）。
 */

/* ---------------- 测试数据工厂 ---------------- */

let seq = 0

function finding(overrides: Partial<CompareFindingInput> = {}): CompareFindingInput {
  seq += 1
  return {
    findingId: `f${seq}`,
    ruleId: null,
    source: 'static',
    evidenceStatus: 'valid',
    feedback: 'unreviewed',
    title: `问题 ${seq}`,
    severity: 'medium',
    category: 'security',
    confidence: 0.9,
    path: 'src/a.ts',
    startLine: 10,
    endLine: 12,
    symbol: null,
    quote: 'const value = transform(input)',
    ...overrides,
  }
}

function scan(overrides: Partial<CompareScanInput> = {}): CompareScanInput {
  return {
    scanId: 'scan-base',
    snapshotId: 'snap-base',
    completed: true,
    modelId: null,
    ruleVersion: 'static-rules-v1',
    promptVersion: 'review-prompt-v1',
    findings: [],
    fileHashes: { 'src/a.ts': 'hash-a' },
    staticCoveredPaths: ['src/a.ts'],
    aiReadFiles: [],
    aiReadLineRanges: {},
    aiEnabled: false,
    ...overrides,
  }
}

/* ---------------- 对比匹配矩阵 ---------------- */

describe('R07 对比匹配（规格 12）', () => {
  it('行号变化但同规则同路径同内容哈希 → 匹配（仍存在），不判新增', () => {
    const base = scan({
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', path: 'src/a.ts', startLine: 10, endLine: 12, symbol: 'run', quote: 'transform(code)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', path: 'src/a.ts', startLine: 30, endLine: 33, symbol: 'run', quote: 'transform(code)' })],
    })
    const out = compareScans(base, target)
    expect(out.counts.persisting).toBe(1)
    expect(out.counts.added).toBe(0)
    expect(out.counts.disappeared).toBe(0)
    expect(out.items[0]!.kind).toBe('persisting')
    expect(out.items[0]!.base!.startLine).toBe(10)
    expect(out.items[0]!.target!.startLine).toBe(30)
  })

  it('同路径同类别但符号/内容不同 → 新增（AI 无 ruleId 按 category 匹配）', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[10, 12]] },
      findings: [finding({ source: 'ai', category: 'security', symbol: 'handlerA', quote: 'fetch(urlA)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      // A01：同一快照重扫且 AI 完整读取旧问题行段（10–12）→ 旧问题才可判未再检出
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[10, 12]] },
      findings: [finding({ source: 'ai', category: 'security', symbol: 'handlerB', quote: 'fetch(urlB)' })],
    })
    const out = compareScans(base, target)
    expect(out.counts.added).toBe(1)
    expect(out.counts.persisting).toBe(0)
    // 旧问题行段被 AI 完整读取但内容不同 → 未再检出（不是新增的一部分）
    expect(out.counts.disappeared).toBe(1)
    expect(out.items.find((i) => i.kind === 'added')!.target!.symbol).toBe('handlerB')
  })

  it('旧问题所在文件本次未被覆盖 → 不可比较，不得算未再检出', () => {
    const base = scan({
      fileHashes: { 'src/a.ts': 'hash-a', 'src/gone.ts': 'hash-g' },
      findings: [finding({ ruleId: 'hardcoded-secret', path: 'src/gone.ts', quote: 'sk-abc' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      // 目标快照不含 src/gone.ts
      fileHashes: { 'src/a.ts': 'hash-a' },
      staticCoveredPaths: ['src/a.ts'],
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.incomparable).toBe(1)
    expect(out.counts.disappeared).toBe(0)
    expect(out.items[0]!.reason).toContain('未覆盖')
    expect(out.items[0]!.reason).toContain('不得算「未再检出」')
    // 快照不同 → 有范围提示
    expect(out.scopeNote).toContain('不同快照')
  })

  it('重复匹配（两条新报对一条旧报）→ 全部标不可比较', () => {
    const base = scan({
      findings: [finding({ ruleId: 'jsx-key', path: 'src/a.ts', quote: 'items.map(it => <li>{it}</li>)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      findings: [
        finding({ ruleId: 'jsx-key', path: 'src/a.ts', quote: 'items.map(it => <li>{it}</li>)' }),
        finding({ ruleId: 'jsx-key', path: 'src/a.ts', quote: 'items.map(it => <li>{it}</li>)' }),
      ],
    })
    const out = compareScans(base, target)
    expect(out.counts.persisting).toBe(0)
    expect(out.counts.incomparable).toBe(3)
    for (const item of out.items) {
      expect(item.kind).toBe('incomparable')
      expect(item.reason).toContain('重复匹配')
    }
  })

  it('文件改名+整文件内容哈希一致 → 识别为同一问题（仍存在，附改名说明）', () => {
    const base = scan({
      fileHashes: { 'src/old.ts': 'hash-same' },
      staticCoveredPaths: ['src/old.ts'],
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', path: 'src/old.ts', quote: 'transform(code)', symbol: 'run' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      fileHashes: { 'src/new.ts': 'hash-same' },
      staticCoveredPaths: ['src/new.ts'],
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', path: 'src/new.ts', quote: 'transform(code)', symbol: 'run' })],
    })
    const out = compareScans(base, target)
    expect(out.counts.persisting).toBe(1)
    expect(out.counts.disappeared).toBe(0)
    expect(out.counts.added).toBe(0)
    expect(out.items[0]!.renamedFrom).toBe('src/old.ts')
    expect(out.items[0]!.target!.path).toBe('src/new.ts')
  })

  it('文件改名但内容也变化（哈希不一致）→ 不自动识别改名', () => {
    const base = scan({
      fileHashes: { 'src/old.ts': 'hash-old' },
      staticCoveredPaths: ['src/old.ts'],
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', path: 'src/old.ts', quote: 'transform(code)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      fileHashes: { 'src/new.ts': 'hash-new' },
      staticCoveredPaths: ['src/new.ts'],
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', path: 'src/new.ts', quote: 'transform(newCode)' })],
    })
    const out = compareScans(base, target)
    expect(out.counts.persisting).toBe(0)
    expect(out.counts.added).toBe(1)
    // 旧文件未覆盖 → 不可比较（不冒充未再检出）
    expect(out.counts.incomparable).toBe(1)
  })

  it('规则版本不同 → 全体不可直接比较提示（comparable=false）', () => {
    const base = scan({
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', quote: 'transform(code)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      ruleVersion: 'static-rules-v2',
      findings: [finding({ ruleId: 'sec/dynamic-code-exec', quote: 'transform(code)' })],
    })
    const out = compareScans(base, target)
    expect(out.comparable).toBe(false)
    expect(out.configDifferences.join('\n')).toContain('规则版本不同')
    expect(out.configDifferences.join('\n')).toContain('不可直接比较')
    expect(out.disclaimer).toBe(COMPARE_DISCLAIMER)
  })

  it('模型版本不同 → 全体不可直接比较提示；提示词版本同理', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      findings: [finding({ source: 'ai', quote: 'q1' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      modelId: 'gpt-b',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      promptVersion: 'review-prompt-v2',
      findings: [finding({ source: 'ai', quote: 'q1' })],
    })
    const out = compareScans(base, target)
    expect(out.comparable).toBe(false)
    const joined = out.configDifferences.join('\n')
    expect(joined).toContain('模型不同')
    expect(joined).toContain('提示词版本不同')
  })

  it('AI 问题要求 AI 实际读取覆盖：目标未启用 AI → 不可比较，不算未再检出', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      findings: [finding({ source: 'ai', quote: 'q1' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      modelId: null,
      aiEnabled: false,
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.disappeared).toBe(0)
    expect(out.counts.incomparable).toBe(1)
    expect(out.comparable).toBe(false)
  })

  it('目标扫描未完成（失败/取消/进行中）→ 全部旧问题不可比较', () => {
    const base = scan({
      findings: [finding({ quote: 'q' }), finding({ quote: 'q2', path: 'src/a.ts' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      completed: false,
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.incomparable).toBe(2)
    expect(out.counts.disappeared).toBe(0)
    for (const item of out.items) expect(item.reason).toContain('未完成')
  })

  it('同一扫描自比 → 全部仍存在', () => {
    const shared = scan({
      findings: [
        finding({ ruleId: 'sec/dynamic-code-exec', quote: 'q1', path: 'src/a.ts' }),
        finding({ ruleId: 'jsx-key', quote: 'q2', path: 'src/a.ts', startLine: 40, endLine: 42 }),
      ],
    })
    const out = compareScans(shared, { ...shared, scanId: 'scan-base' })
    expect(out.counts.persisting).toBe(2)
    expect(out.scopeNote).toBeNull()
  })
})

/* ---------------- A01 回归：AI 覆盖按问题行段完整覆盖判定 ---------------- */

describe('A01 回归：AI 覆盖按问题行段完整覆盖判定', () => {
  it('同文件不同读取行段：目标只读了 1–5 行，旧问题在第 100 行 → 不可比较，不得算未再检出', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[96, 105]] },
      findings: [finding({ source: 'ai', symbol: 'render', quote: 'node.innerHTML = input;', startLine: 100, endLine: 100 })],
    })
    const target = scan({
      scanId: 'scan-target',
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[1, 5]] },
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.incomparable).toBe(1)
    expect(out.counts.disappeared).toBe(0)
    expect(out.items[0]!.kind).toBe('incomparable')
    expect(out.items[0]!.reason).toContain('未完整读取')
  })

  it('完整覆盖才允许未再检出：不连续多段读取合并后完整覆盖问题行段', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[90, 110]] },
      findings: [finding({ source: 'ai', symbol: 'render', quote: 'node.innerHTML = input;', startLine: 98, endLine: 102 })],
    })
    const target = scan({
      scanId: 'scan-target',
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      // 读取 [1,50] 与 [96,105] 两段（不连续），问题 98–102 完整落在合并区间内
      aiReadLineRanges: { 'src/a.ts': [[1, 50], [96, 105]] },
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.disappeared).toBe(1)
    expect(out.counts.incomparable).toBe(0)
  })

  it('仅部分重叠：问题行段（3–7）跨越读取边界（仅 1–5 被读）→ 不可比较', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[1, 12]] },
      findings: [finding({ source: 'ai', symbol: 'render', quote: 'node.innerHTML = input;', startLine: 3, endLine: 7 })],
    })
    const target = scan({
      scanId: 'scan-target',
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[1, 5]] },
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.incomparable).toBe(1)
    expect(out.counts.disappeared).toBe(0)
    expect(out.items[0]!.reason).toContain('未完整读取')
  })

  it('快照变化/插入行：行号不可映射 → 保守归不可比较（即使目标读取行段覆盖同号行）', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[96, 105]] },
      findings: [finding({ source: 'ai', symbol: 'render', quote: 'node.innerHTML = input;', startLine: 100, endLine: 100 })],
    })
    const target = scan({
      scanId: 'scan-target',
      // 插入行产生新快照：旧行号无法映射，不能凭同号行段判覆盖
      snapshotId: 'snap-target',
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[96, 105]] },
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.incomparable).toBe(1)
    expect(out.counts.disappeared).toBe(0)
    expect(out.items[0]!.reason).toContain('行号无法映射')
    expect(out.scopeNote).toContain('不同快照')
  })

  it('combined 来源按静态口径：文件在静态覆盖列表 → 未再检出（与 AI 是否读取无关）', () => {
    const base = scan({
      findings: [finding({ source: 'combined', ruleId: 'sec/dynamic-code-exec', quote: 'transform(code)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      // 目标未启用 AI：combined 起源于静态命中，按静态覆盖判定即可
      aiEnabled: false,
      aiReadFiles: [],
      aiReadLineRanges: {},
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.disappeared).toBe(1)
    expect(out.counts.incomparable).toBe(0)
  })

  it('combined 来源：文件不在静态覆盖列表（未收录/解析失败）→ 不可比较', () => {
    const base = scan({
      findings: [finding({ source: 'combined', ruleId: 'sec/dynamic-code-exec', quote: 'transform(code)' })],
    })
    const target = scan({
      scanId: 'scan-target',
      snapshotId: 'snap-target',
      fileHashes: {},
      staticCoveredPaths: [],
      findings: [],
    })
    const out = compareScans(base, target)
    expect(out.counts.incomparable).toBe(1)
    expect(out.counts.disappeared).toBe(0)
    expect(out.items[0]!.reason).toContain('未覆盖')
  })

  it('模型/规则变化：仍给出参考分类，且 comparable=false 明示不可直接比较', () => {
    const base = scan({
      modelId: 'gpt-a',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[96, 105]] },
      findings: [finding({ source: 'ai', symbol: 'render', quote: 'node.innerHTML = input;', startLine: 100, endLine: 100 })],
    })
    const target = scan({
      scanId: 'scan-target',
      modelId: 'gpt-b',
      ruleVersion: 'static-rules-v2',
      aiEnabled: true,
      aiReadFiles: ['src/a.ts'],
      aiReadLineRanges: { 'src/a.ts': [[1, 105]] },
      findings: [],
    })
    const out = compareScans(base, target)
    // 版本不同仅提示，参考分类仍按覆盖判定：问题行段被完整读取 → 未再检出
    expect(out.counts.disappeared).toBe(1)
    expect(out.comparable).toBe(false)
    const joined = out.configDifferences.join('\n')
    expect(joined).toContain('模型不同')
    expect(joined).toContain('规则版本不同')
  })
})

/* ---------------- 报告模型工厂（导出测试） ---------------- */

function reportFinding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    id: 'finding-1',
    ruleId: 'html-injection',
    source: 'static',
    evidenceStatus: 'valid',
    feedback: 'unreviewed',
    title: '普通问题标题',
    severity: 'high',
    category: 'security',
    confidence: 0.9,
    path: 'src/App.tsx',
    startLine: 2,
    endLine: 3,
    symbol: 'App',
    condition: 'bio 为外部输入',
    impact: '脚本执行',
    reasoningSummary: '命中危险 sink',
    recommendation: '净化输入',
    primaryQuote: 'return <div dangerouslySetInnerHTML={{ __html: bio }} />',
    related: [],
    citations: [],
    patch: null,
    ...overrides,
  }
}

function model(overrides: Partial<ReportModel> = {}): ReportModel {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-13T00:00:00.000Z',
    scan: {
      id: '12345678-9abc-def0-1234-56789abcdef0',
      snapshotId: 'snap-1',
      projectId: 'proj-1',
      projectName: '演示项目',
      status: 'partial',
      stage: 'report',
      config: { enableCloudAI: true, mode: 'standard' },
      ruleVersion: 'static-rules-v1',
      promptVersion: 'review-prompt-v1',
      modelId: 'gpt-test',
      startedAt: '2026-09-13T00:00:00.000Z',
      completedAt: '2026-09-13T00:01:00.000Z',
      createdAt: '2026-09-13T00:00:00.000Z',
      errorText: null,
      incompleteReason: '扫描部分完成：AI 阶段未完成（budget_exceeded）',
    },
    risk: {
      riskIndex: 14,
      counts: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
      countedFindings: 2,
      needsReview: 1,
      falsePositives: 0,
      formula: 'riskIndex = min(100, 20×critical + 10×high + 4×medium + low)',
      note: '仅计入证据有效、非误报、非低置信待核查的去重结果；info 不计分',
    },
    severityCounts: { critical: 0, high: 1, medium: 1, low: 0, info: 0, total: 2 },
    findingCount: 2,
    needsReviewCount: 1,
    coverage: {
      totalFiles: 5,
      analyzableFiles: 4,
      ignoredFiles: 1,
      parseFailedFiles: 0,
      staticCheckedFiles: 4,
      ai: {
        enabled: true,
        completed: false,
        degradedReason: 'budget_exceeded',
        selectedFiles: ['src/App.tsx'],
        readFiles: ['src/App.tsx'],
        readLineRanges: { 'src/App.tsx': [[1, 3]] },
        notReadCount: 3,
        selectionBasis: '按静态候选风险优先',
      },
    },
    usage: {
      provider: 'mock',
      modelId: 'gpt-test',
      modelCalls: 2,
      toolCalls: 3,
      inputTokensEstimated: 1200,
      outputTokensEstimated: 300,
      inputTokensMeasured: 1111,
      outputTokensMeasured: 222,
      aiElapsedMs: 4000,
    },
    citations: [],
    notes: ['说明 A'],
    findings: [
      reportFinding(),
      reportFinding({
        id: 'finding-2',
        ruleId: null,
        source: 'ai',
        evidenceStatus: 'needs_review',
        title: '正常 AI 问题',
        severity: 'medium',
        category: 'correctness',
        path: 'src/b.ts',
        startLine: 1,
        endLine: 1,
        symbol: null,
        primaryQuote: 'const x = 1',
        patch: {
          patchId: 'patch-1',
          status: 'proposed',
          applicable: true,
          syntax: 'pass',
          provider: 'mock',
          label: '有效提案（可下载 .patch，未执行测试）',
        },
        citations: [{ title: '规范 A', version: 3, sourceUrl: 'https://example.com/a', textSnapshot: '快照文本' }],
      }),
    ],
    ...overrides,
  }
}

/* ---------------- 导出：JSON ---------------- */

describe('R07 导出 JSON', () => {
  it('与 ReportModel 字段一致（数量、覆盖、风险、findings）', () => {
    const m = model()
    const parsed = JSON.parse(reportToJson(m)) as ReportModel
    expect(parsed).toEqual(m)
    expect(parsed.findingCount).toBe(parsed.findings.length)
    expect(parsed.severityCounts.total).toBe(2)
    expect(parsed.coverage!.staticCheckedFiles).toBe(4)
    expect(parsed.findings[1]!.patch!.status).toBe('proposed')
  })

  it('格式识别与附件文件名（含 scan 短 id）', () => {
    expect(isExportFormat('json')).toBe(true)
    expect(isExportFormat('markdown')).toBe(true)
    expect(isExportFormat('html')).toBe(true)
    expect(isExportFormat('pdf')).toBe(false)
    expect(exportFilename('12345678-9abc-def0-1234-56789abcdef0', 'markdown')).toBe(
      'codeatlas-report-12345678.md',
    )
    expect(exportFilename('12345678-9abc-def0-1234-56789abcdef0', 'html')).toBe(
      'codeatlas-report-12345678.html',
    )
  })
})

/* ---------------- 导出：Markdown 转义 ---------------- */

describe('R07 导出 Markdown 转义', () => {
  it('标题/字段中的注入字符被转义（尖括号、竖线、反引号、方括号）', () => {
    const evil = '<script>alert(1)</script> | `rm -rf` [x](https://evil.example) *y*'
    const m = model({
      findings: [
        reportFinding({
          title: evil,
          condition: 'a | b <c> `d`',
          recommendation: 'click [here](https://evil.example)',
        }),
      ],
      findingCount: 1,
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0, total: 1 },
      needsReviewCount: 0,
    })
    const md = reportToMarkdown(m)
    // 不存在未转义的危险序列
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('[x](https://evil.example)')
    // 注入字符被逐个转义
    expect(md).toContain('\\<script\\>')
    expect(md).toContain('\\|')
    expect(md).toContain('\\`rm -rf\\`')
    expect(md).toContain('\\[x\\]')
    // 表格行数完整（竖线被转义后标题不会拆列）：标题出现在表格行内
    const tableRow = md.split('\n').find((l) => l.startsWith('| 高 |') && l.includes('script'))
    expect(tableRow).toBeDefined()
    // 表格行数完整：标题中的竖线被转义为 \| 后不再拆列（按未转义竖线计数）
    const unescapedPipes = tableRow!.split(/(?<!\\)\|/).length
    expect(unescapedPipes).toBe(9) // 7 列 → 8 条分隔 + 1
  })

  it('代码引用中的三连反引号不会提前闭合围栏', () => {
    const m = model({
      findings: [reportFinding({ primaryQuote: 'const tpl = ```inline```;' })],
      findingCount: 1,
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0, total: 1 },
      needsReviewCount: 0,
    })
    const md = reportToMarkdown(m)
    const fences = md.split('\n').filter((l) => /^`{3,}$/.test(l))
    // 至少一条围栏长度 > 3（长于内容中最长反引号串）
    expect(fences.some((l) => l.length > 3)).toBe(true)
  })
})

/* ---------------- 导出：HTML 转义 ---------------- */

describe('R07 导出 HTML 净化', () => {
  it('所有动态内容被 HTML 转义，无未转义 <script>', () => {
    const evilTitle = '<script>window.__pwned=1</script>'
    const evilQuote = '</pre><script>alert(1)</script><img src=x onerror=alert(2)>'
    const m = model({
      scan: {
        ...model().scan,
        projectName: `<b>${evilTitle}</b>`,
        errorText: evilTitle,
      },
      findings: [
        reportFinding({ title: evilTitle, primaryQuote: evilQuote, condition: '<img onerror=x>' }),
      ],
      findingCount: 1,
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0, total: 1 },
      needsReviewCount: 0,
      citations: [
        { title: evilTitle, version: 1, sourceUrl: 'javascript:alert(3)', textSnapshot: '<script>x</script>' },
      ],
    })
    const html = reportToHtml(m)
    expect(html).not.toMatch(/<script>/)
    expect(html).toContain('&lt;script&gt;window.__pwned=1&lt;/script&gt;')
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;')
    expect(html).toContain('&lt;img onerror=x&gt;')
    expect(html).toContain('javascript:alert(3)'.replace(/'/g, '&#39;'))
  })

  it('包含覆盖/风险/待核查/降级说明与打印样式（长代码不撑破布局）', () => {
    const m = model()
    const html = reportToHtml(m)
    expect(html).toContain('覆盖')
    expect(html).toContain('风险指标')
    expect(html).toContain('待核查')
    expect(html).toContain('预算耗尽，已保留已有结果')
    expect(html).toContain('扫描部分完成：AI 阶段未完成（budget_exceeded）')
    // 打印友好：pre-wrap + break 规则，长代码换行不撑破；@media print 存在
    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain('overflow-wrap: anywhere')
    expect(html).toContain('@media print')
    expect(html).toContain('lang="zh-CN"')
  })
})

/* ---------------- 导出一致性：JSON / Markdown / HTML 同一模型 ---------------- */

describe('R07 导出一致性（T10：三种格式数字一致）', () => {
  it('问题数量、覆盖数字、风险指数在三种导出中一致', () => {
    const m = model()
    const json = reportToJson(m)
    const md = reportToMarkdown(m)
    const html = reportToHtml(m)

    expect(md).toContain(`## 问题（${m.findingCount} 条，其中待核查 ${m.needsReviewCount} 条）`)
    expect(html).toContain(`问题（${m.findingCount} 条，其中待核查 ${m.needsReviewCount} 条）`)
    expect(JSON.parse(json).findingCount).toBe(m.findingCount)

    // 覆盖：静态已检查 4、AI 未读取 3、风险指数 14 在三种导出中一致
    expect(json).toContain('"staticCheckedFiles": 4')
    expect(json).toContain('"notReadCount": 3')
    expect(md).toContain('| 4 |')
    expect(md).toContain('风险指数 |')
    expect(html).toContain('<strong>14</strong>')
    expect(html).toContain('4') // 覆盖表格中的静态已检查
    for (const out of [json, md, html]) {
      expect(out).toContain('待核查')
    }
    expect(json).toContain('budget_exceeded') // JSON 保留原始降级码
    expect(html).toContain('budget_exceeded') // 未完成原因明示
    expect(md).toContain('budget\\_exceeded') // Markdown 转义下划线后仍可读
    expect(md).toContain('预算耗尽，已保留已有结果') // 降级原因以中文说明呈现
    expect(html).toContain('预算耗尽，已保留已有结果')
  })
})

// Acceptance probes: read-only pure-function checks; no application mutations or model calls.
import { compareScans, type CompareFindingInput, type CompareScanInput } from '../../src/core/report/compare'
import { compareSyntax } from '../../src/core/patch/syntax'
import { isDownloadable } from '../../src/core/patch/diff'
import { Budget } from '../../src/core/review/budget'

const finding: CompareFindingInput = {
  findingId: 'finding', ruleId: null, source: 'ai', evidenceStatus: 'valid',
  feedback: 'unreviewed', title: 'risk', severity: 'high', category: 'security',
  confidence: 0.9, path: 'a.ts', startLine: 100, endLine: 100,
  symbol: 'render', quote: 'node.innerHTML = input;',
}
const base: CompareScanInput = {
  scanId: 'base', snapshotId: 'same', completed: true, modelId: 'test',
  ruleVersion: 'v1', promptVersion: 'v1', findings: [finding],
  fileHashes: { 'a.ts': 'same-content' }, staticCoveredPaths: [],
  aiReadFiles: ['a.ts'], aiEnabled: true,
  aiReadLineRanges: { 'a.ts': [[96, 105]] },
}
// Target read only lines 1..5; the old finding spans line 100 and must be incomparable.
const target: CompareScanInput = { ...base, scanId: 'target', findings: [], aiReadLineRanges: { 'a.ts': [[1, 5]] } }

// A01 probe is assert-style: pass/fail is printed here; the exit code is decided at the end
// of the file. A02 and A03 are also assert-style (fixed).
const aiUnreadRangeActual = compareScans(base, target).items[0]?.kind ?? null
if (aiUnreadRangeActual === 'incomparable') {
  console.log(JSON.stringify({ probe: 'ai-unread-range', expected: 'incomparable', actual: aiUnreadRangeActual, pass: true }))
} else {
  console.log(JSON.stringify({
    probe: 'ai-unread-range', expected: 'incomparable', actual: aiUnreadRangeActual, pass: false,
    diff: '旧问题行段 [100,100] 未被目标 AI 读取行段 [[1,5]] 完整覆盖，应判 incomparable（不可比较），不得判 disappeared（未再检出）',
  }))
}

// A02 probe is assert-style: replacing one syntax error with another (count unchanged,
// patched signatures a subset of baseline) must NOT be downloadable as a verified proposal —
// baseline_failed is the conservative "cannot prove no regression" state and is blocked.
const a02Syntax = compareSyntax('ts', 'a.ts', 'const a = ;\nconst b = 1;', 'const a = 1;\nconst b = ;')
const a02Downloadable = isDownloadable({ applicable: true, syntax: a02Syntax.status })
if (!a02Downloadable) {
  console.log(JSON.stringify({
    probe: 'replace-old-syntax-error-with-new', expected: 'not-downloadable', pass: true,
    actual: {
      status: a02Syntax.status, baselineErrors: a02Syntax.baselineErrors,
      patchedErrors: a02Syntax.patchedErrors, newSignatures: a02Syntax.newSignatures,
    },
  }))
} else {
  console.log(JSON.stringify({
    probe: 'replace-old-syntax-error-with-new', expected: 'not-downloadable', pass: false,
    actual: { status: a02Syntax.status, baselineErrors: a02Syntax.baselineErrors, patchedErrors: a02Syntax.patchedErrors },
    diff: '修好旧行、破坏新行（错误数不变且补丁后签名为基线子集）时，必须以保守状态（baseline_failed）阻止其作为已验证提案下载，不得因「数量未增加」放行',
  }))
}

// A03 probe is assert-style (fixed): measured output over the limit must block
// further calls (canModelCall false) AND the next call must not be prepared
// (prepareModelCall rejects — no "input + output cap" reservation possible).
const budget = new Budget({ maxInputTokens: 100, maxOutputTokens: 10 })
budget.recordModelCall(99, 0, { input: 99, output: 1000 })
const a03Prepared = budget.prepareModelCall(1, 1)
const a03CanCall = budget.canModelCall()
const a03Pass = a03Prepared.ok === false && a03CanCall === false
if (a03Pass) {
  console.log(JSON.stringify({
    probe: 'measured-output-over-limit-and-next-input-not-reserved', expected: false, actual: a03CanCall, pass: true,
    detail: { prepared: a03Prepared.ok, exhaustedReason: budget.exhaustedReason },
  }))
} else {
  console.log(JSON.stringify({
    probe: 'measured-output-over-limit-and-next-input-not-reserved', expected: false, actual: a03CanCall, pass: false,
    diff: '已实测输出 1000 超过输出上限 10 时：canModelCall 必须为 false，且 prepareModelCall（本次输入+输出预留）必须拒绝，不得继续调用',
  }))
}

// A01/A02/A03 assertions: exit 0 when behavior matches expectations, non-zero otherwise (diffs printed above).
if (aiUnreadRangeActual !== 'incomparable' || a02Downloadable || !a03Pass) process.exit(1)

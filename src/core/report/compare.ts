import type {
  Category,
  EvidenceStatus,
  Feedback,
  Severity,
  SourceLabel,
} from '@/core/contracts/findings'
import { isFullyCovered, mergeRanges } from '@/core/review/validate'

/**
 * 快照对比（R07，规格 12；A01 修复行段覆盖口径）：
 * - 匹配键 = 规则/类别（ruleId 优先，否则 category）+ 规范化相对路径 + 符号名 + 去空白局部代码哈希；
 *   不依赖行号（行号变化不等于新问题）。
 * - 重复匹配（一对多/多对一）标不可比较；文件改名仅当整文件内容哈希一致才自动识别。
 * - 旧问题本次未被覆盖时归入不可比较，不得算「未再检出」。覆盖口径（coverageVerdict）：
 *   · AI 来源 = 问题 [startLine,endLine] 被 AI 实际读取行段（合并后）**完整覆盖**，
 *     仅「读过该文件」不算覆盖；行号只在两次扫描同一快照时可用（快照内容不可变，行号稳定），
 *     快照不同时行号不可映射 → 保守归不可比较；
 *   · static 与 combined 来源 = 目标快照「收录且可分析且解析成功」的文件（静态口径，文件级）。
 * - 「未再检出」仅表示该次结果变化，不是已验证修复（COMPARE_DISCLAIMER）。
 */

/** 固定说明：UI 与导出都必须原样展示（不得表述为「已修复」） */
export const COMPARE_DISCLAIMER =
  '「未再检出」仅表示本次扫描未再报告该问题（AI 审查存在随机性、规则覆盖有限），不等于已验证修复；请以人工复核与真实测试为准。'

export type CompareChangeKind = 'added' | 'persisting' | 'disappeared' | 'incomparable'

export const COMPARE_KIND_LABEL: Record<CompareChangeKind, string> = {
  added: '新增',
  persisting: '仍存在',
  disappeared: '未再检出',
  incomparable: '不可比较',
}

/** 对比输入：单条问题（quote 参与去空白哈希，行号不参与匹配） */
export interface CompareFindingInput {
  findingId: string
  ruleId: string | null
  source: SourceLabel
  evidenceStatus: EvidenceStatus
  feedback: Feedback
  title: string
  severity: Severity
  category: Category
  confidence: number
  path: string
  startLine: number
  endLine: number
  symbol: string | null
  quote: string
}

export interface CompareScanInput {
  scanId: string
  snapshotId: string
  /** 扫描是否到达产出覆盖的终态（completed/partial）；未完成时旧问题全部不可比较 */
  completed: boolean
  modelId: string | null
  ruleVersion: string
  promptVersion: string
  findings: CompareFindingInput[]
  /** 快照内文件 path → 整文件内容哈希（文件改名识别依据） */
  fileHashes: Record<string, string>
  /** 本次静态规则实际覆盖（收录、可分析、解析成功）的相对路径 */
  staticCoveredPaths: string[]
  /** AI 阶段实际读取过的相对路径（未启用 AI 时为空）。仅供展示/兼容，覆盖判定以下一行段合同为准 */
  aiReadFiles: string[]
  /** AI 阶段实际读取的行段（相对路径 → [起始行, 结束行] 列表，来自 coverage.ai.readLineRanges） */
  aiReadLineRanges: Record<string, Array<[number, number]>>
  aiEnabled: boolean
}

export interface CompareFindingView {
  findingId: string
  scanId: string
  ruleId: string | null
  source: SourceLabel
  evidenceStatus: EvidenceStatus
  feedback: Feedback
  title: string
  severity: Severity
  category: Category
  path: string
  startLine: number
  endLine: number
  symbol: string | null
}

export interface CompareItem {
  kind: CompareChangeKind
  base: CompareFindingView | null
  target: CompareFindingView | null
  /** persisting 且识别为文件改名：旧路径（新路径见 target.path） */
  renamedFrom: string | null
  /** incomparable 的原因说明 */
  reason: string | null
}

export interface CompareOutcome {
  baseScanId: string
  targetScanId: string
  /** 模型/规则/提示词版本一致（整体可直接比较）；不同时仅提示，仍给出参考分类 */
  comparable: boolean
  configDifferences: string[]
  /** 快照范围不同的提示（扫描范围不同不影响逐条覆盖判定，但需明示） */
  scopeNote: string | null
  counts: Record<CompareChangeKind, number>
  items: CompareItem[]
  disclaimer: string
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

const REASON_DUPLICATE = '重复匹配：同一问题在另一次扫描中被多条结果对应，无法建立一一对应，标为不可比较'
const REASON_NOT_COVERED =
  '该问题所在文件/行段本次扫描未覆盖（未收录、解析失败或 AI 未完整读取该问题行段），归入不可比较，不得算「未再检出」'
const REASON_LINE_UNMAPPABLE =
  '两次扫描基于不同快照，旧 AI 问题的行号无法映射到本次 AI 实际读取的行段，无法确认覆盖，归入不可比较，不得算「未再检出」'
const REASON_TARGET_INCOMPLETE = '对比目标扫描未完成（仍在进行、失败或已取消），覆盖信息不足，不能判定「未再检出」'

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 去空白局部代码哈希：quote 去除全部空白后取双路 64 位确定哈希
 * （FNV-1a 与 djb2 变体，各 32 位拼接；不依赖 node:crypto，客户端/服务端结果一致，
 * 亦便于把对比逻辑复用在浏览器侧）。稳定性需求 > 抗碰撞性需求：键还叠加规则/路径/符号。
 */
function quoteHash(quote: string): string {
  const text = quote.replace(/\s+/g, '')
  let fnv = 0x811c9dc5
  let djb = 5381
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    fnv ^= code
    fnv = Math.imul(fnv, 0x01000193) >>> 0
    djb = (Math.imul(djb, 33) ^ code) >>> 0
  }
  return `${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`
}

/** 匹配键：规则（否则类别）+ 规范化相对路径 + 符号名 + 去空白代码哈希 */
function matchKeyOf(f: CompareFindingInput, pathOverride?: string): string {
  return [
    f.ruleId ?? `category:${f.category}`,
    normalizePath(pathOverride ?? f.path),
    f.symbol ?? '',
    quoteHash(f.quote),
  ].join('\n')
}

function toView(f: CompareFindingInput, scanId: string): CompareFindingView {
  return {
    findingId: f.findingId,
    scanId,
    ruleId: f.ruleId,
    source: f.source,
    evidenceStatus: f.evidenceStatus,
    feedback: f.feedback,
    title: f.title,
    severity: f.severity,
    category: f.category,
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    symbol: f.symbol,
  }
}

function fmtModelId(m: string | null): string {
  return m ?? '未启用云端 AI'
}

/** 目标扫描的 AI 实际读取行段（键为规范化相对路径，同文件多段合并收集） */
function normalizedAiRanges(scan: CompareScanInput): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>()
  for (const [path, ranges] of Object.entries(scan.aiReadLineRanges)) {
    if (!Array.isArray(ranges) || ranges.length === 0) continue
    const key = normalizePath(path)
    const list = map.get(key)
    if (list) list.push(...ranges)
    else map.set(key, [...ranges])
  }
  return map
}

interface CoverageVerdict {
  covered: boolean
  reason: string | null
}

/**
 * 目标扫描对某条旧问题的覆盖判定（A01：按来源分口径）。
 * - ai：AI 阶段必须启用，且问题 [startLine,endLine] 被该文件 AI 实际读取行段（区间合并后）
 *   **完整覆盖**（复用 review/validate 的 mergeRanges/isFullyCovered，仅交集不算覆盖）。
 *   行号判定只在 base 与 target 为**同一快照**时进行——快照内容不可变，基座行号稳定可用；
 *   快照不同时行号不可映射（插入/删除行会平移），无法确认覆盖 → 保守归不可比较。
 *   仅影响「未匹配旧问题判 disappeared 还是 incomparable」，匹配成功（persisting）不受影响。
 * - combined：combined 起源于静态规则命中（AI 只在静态候选上补充上下文/确认后合并），
 *   静态阶段总是对全部「收录且可分析且解析成功」的文件运行，与 AI 是否读取无关，
 *   因此 combined 与 static 同口径：按目标快照静态覆盖文件列表做文件级判定。
 * - static：目标快照收录且可分析且解析成功（文件级）。
 */
function coverageVerdict(
  f: CompareFindingInput,
  base: CompareScanInput,
  target: CompareScanInput,
): CoverageVerdict {
  const path = normalizePath(f.path)
  if (f.source === 'ai') {
    if (!target.aiEnabled) return { covered: false, reason: REASON_NOT_COVERED }
    if (base.snapshotId !== target.snapshotId) {
      return { covered: false, reason: REASON_LINE_UNMAPPABLE }
    }
    const ranges = normalizedAiRanges(target).get(path)
    if (!ranges || ranges.length === 0) return { covered: false, reason: REASON_NOT_COVERED }
    const covered = isFullyCovered(f.startLine, f.endLine, mergeRanges(ranges))
    return covered ? { covered: true, reason: null } : { covered: false, reason: REASON_NOT_COVERED }
  }
  // static / combined：combined 定义与理由见函数头注释（静态口径）
  const covered = target.staticCoveredPaths.map(normalizePath).includes(path)
  return covered ? { covered: true, reason: null } : { covered: false, reason: REASON_NOT_COVERED }
}

/**
 * 对比两个扫描（同一项目）：四类变化 + 可比性信息。纯函数，无 DB 依赖。
 * 匹配三遍：①完全键一对一；②文件改名（整文件哈希一致）重键匹配；③剩余按覆盖判定。
 */
export function compareScans(base: CompareScanInput, target: CompareScanInput): CompareOutcome {
  const configDifferences: string[] = []
  if (base.ruleVersion !== target.ruleVersion) {
    configDifferences.push(
      `规则版本不同（${base.ruleVersion} → ${target.ruleVersion}），结果不可直接比较：规则增删本身就会改变检出结果`,
    )
  }
  if (base.promptVersion !== target.promptVersion) {
    configDifferences.push(
      `提示词版本不同（${base.promptVersion} → ${target.promptVersion}），结果不可直接比较：AI 判定口径可能变化`,
    )
  }
  if ((base.modelId ?? null) !== (target.modelId ?? null)) {
    configDifferences.push(
      `模型不同（${fmtModelId(base.modelId)} → ${fmtModelId(target.modelId)}），结果不可直接比较`,
    )
  }
  const comparable = configDifferences.length === 0
  const scopeNote =
    base.snapshotId === target.snapshotId
      ? null
      : '两次扫描基于不同快照：扫描范围可能不同。仅对本次扫描覆盖到的文件判定「未再检出」，未覆盖的旧问题归入不可比较。'

  const items: CompareItem[] = []
  const baseItems = base.findings.map((f) => ({ f, claimed: false, handled: false }))
  const targetItems = target.findings.map((f) => ({ f, claimed: false, handled: false }))

  const groupBy = (rows: Array<{ f: CompareFindingInput }>) => {
    const map = new Map<string, number[]>()
    rows.forEach((r, i) => {
      const key = matchKeyOf(r.f)
      const list = map.get(key)
      if (list) list.push(i)
      else map.set(key, [i])
    })
    return map
  }
  const baseByKey = groupBy(baseItems)
  const targetByKey = groupBy(targetItems)

  /* 第一遍：完全键。恰好一对一 → 仍存在；一对多/多对一 → 全部标不可比较（重复匹配）。 */
  for (const [key, baseIdxs] of baseByKey) {
    const targetIdxs = targetByKey.get(key) ?? []
    if (targetIdxs.length === 0) continue
    if (baseIdxs.length === 1 && targetIdxs.length === 1) {
      const b = baseItems[baseIdxs[0]!]!
      const t = targetItems[targetIdxs[0]!]!
      b.claimed = true
      b.handled = true
      t.claimed = true
      t.handled = true
      items.push({
        kind: 'persisting',
        base: toView(b.f, base.scanId),
        target: toView(t.f, target.scanId),
        renamedFrom: null,
        reason: null,
      })
    } else {
      for (const i of baseIdxs) {
        const b = baseItems[i]!
        b.claimed = true
        b.handled = true
        items.push({
          kind: 'incomparable',
          base: toView(b.f, base.scanId),
          target: null,
          renamedFrom: null,
          reason: REASON_DUPLICATE,
        })
      }
      for (const i of targetIdxs) {
        const t = targetItems[i]!
        t.claimed = true
        t.handled = true
        items.push({
          kind: 'incomparable',
          base: null,
          target: toView(t.f, target.scanId),
          renamedFrom: null,
          reason: REASON_DUPLICATE,
        })
      }
    }
  }

  /* 第二遍：文件改名识别——仅当整文件内容哈希一致（且目标中该哈希唯一）才重键匹配。 */
  const targetHashToPaths = new Map<string, string[]>()
  for (const [path, hash] of Object.entries(target.fileHashes)) {
    const list = targetHashToPaths.get(hash)
    if (list) list.push(path)
    else targetHashToPaths.set(hash, [path])
  }
  for (const b of baseItems) {
    if (b.handled) continue
    const oldHash = base.fileHashes[b.f.path]
    if (!oldHash) continue
    const oldPath = normalizePath(b.f.path)
    const candidates = (targetHashToPaths.get(oldHash) ?? []).filter((p) => normalizePath(p) !== oldPath)
    if (candidates.length !== 1) continue
    const key = matchKeyOf(b.f, candidates[0]!)
    const free = (targetByKey.get(key) ?? []).filter((i) => !targetItems[i]!.claimed)
    if (free.length !== 1) continue
    const t = targetItems[free[0]!]!
    b.claimed = true
    b.handled = true
    t.claimed = true
    t.handled = true
    items.push({
      kind: 'persisting',
      base: toView(b.f, base.scanId),
      target: toView(t.f, target.scanId),
      renamedFrom: b.f.path,
      reason: null,
    })
  }

  /* 第三遍：剩余旧问题按覆盖判定（未覆盖 → 不可比较；已覆盖未匹配 → 未再检出）。 */
  for (const b of baseItems) {
    if (b.handled) continue
    b.handled = true
    if (!target.completed) {
      items.push({
        kind: 'incomparable',
        base: toView(b.f, base.scanId),
        target: null,
        renamedFrom: null,
        reason: REASON_TARGET_INCOMPLETE,
      })
      continue
    }
    const verdict = coverageVerdict(b.f, base, target)
    if (!verdict.covered) {
      items.push({
        kind: 'incomparable',
        base: toView(b.f, base.scanId),
        target: null,
        renamedFrom: null,
        reason: verdict.reason ?? REASON_NOT_COVERED,
      })
      continue
    }
    items.push({
      kind: 'disappeared',
      base: toView(b.f, base.scanId),
      target: null,
      renamedFrom: null,
      reason: null,
    })
  }

  /* 剩余新结果 → 新增。 */
  for (const t of targetItems) {
    if (t.claimed) continue
    t.claimed = true
    t.handled = true
    items.push({
      kind: 'added',
      base: null,
      target: toView(t.f, target.scanId),
      renamedFrom: null,
      reason: null,
    })
  }

  const counts: Record<CompareChangeKind, number> = {
    added: 0,
    persisting: 0,
    disappeared: 0,
    incomparable: 0,
  }
  for (const item of items) counts[item.kind]++

  items.sort(
    (a, b) =>
      SEVERITY_ORDER[(a.base ?? a.target)!.severity]! -
        SEVERITY_ORDER[(b.base ?? b.target)!.severity]! ||
      (a.base ?? a.target)!.path.localeCompare((b.base ?? b.target)!.path),
  )

  return {
    baseScanId: base.scanId,
    targetScanId: target.scanId,
    comparable,
    configDifferences,
    scopeNote,
    counts,
    items,
    disclaimer: COMPARE_DISCLAIMER,
  }
}

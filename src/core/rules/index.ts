import { analyzeFile, type AnalyzedFile } from '@/core/index/analyzer'
import { dedupeStaticFindings, type StaticFinding } from './types'
import {
  ruleDynamicExec,
  ruleHtmlInjection,
  rulePostMessage,
  ruleMessageOrigin,
} from './security'
import { ruleJsxMissingKey, ruleHookConditional } from './react'
import {
  ruleCheckDisabled,
  ruleConsoleResidue,
  ruleSecretCandidate,
} from './maintainability'

export const STATIC_RULES = [
  { id: 'sec/dynamic-code-exec', title: '动态代码执行入口', category: 'security' },
  { id: 'sec/dom-html-injection', title: 'HTML 注入入口', category: 'security' },
  { id: 'sec/postmessage-unconstrained', title: 'postMessage 目标源未约束', category: 'security' },
  { id: 'sec/message-no-origin-check', title: 'message 监听未校验来源', category: 'security' },
  { id: 'sec/hardcoded-secret-candidate', title: '疑似硬编码密钥', category: 'security' },
  { id: 'cor/jsx-list-missing-key', title: 'JSX 列表缺少 key', category: 'correctness' },
  { id: 'cor/react-hook-conditional', title: 'Hook 条件调用', category: 'correctness' },
  { id: 'mai/ts-check-disabled', title: '显式禁用类型/规则检查', category: 'maintainability' },
  { id: 'mai/console-residue', title: '调试输出残留', category: 'maintainability' },
] as const

export interface StaticFileInput {
  path: string
  content: string
  language: string
  parseOk: boolean
  redactedRanges: Array<{ line: number; start: number; end: number }>
}

export interface StaticScanResult {
  findings: StaticFinding[]
  checkedFileCount: number
  parseFailedCount: number
  analyzedFiles: Map<string, AnalyzedFile>
}

/** 运行全部静态规则（确定性：同一输入同一输出；仅分析解析成功的文件） */
export function runStaticRules(files: StaticFileInput[]): StaticScanResult {
  const findings: StaticFinding[] = []
  const analyzedFiles = new Map<string, AnalyzedFile>()
  let checkedFileCount = 0
  let parseFailedCount = 0

  for (const f of files) {
    if (f.language === 'json' || f.language === 'md' || f.language === 'css' || f.language === 'html') {
      continue
    }
    if (!f.parseOk) {
      parseFailedCount++
      continue
    }
    const analyzed = analyzeFile(f)
    if (!analyzed) continue
    analyzedFiles.set(f.path, analyzed)
    checkedFileCount++
    const ctx = { file: analyzed, redactedRanges: f.redactedRanges }
    findings.push(
      ...ruleDynamicExec(ctx),
      ...ruleHtmlInjection(ctx),
      ...rulePostMessage(ctx),
      ...ruleMessageOrigin(ctx),
      ...ruleJsxMissingKey(ctx),
      ...ruleHookConditional(ctx),
      ...ruleCheckDisabled(ctx),
      ...ruleConsoleResidue(ctx),
      ...ruleSecretCandidate(ctx),
    )
  }
  return { findings: dedupeStaticFindings(findings), checkedFileCount, parseFailedCount, analyzedFiles }
}

export { dedupeStaticFindings }
export type { StaticFinding }

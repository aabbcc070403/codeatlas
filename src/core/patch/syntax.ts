import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import type { PatchSyntaxStatus } from '@/core/contracts/patch'

/**
 * 语法校验（规格 9.5 / R06；A02 修复为诊断**签名集合**比较，不再只比数量）：
 * - 诊断签名 = code + message（**位置无关**）。同一错误挪到别的行、错误数量此消彼长，
 *   只要补丁后出现基线不存在的签名即视为引入新错误；
 * - TS/JS/JSX/TSX：TypeScript Compiler API 内存解析（与 core/index/analyzer 同源，
 *   自有程序、不加载项目插件），取解析期错误诊断签名；
 * - Vue：@vue/compiler-sfc 的 SFC 解析错误（含双 script 块等结构错误）+ script 块转译诊断；
 * - 不支持解析的语言（json/md/css/html）返回 null → 提案阶段直接拒绝生成；
 * - 只做内存解析，不解读语法含义、不执行任何代码。
 */

const SUPPORTED = new Set(['js', 'ts', 'tsx', 'jsx', 'vue'])

export function isSyntaxCheckable(language: string): boolean {
  return SUPPORTED.has(language)
}

function scriptKindFor(language: string): ts.ScriptKind {
  switch (language) {
    case 'ts':
      return ts.ScriptKind.TS
    case 'tsx':
      return ts.ScriptKind.TSX
    case 'jsx':
      return ts.ScriptKind.JSX
    default:
      return ts.ScriptKind.JS
  }
}

/** 诊断签名：code + 展平后的 message（位置无关，签名集合用于比较） */
function signatureOf(code: number | string | undefined, message: string): string {
  return `${code ?? 'unknown'}:${message}`
}

/** TS Compiler API 内存解析错误签名（parseDiagnostics 为解析期诊断，含语法错误） */
function tsErrorSignatures(content: string, path: string, language: string): string[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.ESNext, true, scriptKindFor(language))
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics
  if (!parseDiagnostics) return []
  return parseDiagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => signatureOf(d.code, ts.flattenDiagnosticMessageText(d.messageText, ' ')))
}

/** Vue SFC：解析错误（含双 script 块等结构错误）+ script 块转译诊断（与导入侧同口径） */
function vueErrorSignatures(content: string, path: string): string[] {
  const { descriptor, errors } = parseSfc(content, { filename: path })
  const signatures = errors.map((e) => signatureOf((e as { code?: number }).code, e.message))
  const script = descriptor.scriptSetup ?? descriptor.script
  if (script) {
    const result = ts.transpileModule(script.content, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        jsx: ts.JsxEmit.Preserve,
      },
    })
    for (const d of (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    )) {
      signatures.push(signatureOf(d.code, ts.flattenDiagnosticMessageText(d.messageText, ' ')))
    }
  }
  return signatures
}

/**
 * 语法错误诊断签名列表（每条错误一个签名，保留重复）；不支持解析的语言返回 null
 * （提案阶段据此拒绝生成）。只做内存解析，不执行文件内容。
 */
export function syntaxErrorSignatures(
  language: string,
  path: string,
  content: string,
): string[] | null {
  if (!isSyntaxCheckable(language)) return null
  try {
    if (language === 'vue') return vueErrorSignatures(content, path)
    return tsErrorSignatures(content, path, language)
  } catch {
    // 解析器自身异常按 1 个错误计（保守：视为存在语法问题）
    return ['parser:internal-error']
  }
}

/** 语法错误条数（诊断数，未按签名去重）；不支持解析的语言返回 null */
export function countSyntaxErrors(language: string, path: string, content: string): number | null {
  const signatures = syntaxErrorSignatures(language, path, content)
  return signatures === null ? null : signatures.length
}

export interface SyntaxComparison {
  status: PatchSyntaxStatus
  /** 基线错误诊断条数（展示用；判定以签名集合为准） */
  baselineErrors: number
  /** 补丁后错误诊断条数（展示用；判定以签名集合为准） */
  patchedErrors: number
  /** 补丁后出现、基线不存在的错误签名数（>0 即引入新错误） */
  newSignatures: number
}

/**
 * 基线 vs 补丁后的语法比较（签名集合口径，位置无关）：
 * - fail：补丁后出现基线不存在的错误签名（新增语法错误）→ 提案不可下载；
 * - baseline_failed：基线本身有语法错误（即使补丁后签名是基线子集，也无法证明
 *   「不引入新错误」——等签名迁移无法与真实修复区分）→ 保守状态，同样不可下载；
 * - pass：基线无错误且补丁后无错误（唯一可作为已验证提案下载的状态）。
 */
export function compareSyntax(
  language: string,
  path: string,
  baseline: string,
  patched: string,
): SyntaxComparison {
  const baselineSignatures = syntaxErrorSignatures(language, path, baseline) ?? []
  const patchedSignatures = syntaxErrorSignatures(language, path, patched) ?? []
  const baselineSet = new Set(baselineSignatures)
  const newSignatures = patchedSignatures.filter((s) => !baselineSet.has(s)).length
  let status: PatchSyntaxStatus
  if (newSignatures > 0) status = 'fail'
  else if (baselineSignatures.length > 0) status = 'baseline_failed'
  else status = 'pass'
  return {
    status,
    baselineErrors: baselineSignatures.length,
    patchedErrors: patchedSignatures.length,
    newSignatures,
  }
}

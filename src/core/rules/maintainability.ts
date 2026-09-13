import ts from 'typescript'
import { makeFinding, type RuleContext, type StaticFinding } from './types'
import { quoteLines, toLine } from '@/core/index/analyzer'

/* 规则：显式禁用 TypeScript / ESLint 检查 */

const TS_DIRECTIVE_RE = /^@ts-(ignore|nocheck)\s*$/
const TS_EXPECT_RE = /^@ts-expect-error\s*$/
const ESLINT_DISABLE_SECURITY_RE =
  /eslint-disable.*\b(no-eval|react-hooks\/exhaustive-deps|react-hooks\/rules-of-hooks|no-unsanitized)\b/

export function ruleCheckDisabled(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []

  // 扫描全部注释三连字（TS Compiler API 提供注释范围）
  const scanComments = (ranges: ReadonlyArray<ts.CommentRange>): void => {
    for (const range of ranges) {
      const text = file.sourceFile.text.slice(range.pos, range.end)
      const body = text.replace(/^\/\/+|\/\*+|\*+\/$/g, '').trim()
      const line = toLine(file, range.pos)
      const directiveMatch = body.match(TS_DIRECTIVE_RE) ?? body.match(TS_EXPECT_RE)
      if (directiveMatch) {
        const directive = body.slice(0, body.indexOf(' ') > 0 ? body.indexOf(' ') : body.length)
        out.push(
          makeFinding(ctx, {
            ruleId: 'mai/ts-check-disabled',
            lineRange: [line, line],
            title: `${directive} 禁用了类型检查${body.match(TS_EXPECT_RE) ? ' 且未附说明' : ''}`,
            category: 'maintainability',
            severity: 'low',
            confidence: 0.95,
            condition: '该行/文件绕过 TypeScript 诊断，类型错误不再被报告',
            impact: '类型系统对该处失效，错误逃逸到运行时并随重构扩散',
            reasoningSummary: '注释指令确定性存在；@ts-expect-error 未附原因说明',
            recommendation: '修复底层类型错误；确需豁免时改用 @ts-expect-error 并附 issue 链接',
          }),
        )
      } else if (ESLINT_DISABLE_SECURITY_RE.test(body)) {
        out.push(
          makeFinding(ctx, {
            ruleId: 'mai/ts-check-disabled',
            lineRange: [line, line],
            title: '禁用了安全相关 ESLint 规则',
            category: 'maintainability',
            severity: 'medium',
            confidence: 0.9,
            condition: '被禁用规则在该范围不再检查，新引入的违规将被隐藏',
            impact: '安全类规则（no-eval/Hook 依赖等）失效，风险信号丢失',
            reasoningSummary: 'eslint-disable 命中安全规则名单',
            recommendation: '移除豁免并修复违规；无法立即修复时缩小禁用范围并注明原因',
          }),
        )
      }
    }
  }

  const visit = (node: ts.Node): void => {
    const leading = ts.getLeadingCommentRanges(file.sourceFile.text, node.getFullStart())
    if (leading) scanComments(leading)
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  // 纯注释文件（如首行 @ts-nocheck 后仅声明）也覆盖：扫描文件头
  const head = ts.getLeadingCommentRanges(file.sourceFile.text, 0)
  if (head) scanComments(head)
  return out
}

/* 规则：调试输出残留（console.log/console.debug） */

export function ruleConsoleResidue(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console' &&
      ts.isIdentifier(node.expression.name) &&
      (node.expression.name.text === 'log' || node.expression.name.text === 'debug')
    ) {
      out.push(
        makeFinding(ctx, {
          ruleId: 'mai/console-residue',
          node,
          title: `console.${node.expression.name.text} 调试输出`,
          category: 'maintainability',
          severity: 'low',
          confidence: 0.9,
          condition: '生产环境输出内部结构，可能泄露信息并污染用户控制台',
          impact: '信息泄露与噪音；高频输出影响性能',
          reasoningSummary: '确定性调用语句',
          recommendation: '改用统一 logger（可按环境关闭）或删除；错误路径改用 console.error 或上报',
        }),
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

/* 规则：疑似硬编码密钥（来自导入时等长脱敏记录，候选需人工确认） */

export function ruleSecretCandidate(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  for (const range of ctx.redactedRanges) {
    const line = range.line
    const [start, end] = [line, line]
    const quote = quoteLines(file, start, end)
    if (!quote.includes('*')) continue
    out.push({
      ruleId: 'sec/hardcoded-secret-candidate',
      fingerprint: `static:sec/hardcoded-secret-candidate:${file.path}:${start}-${end}`,
      title: '疑似硬编码密钥（已脱敏，候选）',
      category: 'security',
      severity: 'high',
      confidence: 0.7,
      primary: { path: file.path, startLine: start, endLine: end, quote },
      related: [],
      condition: '触发条件：该位置匹配密钥赋值或已知 token 形态；是否为真实凭证需人工确认',
      impact: '真实密钥入库后即使删除也留在 Git 历史，可能被滥用',
      reasoningSummary: '导入脱敏启发式命中；启发式无法保证发现所有秘密，也不排除误报',
      recommendation: '将密钥移到环境变量或密钥管理服务，轮换已泄露的凭证',
      guidelineChunkIds: [],
      symbol: undefined,
      needsReview: true,
    })
  }
  return out
}

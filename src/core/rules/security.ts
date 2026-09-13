import ts from 'typescript'
import { makeFinding, type RuleContext, type StaticFinding } from './types'

/* 规则：动态代码执行（eval / new Function / 字符串定时器） */

export function ruleDynamicExec(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    // eval(...)：TS AST 中函数表达式为 node.expression
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'eval'
    ) {
      const arg = node.arguments[0]
      const literal = arg !== undefined && ts.isStringLiteralLike(arg)
      out.push(
        makeFinding(ctx, {
          ruleId: 'sec/dynamic-code-exec',
          node,
          title: literal ? 'eval 执行固定字符串（低风险）' : 'eval 动态执行入口（候选）',
          category: 'security',
          severity: literal ? 'low' : 'high',
          confidence: literal ? 0.9 : 0.75,
          condition: literal
            ? 'eval 参数为字符串字面量，内容固定，不受外部输入影响'
            : '触发条件：参数内容若包含外部可控输入则构成任意代码执行入口；需人工追溯参数来源',
          impact: 'eval 会执行任意代码并绕过 CSP 与静态分析；被污染时等同远程代码执行',
          reasoningSummary: literal
            ? '参数为字面量，注入风险低，但 eval 仍阻碍优化与 CSP'
            : '参数为动态表达式，无法静态确认内容来源，按候选风险记录',
          recommendation: literal
            ? '替换为直接代码或 JSON.parse 解析数据'
            : '改用 JSON.parse、映射表或显式分支；确认参数来源后再评估风险',
          needsReview: !literal,
        }),
      )
    }
    // new Function(...)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      out.push(
        makeFinding(ctx, {
          ruleId: 'sec/dynamic-code-exec',
          node,
          title: 'new Function 动态构造函数（候选）',
          category: 'security',
          severity: 'high',
          confidence: 0.75,
          condition: '触发条件：参数若可被外部输入污染则构成任意代码执行；需追溯来源',
          impact: 'new Function 从字符串生成函数体，与 eval 同级风险',
          reasoningSummary: '动态字符串构造函数，内容来源需人工确认',
          recommendation: '改为显式函数或映射对象',
          needsReview: true,
        }),
      )
    }
    // setTimeout/setInterval("code", ...)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'setTimeout' || node.expression.text === 'setInterval') &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(
        makeFinding(ctx, {
          ruleId: 'sec/dynamic-code-exec',
          node,
          title: `${node.expression.text} 以字符串形式执行代码`,
          category: 'security',
          severity: 'medium',
          confidence: 0.9,
          condition: '字符串内容固定；若未来改为动态拼接则有注入风险',
          impact: '字符串参数会被当作代码求值，绕过常规函数调用约束',
          reasoningSummary: '定时器字符串参数即动态执行',
          recommendation: '改为传入函数引用',
        }),
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

/* 规则：HTML 注入入口（innerHTML/outerHTML 赋值、insertAdjacentHTML、document.write、dangerouslySetInnerHTML） */

const HTML_SINK_MEMBERS = new Set(['innerHTML', 'outerHTML'])

export function ruleHtmlInjection(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.name) &&
        HTML_SINK_MEMBERS.has(node.left.name.text)
      ) {
        if (ts.isStringLiteral(node.right)) return // 常量赋值不构成入口
        out.push(htmlFinding(ctx, node, node.left.name.text, '赋值'))
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'insertAdjacentHTML'
    ) {
      const htmlArg = node.arguments[1]
      if (htmlArg !== undefined && !ts.isStringLiteral(htmlArg)) {
        out.push(htmlFinding(ctx, node, 'insertAdjacentHTML', '调用'))
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'document' &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'write'
    ) {
      const arg = node.arguments[0]
      if (arg !== undefined && !ts.isStringLiteral(arg)) {
        out.push(htmlFinding(ctx, node, 'document.write', '调用'))
      }
    }
    // React dangerouslySetInnerHTML={{ __html: expr }}：__html 为字符串字面量时跳过
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'dangerouslySetInnerHTML'
    ) {
      const init = node.initializer
      const expr =
        init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined
          ? init.expression
          : undefined
      if (expr !== undefined && ts.isObjectLiteralExpression(expr)) {
        const htmlProp = expr.properties.find(
          (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === '__html',
        )
        if (
          htmlProp !== undefined &&
          ts.isPropertyAssignment(htmlProp) &&
          ts.isStringLiteral(htmlProp.initializer)
        ) {
          return
        }
        if (htmlProp !== undefined && ts.isPropertyAssignment(htmlProp)) {
          out.push(htmlFinding(ctx, node, 'dangerouslySetInnerHTML', 'JSX 属性'))
        }
      } else if (expr !== undefined && !ts.isStringLiteral(expr)) {
        out.push(htmlFinding(ctx, node, 'dangerouslySetInnerHTML', 'JSX 属性'))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

function htmlFinding(
  ctx: RuleContext,
  node: ts.Node,
  sink: string,
  usage: string,
): StaticFinding {
  return makeFinding(ctx, {
    ruleId: 'sec/dom-html-injection',
    node,
    title: `${sink} ${usage}非字面量内容（候选 HTML 注入入口）`,
    category: 'security',
    severity: 'high',
    confidence: 0.75,
    condition:
      '触发条件：右侧值若可被用户输入污染且未经净化，将注入任意 HTML/脚本；需追溯数据来源与净化环节',
    impact: '浏览器将内容解析为 HTML，攻击者可注入脚本窃取会话或执行操作',
    reasoningSummary: `检测到 HTML 写入入口 ${sink}，右侧为动态表达式；仅凭入口存在不判定漏洞成立`,
    recommendation: `纯文本改用 textContent；富文本必须经 DOMPurify 等白名单净化后再写入 ${sink}`,
    needsReview: true,
  })
}

/* 规则：postMessage 未约束目标源 */

export function rulePostMessage(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'postMessage'
    ) {
      // window.postMessage(message, targetOrigin, [transfer])
      const targetOrigin = node.arguments[1]
      let unconstrained = false
      let detail = ''
      if (targetOrigin === undefined) {
        unconstrained = true
        detail = '未提供 targetOrigin（等同 "*"）'
      } else if (ts.isStringLiteral(targetOrigin) && targetOrigin.text === '*') {
        unconstrained = true
        detail = 'targetOrigin 为 "*"'
      }
      if (unconstrained) {
        out.push(
          makeFinding(ctx, {
            ruleId: 'sec/postmessage-unconstrained',
            node,
            title: `postMessage 目标源未约束（${detail}）`,
            category: 'security',
            severity: 'medium',
            confidence: 0.9,
            condition: '触发条件：消息包含敏感数据且页面可能被恶意站点嵌入时，任意源可收到消息',
            impact: '消息内容可能泄露给非预期来源窗口',
            reasoningSummary: 'targetOrigin 缺失或为通配符，来源约束缺失是确定事实',
            recommendation: '传入具体目标源（如 https://example.com）',
          }),
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

/* 规则：message 事件监听未校验 event.origin */

export function ruleMessageOrigin(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'addEventListener' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'message' &&
      node.arguments[1] !== undefined
    ) {
      const handler = node.arguments[1]
      let handlerFn: ts.FunctionLikeDeclaration | undefined
      if (ts.isFunctionExpression(handler)) handlerFn = handler
      else if (ts.isArrowFunction(handler)) handlerFn = handler
      else if (ts.isIdentifier(handler)) handlerFn = findFunctionByName(ctx, handler.text) ?? undefined
      if (handlerFn === undefined) {
        out.push(
          makeFinding(ctx, {
            ruleId: 'sec/message-no-origin-check',
            node,
            title: 'message 监听回调为外部引用（需人工核查 origin 校验）',
            category: 'security',
            severity: 'low',
            confidence: 0.6,
            condition: '回调函数定义在其他位置，静态分析无法确认是否校验 event.origin',
            impact: '未校验来源的消息处理器可能被恶意页面伪造指令',
            reasoningSummary: '回调通过标识符引用，需人工核查其实现',
            recommendation: '确认回调内先比对 event.origin 白名单再处理数据',
            needsReview: true,
          }),
        )
        return
      }
      const checksOrigin = containsOriginCheck(handlerFn)
      if (!checksOrigin) {
        out.push(
          makeFinding(ctx, {
            ruleId: 'sec/message-no-origin-check',
            node,
            title: 'message 事件监听未校验 event.origin',
            category: 'security',
            severity: 'medium',
            confidence: 0.85,
            condition: '触发条件：任意来源窗口均可向该处理器发送消息并触发数据处理逻辑',
            impact: '恶意页面可伪造消息内容，驱动页面执行非预期操作',
            reasoningSummary:
              '回调函数体内未引用 event.origin（或等价参数的 origin 属性），来源校验缺失为确定事实',
            recommendation: '在处理数据前先比对 event.origin 与预期白名单',
            related: [{ node: handlerFn }],
          }),
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

function findFunctionByName(ctx: RuleContext, name: string): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null
  const visit = (node: ts.Node): void => {
    if (found !== null) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node
      return
    }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer !== undefined &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          found = d.initializer
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.file.sourceFile)
  return found
}

function containsOriginCheck(fn: ts.FunctionLikeDeclaration): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'origin'
    ) {
      found = true
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(fn.body ?? fn)
  return found
}

import ts from 'typescript'
import { makeFinding, type RuleContext, type StaticFinding } from './types'
import { isHookName, isComponentName } from '@/core/index/analyzer'

/* 规则：JSX 列表渲染缺少 key */

export function ruleJsxMissingKey(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  if (file.language !== 'jsx' && file.language !== 'tsx') return []
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    // xs.map(x => <div/>) 或 xs.map(function(x){ return <div/> })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'map'
    ) {
      const callback = node.arguments[0]
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const jsxRoots = collectJsxRoots(callback)
        const missing = jsxRoots.filter((el) => !hasKeyAttribute(el))
        if (jsxRoots.length > 0 && missing.length > 0) {
          out.push(
            makeFinding(ctx, {
              ruleId: 'cor/jsx-list-missing-key',
              node,
              title: '列表渲染缺少稳定 key',
              category: 'correctness',
              severity: 'medium',
              confidence: 0.95,
              condition: '触发条件：列表发生插入/删除/排序时，React 依据 key 复用节点，缺失 key 导致状态错位',
              impact: '输入框内容串行、组件状态残留、重渲染异常等隐蔽 Bug',
              reasoningSummary: '.map 回调返回的 JSX 元素未携带 key 属性，为确定性缺陷',
              recommendation: '使用数据中的稳定唯一标识作为 key（如 item.id），不要使用数组索引',
              related: missing.map((el) => ({ node: el })),
            }),
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

/** JSX 元素（开闭标签或自闭合） */
type JsxElementLike = ts.JsxElement | ts.JsxSelfClosingElement

/** 回调中直接返回（含表达式体与条件分支）的 JSX 根元素 */
function collectJsxRoots(fn: ts.FunctionLikeDeclaration): JsxElementLike[] {
  const roots: JsxElementLike[] = []
  if (fn.body !== undefined && !ts.isBlock(fn.body)) {
    // 箭头函数表达式体：(it) => <li/>
    collectFromExpression(fn.body as ts.Expression, roots)
    return roots
  }
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      collectFromExpression(node.expression, roots)
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.body ?? fn)
  return roots
}

function collectFromExpression(
  expr: ts.Expression,
  roots: JsxElementLike[],
): void {
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) {
    roots.push(expr)
    return
  }
  if (ts.isParenthesizedExpression(expr)) {
    collectFromExpression(expr.expression, roots)
    return
  }
  if (ts.isConditionalExpression(expr)) {
    collectFromExpression(expr.whenTrue, roots)
    collectFromExpression(expr.whenFalse, roots)
    return
  }
  if (ts.isJsxFragment(expr)) {
    // Fragment 根：其子元素需要 key
    for (const child of expr.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) roots.push(child)
    }
  }
}

function hasKeyAttribute(el: JsxElementLike): boolean {
  const attrs = ts.isJsxSelfClosingElement(el)
    ? el.attributes
    : el.openingElement.attributes
  return attrs.properties.some(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'key',
  )
}

/* 规则：React Hook 条件调用 / 非法作用域调用 */

export function ruleHookConditional(ctx: RuleContext): StaticFinding[] {
  const { file } = ctx
  const out: StaticFinding[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isHookName(node.expression.text)
    ) {
      const violation = findHookScopeViolation(file.sourceFile, node)
      if (violation) {
        out.push(
          makeFinding(ctx, {
            ruleId: 'cor/react-hook-conditional',
            node,
            title:
              violation === 'conditional'
                ? `Hook「${node.expression.text}」在条件/循环分支内调用`
                : `Hook「${node.expression.text}」在非组件/非 Hook 函数内调用`,
            category: 'correctness',
            severity: 'high',
            confidence: 0.9,
            condition:
              violation === 'conditional'
                ? '触发条件：分支未命中时 Hook 调用次数改变，React 依赖固定调用顺序，运行时将抛错或状态错乱'
                : '触发条件：普通函数内的 Hook 与任何组件实例都不对应，违反 Hook 调用规则',
            impact: '组件渲染崩溃（Rendered fewer hooks than expected）或状态串位',
            reasoningSummary:
              violation === 'conditional'
                ? 'Hook 调用位于 if/三元/逻辑表达式/循环体内（语法层确定）'
                : 'Hook 调用所在函数名既非组件（PascalCase）也非自定义 Hook（use*）',
            recommendation:
              violation === 'conditional'
                ? '把 Hook 调用移到组件顶层，条件逻辑放进 Hook 回调内部'
                : '将该函数重命名为 use* 自定义 Hook，或将 Hook 调用上移到组件内',
          }),
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return out
}

/** 判定 Hook 调用是否处于非法作用域；合法返回 null */
function findHookScopeViolation(
  sourceFile: ts.SourceFile,
  call: ts.CallExpression,
): 'conditional' | 'plain-function' | null {
  let current: ts.Node = call
  while (current.parent) {
    const parent = current.parent
    if (
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isForStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)
    ) {
      // 仅当 Hook 调用在条件/循环体内（而非判断表达式本身）
      if (
        !(ts.isIfStatement(parent) && parent.expression === current) &&
        !(ts.isConditionalExpression(parent) && parent.condition === current) &&
        !(ts.isWhileStatement(parent) && parent.expression === current) &&
        !(ts.isDoStatement(parent) && parent.expression === current) &&
        !((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
          (parent.initializer === current || parent.expression === current)) &&
        !(ts.isForStatement(parent) &&
          (parent.initializer === current || parent.condition === current || parent.incrementor === current))
      ) {
        return 'conditional'
      }
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind
      if (
        (op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken) &&
        parent.right === current
      ) {
        // a && useState()：Hook 在右侧即条件调用
        return 'conditional'
      }
    }
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      const name = getFunctionName(parent)
      // 合法：组件（PascalCase）或自定义 Hook（use*）
      if (name && (isComponentName(name) || isHookName(name))) return null
      // 顶层 anonymous（如直接导出的箭头组件匿名）→ 继续向上看一层
      if (!name) {
        current = parent
        continue
      }
      return 'plain-function'
    }
    current = parent
  }
  return null
}

function getFunctionName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    fn.parent &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text
  }
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text
  return null
}

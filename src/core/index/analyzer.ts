import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'

/**
 * 内存 AST 分析（规格 6）：自有 TypeScript 程序，不加载项目插件、不执行代码。
 * Vue 文件抽取 script 块并维护原始行号映射。
 */

export interface FileInput {
  path: string
  content: string
  language: string
}

export interface AnalyzedFile {
  path: string
  language: string
  content: string
  sourceFile: ts.SourceFile
  /** Vue: script 块首行在 SFC 中的 1 起始行号 - 1；其他文件为 0 */
  lineOffset: number
}

export interface SymbolInfo {
  name: string
  kind: 'function' | 'component' | 'hook' | 'const' | 'method'
  startLine: number
  endLine: number
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

export function analyzeFile(file: FileInput): AnalyzedFile | null {
  if (file.language === 'vue') {
    const { descriptor } = parseSfc(file.content, { filename: file.path })
    const script = descriptor.scriptSetup ?? descriptor.script
    if (!script || script.content.trim() === '') return null
    const lang = script.lang ?? 'js'
    const sourceFile = ts.createSourceFile(
      file.path,
      script.content,
      ts.ScriptTarget.ESNext,
      true,
      lang === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    )
    // script.loc.start.line 为 <script> 标签所在 SFC 行（1 起始）；
    // script 内容第 0 行与标签同行，故偏移 = start.line - 1
    return {
      path: file.path,
      language: 'vue',
      content: file.content,
      sourceFile,
      lineOffset: script.loc.start.line - 1,
    }
  }
  const sourceFile = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.ESNext,
    true,
    scriptKindFor(file.language),
  )
  return { path: file.path, language: file.language, content: file.content, sourceFile, lineOffset: 0 }
}

export function toLine(file: AnalyzedFile, pos: number): number {
  return file.sourceFile.getLineAndCharacterOfPosition(pos).line + 1 + file.lineOffset
}

/** 节点覆盖的 SFC 行段 [startLine, endLine]（1 起始，闭区间） */
export function nodeLineRange(file: AnalyzedFile, node: ts.Node): [number, number] {
  return [toLine(file, node.getStart(file.sourceFile)), toLine(file, node.getEnd())]
}

/** 引文 = 行段内真实源码（SFC 全文行，与快照行一致），统一 LF */
export function quoteLines(file: AnalyzedFile, startLine: number, endLine: number): string {
  const allLines = file.content.split('\n')
  const from = startLine - 1 - file.lineOffset
  const to = endLine - file.lineOffset
  return allLines.slice(from, to).join('\n')
}

const HOOK_BUILTINS = new Set([
  'useState', 'useEffect', 'useReducer', 'useContext', 'useRef', 'useMemo',
  'useCallback', 'useLayoutEffect', 'useImperativeHandle', 'useInsertionEffect',
  'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'useId', 'useDebugValue',
  'useOptimistic', 'useActionState', 'useFormStatus', 'useParams', 'useSearchParams',
  'useNavigate', 'useLocation', 'useSelector', 'useDispatch', 'useStore', 'useRouter',
])

export function isHookName(name: string): boolean {
  return HOOK_BUILTINS.has(name) || (/^use[A-Z0-9]/.test(name) && name !== 'use')
}

export function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name)
}

/** 收集函数/组件/Hook 符号（供规则上下文与 AI 去重归组） */
export function collectSymbols(file: AnalyzedFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push(makeSymbol(file, node, node.name.text))
    } else if (ts.isVariableStatement(node)) {
      const decl = node.declarationList.declarations[0]
      if (decl && ts.isIdentifier(decl.name) && decl.initializer) {
        const name = decl.name.text
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          symbols.push(makeSymbol(file, node, name))
        }
      }
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      symbols.push(makeSymbol(file, node, node.name.text))
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sourceFile)
  return symbols
}

function makeSymbol(file: AnalyzedFile, node: ts.Node, name: string): SymbolInfo {
  const [startLine, endLine] = nodeLineRange(file, node)
  let kind: SymbolInfo['kind'] = 'function'
  if (isHookName(name)) kind = 'hook'
  else if (isComponentName(name)) kind = 'component'
  else if (ts.isMethodDeclaration(node)) kind = 'method'
  return { name, kind, startLine, endLine }
}

/** 定位 pos 所在的最内层符号 */
export function enclosingSymbol(
  file: AnalyzedFile,
  pos: number,
  symbols?: SymbolInfo[],
): SymbolInfo | null {
  const list = symbols ?? collectSymbols(file)
  let best: SymbolInfo | null = null
  for (const s of list) {
    if (s.startLine <= toLine(file, pos) && toLine(file, pos) <= s.endLine) {
      if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) best = s
    }
  }
  return best
}

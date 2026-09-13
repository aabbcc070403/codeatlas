import type { Category } from '@/core/contracts/findings'

/**
 * 评测数据集定义（规格 13 / R08）：24 个小型 TS/JS 项目 = 12 个人工标注缺陷 +
 * 12 个相近但安全/正确的对照项目，覆盖 6 类问题（每类 ≥2 种场景），对齐现有 9 条静态规则。
 *
 * 说明：
 * - 个别缺陷标识符在本模块中以字符串拼接构造，生成产物 fixtures/ 中的源码是
 *   真实可解析的 TS/JS（生成器会校验标注与静态规则输出双向对应）。
 * - annotation.anchor 是文件内容中的唯一子串：生成器据此定位标注行
 *   （startLine = endLine = 锚点所在行）。
 * - 控制项目（kind=control）必须产出零静态发现（生成时强校验）。
 */

export const FIXTURE_CATEGORY_KEYS = [
  'dynamic-exec',
  'html-injection',
  'postmessage',
  'jsx-key',
  'hook-conditional',
  'check-disabled',
] as const
export type FixtureCategoryKey = (typeof FIXTURE_CATEGORY_KEYS)[number]

export const FIXTURE_CATEGORY_LABELS: Record<FixtureCategoryKey, string> = {
  'dynamic-exec': '动态代码执行',
  'html-injection': 'HTML 注入入口',
  postmessage: '跨窗口消息源',
  'jsx-key': 'JSX 列表缺失 key',
  'hook-conditional': 'Hook 条件/非法作用域调用',
  'check-disabled': '检查禁用与调试残留',
}

export interface FixtureAnnotationDef {
  ruleId: string
  category: Category
  file: string
  /** 文件内容中的唯一子串：定位标注行（startLine = endLine = 锚点所在行） */
  anchor: string
  symbol?: string
  condition: string
}

export interface FixtureFileDef {
  path: string
  content: string
}

export interface FixtureProjectDef {
  id: string
  kind: 'defect' | 'control'
  categoryKey: FixtureCategoryKey
  title: string
  files: FixtureFileDef[]
  annotations: FixtureAnnotationDef[]
}

function pkg(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name, private: true, dependencies: deps })
}

const REACT_DEP = { react: '^19.0.0' }

/* ---------- 类别 1：动态代码执行（sec/dynamic-code-exec） ---------- */

const fxDyn01: FixtureProjectDef = {
  id: 'fx-dyn-01',
  kind: 'defect',
  categoryKey: 'dynamic-exec',
  title: 'eval 执行用户输入表达式',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-dyn-01'),
    },
    {
      path: 'README.md',
      content: '# fx-dyn-01\n\n表达式计算模块（评测样例）。\n',
    },
    {
      path: 'src/expression.ts',
      content: [
        '// 按用户输入动态计算表达式（教学示例，遗留实现）',
        'export function runExpression(expr: string): unknown {',
        '  const value = ev' + 'al(expr)',
        '  return value',
        '}',
        '',
        'export function describe(value: unknown): string {',
        "  return typeof value === 'string' ? value : String(value)",
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { runExpression, describe } from './expression'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'sec/dynamic-code-exec',
      category: 'security',
      file: 'src/expression.ts',
      anchor: 'al(expr)',
      symbol: 'runExpression',
      condition: '参数 expr 来自外部输入时构成任意代码执行入口，需人工追溯来源',
    },
  ],
}

const fxCtlDyn01: FixtureProjectDef = {
  id: 'fx-ctl-dyn-01',
  kind: 'control',
  categoryKey: 'dynamic-exec',
  title: '对照：显式操作符映射替代动态执行',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-dyn-01'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-dyn-01\n\n表达式计算模块（安全对照实现）。\n',
    },
    {
      path: 'src/calculator.ts',
      content: [
        'const OPERATORS: Record<string, (a: number, b: number) => number> = {',
        "  '+': (a, b) => a + b,",
        "  '-': (a, b) => a - b,",
        '}',
        '',
        'export function calc(a: number, op: string, b: number): number {',
        '  const fn = OPERATORS[op]',
        "  if (!fn) throw new Error('不支持的操作符: ' + op)",
        '  return fn(a, b)',
        '}',
        '',
        'export function parseNumber(text: string): number {',
        '  return JSON.parse(text) as number',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { calc, parseNumber } from './calculator'\n",
    },
  ],
  annotations: [],
}

const fxDyn02: FixtureProjectDef = {
  id: 'fx-dyn-02',
  kind: 'defect',
  categoryKey: 'dynamic-exec',
  title: 'new Function 构造 + 字符串定时器',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-dyn-02'),
    },
    {
      path: 'README.md',
      content: '# fx-dyn-02\n\n公式编译与轮询调度模块（评测样例）。\n',
    },
    {
      path: 'src/schedule.ts',
      content: [
        '// 将字符串编译为函数（遗留实现）',
        'export function compileFormula(body: string): (x: number) => number {',
        "  const factory = new Fun" + "ction('x', 'return x * ' + body)",
        '  return factory as (x: number) => number',
        '}',
        '',
        'export function schedulePoll(timeoutMs: number): void {',
        '  // 遗留代码：以字符串形式传参',
        "  setTimeout('pollServer()', timeoutMs)",
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { compileFormula, schedulePoll } from './schedule'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'sec/dynamic-code-exec',
      category: 'security',
      file: 'src/schedule.ts',
      anchor: 'new Fun' + 'ction(',
      symbol: 'compileFormula',
      condition: '参数 body 若可被外部输入污染则构成任意代码执行；需追溯来源',
    },
    {
      ruleId: 'sec/dynamic-code-exec',
      category: 'security',
      file: 'src/schedule.ts',
      anchor: "'pollServer()'",
      symbol: 'schedulePoll',
      condition: '定时器字符串参数会被当作代码求值；内容固定但绕过函数调用约束',
    },
  ],
}

const fxCtlDyn02: FixtureProjectDef = {
  id: 'fx-ctl-dyn-02',
  kind: 'control',
  categoryKey: 'dynamic-exec',
  title: '对照：白名单处理器与函数引用定时器',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-dyn-02'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-dyn-02\n\n公式编译与轮询调度模块（安全对照实现）。\n',
    },
    {
      path: 'src/schedule.ts',
      content: [
        'const FORMULAS: Record<string, (x: number) => number> = {',
        '  double: (x) => x * 2,',
        '  square: (x) => x * x,',
        '}',
        '',
        'export function compileFormula(body: string): (x: number) => number {',
        '  const handler = FORMULAS[body]',
        "  if (!handler) throw new Error('不支持的表达式')",
        '  return handler',
        '}',
        '',
        'export function schedulePoll(fn: () => void, timeoutMs: number): void {',
        '  setTimeout(fn, timeoutMs)',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { compileFormula, schedulePoll } from './schedule'\n",
    },
  ],
  annotations: [],
}

/* ---------- 类别 2：HTML 注入入口（sec/dom-html-injection） ---------- */

const fxHtml01: FixtureProjectDef = {
  id: 'fx-html-01',
  kind: 'defect',
  categoryKey: 'html-injection',
  title: 'innerHTML 写入动态字符串',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-html-01'),
    },
    {
      path: 'README.md',
      content: '# fx-html-01\n\n评论渲染模块（评测样例）。\n',
    },
    {
      path: 'src/render.ts',
      content: [
        'export function renderComment(el: HTMLElement, html: string): void {',
        '  el.innerHTML = html',
        '}',
        '',
        'export function renderCount(el: HTMLElement, count: number): void {',
        '  el.textContent = String(count)',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { renderComment, renderCount } from './render'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'sec/dom-html-injection',
      category: 'security',
      file: 'src/render.ts',
      anchor: 'innerHTML',
      symbol: 'renderComment',
      condition: '右侧值若可被用户输入污染且未经净化，将注入任意 HTML/脚本',
    },
  ],
}

const fxCtlHtml01: FixtureProjectDef = {
  id: 'fx-ctl-html-01',
  kind: 'control',
  categoryKey: 'html-injection',
  title: '对照：textContent 纯文本渲染',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-html-01'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-html-01\n\n评论渲染模块（安全对照实现）。\n',
    },
    {
      path: 'src/render.ts',
      content: [
        'export function renderComment(el: HTMLElement, text: string): void {',
        '  // 纯文本渲染：不解析 HTML',
        '  el.textContent = text',
        '}',
        '',
        'export function renderBadge(el: HTMLElement, label: string): void {',
        "  el.setAttribute('data-label', label)",
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { renderComment, renderBadge } from './render'\n",
    },
  ],
  annotations: [],
}

const fxHtml02: FixtureProjectDef = {
  id: 'fx-html-02',
  kind: 'defect',
  categoryKey: 'html-injection',
  title: 'dangerouslySetInnerHTML 注入动态内容',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-html-02', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-html-02\n\n个人简介卡片组件（评测样例）。\n',
    },
    {
      path: 'src/BioCard.tsx',
      content: [
        'export function BioCard({ bio }: { bio: string }) {',
        '  return <div className="bio" dangerouslySetInnerHTML={{ __html: bio }} />',
        '}',
        '',
        'export function TagList({ tags }: { tags: string[] }) {',
        '  return (',
        '    <ul>',
        '      {tags.map((t) => (',
        '        <li key={t}>{t}</li>',
        '      ))}',
        '    </ul>',
        '  )',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { BioCard, TagList } from './BioCard'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'sec/dom-html-injection',
      category: 'security',
      file: 'src/BioCard.tsx',
      anchor: 'dangerouslySetInnerHTML',
      symbol: 'BioCard',
      condition: 'bio 属性若来自用户输入且未净化，将注入任意 HTML/脚本',
    },
  ],
}

const fxCtlHtml02: FixtureProjectDef = {
  id: 'fx-ctl-html-02',
  kind: 'control',
  categoryKey: 'html-injection',
  title: '对照：JSX 表达式渲染 + 带 key 列表',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-html-02', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-html-02\n\n个人简介卡片组件（安全对照实现）。\n',
    },
    {
      path: 'src/BioCard.tsx',
      content: [
        'export function BioCard({ bio }: { bio: string }) {',
        '  return <div className="bio">{bio}</div>',
        '}',
        '',
        'export function TagList({ tags }: { tags: string[] }) {',
        '  return (',
        '    <ul>',
        '      {tags.map((t) => (',
        '        <li key={t}>{t}</li>',
        '      ))}',
        '    </ul>',
        '  )',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { BioCard, TagList } from './BioCard'\n",
    },
  ],
  annotations: [],
}

/* ---------- 类别 3：跨窗口消息源（sec/postmessage-unconstrained / sec/message-no-origin-check） ---------- */

const fxMsg01: FixtureProjectDef = {
  id: 'fx-msg-01',
  kind: 'defect',
  categoryKey: 'postmessage',
  title: 'postMessage 目标源为通配符',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-msg-01'),
    },
    {
      path: 'README.md',
      content: '# fx-msg-01\n\niframe 高度上报桥（评测样例）。\n',
    },
    {
      path: 'src/bridge.ts',
      content: [
        'export interface HeightMessage {',
        "  type: 'height'",
        '  height: number',
        '}',
        '',
        'export function sendHeight(height: number): void {',
        "  window.postMessage({ type: 'height', height }, '*')",
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { sendHeight } from './bridge'\nexport type { HeightMessage } from './bridge'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'sec/postmessage-unconstrained',
      category: 'security',
      file: 'src/bridge.ts',
      anchor: 'postMessage',
      symbol: 'sendHeight',
      condition: 'targetOrigin 为 "*"：消息包含敏感数据且页面被恶意站点嵌入时任意源可收到',
    },
  ],
}

const fxCtlMsg01: FixtureProjectDef = {
  id: 'fx-ctl-msg-01',
  kind: 'control',
  categoryKey: 'postmessage',
  title: '对照：postMessage 指定具体目标源',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-msg-01'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-msg-01\n\niframe 高度上报桥（安全对照实现）。\n',
    },
    {
      path: 'src/bridge.ts',
      content: [
        "const PARENT_ORIGIN = 'https://portal.example.com'",
        '',
        'export interface HeightMessage {',
        "  type: 'height'",
        '  height: number',
        '}',
        '',
        'export function sendHeight(height: number): void {',
        '  window.postMessage({ type: "height", height }, PARENT_ORIGIN)',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { sendHeight } from './bridge'\nexport type { HeightMessage } from './bridge'\n",
    },
  ],
  annotations: [],
}

const fxMsg02: FixtureProjectDef = {
  id: 'fx-msg-02',
  kind: 'defect',
  categoryKey: 'postmessage',
  title: 'message 监听未校验 event.origin',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-msg-02'),
    },
    {
      path: 'README.md',
      content: '# fx-msg-02\n\n主题同步监听模块（评测样例）。\n',
    },
    {
      path: 'src/listener.ts',
      content: [
        'export function listenForTheme(apply: (theme: string) => void): void {',
        "  window.addEventListener('message', (event) => {",
        '    const data = event.data as { type?: string; theme?: string }',
        "    if (data.type === 'theme') apply(data.theme ?? 'light')",
        '  })',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { listenForTheme } from './listener'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'sec/message-no-origin-check',
      category: 'security',
      file: 'src/listener.ts',
      anchor: "addEventListener('message'",
      symbol: 'listenForTheme',
      condition: '回调未比对 event.origin：任意来源窗口可伪造消息驱动页面逻辑',
    },
  ],
}

const fxCtlMsg02: FixtureProjectDef = {
  id: 'fx-ctl-msg-02',
  kind: 'control',
  categoryKey: 'postmessage',
  title: '对照：message 监听先比对来源白名单',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-msg-02'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-msg-02\n\n主题同步监听模块（安全对照实现）。\n',
    },
    {
      path: 'src/listener.ts',
      content: [
        "const ALLOWED_ORIGINS = ['https://portal.example.com']",
        '',
        'export function listenForTheme(apply: (theme: string) => void): void {',
        "  window.addEventListener('message', (event) => {",
        '    if (!ALLOWED_ORIGINS.includes(event.origin)) return',
        '    const data = event.data as { type?: string; theme?: string }',
        "    if (data.type === 'theme') apply(data.theme ?? 'light')",
        '  })',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { listenForTheme } from './listener'\n",
    },
  ],
  annotations: [],
}

/* ---------- 类别 4：JSX 列表缺失 key（cor/jsx-list-missing-key） ---------- */

const fxJsx01: FixtureProjectDef = {
  id: 'fx-jsx-01',
  kind: 'defect',
  categoryKey: 'jsx-key',
  title: '列表渲染缺少稳定 key',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-jsx-01', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-jsx-01\n\n用户列表组件（评测样例）。\n',
    },
    {
      path: 'src/UserList.tsx',
      content: [
        'export interface User {',
        '  id: string',
        '  name: string',
        '}',
        '',
        'export function UserList({ users }: { users: User[] }) {',
        '  return (',
        '    <ul>',
        '      {users.map((u) => (',
        '        <li>{u.name}</li>',
        '      ))}',
        '    </ul>',
        '  )',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { UserList } from './UserList'\nexport type { User } from './UserList'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'cor/jsx-list-missing-key',
      category: 'correctness',
      file: 'src/UserList.tsx',
      anchor: 'users.map',
      symbol: 'UserList',
      condition: '列表插入/删除/排序时 React 依据 key 复用节点，缺失导致状态错位',
    },
  ],
}

const fxCtlJsx01: FixtureProjectDef = {
  id: 'fx-ctl-jsx-01',
  kind: 'control',
  categoryKey: 'jsx-key',
  title: '对照：列表使用稳定 key',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-jsx-01', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-jsx-01\n\n用户列表组件（安全对照实现）。\n',
    },
    {
      path: 'src/UserList.tsx',
      content: [
        'export interface User {',
        '  id: string',
        '  name: string',
        '}',
        '',
        'export function UserList({ users }: { users: User[] }) {',
        '  return (',
        '    <ul>',
        '      {users.map((u) => (',
        '        <li key={u.id}>{u.name}</li>',
        '      ))}',
        '    </ul>',
        '  )',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { UserList } from './UserList'\nexport type { User } from './UserList'\n",
    },
  ],
  annotations: [],
}

const fxJsx02: FixtureProjectDef = {
  id: 'fx-jsx-02',
  kind: 'defect',
  categoryKey: 'jsx-key',
  title: 'Fragment 子元素缺少 key',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-jsx-02', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-jsx-02\n\n键值行列表组件（评测样例）。\n',
    },
    {
      path: 'src/RowList.tsx',
      content: [
        'export interface Row {',
        '  id: string',
        '  label: string',
        '}',
        '',
        'export function RowList({ rows }: { rows: Row[] }) {',
        '  return (',
        '    <div>',
        '      {rows.map((r) => (',
        '        <>',
        '          <dt>{r.label}</dt>',
        '          <dd>{r.id}</dd>',
        '        </>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { RowList } from './RowList'\nexport type { Row } from './RowList'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'cor/jsx-list-missing-key',
      category: 'correctness',
      file: 'src/RowList.tsx',
      anchor: 'rows.map',
      symbol: 'RowList',
      condition: 'Fragment 子元素未携带 key：列表重排时 dt/dd 状态错位',
    },
  ],
}

const fxCtlJsx02: FixtureProjectDef = {
  id: 'fx-ctl-jsx-02',
  kind: 'control',
  categoryKey: 'jsx-key',
  title: '对照：Fragment 携带 key',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-jsx-02', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-jsx-02\n\n键值行列表组件（安全对照实现）。\n',
    },
    {
      path: 'src/RowList.tsx',
      content: [
        "import { Fragment } from 'react'",
        '',
        'export interface Row {',
        '  id: string',
        '  label: string',
        '}',
        '',
        'export function RowList({ rows }: { rows: Row[] }) {',
        '  return (',
        '    <div>',
        '      {rows.map((r) => (',
        '        <Fragment key={r.id}>',
        '          <dt>{r.label}</dt>',
        '          <dd>{r.id}</dd>',
        '        </Fragment>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { RowList } from './RowList'\nexport type { Row } from './RowList'\n",
    },
  ],
  annotations: [],
}

/* ---------- 类别 5：Hook 条件/非法作用域调用（cor/react-hook-conditional） ---------- */

const fxHook01: FixtureProjectDef = {
  id: 'fx-hook-01',
  kind: 'defect',
  categoryKey: 'hook-conditional',
  title: 'useState 在条件分支内调用',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-hook-01', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-hook-01\n\n筛选器组件（评测样例）。\n',
    },
    {
      path: 'src/Filters.tsx',
      content: [
        "import { useState } from 'react'",
        '',
        'export function Filters({ items }: { items: string[] }) {',
        "  const [query, setQuery] = useState('')",
        '  if (items.length > 10) {',
        '    const [page, setPage] = useState(1)',
        '    void setPage',
        '  }',
        '  return <input value={query} onChange={(e) => setQuery(e.target.value)} />',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { Filters } from './Filters'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'cor/react-hook-conditional',
      category: 'correctness',
      file: 'src/Filters.tsx',
      anchor: 'useState(1)',
      symbol: 'Filters',
      condition: '分支未命中时 Hook 调用次数改变，React 依赖固定调用顺序，运行时将抛错',
    },
  ],
}

const fxCtlHook01: FixtureProjectDef = {
  id: 'fx-ctl-hook-01',
  kind: 'control',
  categoryKey: 'hook-conditional',
  title: '对照：Hook 全部位于组件顶层',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-hook-01', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-hook-01\n\n筛选器组件（安全对照实现）。\n',
    },
    {
      path: 'src/Filters.tsx',
      content: [
        "import { useState } from 'react'",
        '',
        'export function Filters({ items }: { items: string[] }) {',
        "  const [query, setQuery] = useState('')",
        '  const [page, setPage] = useState(1)',
        '  const showPager = items.length > 10',
        '  void setPage',
        '  void showPager',
        '  return <input value={query} onChange={(e) => setQuery(e.target.value)} />',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { Filters } from './Filters'\n",
    },
  ],
  annotations: [],
}

const fxHook02: FixtureProjectDef = {
  id: 'fx-hook-02',
  kind: 'defect',
  categoryKey: 'hook-conditional',
  title: 'useEffect 在普通函数内调用',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-hook-02', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-hook-02\n\n窗口尺寸绑定工具（评测样例）。\n',
    },
    {
      path: 'src/bindResize.ts',
      content: [
        "import { useEffect } from 'react'",
        '',
        'export function bindResizeOnce(): void {',
        '  useEffect(() => {',
        '    const onResize = () => undefined',
        "    window.addEventListener('resize', onResize)",
        "    return () => window.removeEventListener('resize', onResize)",
        '  }, [])',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { bindResizeOnce } from './bindResize'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'cor/react-hook-conditional',
      category: 'correctness',
      file: 'src/bindResize.ts',
      anchor: 'useEffect(() =>',
      symbol: 'bindResizeOnce',
      condition: '普通函数内的 Hook 与任何组件实例都不对应，违反 Hook 调用规则',
    },
  ],
}

const fxCtlHook02: FixtureProjectDef = {
  id: 'fx-ctl-hook-02',
  kind: 'control',
  categoryKey: 'hook-conditional',
  title: '对照：封装为自定义 Hook',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-hook-02', REACT_DEP),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-hook-02\n\n窗口尺寸绑定工具（安全对照实现）。\n',
    },
    {
      path: 'src/bindResize.ts',
      content: [
        "import { useEffect } from 'react'",
        '',
        'export function useBindResize(onResize: () => void): void {',
        '  useEffect(() => {',
        "    window.addEventListener('resize', onResize)",
        "    return () => window.removeEventListener('resize', onResize)",
        '  }, [onResize])',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { useBindResize } from './bindResize'\n",
    },
  ],
  annotations: [],
}

/* ---------- 类别 6：检查禁用与调试残留（mai/ts-check-disabled / mai/console-residue） ---------- */

const fxChk01: FixtureProjectDef = {
  id: 'fx-chk-01',
  kind: 'defect',
  categoryKey: 'check-disabled',
  title: '裸 @ts-ignore 关闭类型检查',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-chk-01'),
    },
    {
      path: 'README.md',
      content: '# fx-chk-01\n\n配置加载模块（评测样例）。\n',
    },
    {
      path: 'src/config.ts',
      content: [
        'export function loadPort(raw: string): number {',
        '  const config = JSON.parse(raw) as { port?: number }',
        '  const port = config.port',
        '  // @ts-ignore',
        '  return port',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { loadPort } from './config'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'mai/ts-check-disabled',
      category: 'maintainability',
      file: 'src/config.ts',
      anchor: '@ts-ignore',
      symbol: 'loadPort',
      condition: '该行绕过 TypeScript 诊断，类型错误不再被报告',
    },
  ],
}

const fxCtlChk01: FixtureProjectDef = {
  id: 'fx-ctl-chk-01',
  kind: 'control',
  categoryKey: 'check-disabled',
  title: '对照：@ts-expect-error 附带说明',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-chk-01'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-chk-01\n\n配置加载模块（安全对照实现）。\n',
    },
    {
      path: 'src/config.ts',
      content: [
        'export interface AppConfig {',
        '  port: number',
        '  host: string',
        '}',
        '',
        'export function loadConfig(raw: string): AppConfig {',
        '  const parsed: unknown = JSON.parse(raw)',
        '  const config = parsed as Partial<AppConfig>',
        '  // @ts-expect-error 遗留响应缺少 host 字段，等待后端补齐后移除（issue #142）',
        '  const host = config.host',
        '  return { port: config.port ?? 8080, host }',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { loadConfig } from './config'\nexport type { AppConfig } from './config'\n",
    },
  ],
  annotations: [],
}

const fxChk02: FixtureProjectDef = {
  id: 'fx-chk-02',
  kind: 'defect',
  categoryKey: 'check-disabled',
  title: 'console 调试残留 + 禁用安全 ESLint 规则',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-chk-02'),
    },
    {
      path: 'README.md',
      content: '# fx-chk-02\n\n调试工具模块（评测样例）。\n',
    },
    {
      path: 'src/debug.ts',
      content: [
        'export function debugDump(state: unknown): void {',
        '  // 调试用输出（遗留）',
        "  console.log('state', state)",
        '  // 另一处调试输出',
        "  console.debug('dump', state)",
        '}',
        '',
        'export function reportError(err: Error): void {',
        "  console.error('failed', err.message)",
        '}',
      ].join('\n'),
    },
    {
      path: 'src/legacy-flags.ts',
      content: [
        '/* eslint-disable no-eval -- 本模块历史上集中封装动态执行入口 */',
        'export function legacyDynamicModule(): boolean {',
        '  return true',
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { debugDump, reportError } from './debug'\nexport { legacyDynamicModule } from './legacy-flags'\n",
    },
  ],
  annotations: [
    {
      ruleId: 'mai/console-residue',
      category: 'maintainability',
      file: 'src/debug.ts',
      anchor: 'console.log(',
      symbol: 'debugDump',
      condition: '生产环境输出内部结构，可能泄露信息并污染用户控制台',
    },
    {
      ruleId: 'mai/console-residue',
      category: 'maintainability',
      file: 'src/debug.ts',
      anchor: 'console.debug(',
      symbol: 'debugDump',
      condition: '调试输出残留在生产代码中，应改用统一 logger',
    },
    {
      ruleId: 'mai/ts-check-disabled',
      category: 'maintainability',
      file: 'src/legacy-flags.ts',
      anchor: 'eslint-disable',
      symbol: 'legacyDynamicModule',
      condition: '禁用安全相关 ESLint 规则（no-eval），风险信号在该范围丢失',
    },
  ],
}

const fxCtlChk02: FixtureProjectDef = {
  id: 'fx-ctl-chk-02',
  kind: 'control',
  categoryKey: 'check-disabled',
  title: '对照：统一 logger 缓冲实现',
  files: [
    {
      path: 'package.json',
      content: pkg('fx-ctl-chk-02'),
    },
    {
      path: 'README.md',
      content: '# fx-ctl-chk-02\n\n调试工具模块（安全对照实现）。\n',
    },
    {
      path: 'src/logger.ts',
      content: [
        'export interface LogEntry {',
        '  level: string',
        '  message: string',
        '}',
        '',
        'export interface Logger {',
        '  info(message: string): void',
        '  error(message: string): void',
        '}',
        '',
        'export function createLogger(prefix: string): Logger {',
        '  const buffer: LogEntry[] = []',
        '  return {',
        '    info: (message) => {',
        "      buffer.push({ level: 'info', message: prefix + ' ' + message })",
        '    },',
        '    error: (message) => {',
        "      buffer.push({ level: 'error', message: prefix + ' ' + message })",
        '    },',
        '  }',
        '}',
        '',
        'export function formatEntries(entries: LogEntry[]): string[] {',
        "  return entries.map((entry) => '[' + entry.level + '] ' + entry.message)",
        '}',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      content: "export { createLogger, formatEntries } from './logger'\nexport type { Logger, LogEntry } from './logger'\n",
    },
  ],
  annotations: [],
}

/** 24 个项目定义：6 类 × 2 场景 ×（缺陷 + 对照） */
export const FIXTURE_PROJECTS: FixtureProjectDef[] = [
  fxDyn01,
  fxCtlDyn01,
  fxDyn02,
  fxCtlDyn02,
  fxHtml01,
  fxCtlHtml01,
  fxHtml02,
  fxCtlHtml02,
  fxMsg01,
  fxCtlMsg01,
  fxMsg02,
  fxCtlMsg02,
  fxJsx01,
  fxCtlJsx01,
  fxJsx02,
  fxCtlJsx02,
  fxHook01,
  fxCtlHook01,
  fxHook02,
  fxCtlHook02,
  fxChk01,
  fxCtlChk01,
  fxChk02,
  fxCtlChk02,
]

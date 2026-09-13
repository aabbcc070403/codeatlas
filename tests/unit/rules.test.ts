import { describe, it, expect } from 'vitest'
import { runStaticRules, type StaticFileInput } from '../../src/core/rules'

function run(path: string, content: string, extra: Partial<StaticFileInput> = {}) {
  const language = path.split('.').pop() ?? 'ts'
  return runStaticRules([
    { path, content, language, parseOk: true, redactedRanges: [], ...extra },
  ])
}

function byRule(findings: ReturnType<typeof run>['findings'], ruleId: string) {
  return findings.filter((f) => f.ruleId === ruleId)
}

describe('规则：动态代码执行', () => {
  it('命中：eval 动态参数 / new Function', () => {
    const r = run('a.ts', 'const x = eval(userInput)\nconst f = new Function("return 1")\n')
    expect(byRule(r.findings, 'sec/dynamic-code-exec').length).toBe(2)
    const dynamic = byRule(r.findings, 'sec/dynamic-code-exec').find((f) => f.title.includes('候选'))!
    expect(dynamic.severity).toBe('high')
    expect(dynamic.needsReview).toBe(true)
  })

  it('命中：eval 字面量为低风险', () => {
    const r = run('a.ts', "const x = eval('1+1')\n")
    const f = byRule(r.findings, 'sec/dynamic-code-exec')[0]!
    expect(f.severity).toBe('low')
    expect(f.needsReview).toBe(false)
  })

  it('不命中：JSON.parse / 普通函数调用', () => {
    const r = run('a.ts', 'const x = JSON.parse(userInput)\nfunction evalx(a) { return a }\n')
    expect(byRule(r.findings, 'sec/dynamic-code-exec').length).toBe(0)
  })

  it('命中：setTimeout 字符串；不命中：函数引用', () => {
    const r = run('a.ts', "setTimeout('doThing()', 100)\nsetTimeout(() => doThing(), 100)\n")
    expect(byRule(r.findings, 'sec/dynamic-code-exec').length).toBe(1)
  })
})

describe('规则：HTML 注入入口', () => {
  it('命中：innerHTML 非字面量赋值 / insertAdjacentHTML 动态参数', () => {
    const r = run('a.js', [
      'el.innerHTML = getUserInput()',
      'el.insertAdjacentHTML("beforeend", template)',
    ].join('\n'))
    const hits = byRule(r.findings, 'sec/dom-html-injection')
    expect(hits.length).toBe(2)
    expect(hits.every((f) => f.needsReview)).toBe(true)
  })

  it('命中：dangerouslySetInnerHTML 动态值', () => {
    const r = run('a.tsx', 'export function C({ bio }: { bio: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: bio }} />\n}\n')
    expect(byRule(r.findings, 'sec/dom-html-injection').length).toBe(1)
  })

  it('不命中：innerHTML 字面量赋值 / dangerouslySetInnerHTML 固定字符串 / textContent', () => {
    const r = run('a.tsx', [
      'el.innerHTML = "<b>fixed</b>"',
      'export function C() {',
      '  return <div dangerouslySetInnerHTML={{ __html: "<b>ok</b>" }} />',
      '}',
      'el.textContent = userInput',
    ].join('\n'))
    expect(byRule(r.findings, 'sec/dom-html-injection').length).toBe(0)
  })
})

describe('规则：postMessage 目标源', () => {
  it('命中：* 与缺失 targetOrigin', () => {
    const r = run('a.js', [
      'iframe.contentWindow.postMessage(data, "*")',
      'win.postMessage(data)',
    ].join('\n'))
    expect(byRule(r.findings, 'sec/postmessage-unconstrained').length).toBe(2)
  })

  it('不命中：显式来源', () => {
    const r = run('a.js', 'iframe.contentWindow.postMessage(data, "https://app.example.com")\n')
    expect(byRule(r.findings, 'sec/postmessage-unconstrained').length).toBe(0)
  })
})

describe('规则：message 来源校验', () => {
  it('命中：无 origin 校验', () => {
    const r = run('a.js', 'window.addEventListener("message", (e) => {\n  doThing(e.data)\n})\n')
    const hits = byRule(r.findings, 'sec/message-no-origin-check')
    expect(hits.length).toBe(1)
    expect(hits[0]!.needsReview).toBe(false)
  })

  it('不命中：校验了 event.origin', () => {
    const r = run('a.js', 'window.addEventListener("message", (e) => {\n  if (e.origin !== "https://a.com") return\n  doThing(e.data)\n})\n')
    expect(byRule(r.findings, 'sec/message-no-origin-check').length).toBe(0)
  })

  it('命中：外部回调引用且函数体内无 origin 校验', () => {
    const r = run('a.js', 'window.addEventListener("message", onMessage)\nfunction onMessage(e) { doThing(e.data) }\n')
    const hits = byRule(r.findings, 'sec/message-no-origin-check')
    expect(hits.length).toBe(1)
    expect(hits[0]!.needsReview).toBe(false)
  })
})

describe('规则：JSX 列表 key', () => {
  it('命中：map 缺 key（直接返回与条件分支）', () => {
    const r = run('list.tsx', [
      'export function List({ items }: { items: string[] }) {',
      '  return <ul>{items.map((it) => <li>{it}</li>)}</ul>',
      '}',
      'export function List2({ items }: { items: string[] }) {',
      '  return <div>{items.map((it) => it.active ? <span>{it.name}</span> : <b>{it.name}</b>)}</div>',
      '}',
    ].join('\n'))
    expect(byRule(r.findings, 'cor/jsx-list-missing-key').length).toBe(2)
  })

  it('不命中：有 key / 非列表 JSX', () => {
    const r = run('list.tsx', [
      'export function A({ items }: { items: Array<{ id: string }> }) {',
      '  return <ul>{items.map((it) => <li key={it.id}>{it.name}</li>)}</ul>',
      '}',
      'export function B({ name }: { name: string }) {',
      '  return <h1>{name}</h1>',
      '}',
    ].join('\n'))
    expect(byRule(r.findings, 'cor/jsx-list-missing-key').length).toBe(0)
  })

  it('Vue 文件不运行 JSX 规则', () => {
    const r = run('c.vue', '<template><div/></template>\n<script setup>\nconst f = () => {}\n</script>\n')
    expect(byRule(r.findings, 'cor/jsx-list-missing-key').length).toBe(0)
  })
})

describe('规则：Hook 条件调用', () => {
  it('命中：if 内 / && 右侧 / 普通函数内', () => {
    const r = run('h.tsx', [
      'export function C({ flag }: { flag: boolean }) {',
      '  if (flag) {',
      '    const [v] = useState(0)',
      '  }',
      '  const w = flag && useMemo(() => 1, [])',
      '  return <div/>',
      '}',
      'function helper() {',
      '  const r = useRef(null)',
      '  return r',
      '}',
    ].join('\n'))
    const hits = byRule(r.findings, 'cor/react-hook-conditional')
    expect(hits.length).toBe(3)
  })

  it('不命中：组件顶层 / 自定义 Hook 内 / 同名普通函数不含 Hook', () => {
    const r = run('h.tsx', [
      'export function C() {',
      '  const [v] = useState(0)',
      '  const data = useFetch("/api")',
      '  return <div>{v}</div>',
      '}',
      'function useFetch(url: string) {',
      '  return useMemo(() => url, [url])',
      '}',
      'function useStateLog() {',
      '  return "not a hook call site"',
      '}',
    ].join('\n'))
    expect(byRule(r.findings, 'cor/react-hook-conditional').length).toBe(0)
  })

  it('不命中：循环体外层的判断表达式', () => {
    const r = run('h.tsx', [
      'export function C({ items }: { items: string[] }) {',
      '  const [v] = useState(0)',
      '  return <ul>{items.map((it) => <li key={it}>{v}</li>)}</ul>',
      '}',
    ].join('\n'))
    expect(byRule(r.findings, 'cor/react-hook-conditional').length).toBe(0)
  })
})

describe('规则：禁用检查与调试输出', () => {
  it('命中：@ts-ignore / @ts-nocheck / 无说明 @ts-expect-error', () => {
    const r = run('d.ts', [
      '// @ts-ignore',
      'const a: number = "x"',
      '// @ts-expect-error',
      'const b: number = "y"',
    ].join('\n'))
    expect(byRule(r.findings, 'mai/ts-check-disabled').length).toBe(2)
  })

  it('不命中：带说明的 @ts-expect-error / 普通注释', () => {
    const r = run('d.ts', [
      '// @ts-expect-error 上游类型错误，issue #123',
      'const a: number = "x"',
      '// 正常注释',
      'const b = 1',
    ].join('\n'))
    expect(byRule(r.findings, 'mai/ts-check-disabled').length).toBe(0)
  })

  it('命中：eslint-disable 安全规则', () => {
    const r = run('d.ts', '// eslint-disable-next-line no-eval\nconst x = eval(y)\n')
    expect(byRule(r.findings, 'mai/ts-check-disabled').length).toBe(1)
  })

  it('命中 console.log；不命中 console.error', () => {
    const r = run('d.ts', 'console.log("debug", data)\nconsole.error("real error", err)\n')
    expect(byRule(r.findings, 'mai/console-residue').length).toBe(1)
  })
})

describe('规则：疑似硬编码密钥（来自脱敏记录）', () => {
  it('命中：脱敏区间 → 候选待核查', () => {
    const content = 'const apiKey = "**********************"\n'
    const r = run('s.ts', content, { redactedRanges: [{ line: 1, start: 16, end: 38 }] })
    const hits = byRule(r.findings, 'sec/hardcoded-secret-candidate')
    expect(hits.length).toBe(1)
    expect(hits[0]!.needsReview).toBe(true)
    expect(hits[0]!.primary.quote).toContain('*')
  })

  it('不命中：无脱敏记录', () => {
    const r = run('s.ts', 'const name = "hello"\n', { redactedRanges: [] })
    expect(byRule(r.findings, 'sec/hardcoded-secret-candidate').length).toBe(0)
  })
})

describe('静态结果合同', () => {
  it('所有 finding 携带真实路径、行号与引文', () => {
    const content = 'function run(code) {\n  return eval(code)\n}\n'
    const r = run('src/danger.js', content)
    const f = byRule(r.findings, 'sec/dynamic-code-exec')[0]!
    expect(f.primary.path).toBe('src/danger.js')
    expect(f.primary.startLine).toBe(2)
    expect(f.primary.endLine).toBe(2)
    expect(f.primary.quote).toBe('  return eval(code)')
    expect(f.ruleId).toBeTruthy()
    expect(f.fingerprint).toContain('sec/dynamic-code-exec')
  })

  it('同一输入结果确定且按路径排序', () => {
    const content = 'const x = eval(a)\nconsole.log(x)\n'
    const r1 = run('z.ts', content)
    const r2 = run('z.ts', content)
    expect(r1.findings).toEqual(r2.findings)
  })

  it('parse_error 文件不参与规则且计入解析失败', () => {
    const r = runStaticRules([
      { path: 'bad.ts', content: 'const x = {{{', language: 'ts', parseOk: false, redactedRanges: [] },
      { path: 'ok.ts', content: 'const y = 1\n', language: 'ts', parseOk: true, redactedRanges: [] },
    ])
    expect(r.parseFailedCount).toBe(1)
    expect(r.checkedFileCount).toBe(1)
    expect(r.findings.length).toBe(0)
  })
})

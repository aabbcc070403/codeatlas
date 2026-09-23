import fs from 'node:fs'
import path from 'node:path'

/**
 * 测试语料加载（版本化数据文件，单一数据源）：
 * 脱敏样例 token、规则/报告样例代码、演示语料均为**被测功能的输入数据**，
 * 统一存放于 tests/fixtures/*.json —— 语料不作为可执行代码存在于源码文件，
 * 与 scripts/make-demo-zip.ts、契约测试共用同一份数据。
 *
 * 用 fs 读取而非 ESM JSON 导入：Playwright（Node ESM）要求 import attributes，
 * vitest / tsx / tsc 支持各不相同；fs 读取在全部运行时行为一致。
 */

const fixturesDir = path.resolve(process.cwd(), 'tests', 'fixtures')

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as T
}

export const redactTokens = readJson<{
  skToken: string
  awsToken: string
  ghToken: string
  jwtToken: string
  pemBody: string
  passwordValue: string
  skLiveToken: string
}>('redact-tokens.json')

export const codeSamples = readJson<{
  evalDynamicAndFunction: string
  evalLiteralArg: string
  evalWithDisableComment: string
  evalReturnFunction: string
  evalAssign: string
  evalTsFile: string
  jsxListFile: string
}>('code-samples.json')

export const demoCorpus = readJson<{
  sample: Array<{ name: string; content: string }>
  fixed: Array<{ name: string; content: string }>
}>('demo-corpus.json')

/** 取样例代码的第 n 行（1 起）：报告/校验测试的引文断言与样例内容保持同源 */
export function lineOf(content: string, n: number): string {
  const line = content.split('\n')[n - 1]
  if (line === undefined) throw new Error(`样例代码无第 ${n} 行`)
  return line
}

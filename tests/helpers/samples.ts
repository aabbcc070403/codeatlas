import redactTokensJson from '../fixtures/redact-tokens.json'
import codeSamplesJson from '../fixtures/code-samples.json'
import demoCorpusJson from '../fixtures/demo-corpus.json'

/**
 * 测试语料加载（版本化数据文件，单一数据源）：
 * 脱敏样例 token、规则/报告样例代码、演示语料均为**被测功能的输入数据**，
 * 统一存放于 tests/fixtures/*.json —— 语料不作为可执行代码存在于源码文件，
 * 与 scripts/make-demo-zip.ts、契约测试共用同一份数据。
 */

export const redactTokens = redactTokensJson

export const codeSamples = codeSamplesJson

export const demoCorpus = demoCorpusJson as {
  sample: Array<{ name: string; content: string }>
  fixed: Array<{ name: string; content: string }>
}

/** 取样例代码的第 n 行（1 起）：报告/校验测试的引文断言与样例内容保持同源 */
export function lineOf(content: string, n: number): string {
  const line = content.split('\n')[n - 1]
  if (line === undefined) throw new Error(`样例代码无第 ${n} 行`)
  return line
}

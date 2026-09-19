import { describe, expect, it } from 'vitest'
import { FIXED_FILES, SAMPLE_FILES } from '../e2e/helpers'

/**
 * P4.2 演示语料契约:docs/demo-script.md 的演示 ZIP 由 SAMPLE_FILES / FIXED_FILES
 * 经 scripts/make-demo-zip.ts 生成,本测试锁定其结构,防止测试语料演化后
 * 演示环节(4 类静态问题 / 追问 / 补丁 / 第二快照对比)静默失效。
 */

const allOrigin = SAMPLE_FILES.map((f) => f.content).join('\n')
const app = SAMPLE_FILES.find((f) => f.name === 'src/App.tsx')
const danger = SAMPLE_FILES.find((f) => f.name === 'src/danger.js')

describe('演示语料契约(P4.2)', () => {
  it('原始版:4 个文件(3 个源文件 + package.json)', () => {
    expect(SAMPLE_FILES.length).toBe(4)
    expect(SAMPLE_FILES.filter((f) => f.name !== 'package.json').length).toBe(3)
  })

  it('原始版:覆盖 4 类静态问题标记', () => {
    expect(app).toBeDefined()
    expect(danger).toBeDefined()
    expect(app!.content).toContain('dangerouslySetInnerHTML') // html-injection
    expect(app!.content).toContain('.map((it) => <li>{it}</li>)') // jsx-key(无 key)
    expect(danger!.content).toMatch(/\beval\(/) // dynamic-exec
    expect(danger!.content).toContain('addEventListener("message"') // postmessage
  })

  it('原始版:html-injection 可追问可补丁(演示脚本第 4/5 段目标)', () => {
    // App.tsx 主引用 src/App.tsx:3 为追问示例「这段输入经过净化了吗?」与补丁提案对象
    expect(app!.content.split('\n')[2]).toContain('dangerouslySetInnerHTML')
  })

  it('修复版:移除 HTML 注入、新增 new Function、保留其余问题(对比四态可达)', () => {
    const fixedApp = FIXED_FILES.find((f) => f.name === 'src/App.tsx')!
    const fixedDanger = FIXED_FILES.find((f) => f.name === 'src/danger.js')!
    expect(fixedApp.content).not.toContain('dangerouslySetInnerHTML') // 未再检出
    expect(fixedApp.content).toContain('.map((it) => <li>{it}</li>)') // 仍存在
    expect(fixedDanger.content).toContain('new Function(') // 新增
    const fixedAll = FIXED_FILES.map((f) => f.content).join('\n')
    expect(fixedAll).toMatch(/\beval\(/) // 仍存在
    expect(fixedAll).toContain('addEventListener("message"') // 仍存在
  })

  it('两版文件名集合一致(对比按路径匹配)', () => {
    expect(FIXED_FILES.map((f) => f.name).sort()).toEqual(SAMPLE_FILES.map((f) => f.name).sort())
  })

  it('语料不含真实凭证形态的长密钥', () => {
    expect(allOrigin).not.toMatch(/(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/)
  })
})

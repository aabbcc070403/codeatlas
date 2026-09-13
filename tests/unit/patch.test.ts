import { describe, expect, it } from 'vitest'
import {
  MAX_PATCH_CHANGED_LINES,
  submitPatchInputSchema,
  type PatchEdit,
} from '../../src/core/contracts/patch'
import { applyEdits } from '../../src/core/patch/apply'
import { makeUnifiedDiff, isDownloadable } from '../../src/core/patch/diff'
import { isLockfilePath, sha256OfContent, validateEdits } from '../../src/core/patch/edits'
import { compareSyntax, countSyntaxErrors, isSyntaxCheckable } from '../../src/core/patch/syntax'
import { buildFileExcerpt, MockPatchProvider } from '../../src/core/patch/propose'

/**
 * R06 补丁编辑校验矩阵（规格 9.5）：hash 不符、旧文本不匹配、行越界、
 * 重叠编辑、超 200 行、多文件、脱敏区间命中、创建/删除文件与锁文件拒绝；
 * apply 正确应用（含多段编辑顺序无关）；unified diff 含 +/− 行。
 * 全部为纯内存函数，不触数据库与存储。
 */

const FILE_LINES = [
  'export function greet(name: string) {',
  "  const greeting = 'hello ' + name",
  '  return greeting',
  '}',
  '',
  'export const VERSION = 1',
  'export const TAG = "v1"',
  'export function bye() {',
  '  return "bye"',
  '}',
]
const FILE = FILE_LINES.join('\n')
const FILE_HASH = sha256OfContent(FILE)

function target(overrides: Partial<Parameters<typeof validateEdits>[1]> = {}) {
  return {
    path: 'src/a.ts',
    content: FILE,
    contentHash: FILE_HASH,
    lineCount: FILE_LINES.length,
    redactedRanges: [],
    ...overrides,
  }
}

function edit(overrides: Partial<PatchEdit> = {}): PatchEdit {
  return {
    path: 'src/a.ts',
    baseFileHash: FILE_HASH,
    startLine: 2,
    endLine: 2,
    expectedOldText: FILE_LINES[1]!,
    replacementText: "  const greeting = 'hi ' + name",
    ...overrides,
  }
}

/* ---------------- 校验链矩阵 ---------------- */

describe('R06 validateEdits 校验链', () => {
  it('合法的单行/多行编辑通过', () => {
    const single = validateEdits([edit()], target())
    expect(single.ok).toBe(true)
    expect(single.reasons).toEqual([])

    const multi = validateEdits(
      [
        edit({ startLine: 2, endLine: 3, expectedOldText: FILE_LINES.slice(1, 3).join('\n') }),
        edit({ startLine: 7, endLine: 7, expectedOldText: FILE_LINES[6]!, replacementText: 'export const TAG = "v2"' }),
      ],
      target(),
    )
    expect(multi.ok).toBe(true)
  })

  it('hash 不符（过期基线）拒绝', () => {
    const result = validateEdits([edit({ baseFileHash: 'deadbeef'.repeat(8) })], target())
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('baseFileHash')
  })

  it('旧文本与快照行不匹配拒绝；统一 LF 后 CRLF 可通过', () => {
    const bad = validateEdits([edit({ expectedOldText: '  const greeting = "hello " + name' })], target())
    expect(bad.ok).toBe(false)
    expect(bad.reasons.join('\n')).toContain('旧文本')

    const crlf = validateEdits(
      [
        edit({
          startLine: 2,
          endLine: 3,
          expectedOldText: FILE_LINES.slice(1, 3).join('\r\n'),
          replacementText: 'a\r\nb',
        }),
      ],
      target(),
    )
    expect(crlf.ok).toBe(true)
  })

  it('行段越界与 start > end 拒绝', () => {
    const beyond = validateEdits([edit({ startLine: 9, endLine: 11 })], target())
    expect(beyond.ok).toBe(false)
    expect(beyond.reasons.join('\n')).toContain('越界')

    const reversed = validateEdits([edit({ startLine: 3, endLine: 2 })], target())
    expect(reversed.ok).toBe(false)
    expect(reversed.reasons.join('\n')).toContain('行范围非法')
  })

  it('重叠编辑拒绝；相邻不重叠通过', () => {
    const overlap = validateEdits(
      [
        edit({ startLine: 1, endLine: 3, expectedOldText: FILE_LINES.slice(0, 3).join('\n') }),
        edit({ startLine: 3, endLine: 5, expectedOldText: FILE_LINES.slice(2, 5).join('\n') }),
      ],
      target(),
    )
    expect(overlap.ok).toBe(false)
    expect(overlap.reasons.join('\n')).toContain('重叠')

    const adjacent = validateEdits(
      [
        edit({ startLine: 1, endLine: 2, expectedOldText: FILE_LINES.slice(0, 2).join('\n') }),
        edit({ startLine: 3, endLine: 4, expectedOldText: FILE_LINES.slice(2, 4).join('\n') }),
      ],
      target(),
    )
    expect(adjacent.ok).toBe(true)
  })

  it(`总变更行数 ≤ ${MAX_PATCH_CHANGED_LINES}：恰好 200 通过，201 拒绝`, () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
    const bigTarget = target({ content: big, lineCount: 300 })
    // 替换 10–200 行（191 行旧文本）为 200 行 → 变更行数 = max(191, 200) = 200
    const old200 = Array.from({ length: 191 }, (_, i) => `line ${i + 10}`).join('\n')
    const new200 = Array.from({ length: 200 }, (_, i) => `new ${i + 1}`).join('\n')
    expect(validateEdits([edit({ startLine: 10, endLine: 200, expectedOldText: old200, replacementText: new200 })], bigTarget).ok).toBe(true)
    const new201 = Array.from({ length: 201 }, (_, i) => `new ${i + 1}`).join('\n')
    const over = validateEdits([edit({ startLine: 10, endLine: 200, expectedOldText: old200, replacementText: new201 })], bigTarget)
    expect(over.ok).toBe(false)
    expect(over.reasons.join('\n')).toContain('上限')
  })

  it('多文件编辑拒绝；路径与目标文件不一致拒绝（禁止创建/删除文件）', () => {
    const multiFile = validateEdits([edit(), edit({ path: 'src/b.ts', startLine: 1, endLine: 1, expectedOldText: 'x' })], target())
    expect(multiFile.ok).toBe(false)
    expect(multiFile.reasons.join('\n')).toContain('单个文件')

    const otherPath = validateEdits([edit({ path: 'src/not-in-snapshot.ts' })], target())
    expect(otherPath.ok).toBe(false)
    expect(otherPath.reasons.join('\n')).toContain('不一致')
  })

  it('锁文件路径拒绝', () => {
    expect(isLockfilePath('package-lock.json')).toBe(true)
    expect(isLockfilePath('sub/dir/pnpm-lock.yaml')).toBe(true)
    expect(isLockfilePath('yarn.lock')).toBe(true)
    expect(isLockfilePath('vue.lock')).toBe(true)
    expect(isLockfilePath('src/a.ts')).toBe(false)

    const lockTarget = target({ path: 'sub/package-lock.json' })
    const result = validateEdits([edit({ path: 'sub/package-lock.json' })], lockTarget)
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('锁文件')
  })

  it('命中脱敏区间（含 diff 上下文邻域）的编辑拒绝', () => {
    // 第 2 行有脱敏区间
    const t = target({ redactedRanges: [{ line: 2, start: 10, end: 14 }] })
    const hit = validateEdits([edit()], t)
    expect(hit.ok).toBe(false)
    expect(hit.reasons.join('\n')).toContain('脱敏')
    // 邻域：第 5 行（span 3 → 2..8 含第 2 行）同样拒绝
    const neighbor = validateEdits(
      [edit({ startLine: 5, endLine: 5, expectedOldText: FILE_LINES[4]!, replacementText: 'x' })],
      t,
    )
    expect(neighbor.ok).toBe(false)
    // 远离脱敏行：第 9 行（span 3 → 6..12）通过
    const far = validateEdits(
      [edit({ startLine: 9, endLine: 9, expectedOldText: FILE_LINES[8]!, replacementText: '  return "bye!"' })],
      t,
    )
    expect(far.ok).toBe(true)
  })

  it('submit_patch 工具合同：多文件列表 Zod 校验失败', () => {
    const parsed = submitPatchInputSchema.safeParse({ edits: [edit(), edit({ path: 'src/b.ts' })] })
    expect(parsed.success).toBe(false)
    const ok = submitPatchInputSchema.safeParse({ edits: [edit()] })
    expect(ok.success).toBe(true)
  })
})

/* ---------------- 应用与 diff ---------------- */

describe('R06 applyEdits 内存副本应用', () => {
  it('单段替换正确应用；空 replacementText 表示删除区间', () => {
    const replaced = applyEdits(FILE, [edit()])
    expect(replaced.split('\n')[1]).toBe("  const greeting = 'hi ' + name")
    expect(replaced.split('\n').length).toBe(FILE_LINES.length)

    const deleted = applyEdits(FILE, [edit({ replacementText: '' })])
    expect(deleted.split('\n').length).toBe(FILE_LINES.length - 1)
    expect(deleted.split('\n')[1]).toBe(FILE_LINES[2])
  })

  it('多段编辑顺序无关：乱序输入与升序输入结果一致', () => {
    const edits = [
      edit({ startLine: 2, endLine: 2, replacementText: '  // rewritten 2' }),
      edit({ startLine: 5, endLine: 6, expectedOldText: FILE_LINES.slice(4, 6).join('\n'), replacementText: 'export const VERSION = 2\nexport const EXTRA = true' }),
      edit({ startLine: 9, endLine: 9, replacementText: '  return "see you"' }),
    ]
    const asc = applyEdits(FILE, [...edits].sort((a, b) => a.startLine - b.startLine))
    const shuffled = applyEdits(FILE, [edits[2]!, edits[0]!, edits[1]!])
    const reversed = applyEdits(FILE, [...edits].reverse())
    expect(shuffled).toBe(asc)
    expect(reversed).toBe(asc)
    const lines = asc.split('\n')
    expect(lines[1]).toBe('  // rewritten 2')
    expect(lines[4]).toBe('export const VERSION = 2')
    expect(lines[8]).toBe('  return "see you"')
  })

  it('插入式编辑（原行保留 + 上方插入注释）不丢内容', () => {
    const insertion = edit({ replacementText: `// review note\n${FILE_LINES[1]!}` })
    const out = applyEdits(FILE, [insertion])
    const lines = out.split('\n')
    expect(lines[1]).toBe('// review note')
    expect(lines[2]).toBe(FILE_LINES[1])
    expect(lines.length).toBe(FILE_LINES.length + 1)
  })
})

describe('R06 unified diff 生成', () => {
  it('输出含 +/− 行与 a/ b/ 文件头', () => {
    const diff = makeUnifiedDiff('src/a.ts', FILE, applyEdits(FILE, [edit()]))
    expect(diff).toContain('--- a/src/a.ts')
    expect(diff).toContain('+++ b/src/a.ts')
    expect(diff).toContain('-' + FILE_LINES[1])
    expect(diff).toContain("+  const greeting = 'hi ' + name")
    expect(diff).toContain('@@')
  })

  it('isDownloadable：仅 applicable 且 syntax=pass 可下载（A02：baseline_failed 保守不可下载）', () => {
    expect(isDownloadable({ applicable: true, syntax: 'pass' })).toBe(true)
    expect(isDownloadable({ applicable: true, syntax: 'fail' })).toBe(false)
    // A02：基线已有错误 → 无法证明补丁不引入新错误 → 不可作为已验证提案下载
    expect(isDownloadable({ applicable: true, syntax: 'baseline_failed' })).toBe(false)
    expect(isDownloadable({ applicable: true, syntax: 'not_checkable' })).toBe(false)
    expect(isDownloadable({ applicable: false, syntax: 'pass' })).toBe(false)
  })
})

/* ---------------- 语法比较 ---------------- */

describe('R06 compareSyntax 语法比较', () => {
  it('签名集合比较：干净→干净 pass；干净→有错 fail；基线有错 → baseline_failed（保守）', () => {
    const clean = 'const a = 1\n'
    expect(compareSyntax('ts', 'a.ts', clean, 'const a = 2\n')).toMatchObject({ status: 'pass', baselineErrors: 0, patchedErrors: 0, newSignatures: 0 })
    expect(compareSyntax('ts', 'a.ts', clean, 'const const const\n').newSignatures).toBeGreaterThan(0)
    expect(compareSyntax('ts', 'a.ts', clean, 'const const const\n').status).toBe('fail')
    expect(compareSyntax('ts', 'a.ts', clean, 'const a = ;\n').patchedErrors).toBeGreaterThan(0)
    const broken = 'const const const\n'
    // 与基线完全相同 → 补丁后签名是基线子集 → 无法证明不退化 → baseline_failed（错误数如实展示）
    const same = compareSyntax('ts', 'a.ts', broken, broken)
    expect(same.status).toBe('baseline_failed')
    expect(same.newSignatures).toBe(0)
    expect(same.patchedErrors).toBe(same.baselineErrors)
    expect(same.baselineErrors).toBeGreaterThan(0)
    // 注释掉出错行：修复了基线错误且未出现新签名 → 仍 baseline_failed（非 pass，不可下载）
    const fewer = compareSyntax('ts', 'a.ts', broken, '// const const const\nlet ok = 1\n')
    expect(fewer.status).toBe('baseline_failed')
    expect(fewer.patchedErrors).toBeLessThan(fewer.baselineErrors)
  })

  it('JSX/TSX/Vue 可解析；json/md/css/html 不支持（countSyntaxErrors → null）', () => {
    expect(countSyntaxErrors('tsx', 'a.tsx', 'export const el = <div className="x">hi</div>\n')).toBe(0)
    expect(countSyntaxErrors('vue', 'a.vue', '<template><p>{{ msg }}</p></template>\n<script setup lang="ts">\nconst msg = "hi"\n</script>\n')).toBe(0)
    expect(countSyntaxErrors('vue', 'a.vue', '<template><p></template>\n')).toBeGreaterThan(0)
    expect(countSyntaxErrors('json', 'a.json', '{')).toBeNull()
    expect(countSyntaxErrors('md', 'a.md', '# hi')).toBeNull()
    expect(countSyntaxErrors('css', 'a.css', 'body {')).toBeNull()
    expect(countSyntaxErrors('html', 'a.html', '<div>')).toBeNull()
    expect(isSyntaxCheckable('ts')).toBe(true)
    expect(isSyntaxCheckable('json')).toBe(false)
  })
})

/* ---------------- A02：语法不退化验收回归 ---------------- */

describe('A02 语法比较与下载许可（不得以"数量未增加"冒充"无新增语法错误"）', () => {
  it('替换错误位置（修好旧行、破坏新行）：错误数不变但错误迁移 → 不可作为已验证提案下载', () => {
    // 验收报告 A02 原始复现：两边错误数都是 1，数量比较会放行
    const result = compareSyntax('ts', 'a.ts', 'const a = ;\nconst b = 1;', 'const a = 1;\nconst b = ;')
    // 两处错误签名相同（位置无关）→ 签名集合无法区分"迁移"与"修复" → 保守状态
    expect(result).toMatchObject({ status: 'baseline_failed', baselineErrors: 1, patchedErrors: 1, newSignatures: 0 })
    expect(isDownloadable({ applicable: true, syntax: result.status })).toBe(false)
  })

  it('错误数量下降但新增基线不存在的其他错误 → fail，同样阻止下载', () => {
    // 基线 2 处 1109（Expression expected）；补丁后仅 1 处但为 1005（',' expected）——
    // 数量下降（2 → 1）却出现了基线不存在的签名
    const result = compareSyntax('ts', 'a.ts', 'const a = ;\nconst b = ;', 'const a = 1;\nconst b = 1 const c = 2')
    expect(result.baselineErrors).toBe(2)
    expect(result.patchedErrors).toBe(1)
    expect(result).toMatchObject({ status: 'fail', newSignatures: 1 })
    expect(isDownloadable({ applicable: true, syntax: result.status })).toBe(false)
  })

  it('错误数量下降且全部为基线已知签名 → 仍 baseline_failed（无法证明不退化），不可下载', () => {
    // 基线 3 处 1109；补丁后 1 处 1109（修好两行、破坏一行也无从区分）
    const result = compareSyntax('ts', 'a.ts', 'const a = ;\nconst b = ;\nconst c = ;', 'const a = 1;\nconst b = ;')
    expect(result).toMatchObject({ status: 'baseline_failed', baselineErrors: 3, patchedErrors: 1, newSignatures: 0 })
    expect(isDownloadable({ applicable: true, syntax: result.status })).toBe(false)
  })

  it('Vue 双 script 块：干净基线引入双 script → fail；双 script 基线被修复 → 保守 baseline_failed，均不可下载', () => {
    const clean = '<template><p>{{ msg }}</p></template>\n<script setup lang="ts">\nconst msg = "hi"\n</script>\n'
    const double = '<template><p>{{ msg }}</p></template>\n<script>\nconst a = 1\n</script>\n<script>\nconst b = 2\n</script>\n'
    // 干净基线 + 补丁引入双 script 结构错误 → 新签名 → fail
    const introduced = compareSyntax('vue', 'a.vue', clean, double)
    expect(introduced).toMatchObject({ status: 'fail', baselineErrors: 0, patchedErrors: 1, newSignatures: 1 })
    expect(isDownloadable({ applicable: true, syntax: introduced.status })).toBe(false)
    // 基线双 script、补丁后干净：基线已有错误 → 无法证明不退化 → 保守不可下载，
    // 不得表述为"无新增语法错误"
    const fixed = compareSyntax('vue', 'a.vue', double, clean)
    expect(fixed).toMatchObject({ status: 'baseline_failed', baselineErrors: 1, patchedErrors: 0, newSignatures: 0 })
    expect(isDownloadable({ applicable: true, syntax: fixed.status })).toBe(false)
  })

  it('正常修复全链路：validateEdits → applyEdits → compareSyntax = pass 且可下载', () => {
    // FILE 基线语法干净；把第 2 行替换为等价的干净文本（'hello ' → 'hi '）
    const edits = [edit()]
    expect(validateEdits(edits, target()).ok).toBe(true)
    const patched = applyEdits(FILE, edits)
    const result = compareSyntax('ts', 'src/a.ts', FILE, patched)
    expect(result).toMatchObject({ status: 'pass', baselineErrors: 0, patchedErrors: 0, newSignatures: 0 })
    expect(isDownloadable({ applicable: true, syntax: result.status })).toBe(true)
  })
})

/* ---------------- Mock 提案 provider 与摘录 ---------------- */

describe('R06 MockPatchProvider 确定性提案', () => {
  it('生成保守插入式注释编辑，通过校验链且语法不退化，明确 Mock 标注', async () => {
    const provider = new MockPatchProvider({
      path: 'src/a.ts',
      language: 'ts',
      baseFileHash: FILE_HASH,
      lineCount: FILE_LINES.length,
      startLine: 2,
      title: '示例问题 <b>标题\n第二行</b>',
      content: FILE,
    })
    expect(provider.isMock).toBe(true)
    const result = await provider.chat({ system: '', messages: [], tools: [], maxOutputTokens: 100 })
    expect(result.toolCalls).toHaveLength(1)
    const call = result.toolCalls[0]!
    expect(call.name).toBe('submit_patch')
    const parsed = submitPatchInputSchema.safeParse(call.args)
    expect(parsed.success).toBe(true)
    const edits = parsed.success ? parsed.data.edits : []
    const validated = validateEdits(edits, target())
    expect(validated.ok).toBe(true)
    const patched = applyEdits(FILE, edits)
    // 注入的标题（含 HTML 与换行）被单行化为一行注释，不引入额外行
    expect(patched).not.toContain('标题\n第二行</b>')
    expect(patched).toContain('Mock 示例提案，非真实 AI 修复')
    expect(compareSyntax('ts', 'src/a.ts', FILE, patched).status).toBe('pass')
  })

  it('buildFileExcerpt：窗口带 1 起始行号，越界收敛', () => {
    const excerpt = buildFileExcerpt(FILE, 2, 2)
    expect(excerpt.from).toBe(1)
    expect(excerpt.to).toBe(FILE_LINES.length)
    expect(excerpt.text).toContain(`2: ${FILE_LINES[1]}`)
    const huge = Array.from({ length: 400 }, (_, i) => `L${i + 1}`).join('\n')
    const capped = buildFileExcerpt(huge, 300, 300)
    expect(capped.to - capped.from + 1).toBeLessThanOrEqual(200)
    expect(capped.text).toContain('300: L300')
  })
})

import { describe, it, expect } from 'vitest'
import { normalizeEntryName, normalizeForCompare, PathRejection } from '../../src/core/import/paths'

describe('ZIP 条目路径校验', () => {
  it('接受正常相对路径', () => {
    expect(normalizeEntryName('src/a.ts')).toBe('src/a.ts')
    expect(normalizeEntryName('a/b/c.js')).toBe('a/b/c.js')
    expect(normalizeEntryName('README.md')).toBe('README.md')
    expect(normalizeEntryName('deep/nested/dir/file.vue')).toBe('deep/nested/dir/file.vue')
  })

  it('拒绝路径穿越（/ 与 \\ 形式）', () => {
    expect(() => normalizeEntryName('../evil.txt')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a/../../b.txt')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a/b/../c.txt')).toThrow(PathRejection)
    expect(() => normalizeEntryName('..\\evil.txt')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a\\..\\..\\b')).toThrow(PathRejection)
  })

  it('拒绝绝对路径与盘符', () => {
    expect(() => normalizeEntryName('/etc/passwd')).toThrow(PathRejection)
    expect(() => normalizeEntryName('C:/x.txt')).toThrow(PathRejection)
    expect(() => normalizeEntryName('C:\\x.txt')).toThrow(PathRejection)
    expect(() => normalizeEntryName('\\\\server\\share\\f')).toThrow(PathRejection)
  })

  it('拒绝 Windows 保留设备名', () => {
    for (const name of ['CON', 'con', 'NUL', 'nul.txt', 'aux.js', 'com1.ts', 'LPT1']) {
      expect(() => normalizeEntryName(name)).toThrow(PathRejection)
      expect(() => normalizeEntryName(`src/${name}`)).toThrow(PathRejection)
    }
  })

  it('拒绝 ADS 冒号、NUL、控制字符、非法字符', () => {
    expect(() => normalizeEntryName('file.txt:hidden')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a\u0000b')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a\u0001b')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a<b')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a|b')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a?b')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a*b')).toThrow(PathRejection)
  })

  it('拒绝空段、结尾点/空格、超长路径', () => {
    expect(() => normalizeEntryName('')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a//b')).toThrow(PathRejection)
    expect(() => normalizeEntryName('./x')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a.')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a ')).toThrow(PathRejection)
    expect(() => normalizeEntryName('a/'.repeat(200))).toThrow(PathRejection)
    expect(() => normalizeEntryName('x'.repeat(300))).toThrow(PathRejection)
  })

  it('大小写比较键：Windows 语义', () => {
    expect(normalizeForCompare('src/App.tsx')).toBe(normalizeForCompare('SRC/app.TSX'))
    expect(normalizeForCompare('a.ts')).not.toBe(normalizeForCompare('b.ts'))
  })
})

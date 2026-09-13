/**
 * ZIP 条目路径安全校验（规格 8）。
 * 拒绝：路径穿越、绝对路径、盘符、UNC、NUL/控制字符、Windows 保留设备名、
 * ADS 冒号、非法字符、结尾点/空格、超长路径。同时识别 / 与 \ 作为分隔符。
 * 大小写冲突检测由调用方用 normalizeForCompare 完成。
 */

export class PathRejection extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathRejection'
  }
}

const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

const ILLEGAL_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/

export function normalizeEntryName(rawName: string): string {
  if (rawName.length === 0) throw new PathRejection('空路径')
  if (rawName.length > 1024) throw new PathRejection('路径过长')
  // 统一识别 / 与 \
  const name = rawName.replace(/\\/g, '/')
  if (name.startsWith('/')) throw new PathRejection('绝对路径')
  if (name.includes('//')) throw new PathRejection('空路径段')

  const segments = name.split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') throw new PathRejection('空路径段')
    if (seg === '..') throw new PathRejection('路径穿越（..）')
    if (seg.length > 255) throw new PathRejection('路径段过长')
    if (ILLEGAL_CHARS.test(seg)) {
      if (seg.includes('\u0000')) throw new PathRejection('路径含 NUL 字符')
      throw new PathRejection(`路径含非法字符: ${seg.slice(0, 30)}`)
    }
    // 盘符（C:）与 ADS（file.txt:stream）
    if (seg.includes(':')) throw new PathRejection(`路径含冒号: ${seg.slice(0, 30)}`)
    // Windows 保留设备名（含带扩展名的形式 con.txt）
    const base = seg.split('.')[0]!.toLowerCase()
    if (RESERVED_DEVICE_NAMES.has(base)) {
      throw new PathRejection(`Windows 保留设备名: ${seg.slice(0, 30)}`)
    }
    if (/[. ]$/.test(seg)) throw new PathRejection('路径段以点或空格结尾')
    out.push(seg)
  }
  const result = out.join('/')
  if (result.length === 0) throw new PathRejection('空路径')
  return result
}

/** 大小写不敏感比较键（Windows 文件系统语义） */
export function normalizeForCompare(path: string): string {
  return path.toLowerCase()
}

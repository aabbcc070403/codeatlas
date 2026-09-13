/**
 * 测试用最小 ZIP 构造器（STORE / 预压缩 DEFLATE）。
 * 可控制 external attributes（模拟符号链接）、重复条目与真实解压大小（压缩炸弹）。
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i])!]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface RawZipEntry {
  name: string
  /** STORE：原始内容；DEFLATE：已用 deflateSync 压缩的内容 */
  content: Buffer | string
  /** (mode << 16) | dosAttrs；0xa1ff<<16 = 符号链接 */
  externalAttrs?: number
  /** method=8 时原始（未压缩）大小 */
  uncompressedSize?: number
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v, 0)
  return b
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0, 0)
  return b
}

/** 构造 ZIP；method 8 条目需传入已压缩内容与原始大小 */
export function buildRawZip(entries: Array<RawZipEntry & { method?: 0 | 8 }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const method = entry.method ?? 0
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw =
      typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content
    const stored = method === 8 ? raw : raw
    const uncompressedSize = method === 8 ? entry.uncompressedSize! : raw.length
    const crc = method === 8 ? undefined : crc32(raw)

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8 names
      u16(method),
      u16(0), u16(0), // time, date
      u32(crc ?? 0), // DEFLATE 场景由测试省略 CRC 校验（validateEntrySizes 只校验大小）
      u32(stored.length),
      u32(uncompressedSize),
      u16(nameBuf.length),
      u16(0),
    ])
    localParts.push(localHeader, nameBuf, stored)

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800),
      u16(method),
      u16(0), u16(0),
      u32(crc ?? 0),
      u32(stored.length),
      u32(uncompressedSize),
      u16(nameBuf.length),
      u16(0), u16(0), // extra, comment
      u16(0), u16(0), // disk start, internal attrs
      u32(entry.externalAttrs ?? 0),
      u32(offset),
    ])
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + stored.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

/** 构造 DEFLATE 压缩条目（先压缩再交给 buildRawZip） */
export function deflateEntry(name: string, content: Buffer | string): {
  name: string
  content: Buffer
  method: 8
  uncompressedSize: number
} {
  const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return {
    name,
    content: deflateRawSync(raw, { level: 9 }),
    method: 8 as const,
    uncompressedSize: raw.length,
  }
}

/** 用 jszip 构造常规 DEFLATE 归档（小体积正常场景） */
export async function buildDeflateZip(
  entries: Array<{ name: string; content: Buffer | string }>,
): Promise<Buffer> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  for (const e of entries) zip.file(e.name, e.content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

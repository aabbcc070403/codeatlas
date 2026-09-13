/**
 * 最小 ZIP 构造器（STORE，无压缩依赖）：评测 runner 用它把样例文件打包为
 * 真实 ZIP 归档，再走与用户上传完全一致的 prepareSnapshot 导入管线
 * （语言识别、LF 标准化、脱敏、解析状态、结构统计），保证评测与生产同构。
 */

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
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
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

export interface ZipEntry {
  name: string
  content: string
}

/** 构造 STORE 方式 ZIP（条目按名称排序，确定性输出） */
export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content, 'utf8')
    const crc = crc32(raw)

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8 names
      u16(0), // method = STORE
      u16(0),
      u16(0), // time, date
      u32(crc),
      u32(raw.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
    ])
    localParts.push(localHeader, nameBuf, raw)

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(raw.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0), // external attrs
      u32(offset),
    ])
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + raw.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(sorted.length),
    u16(sorted.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

import yauzl from 'yauzl'
import { normalizeEntryName, normalizeForCompare, PathRejection } from './paths'

export const ARCHIVE_LIMITS = {
  maxCompressedBytes: 20 * 1024 * 1024, // 20MiB
  maxTotalUncompressedBytes: 80 * 1024 * 1024, // 80MiB
  maxEntries: 2000,
  maxFileBytes: 512 * 1024, // 单文件 512KiB
} as const

export interface ArchiveFile {
  path: string
  content: Buffer
}

export interface SkippedItem {
  path: string
  reason: string
}

export type ArchiveRejection =
  | { kind: 'rejected'; reason: string }

export interface ArchiveResult {
  files: ArchiveFile[]
  skipped: SkippedItem[]
}

export class ArchiveError extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'ArchiveError'
  }
}

const S_IFMT = 0xf000
const S_IFLNK = 0xa000

/**
 * 预解析 central directory 检测符号链接条目（yauzl 不暴露 externalAttributes）。
 * 归档中存在任何符号链接即整体拒绝。zip64 时跳过预检（yauzl 仍按条目校验）。
 */
function detectSymlinks(buffer: Buffer): string | null {
  // 从尾部找 EOCD
  const minEocdPos = Math.max(0, buffer.length - 22 - 65535)
  let eocdPos = -1
  for (let i = buffer.length - 22; i >= minEocdPos; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i
      break
    }
  }
  if (eocdPos < 0) return null
  const entries = buffer.readUInt16LE(eocdPos + 10)
  let offset = buffer.readUInt32LE(eocdPos + 16)
  if (entries === 0xffff || offset === 0xffffffff) return null // zip64
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > buffer.length) return null
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const extAttrs = buffer.readUInt32LE(offset + 38)
    const mode = (extAttrs >>> 16) & S_IFMT
    if (mode === S_IFLNK) {
      const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
      return name
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/**
 * 流式读取 ZIP（规格 8）：按实际解压字节执行限额；
 * 拒绝路径穿越/绝对路径/盘符/符号链接/重复规范化路径/NUL/设备条目；
 * 内嵌 ZIP 不递归解析。
 */
export function readZip(
  buffer: Buffer,
  limits: typeof ARCHIVE_LIMITS = ARCHIVE_LIMITS,
): Promise<ArchiveResult> {
  return new Promise<ArchiveResult>((resolve, reject) => {
    if (buffer.length > limits.maxCompressedBytes) {
      reject(new ArchiveError(`归档大小超过 ${formatSize(limits.maxCompressedBytes)} 限制`))
      return
    }
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      reject(new ArchiveError('不是有效的 ZIP 文件'))
      return
    }
    const symlinkName = detectSymlinks(buffer)
    if (symlinkName) {
      reject(new ArchiveError(`符号链接条目被拒绝: ${symlinkName.slice(0, 60)}`))
      return
    }

    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
    }, handleOpen)

    function handleOpen(err: Error | null, zipfile: yauzl.ZipFile | null) {
      if (err || !zipfile) {
        reject(new ArchiveError(`无法读取 ZIP: ${err?.message ?? '未知错误'}`))
        return
      }
      const files: ArchiveFile[] = []
      const skipped: SkippedItem[] = []
      const seenPaths = new Set<string>()
      let totalUncompressed = 0
      let entryCount = 0
      let aborted = false

      const fail = (reason: string) => {
        if (aborted) return
        aborted = true
        try {
          zipfile.close()
        } catch {
          /* ignore */
        }
        reject(new ArchiveError(reason))
      }

      zipfile.on('error', (e: Error) => fail(`ZIP 读取错误: ${e.message}`))

      zipfile.readEntry()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (aborted) return
        entryCount++
        if (entryCount > limits.maxEntries) {
          fail(`条目数超过 ${limits.maxEntries} 限制`)
          return
        }

        // 目录条目：跳过
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry()
          return
        }

        // 路径安全
        let path: string
        try {
          path = normalizeEntryName(entry.fileName)
        } catch (e) {
          if (e instanceof PathRejection) {
            fail(`危险路径被拒绝（${e.message}）: ${entry.fileName.slice(0, 60)}`)
          } else {
            fail('路径解析失败')
          }
          return
        }
        const compareKey = normalizeForCompare(path)
        if (seenPaths.has(compareKey)) {
          fail(`重复路径（大小写冲突）: ${path}`)
          return
        }
        seenPaths.add(compareKey)

        // 单文件超限：流式读掉但不保留（保证实际字节计入总量）
        const oversized = entry.uncompressedSize > limits.maxFileBytes

        zipfile.openReadStream(entry, (err2, readStream) => {
          if (aborted) return
          if (err2 || !readStream) {
            fail(`读取条目失败: ${path}`)
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          readStream.on('data', (chunk: Buffer) => {
            size += chunk.length
            totalUncompressed += chunk.length
            if (totalUncompressed > limits.maxTotalUncompressedBytes) {
              fail(`解压总量超过 ${formatSize(limits.maxTotalUncompressedBytes)} 限制（疑似压缩炸弹）`)
              readStream.destroy()
              return
            }
            if (size > limits.maxFileBytes + 1024) {
              // 超限时不再累积内容
              return
            }
            chunks.push(chunk)
          })
          readStream.on('end', () => {
            if (aborted) return
            if (oversized || size > limits.maxFileBytes) {
              skipped.push({ path, reason: `单文件超过 ${formatSize(limits.maxFileBytes)} 限制` })
              zipfile.readEntry()
              return
            }
            files.push({ path, content: Buffer.concat(chunks) })
            zipfile.readEntry()
          })
          readStream.on('error', () => fail(`条目流错误: ${path}`))
        })
      })

      zipfile.on('end', () => {
        if (aborted) return
        resolve({ files, skipped })
      })
    }
  })
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KiB`
  return `${bytes}B`
}

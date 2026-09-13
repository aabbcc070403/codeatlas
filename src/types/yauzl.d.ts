/** yauzl 3.4 无官方类型，声明本项目使用的 API 子集 */
declare module 'yauzl' {
  import { Readable } from 'node:stream'

  export interface Entry {
    fileName: string
    compressedSize: number
    uncompressedSize: number
    crc32: number
  }

  export interface ZipFile {
    readEntry(): void
    openReadStream(
      entry: Entry,
      cb: (err: Error | null, stream?: Readable) => void,
    ): void
    close(): void
    on(event: 'entry', cb: (entry: Entry) => void): ZipFile
    on(event: 'error', cb: (err: Error) => void): ZipFile
    on(event: 'end', cb: () => void): ZipFile
    on(event: string, cb: (...args: unknown[]) => void): ZipFile
  }

  export interface OpenOptions {
    lazyEntries?: boolean
    autoClose?: boolean
    decodeStrings?: boolean
    validateEntrySizes?: boolean
  }

  export function fromBuffer(
    buffer: Buffer,
    options: OpenOptions,
    cb: (err: Error | null, zipfile: ZipFile | null) => void,
  ): void
}

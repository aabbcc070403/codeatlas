import { describe, it, expect } from 'vitest'
import { readZip, ArchiveError, ARCHIVE_LIMITS } from '../../src/core/import/archive'
import { buildRawZip, deflateEntry } from '../helpers/zip'

describe('ZIP 流式安全读取', () => {
  it('正常归档：条目与内容正确', async () => {
    const zip = buildRawZip([
      { name: 'src/a.ts', content: 'export const a = 1\n' },
      { name: 'README.md', content: '# hello\n' },
    ])
    const result = await readZip(zip)
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts', 'README.md'])
    expect(result.files[0]!.content.toString()).toBe('export const a = 1\n')
  })

  it('拒绝符号链接条目', async () => {
    const zip = buildRawZip([
      { name: 'link.ts', content: '../../etc/passwd', externalAttrs: 0xa1ff << 16 },
    ])
    await expect(readZip(zip)).rejects.toThrow(ArchiveError)
    await expect(readZip(zip)).rejects.toThrow(/符号链接/)
  })

  it('拒绝路径穿越（/ 与 \\）', async () => {
    await expect(
      readZip(buildRawZip([{ name: '../evil.txt', content: 'x' }])),
    ).rejects.toThrow(ArchiveError)
    await expect(
      readZip(buildRawZip([{ name: '..\\evil.txt', content: 'x' }])),
    ).rejects.toThrow(ArchiveError)
  })

  it('拒绝绝对路径与盘符', async () => {
    await expect(readZip(buildRawZip([{ name: '/abs.txt', content: 'x' }]))).rejects.toThrow(
      ArchiveError,
    )
    await expect(readZip(buildRawZip([{ name: 'C:/x.txt', content: 'x' }]))).rejects.toThrow(
      ArchiveError,
    )
  })

  it('拒绝保留设备名与 NUL 路径', async () => {
    await expect(readZip(buildRawZip([{ name: 'CON', content: 'x' }]))).rejects.toThrow(
      /保留设备名/,
    )
    await expect(readZip(buildRawZip([{ name: 'a\u0000b', content: 'x' }]))).rejects.toThrow(
      ArchiveError,
    )
  })

  it('拒绝重复路径与大小写冲突', async () => {
    await expect(
      readZip(buildRawZip([{ name: 'a.ts', content: 'x' }, { name: 'a.ts', content: 'y' }])),
    ).rejects.toThrow(/重复路径/)
    await expect(
      readZip(buildRawZip([{ name: 'A.ts', content: 'x' }, { name: 'a.ts', content: 'y' }])),
    ).rejects.toThrow(/重复路径/)
  })

  it('单文件超限被跳过并记录，其余文件保留', async () => {
    const big = 'x'.repeat(600 * 1024)
    const zip = buildRawZip([
      { name: 'big.txt', content: big },
      { name: 'small.ts', content: 'ok\n' },
    ])
    const result = await readZip(zip)
    expect(result.files.map((f) => f.path)).toEqual(['small.ts'])
    expect(result.skipped).toEqual([
      { path: 'big.txt', reason: expect.stringContaining('单文件超过') },
    ])
  })

  it('压缩炸弹：解压总量超限即中止', async () => {
    const bomb = Buffer.alloc(100 * 1024 * 1024, 0x41) // 100MiB 'A'
    const zip = buildRawZip([deflateEntry('bomb.txt', bomb)])
    expect(zip.length).toBeLessThan(ARCHIVE_LIMITS.maxCompressedBytes)
    await expect(readZip(zip)).rejects.toThrow(/解压总量超过|压缩炸弹/)
  })

  it('归档压缩体积超过 20MiB 直接拒绝', async () => {
    const random = Buffer.alloc(21 * 1024 * 1024)
    for (let i = 0; i < random.length; i += 4096) {
      random.fill(Math.floor(Math.random() * 256), i, i + 4096)
    }
    // STORE 方式打包：体积即为内容体积，无需压缩
    const zip = buildRawZip([{ name: 'rnd.bin', content: random }])
    expect(zip.length).toBeGreaterThan(ARCHIVE_LIMITS.maxCompressedBytes)
    await expect(readZip(zip)).rejects.toThrow(/归档大小超过/)
  })

  it('条目数超过 2000 拒绝', async () => {
    const entries = Array.from({ length: 2001 }, (_, i) => ({
      name: `f${i}.ts`,
      content: 'x',
    }))
    await expect(readZip(buildRawZip(entries))).rejects.toThrow(/条目数超过/)
  })

  it('非 ZIP 内容拒绝', async () => {
    await expect(readZip(Buffer.from('not a zip at all'))).rejects.toThrow(/ZIP/)
  })

  it('目录条目被忽略', async () => {
    const zip = buildRawZip([
      { name: 'src/', content: '' },
      { name: 'src/a.ts', content: 'x' },
    ])
    const result = await readZip(zip)
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts'])
  })
})

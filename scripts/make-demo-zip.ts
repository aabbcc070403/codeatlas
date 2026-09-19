/**
 * P4.2 演示数据固定:生成自有脱敏演示 ZIP(原始版 + 修复版)到 demo/。
 *
 * 语料复用 tests/e2e/helpers.ts 的 SAMPLE_FILES / FIXED_FILES(版本化,自有合成代码,
 * 不含他人源码与真实凭证);其稳定性由 tests/unit/demo-corpus.test.ts 契约测试锁定:
 * 4 个文件、覆盖 html-injection / jsx-key / dynamic-exec / postmessage 四类静态问题,
 * 修复版移除 dangerouslySetInnerHTML 并新增 new Function,支持第二快照对比。
 *
 * 用法:pnpm demo:zip(输出 demo/codeatlas-demo-origin.zip 与 codeatlas-demo-fixed.zip)
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildDeflateZip } from '../tests/helpers/zip'
import { FIXED_FILES, SAMPLE_FILES } from '../tests/e2e/helpers'

async function main(): Promise<void> {
  const outDir = path.resolve('demo')
  fs.mkdirSync(outDir, { recursive: true })
  const origin = path.join(outDir, 'codeatlas-demo-origin.zip')
  const fixed = path.join(outDir, 'codeatlas-demo-fixed.zip')
  fs.writeFileSync(origin, await buildDeflateZip(SAMPLE_FILES))
  fs.writeFileSync(fixed, await buildDeflateZip(FIXED_FILES))
  console.log('[demo-zip] 已生成:')
  console.log(`  ${origin}(${SAMPLE_FILES.length} 个文件)`)
  console.log(`  ${fixed}(${FIXED_FILES.length} 个文件,用于第二快照对比)`)
}

main().catch((err) => {
  console.error('[demo-zip] 失败:', err)
  process.exit(1)
})

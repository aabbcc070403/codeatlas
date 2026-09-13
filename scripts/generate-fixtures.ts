/**
 * 生成评测数据集 fixtures/（R08）：24 个样例项目（12 缺陷 + 12 对照）+
 * dataset.json（内容哈希版本化）+ 每项目 manifest.json。
 * 生成器幂等：内容不变时输出字节一致；内容变化时版本 revision 递增。
 * 生成时强校验标注与静态规则输出双向对应，保证 manifest 行段与文件真实对应。
 */
import path from 'node:path'
import { generateDataset, readPreviousDataset } from '../src/core/evaluation/fixtures'
import { FIXTURE_PROJECTS } from '../src/core/evaluation/fixtures-defs'

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), 'fixtures')
  const previous = readPreviousDataset(dir)
  const dataset = generateDataset(dir, FIXTURE_PROJECTS)
  console.log(`数据集已生成：${dir}`)
  console.log(`  版本：${dataset.version}（revision ${dataset.revision}）`)
  if (previous && previous.version !== dataset.version) {
    console.log(`  内容哈希变化：${previous.version} → ${dataset.version}（revision ${previous.revision} → ${dataset.revision}）`)
  }
  console.log(`  项目：${dataset.projectCount}（缺陷 ${dataset.defectCount} + 对照 ${dataset.controlCount}）`)
  console.log(`  划分：开发集 ${dataset.split.dev.length} / 保留集 ${dataset.split.holdout.length}`)
  for (const c of dataset.categories) {
    console.log(`  类别：${c.key}（${c.label}）`)
  }
}

main().catch((err) => {
  console.error('fixtures 生成失败:', err instanceof Error ? err.message : err)
  process.exit(1)
})

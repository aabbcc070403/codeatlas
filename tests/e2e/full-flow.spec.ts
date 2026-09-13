import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDeflateZip } from '../helpers/zip'
import {
  FIXED_FILES,
  assertNoHorizontalOverflow,
  createStaticScan,
} from './helpers'

/**
 * R09 完整用户闭环（单条用例串起 F01–F10 的核心路径）：
 * 登录 → 建项目 → 上传 ZIP → 静态扫描完成 → 打开 finding（证据/行号）→ 确认反馈
 * → 生成补丁提案（Mock）→ 导出报告（JSON）→ 第二个快照/扫描 → 对比页四类变化可见
 * → 1440×900 与 390×844 无横向溢出。
 * AI_PROVIDER=mock：补丁提案为确定性 Mock 输出（界面明确标注），静态路径全部真实。
 */
test('完整闭环：导入→扫描→证据→反馈→补丁→报告→第二快照→对比→移动端', async ({ page }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  // 1. 登录 → 建项目 → 上传 ZIP → 静态扫描 → 完成态
  const scanUrl = await createStaticScan(page, 'E2E 完整闭环')
  const scanId = new URL(scanUrl).pathname.split('/').pop()!
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('风险指数', { exact: true })).toBeVisible()

  // 2. 打开 finding：证据面板 + 行号定位（1 起始）+ evidence 状态
  await page.locator('a[href*="/findings/"]').first().click()
  await expect(page).toHaveURL(/\/scans\/[0-9a-f-]{36}\/findings\//)
  await expect(page.getByText('主引用')).toBeVisible()
  await expect(page.getByText('evidence=')).toBeVisible()
  await expect(page.locator('table td').first()).toHaveText('1')

  // 3. 人工反馈：确认问题（顶栏出现「已确认」徽标）
  await page.getByRole('button', { name: '确认问题' }).click()
  await expect(page.getByText('已确认', { exact: true })).toBeVisible({ timeout: 10_000 })

  // 4. 补丁提案（Mock）：diff + 三项验证分开 + 明确「非真实 AI 修复」标注
  await expect(page.getByTestId('patch-panel')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('patch-generate').click()
  await expect(page.getByTestId('patch-diff')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('patch-diff')).toContainText('--- a/')
  await expect(page.getByTestId('patch-status-applicable')).toContainText('可应用')
  await expect(page.getByTestId('patch-status-tests')).toContainText('not_run')
  await expect(page.getByText('Mock 示例提案，非真实 AI 修复').first()).toBeVisible()

  // 5. 回扫描工作台导出报告（JSON）：附件文件名与内容同源（scan.id、findings 数量一致）。
  //    导出链接在 /scans/:id 工作台页（finding 详情页没有），整页加载避免客户端路由陈旧预取。
  await page.goto(scanUrl)
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 60_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-json').click(),
  ])
  expect(download.suggestedFilename()).toBe(`codeatlas-report-${scanId.slice(0, 8)}.json`)
  const report = JSON.parse(fs.readFileSync(await download.path(), 'utf8')) as {
    scan: { id: string }
    findings: unknown[]
    findingCount: number
  }
  expect(report.scan.id).toBe(scanId)
  expect(report.findings.length).toBeGreaterThan(0)
  expect(report.findingCount).toBe(report.findings.length)

  // 6. 返回项目页（整页加载，避免复用过期 RSC 预取），上传修复版 ZIP → 第二次扫描
  const backHref = await page.getByRole('link', { name: /返回「E2E 完整闭环」/ }).getAttribute('href')
  await page.goto(backHref!)
  await expect(page.getByRole('heading', { name: 'E2E 完整闭环' })).toBeVisible()
  const fixedZipPath = path.join(os.tmpdir(), `ca-e2e-fixed-${Date.now()}.zip`)
  fs.writeFileSync(fixedZipPath, await buildDeflateZip(FIXED_FILES))
  await page.setInputFiles('input[type="file"]', fixedZipPath)
  await expect(page.getByText('导入完成：')).toBeVisible({ timeout: 60_000 })
  fs.rmSync(fixedZipPath, { force: true })
  await page.getByRole('button', { name: '开始审查' }).first().click()
  await expect(page).toHaveURL(/\/scans\/[0-9a-f-]{36}$/)
  expect(page.url()).not.toBe(scanUrl)
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })

  // 7. 对比页：四类变化摘要可见（新增/未再检出有内容，仍存在行号平移匹配，不可比较=0 也展示）
  const backHref2 = await page.getByRole('link', { name: /返回「E2E 完整闭环」/ }).getAttribute('href')
  await page.goto(backHref2!)
  await expect(page.getByRole('heading', { name: 'E2E 完整闭环' })).toBeVisible()
  await page.getByRole('link', { name: '快照对比' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/compare$/)
  await expect(page.getByTestId('base-select')).toBeVisible()
  await expect(page.getByTestId('target-select')).toBeVisible()
  await page.getByTestId('compare-run').click()
  await expect(page.getByTestId('count-added')).toContainText('新增 1')
  await expect(page.getByTestId('count-disappeared')).toContainText('未再检出 1')
  await expect(page.getByTestId('count-persisting')).toContainText('仍存在')
  await expect(page.getByTestId('count-incomparable')).toContainText('不可比较')
  await expect(page.getByTestId('section-added')).toContainText('new Function 动态构造函数')
  await expect(page.getByTestId('section-disappeared')).toContainText('候选 HTML 注入入口')
  await expect(page.getByTestId('section-persisting')).toContainText('列表渲染缺少稳定 key')
  await expect(page.getByTestId('compare-scope-note')).toContainText('不同快照')
  await expect(page.getByTestId('compare-disclaimer')).toContainText('不等于已验证修复')

  // 8. 桌面（1440×900）与手机（390×844）均无横向溢出
  await page.setViewportSize({ width: 1440, height: 900 })
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow(page)
})

import { test, expect } from '@playwright/test'
import { createStaticScan, assertNoHorizontalOverflow } from './helpers'

test('手机引用可见定位、问题往返与反馈失败提示', async ({ page }) => {
  await createStaticScan(page, 'UI 回归')
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  await page.locator('a[href*="/findings/"]').first().click()
  await expect(page.getByText('主引用', { exact: true })).toBeVisible()
  const firstUrl = page.url()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '解释', exact: true }).click()
  await page.getByRole('button', { name: /^src\/App.tsx:3-3/ }).click()
  await expect(page.locator('table')).toBeVisible({ timeout: 3000 })
  await expect(page.getByText('定位 3-3', { exact: true })).toBeVisible()
  await assertNoHorizontalOverflow(page)
  await page.getByRole('button', { name: '问题', exact: true }).click()
  await page.getByRole('button', { name: /列表渲染缺少稳定 key/ }).click()
  await expect(page).not.toHaveURL(firstUrl)
  await expect(page.getByText('定位 6-6', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '问题', exact: true }).click()
  await page.getByRole('button', { name: /dangerouslySetInnerHTML/ }).click()
  await expect(page).toHaveURL(firstUrl)
  await expect(page.getByText('定位 3-3', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '解释', exact: true }).click()
  await page.route('**/api/findings/*/feedback', route => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '反馈保存失败，请重试' } }),
  }))
  await page.getByRole('button', { name: '确认问题', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: '反馈保存失败' })).toBeVisible()
  await page.unroute('**/api/findings/*/feedback')
  await page.getByRole('button', { name: '确认问题', exact: true }).click()
  await expect(page.getByText('已确认', { exact: true })).toBeVisible()
})

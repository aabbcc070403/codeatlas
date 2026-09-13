import { test, expect } from '@playwright/test'
import { ADMIN_CODE, DEMO_CODE, assertNoHorizontalOverflow, login } from './helpers'

/**
 * R08 评测中心 E2E：管理员登录 → /evaluation 触发 static_only 评测 → 等待结果
 * → 指标表可见且数字真实（N/A 或数值，来自 evaluations.metrics_json）→
 * demo 会话触发显示 403/无权限 → 390×844 无横向溢出。
 * e2e-server 注入 EVAL_FIXTURES_DIR（临时数据集）与 EVAL_PROJECT_LIMIT=6（小子集口径）。
 * 共享帮助（登录/视口断言）在 tests/e2e/helpers.ts（R09 抽取）。
 */

test('评测中心：admin 触发 static_only → 真实指标展示 → demo 触发 403 → 移动端无溢出', async ({ page, browser }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  // 1. 管理员登录 → 评测中心：数据集概况、小样本口径、真实模型状态说明可见
  await login(page, ADMIN_CODE)
  await page.goto('/evaluation')
  await expect(page.getByTestId('dataset-info')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dataset-info')).toContainText('24 项目')
  await expect(page.getByTestId('eval-disclaimer')).toContainText('小样本')
  await expect(page.getByTestId('real-model-note')).toContainText('真实模型评测未执行')

  // 2. 触发 static_only 评测（开发集；worker 以 EVAL_PROJECT_LIMIT=6 小子集执行）
  await page.getByTestId('eval-mode').selectOption('static_only')
  await page.getByTestId('eval-split').selectOption('dev')
  await page.getByTestId('eval-run').click()

  // 3. 等待运行完成（进行中 → 已完成；结果来自真实扫描管线）
  await expect(page.getByTestId('eval-detail')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('eval-run-row').first()).toContainText('已完成', { timeout: 120_000 })
  await expect(page.getByTestId('eval-detail')).toContainText('已完成', { timeout: 30_000 })

  // 4. 指标表可见且数字非伪造：P/R/F1 显示 N/A 或 0..1 数值；逐项目结果与扫描可回溯
  await expect(page.getByTestId('metric-precision')).toBeVisible()
  await expect(page.getByTestId('metric-precision')).toContainText(/N\/A|[01]\.\d{3}/)
  await expect(page.getByTestId('metric-recall')).toContainText(/N\/A|[01]\.\d{3}/)
  await expect(page.getByTestId('metric-f1')).toContainText(/N\/A|[01]\.\d{3}/)
  await expect(page.getByTestId('metric-evidence-valid')).toContainText(/%|—/)
  await expect(page.getByTestId('metric-p50')).toContainText(/ms|—/)
  await expect(page.getByTestId('project-table')).toBeVisible()
  const projectRows = page.getByTestId('project-table').locator('tbody tr')
  await expect(projectRows.first()).toBeVisible()
  const rowCount = await projectRows.count()
  expect(rowCount).toBeGreaterThan(0)
  expect(rowCount).toBeLessThanOrEqual(6) // 小子集口径：EVAL_PROJECT_LIMIT=6
  await expect(page.getByTestId('ablation-table')).toBeVisible()
  // 配置溯源：数据集版本 / 模式 / 规则版本 / 执行方
  await expect(page.getByTestId('eval-config')).toContainText('static-rules-v1')
  await expect(page.getByTestId('eval-config')).toContainText('划分 dev')

  // 5. 1440×900 无横向溢出
  await page.setViewportSize({ width: 1440, height: 900 })
  await assertNoHorizontalOverflow(page)

  // 6. demo 会话触发评测 → 服务端 403，页面如实显示无权限
  const demoCtx = await browser.newContext()
  const demoPage = await demoCtx.newPage()
  await login(demoPage, DEMO_CODE)
  await demoPage.goto('/evaluation')
  await expect(demoPage.getByTestId('dataset-info')).toBeVisible({ timeout: 30_000 })
  await demoPage.getByTestId('eval-mode').selectOption('static_only')
  await demoPage.getByTestId('eval-run').click()
  await expect(demoPage.getByTestId('eval-error')).toBeVisible({ timeout: 15_000 })
  await expect(demoPage.getByTestId('eval-error')).toContainText('管理员访问码会话')
  await expect(demoPage.getByTestId('eval-error')).toContainText('403')
  await demoCtx.close()

  // 7. 390×844 无横向溢出（表格在容器内横向滚动，不撑破页面）
  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow(page)
})

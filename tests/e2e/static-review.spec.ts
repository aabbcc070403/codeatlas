import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDeflateZip } from '../helpers/zip'
import {
  FIXED_FILES,
  assertNoHorizontalOverflow,
  createStaticScan,
  newSessionContext,
} from './helpers'

/**
 * R02 静态闭环：登录 → 创建项目 → ZIP 上传 → 静态扫描（不启用云端 AI）
 * → 查看问题 → 证据定位 → 人工反馈（风险摘要联动）；
 * 刷新后终态可恢复、SSE 断开轮询降级、跨会话 404；
 * 1440×900 与 390×844 工作台不横向撑破。
 * 共享帮助（登录/建项目/上传/视口断言/独立会话）在 tests/e2e/helpers.ts（R09 抽取）。
 */

test('静态体检闭环：上传→扫描→问题→证据→反馈→风险联动', async ({ page }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('requestfailed', (r) => console.error('[reqfail]', r.url(), r.failure()?.errorText))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  await createStaticScan(page, 'E2E 静态闭环')

  // 1. 等待扫描完成（SSE/轮询驱动状态更新）
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('风险指数', { exact: true })).toBeVisible()

  // 2. 问题列表出现静态发现（eval / dangerouslySetInnerHTML / jsx key / message origin）
  await expect(page.getByText('问题列表')).toBeVisible()
  const firstFinding = page.locator('a[href*="/findings/"]').first()
  await expect(firstFinding).toBeVisible({ timeout: 30_000 })
  await expect(firstFinding.getByText('静态规则')).toBeVisible()
  // 工具轨迹（纯静态扫描无工具调用，如实展示）
  await expect(page.getByText('工具轨迹')).toBeVisible()

  // 3. 工作台布局：1440×900 与 390×844 均不横向撑破
  await page.setViewportSize({ width: 1440, height: 900 })
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 1440, height: 900 })

  // 4. 刷新扫描页后仍可读终态（从持久化结果恢复，不依赖内存事件）
  await page.reload()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('风险指数', { exact: true })).toBeVisible()
  await expect(page.locator('a[href*="/findings/"]').first()).toBeVisible()

  // 5. 打开问题详情：代码定位 + 证据面板 + 行号（服务端预取首屏）
  await page.locator('a[href*="/findings/"]').first().click()
  await expect(page).toHaveURL(/\/scans\/[0-9a-f-]{36}\/findings\//)
  await expect(page.getByText('主引用')).toBeVisible()
  await expect(page.getByText('人工反馈')).toBeVisible()
  await expect(page.getByText('evidence=')).toBeVisible()
  // 代码区渲染真实文件内容（行号从 1 起始）
  await expect(page.locator('table td').first()).toHaveText('1')
  // 390×844 详情页不横向撑破
  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 1440, height: 900 })

  // 6. 人工反馈：确认问题 → 顶栏出现「已确认」徽标
  await page.getByRole('button', { name: '确认问题' }).click()
  await expect(page.getByText('已确认', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: '重置' })).toBeEnabled()

  // 7. 标记误报 → 风险摘要联动更新。
  //    首条 high 为 needs_review（本就不计入指数），须选一条计入指数的问题（medium）验证联动。
  await page.getByRole('button', { name: /列表渲染缺少稳定 key/ }).click()
  await expect(page.getByRole('heading', { name: /列表渲染缺少稳定 key/ })).toBeVisible({ timeout: 10_000 })
  const riskBefore = await page.getByTestId('risk-index').textContent()
  expect(riskBefore).not.toBeNull()
  await page.getByRole('button', { name: '标记误报' }).click()
  await expect(page.getByText('误报', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(async () => page.getByTestId('risk-index').textContent(), { timeout: 10_000 })
    .not.toBe(riskBefore)
})

test('SSE 断开后轮询降级，仍能到达终态', async ({ page }) => {
  test.slow()
  const scanUrl = await createStaticScan(page, 'E2E 轮询降级')

  // 拦截 SSE 请求（连接即失败）→ EventSource 连续 onerror → 降级轮询
  await page.route(`**/api/scans/*/events`, (route) => route.abort())

  // 降级徽章出现（真实连接模式，不伪造实时性）
  await expect(page.getByText('轮询降级')).toBeVisible({ timeout: 30_000 })

  // 轮询驱动下扫描仍能到达终态
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('风险指数', { exact: true })).toBeVisible()
  expect(page.url()).toBe(scanUrl)
})

test('跨会话访问 scan/finding 一律 404', async ({ page, browser }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  await createStaticScan(page, 'E2E 跨会话')
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  const firstFinding = page.locator('a[href*="/findings/"]').first()
  await expect(firstFinding).toBeVisible({ timeout: 30_000 })
  const scanUrl = page.url()
  const findingUrl = await firstFinding.getAttribute('href')

  // 第二个会话：同一访问码重新登录（新 session），访问他人项目的扫描
  const ctx2 = await newSessionContext(browser, new URL(scanUrl).origin)
  const page2 = await ctx2.newPage()
  const scanResp = await page2.goto(scanUrl)
  expect(scanResp?.status()).toBe(404)
  if (findingUrl) {
    const findingResp = await page2.goto(new URL(findingUrl, scanUrl).toString())
    expect(findingResp?.status()).toBe(404)
  }
  // API 层同样不泄露存在性（页面内 same-origin fetch，携带会话 cookie）
  const apiUrl = `${new URL(scanUrl).origin}/api${new URL(scanUrl).pathname}`
  const apiStatus = await page2.evaluate(async (url: string) => (await fetch(url)).status, apiUrl)
  expect(apiStatus).toBe(404)
  await ctx2.close()
})

test('追问闭环：Mock 回答 + 引用定位 + 刷新恢复 + 恶意文本不执行 + 移动端无溢出', async ({ page }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  await createStaticScan(page, 'E2E 追问闭环')
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  await page.locator('a[href*="/findings/"]').first().click()
  await expect(page.getByTestId('conversation-panel')).toBeVisible({ timeout: 30_000 })

  // 键盘提交（Enter）：问题含恶意 Markdown/HTML
  const question = '这段输入经过净化了吗？**b** <img src=x onerror=window.__xss=1>'
  await page.getByTestId('conv-input').fill(question)
  await page.getByTestId('conv-input').press('Enter')

  // Mock 回答出现：明确 Mock 标签 + 代码引用 + 调用计数（AI_PROVIDER=mock，界面如实标注）
  await expect(page.getByTestId('conv-answer').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Mock（非真实模型）').first()).toBeVisible()
  await expect(page.getByText(/模型请求 \d+ 次 · 工具调用 \d+ 次/).first()).toBeVisible()
  const citation = page.getByTestId('conv-citation').first()
  await expect(citation).toBeVisible()

  // 恶意 HTML 不执行：payload 以纯文本渲染，window.__xss 未被设置
  expect(await page.evaluate(() => (window as unknown as { __xss?: string }).__xss)).toBeUndefined()
  await expect(page.getByText('<img src=x onerror=window.__xss=1>')).toBeVisible()

  // 引用点击定位代码区（行号渲染正常）
  await citation.click()
  await expect(page.locator('table td').first()).toHaveText('1')

  // 刷新后从 GET messages 恢复（问题与回答均持久化）
  await page.reload()
  await expect(page.getByTestId('conv-answer').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(question)).toBeVisible()

  // 移动端（390×844）：切到「解释」标签显示追问面板，无横向溢出
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '解释' }).click()
  await expect(page.getByTestId('conversation-panel')).toBeVisible()
  await assertNoHorizontalOverflow(page)
})

test('补丁提案闭环：Mock 提案 → diff 与三项验证 → 下载可用 → 刷新恢复 → 移动端无溢出', async ({ page }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  await createStaticScan(page, 'E2E 补丁提案')
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  await page.locator('a[href*="/findings/"]').first().click()
  await expect(page.getByTestId('patch-panel')).toBeVisible({ timeout: 30_000 })

  // 生成补丁（AI_PROVIDER=mock → 确定性 MockPatchProvider，明确标注非真实 AI 修复）
  await page.getByTestId('patch-generate').click()
  await expect(page.getByTestId('patch-diff')).toBeVisible({ timeout: 60_000 })
  const diffBox = page.getByTestId('patch-diff')

  // diff 逐行着色：+ 行与上下文行出现（Mock 为纯插入式注释提案，最小 diff 无删除行）
  await expect(diffBox).toContainText('+')
  await expect(diffBox).toContainText('--- a/')
  await expect(diffBox).toContainText('+++ b/')
  await expect(diffBox).toContainText('@@')
  await expect(diffBox).toContainText('Mock 示例提案，非真实 AI 修复')
  // 上下文行（未改动内容）与添加行并存
  await expect(diffBox).toContainText('import { format }')

  // 三项验证状态分开显示：applicable / syntax / tests=not_run（不冒充测试通过）
  await expect(page.getByTestId('patch-status-applicable')).toContainText('可应用')
  await expect(page.getByTestId('patch-status-syntax')).toContainText('语法')
  await expect(page.getByTestId('patch-status-tests')).toContainText('not_run')
  await expect(page.getByTestId('patch-status-tests')).toContainText('请在你的环境中自行测试')
  // Mock 徽章 + 不给「已修复」类表述
  await expect(page.getByText('Mock 示例提案，非真实 AI 修复').first()).toBeVisible()

  // 下载 .patch 附件：内容为 unified diff（与界面展示一致）
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('patch-download').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.patch$/)
  const downloaded = fs.readFileSync(await download.path(), 'utf8')
  expect(downloaded).toContain('--- a/')
  expect(downloaded).toContain('+++ b/')
  expect(downloaded).toContain('+')

  // 刷新后提案仍在（GET /api/findings/:id/patch 恢复）
  await page.reload()
  await expect(page.getByTestId('patch-diff')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Mock 示例提案，非真实 AI 修复').first()).toBeVisible()
  await expect(page.getByTestId('patch-download')).toBeVisible()

  // 移动端（390×844）：「解释」标签内补丁面板可见，无横向溢出
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '解释' }).click()
  await expect(page.getByTestId('patch-panel')).toBeVisible()
  await assertNoHorizontalOverflow(page)
})

test('报告导出与快照对比：导出下载 → 第二次扫描 → 四类变化与「未再检出≠已验证修复」说明 → 无横向溢出', async ({ page }) => {
  test.slow()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      console.error('[api-err]', r.status(), r.url().slice(0, 110), (await r.text().catch(() => '')).slice(0, 150))
    }
  })

  const scanUrl = await createStaticScan(page, 'E2E 报告对比')
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })
  const scanId = new URL(scanUrl).pathname.split('/').pop()!

  // 1. 扫描页导出报告：JSON 附件下载成功，内容为结构化报告模型（与 UI 同源）
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

  // 2. 同一会话返回项目页，上传修复版 ZIP 并发起第二次扫描（同一项目下得第二个 scan）。
  //    注意：用 page.goto 整页加载返回，避免 Next 客户端路由复用预取的过期 RSC（扫描记录区滞后）。
  const backHref = await page.getByRole('link', { name: /返回「E2E 报告对比」/ }).getAttribute('href')
  await page.goto(backHref!)
  await expect(page.getByRole('heading', { name: 'E2E 报告对比' })).toBeVisible()
  const fixedZipPath = path.join(os.tmpdir(), `ca-e2e-fixed-${Date.now()}.zip`)
  fs.writeFileSync(fixedZipPath, await buildDeflateZip(FIXED_FILES))
  await page.setInputFiles('input[type="file"]', fixedZipPath)
  await expect(page.getByText('导入完成：')).toBeVisible({ timeout: 60_000 })
  fs.rmSync(fixedZipPath, { force: true })
  // 新快照卡片在列表最上方：其按钮为「开始审查」；旧快照显示「再次扫描」
  await page.getByRole('button', { name: '开始审查' }).first().click()
  await expect(page).toHaveURL(/\/scans\/[0-9a-f-]{36}$/)
  expect(page.url()).not.toBe(scanUrl)
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120_000 })

  // 3. 项目页扫描记录区出现「快照对比」入口 → 对比页（整页加载，取最新扫描记录）
  const backHref2 = await page.getByRole('link', { name: /返回「E2E 报告对比」/ }).getAttribute('href')
  await page.goto(backHref2!)
  await expect(page.getByRole('heading', { name: 'E2E 报告对比' })).toBeVisible()
  await page.getByRole('link', { name: '快照对比' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/compare$/)

  // 4. 默认基准=最早扫描、目标=最新扫描；执行对比
  await expect(page.getByTestId('base-select')).toBeVisible()
  await expect(page.getByTestId('target-select')).toBeVisible()
  await page.getByTestId('compare-run').click()

  // 四类变化：新增（new Function）、仍存在（List 缺 key，行号平移）、未再检出（dangerouslySetInnerHTML）
  await expect(page.getByTestId('count-added')).toContainText('新增 1')
  await expect(page.getByTestId('count-disappeared')).toContainText('未再检出 1')
  await expect(page.getByTestId('count-persisting')).toContainText('仍存在')
  await expect(page.getByTestId('section-added')).toContainText('new Function 动态构造函数')
  await expect(page.getByTestId('section-disappeared')).toContainText('候选 HTML 注入入口')
  await expect(page.getByTestId('section-persisting')).toContainText('列表渲染缺少稳定 key')
  // 不同快照 → 范围提示；固定说明「未再检出 ≠ 已验证修复」始终展示
  await expect(page.getByTestId('compare-scope-note')).toContainText('不同快照')
  await expect(page.getByTestId('compare-disclaimer')).toContainText('不等于已验证修复')

  // 5. 1440×900 与 390×844 均无横向溢出
  await page.setViewportSize({ width: 1440, height: 900 })
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow(page)
})

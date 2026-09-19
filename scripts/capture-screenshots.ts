/**
 * R09 三视口截图（1440×900 / 1024×768 / 390×844）。
 *
 * 自建隔离环境（与 scripts/e2e-server.ts 同模式）：临时 PGlite 数据库 + 存储 + fixtures，
 * next build（独立 distDir=.next-shots）+ next start + worker，AI_PROVIDER=mock；
 * 走完整用户流程（登录 → 建项目 → 上传 → 静态扫描 → finding 证据 + 追问 + 补丁
 * → 修复版第二扫描 → 对比 → admin 触发评测），在 7 个页面 × 3 视口截图到
 * artifacts/screenshots/<页面>-<宽>x<高>.png（artifacts/ 已被 .gitignore 忽略）。
 *
 * 用法：pnpm tsx scripts/capture-screenshots.ts   （可重复运行；结束清理临时资源）
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
import postgres from 'postgres'
import { startDbServer } from './db-server'
import { applyMigrations } from '../src/server/db/migrate'
import { seedAll } from '../src/server/db/seed'
import { generateDataset } from '../src/core/evaluation/fixtures'
import { buildDeflateZip } from '../tests/helpers/zip'
import { DEMO_CODE, ADMIN_CODE, SAMPLE_FILES, FIXED_FILES } from '../tests/e2e/helpers'

const APP_PORT = 3220
const BASE = `http://127.0.0.1:${APP_PORT}`
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
] as const
const OUT_DIR = path.resolve('artifacts/screenshots')
const SHOTS_DIST_DIR = '.next-shots'

/** 依次在三个视口截图；mobileTab 在 390 视口点击的标签按钮（如 finding 页的「解释」） */
async function shot(page: Page, name: string, mobileTab?: string): Promise<void> {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.waitForTimeout(500) // 等待响应式布局稳定
    if (mobileTab && vp.width < 1280) {
      const tab = page.getByRole('button', { name: mobileTab })
      if (await tab.isVisible()) {
        await tab.click()
        await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent === '解释')
      }
    }
    await page.screenshot({ path: path.join(OUT_DIR, `${name}-${vp.width}x${vp.height}.png`) })
    console.log(`[shots] ${name}-${vp.width}x${vp.height}.png`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-shots-db-'))
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-shots-storage-'))
  const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-shots-fixtures-'))
  generateDataset(fixturesDir)

  let handle: Awaited<ReturnType<typeof startDbServer>> | null = null
  for (let i = 0; i < 20 && !handle; i++) {
    const port = 25400 + Math.floor(Math.random() * 800)
    try {
      handle = await startDbServer({ dataDir, port, maxConnections: 8 })
    } catch {
      // 端口被占用：换下一个
    }
  }
  if (!handle) throw new Error('无法为截图环境分配数据库端口')

  const sql = postgres(handle.url, { max: 2, prepare: false })
  await applyMigrations(sql)
  await seedAll(sql)
  await sql.end()

  const children: ChildProcess[] = []
  let exiting = false
  const cleanup = (code: number): void => {
    if (exiting) return
    exiting = true
    for (const c of children) {
      if (c.pid == null) continue
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'])
      } else {
        c.kill('SIGTERM')
      }
    }
    void handle
      .stop()
      .catch(() => undefined)
      .finally(() => {
        fs.rmSync(dataDir, { recursive: true, force: true })
        fs.rmSync(storageRoot, { recursive: true, force: true })
        fs.rmSync(fixturesDir, { recursive: true, force: true })
        fs.rmSync(SHOTS_DIST_DIR, { recursive: true, force: true })
        process.exit(code)
      })
  }
  process.on('SIGINT', () => cleanup(0))
  process.on('SIGTERM', () => cleanup(0))

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: handle.url,
      STORAGE_ROOT: storageRoot,
      AI_PROVIDER: 'mock',
      DEMO_ACCESS_CODE: DEMO_CODE,
      ADMIN_ACCESS_CODE: ADMIN_CODE,
      SESSION_SECRET: 'shots-session-secret',
      APP_ORIGIN: BASE,
      NEXT_DIST_DIR: SHOTS_DIST_DIR,
      EVAL_FIXTURES_DIR: fixturesDir,
      EVAL_PROJECT_LIMIT: '6',
    }
    const nextBin = path.resolve('node_modules/next/dist/bin/next')
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs')

    console.log('[shots] next build ...')
    const build = spawnSync(process.execPath, [nextBin, 'build'], { env, stdio: 'inherit' })
    if (build.status !== 0) throw new Error(`截图环境构建失败（exit ${build.status}）`)

    children.push(
      spawn(process.execPath, [nextBin, 'start', '-p', String(APP_PORT)], { env, stdio: 'inherit' }),
      spawn(process.execPath, [tsxCli, 'scripts/worker.ts'], { env, stdio: 'inherit' }),
    )

    // 等待应用就绪
    let ready = false
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        ready = (await fetch(`${BASE}/login`)).ok
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    if (!ready) throw new Error('应用未在超时内就绪')

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

      // 1. 登录页（未登录状态）
      await page.goto(`${BASE}/login`)
      await page.getByLabel('访问码').waitFor({ timeout: 30_000 })
      await shot(page, 'login')

      // 2. 登录（demo）→ 新建项目 → 项目列表
      await page.getByLabel('访问码').fill(DEMO_CODE)
      await page.getByRole('button', { name: '进入工作台' }).click()
      await page.getByRole('heading', { name: '项目', exact: true }).waitFor({ timeout: 60_000 })
      await page.getByLabel('项目名称').fill('校园活动平台')
      await page.getByRole('button', { name: '新建项目' }).click()
      await page.getByRole('link', { name: /校园活动平台/ }).first().waitFor({ timeout: 30_000 })
      await shot(page, 'projects')

      // 3. 进入项目 → 上传 ZIP → 项目页（导入摘要）
      await page.getByRole('link', { name: /校园活动平台/ }).first().click()
      await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 30_000 })
      const projectUrl = page.url()
      const zipPath = path.join(os.tmpdir(), `ca-shots-${Date.now()}.zip`)
      fs.writeFileSync(zipPath, await buildDeflateZip(SAMPLE_FILES))
      await page.setInputFiles('input[type="file"]', zipPath)
      await page.getByText('导入完成：').waitFor({ timeout: 60_000 })
      fs.rmSync(zipPath, { force: true })
      await shot(page, 'project')

      // 4. 开始审查 → 等待完成 → 扫描工作台
      await page.getByRole('button', { name: '开始审查' }).click()
      await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/, { timeout: 60_000 })
      await page.getByText('已完成', { exact: true }).waitFor({ timeout: 120_000 })
      await page.getByText('风险指数', { exact: true }).waitFor({ timeout: 30_000 })
      await shot(page, 'scan')

      // 5. 打开 finding → 追问（Mock 回答）→ 补丁（Mock 提案）→ 详情页
      await page.locator('a[href*="/findings/"]').first().click()
      await page.getByText('主引用').waitFor({ timeout: 30_000 })
      await page.getByTestId('conversation-panel').waitFor({ timeout: 30_000 })
      await page.getByTestId('conv-input').fill('这段输入经过净化了吗？')
      await page.getByTestId('conv-input').press('Enter')
      await page.getByTestId('conv-answer').first().waitFor({ timeout: 60_000 })
      await page.getByTestId('patch-generate').click()
      await page.getByTestId('patch-diff').waitFor({ timeout: 60_000 })
      await shot(page, 'finding', '解释')

      // 6. 返回项目页上传修复版 ZIP → 第二次扫描 → 对比页
      //    （finding 页的返回链接指向 /scans/:id，直接用记录的 projectUrl 整页加载）
      await page.goto(projectUrl)
      const fixedZipPath = path.join(os.tmpdir(), `ca-shots-fixed-${Date.now()}.zip`)
      fs.writeFileSync(fixedZipPath, await buildDeflateZip(FIXED_FILES))
      await page.setInputFiles('input[type="file"]', fixedZipPath)
      await page.getByText('导入完成：').waitFor({ timeout: 60_000 })
      fs.rmSync(fixedZipPath, { force: true })
      await page.getByRole('button', { name: '开始审查' }).first().click()
      await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/, { timeout: 60_000 })
      await page.getByText('已完成', { exact: true }).waitFor({ timeout: 120_000 })
      const backHref2 = await page.getByRole('link', { name: /返回「校园活动平台」/ }).getAttribute('href')
      await page.goto(new URL(backHref2 ?? projectUrl, BASE).toString())
      await page.getByRole('link', { name: '快照对比' }).click()
      await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/compare$/, { timeout: 30_000 })
      await page.getByTestId('compare-run').click()
      await page.getByTestId('count-added').waitFor({ timeout: 30_000 })
      await shot(page, 'compare')

      // 7. admin 会话触发评测 → 等待完成 → 评测中心
      const adminPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await adminPage.goto(`${BASE}/login`)
      await adminPage.getByLabel('访问码').fill(ADMIN_CODE)
      await adminPage.getByRole('button', { name: '进入工作台' }).click()
      await adminPage.goto(`${BASE}/evaluation`)
      await adminPage.getByTestId('dataset-info').waitFor({ timeout: 30_000 })
      await adminPage.getByTestId('eval-mode').selectOption('static_only')
      await adminPage.getByTestId('eval-split').selectOption('dev')
      await adminPage.getByTestId('eval-run').click()
      await adminPage.getByTestId('eval-detail').waitFor({ timeout: 30_000 })
      try {
        await adminPage.getByTestId('eval-detail').getByText('已完成').waitFor({ timeout: 180_000 })
      } catch {
        // 兜底：评测未达「已完成」也保留当前真实状态截图
        console.warn('[shots] 评测未达「已完成」，按当前真实状态截图')
      }
      await shot(adminPage, 'evaluation')

      console.log(`[shots] 完成：${OUT_DIR}`)
      cleanup(0)
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err) {
    console.error('[shots] 失败:', err)
    cleanup(1)
  }
}

main().catch((err) => {
  console.error('[shots] 失败:', err)
  process.exit(1)
})

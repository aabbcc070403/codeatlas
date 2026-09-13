import { expect, type Page, type Browser } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDeflateZip } from '../helpers/zip'

/**
 * E2E 共享帮助（R09 抽取自 static-review.spec.ts / evaluation.spec.ts，行为不变）：
 * 登录、建项目、上传 ZIP、启动静态扫描、无横向溢出断言、独立会话上下文。
 * 环境变量由 scripts/e2e-server.ts 注入（AI_PROVIDER=mock、隔离数据库/存储/fixtures）。
 */

export const DEMO_CODE = 'e2e-demo-2026'
export const ADMIN_CODE = 'e2e-admin-2026'

export const SAMPLE_FILES: Array<{ name: string; content: string }> = [
  {
    name: 'src/App.tsx',
    content: [
      'import { format } from "./utils/format"',
      'export function App({ bio }: { bio: string }) {',
      '  return <div dangerouslySetInnerHTML={{ __html: bio }} />',
      '}',
      'export function List({ items }: { items: string[] }) {',
      '  return <ul>{items.map((it) => <li>{it}</li>)}</ul>',
      '}',
    ].join('\n'),
  },
  {
    name: 'src/danger.js',
    content:
      'function run(code) {\n  return eval(code)\n}\nwindow.addEventListener("message", (e) => {\n  doThing(e.data)\n})\n',
  },
  { name: 'src/utils/format.ts', content: 'export function format(s: string) {\n  return s.trim()\n}\n' },
  { name: 'package.json', content: '{"name":"e2e-sample","dependencies":{"react":"^19.0.0"}}' },
]

/** 修复版样例（对比用）：移除 dangerouslySetInnerHTML（未再检出）、danger.js 增加 new Function（新增）；
 *  List 缺 key 与 eval 保持原内容（行号可能平移 → 仍存在），message 监听不变 */
export const FIXED_FILES: Array<{ name: string; content: string }> = [
  {
    name: 'src/App.tsx',
    content: [
      'import { format } from "./utils/format"',
      'export function List({ items }: { items: string[] }) {',
      '  return <ul>{items.map((it) => <li>{it}</li>)}</ul>',
      '}',
    ].join('\n'),
  },
  {
    name: 'src/danger.js',
    content:
      'function run(code) {\n  return eval(code)\n}\nfunction compile(expr) {\n  return new Function(expr)\n}\nwindow.addEventListener("message", (e) => {\n  doThing(e.data)\n})\n',
  },
  { name: 'src/utils/format.ts', content: 'export function format(s: string) {\n  return s.trim()\n}\n' },
  { name: 'package.json', content: '{"name":"e2e-sample","dependencies":{"react":"^19.0.0"}}' },
]

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

/** 登录到项目列表页（/projects） */
export async function login(page: Page, code: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('访问码').fill(code)
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible({ timeout: 60_000 })
}

/** 登录 → 建项目 → 上传 ZIP → 启动静态扫描；返回 /scans/:id 的 URL */
export async function createStaticScan(page: Page, label: string): Promise<string> {
  await login(page, DEMO_CODE)

  await page.getByLabel('项目名称').fill(label)
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.getByRole('link', { name: new RegExp(label) })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(label) }).click()
  await expect(page.getByRole('heading', { name: label })).toBeVisible()

  const zipPath = path.join(os.tmpdir(), `ca-e2e-${Date.now()}.zip`)
  fs.writeFileSync(zipPath, await buildDeflateZip(SAMPLE_FILES))
  await page.setInputFiles('input[type="file"]', zipPath)
  await expect(page.getByText('导入完成：')).toBeVisible({ timeout: 60_000 })
  fs.rmSync(zipPath, { force: true })

  await page.getByRole('button', { name: '开始审查' }).click()
  await expect(page).toHaveURL(/\/scans\/[0-9a-f-]{36}$/)
  return page.url()
}

/** 新建已登录（demo code）的独立浏览器上下文：与 page 的 session 不同 */
export async function newSessionContext(browser: Browser, origin: string) {
  const ctx = await browser.newContext()
  const loginPage = await ctx.newPage()
  await loginPage.goto(`${origin}/login`)
  await loginPage.getByLabel('访问码').fill(DEMO_CODE)
  await loginPage.getByRole('button', { name: '进入工作台' }).click()
  await expect(loginPage.getByRole('heading', { name: '项目', exact: true })).toBeVisible({ timeout: 60_000 })
  await loginPage.close()
  return ctx
}

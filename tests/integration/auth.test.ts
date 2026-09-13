import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createTestDb, type TestDb } from '../helpers/db'
import { resetRateLimiter } from '../../src/server/auth/rate-limit'
import * as sessionRoute from '../../src/app/api/session/route'
import * as projectsRoute from '../../src/app/api/projects/route'
import * as projectDetailRoute from '../../src/app/api/projects/[id]/route'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
})

afterAll(async () => {
  const { resetDb } = await import('../../src/server/db/client')
  await resetDb()
  await db.dispose()
})

beforeEach(() => {
  resetRateLimiter()
})

function makeJsonReq(
  path: string,
  opts: {
    method?: string
    body?: unknown
    cookie?: string
    origin?: string
    ip?: string
  } = {},
): NextRequest {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers['cookie'] = opts.cookie
  if (opts.origin) headers['origin'] = opts.origin
  if (opts.ip) headers['x-forwarded-for'] = opts.ip
  return new NextRequest(`http://localhost:3100${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

function extractCookie(res: Response): string {
  const setCookies = res.headers.getSetCookie()
  const target = setCookies.find((c) => c.startsWith('ca_session='))
  if (!target) throw new Error('未发现会话 cookie: ' + JSON.stringify(setCookies))
  const token = target.split(';')[0]!.split('=').slice(1).join('=')
  return `ca_session=${token}`
}

async function loginAs(code: string, ip = '10.0.0.1'): Promise<string> {
  const res = await sessionRoute.POST(
    makeJsonReq('/api/session', { method: 'POST', body: { accessCode: code }, ip }),
  )
  expect(res.status).toBe(200)
  return extractCookie(res)
}

describe('T02 会话与权限', () => {
  it('正确演示访问码 → 200 + HttpOnly cookie', async () => {
    const res = await sessionRoute.POST(
      makeJsonReq('/api/session', {
        method: 'POST',
        body: { accessCode: 'codeatlas-demo' },
        ip: '10.1.0.1',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: string }
    expect(body.role).toBe('demo')
    const setCookie = res.headers.getSetCookie()[0]!
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('管理访问码 → admin 角色', async () => {
    const res = await sessionRoute.POST(
      makeJsonReq('/api/session', {
        method: 'POST',
        body: { accessCode: 'codeatlas-admin' },
        ip: '10.1.0.2',
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { role: string }).role).toBe('admin')
  })

  it('错误访问码 → 401 结构化错误', async () => {
    const res = await sessionRoute.POST(
      makeJsonReq('/api/session', {
        method: 'POST',
        body: { accessCode: 'wrong-code' },
        ip: '10.2.0.1',
      }),
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } }
    expect(body.error.code).toBe('unauthorized')
    expect(typeof body.error.requestId).toBe('string')
  })

  it('同一 IP 失败超过 10 次/10 分钟 → 429', async () => {
    const ip = '10.3.0.1'
    for (let i = 0; i < 10; i++) {
      const res = await sessionRoute.POST(
        makeJsonReq('/api/session', { method: 'POST', body: { accessCode: 'bad' }, ip }),
      )
      expect(res.status).toBe(401)
    }
    const limited = await sessionRoute.POST(
      makeJsonReq('/api/session', { method: 'POST', body: { accessCode: 'bad' }, ip }),
    )
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('非法 Origin 写请求 → 403', async () => {
    const res = await sessionRoute.POST(
      makeJsonReq('/api/session', {
        method: 'POST',
        body: { accessCode: 'codeatlas-demo' },
        origin: 'https://evil.example.com',
        ip: '10.4.0.1',
      }),
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden')
  })

  it('无 cookie 访问项目列表 → 401', async () => {
    const res = await projectsRoute.GET(makeJsonReq('/api/projects'))
    expect(res.status).toBe(401)
  })

  it('伪造 cookie → 401', async () => {
    const res = await projectsRoute.GET(
      makeJsonReq('/api/projects', { cookie: 'ca_session=forged-token' }),
    )
    expect(res.status).toBe(401)
  })

  it('跨会话项目读取 → 404（不泄露存在性）', async () => {
    const cookieA = await loginAs('codeatlas-demo', '10.5.0.1')
    const cookieB = await loginAs('codeatlas-demo', '10.5.0.2')
    const createRes = await projectsRoute.POST(
      makeJsonReq('/api/projects', {
        method: 'POST',
        body: { name: '会话A的项目' },
        cookie: cookieA,
        origin: 'http://localhost:3100',
      }),
    )
    expect(createRes.status).toBe(201)
    const project = (await createRes.json()) as { id: string }

    const readRes = await projectDetailRoute.GET(
      makeJsonReq(`/api/projects/${project.id}`, { cookie: cookieB }),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(readRes.status).toBe(404)

    const deleteRes = await projectDetailRoute.DELETE(
      makeJsonReq(`/api/projects/${project.id}`, {
        method: 'DELETE',
        cookie: cookieB,
        origin: 'http://localhost:3100',
      }),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(deleteRes.status).toBe(404)

    // 本人可读可删
    const ownRead = await projectDetailRoute.GET(
      makeJsonReq(`/api/projects/${project.id}`, { cookie: cookieA }),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(ownRead.status).toBe(200)
    const ownDelete = await projectDetailRoute.DELETE(
      makeJsonReq(`/api/projects/${project.id}`, {
        method: 'DELETE',
        cookie: cookieA,
        origin: 'http://localhost:3100',
      }),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(ownDelete.status).toBe(204)
  })
})

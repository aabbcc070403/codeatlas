import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/server/db/client'
import { env } from '@/server/env'
import { assertSameOrigin, jsonError, toErrorResponse } from '@/server/api/http'
import {
  buildSessionCookie,
  createSession,
  verifyAccessCode,
} from '@/server/auth/session'
import {
  clientIpFromRequest,
  clearFailures,
  registerFailure,
} from '@/server/auth/rate-limit'

const bodySchema = z.object({ accessCode: z.string().max(200) })

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req, env.APP_ORIGIN)
    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError(400, 'invalid_request', '请求体必须是 {accessCode}')
    }
    const ip = clientIpFromRequest(req)
    const result = verifyAccessCode(
      parsed.data.accessCode,
      env.DEMO_ACCESS_CODE,
      env.ADMIN_ACCESS_CODE,
    )
    if (!result.ok) {
      const rl = registerFailure(ip)
      if (rl.limited) {
        const res = jsonError(
          429,
          'rate_limited',
          `尝试次数过多，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试`,
        )
        res.headers.set('Retry-After', String(rl.retryAfterSec))
        return res
      }
      return jsonError(401, 'unauthorized', '访问码不正确')
    }
    clearFailures(ip)
    const session = await createSession(getDb(), result.role, env.DATA_TTL_HOURS)
    const res = NextResponse.json({
      role: result.role,
      expiresAt: session.expiresAt.toISOString(),
    })
    res.headers.append(
      'Set-Cookie',
      buildSessionCookie(session.token, session.expiresAt, env.isProduction),
    )
    return res
  } catch (err) {
    return toErrorResponse(err)
  }
}

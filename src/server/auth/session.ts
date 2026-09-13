import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import postgres from 'postgres'

export const SESSION_COOKIE = 'ca_session'

export interface SessionInfo {
  id: string
  role: 'demo' | 'admin'
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export interface AccessCodeResult {
  ok: boolean
  role: 'demo' | 'admin'
}

/** 验证访问码：先比对演示码，再比对管理码；常数时间比较。日志不得输出访问码。 */
export function verifyAccessCode(
  code: unknown,
  demoCode: string,
  adminCode: string,
): AccessCodeResult {
  if (typeof code !== 'string' || code.length === 0 || code.length > 200) {
    return { ok: false, role: 'demo' }
  }
  if (safeEqual(code, adminCode)) return { ok: true, role: 'admin' }
  if (safeEqual(code, demoCode)) return { ok: true, role: 'demo' }
  return { ok: false, role: 'demo' }
}

/** 创建会话：明文 token 仅写入 cookie，数据库只存哈希 */
export async function createSession(
  sql: postgres.Sql,
  role: 'demo' | 'admin',
  ttlHours: number,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = sha256(token)
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000)
  const rows = await sql`insert into sessions (token_hash, role, expires_at)
    values (${tokenHash}, ${role}, ${expiresAt.toISOString()}) returning id`
  return {
    token,
    sessionId: (rows[0] as { id: string }).id,
    expiresAt,
  }
}

function parseSessionCookie(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** 从请求解析有效会话（未过期）。无效返回 null。 */
export async function getSession(
  sql: postgres.Sql,
  req: Request,
): Promise<SessionInfo | null> {
  const token = parseSessionCookie(req.headers.get('cookie'))
  if (!token) return null
  const tokenHash = sha256(token)
  const rows = await sql`select id, role from sessions
    where token_hash = ${tokenHash} and expires_at > now() limit 1`
  if (rows.length === 0) return null
  const row = rows[0] as { id: string; role: 'demo' | 'admin' }
  return { id: row.id, role: row.role }
}

export function sessionCookieOptions(expiresAt: Date, secure: boolean) {
  return {
    name: SESSION_COOKIE,
    value: 'PLACEHOLDER',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    expires: expiresAt,
  }
}

/** 构造 Set-Cookie 字符串 */
export function buildSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** NextRequest 版本（供 server component / middleware 使用） */
export function sessionTokenFromNextRequest(req: NextRequest): string | null {
  return parseSessionCookie(req.headers.get('cookie'))
}

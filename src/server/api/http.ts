import { NextResponse } from 'next/server'
import { makeApiErrorBody, type ApiErrorCode } from '@/core/contracts/api'
import { randomUUID } from 'node:crypto'

export function jsonError(
  status: number,
  code: ApiErrorCode,
  message: string,
): NextResponse {
  return NextResponse.json(makeApiErrorBody(code, message, randomUUID()), {
    status,
  })
}

export function jsonOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as object, { status })
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 统一路由错误处理：HttpError → 结构化错误；其余 → 500（不泄露内部细节） */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message)
  }
  console.error('[api] unhandled error:', err)
  return jsonError(500, 'internal_error', '服务器内部错误')
}

/**
 * 写请求 Origin 校验（规格 8）。
 * 浏览器跨站请求必带 Origin：与配置的 APP_ORIGIN 或请求 Host 不一致即拒绝；
 * 无 Origin（如服务端调用、测试工具）不视为 CSRF 风险。
 */
export function assertSameOrigin(req: Request, appOrigin?: string): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const origin = req.headers.get('origin')
  if (!origin) return
  const allowed = new Set<string>()
  if (appOrigin) allowed.add(appOrigin)
  try {
    const url = new URL(req.url)
    allowed.add(url.origin)
  } catch {
    /* ignore */
  }
  try {
    const host = req.headers.get('host')
    const proto = req.headers.get('x-forwarded-proto') ?? 'http'
    if (host) {
      allowed.add(`${proto}://${host}`)
      allowed.add(`http://${host}`)
      allowed.add(`https://${host}`)
    }
  } catch {
    /* ignore */
  }
  if (!allowed.has(origin)) {
    throw new HttpError(403, 'forbidden', '跨站写请求被拒绝')
  }
}

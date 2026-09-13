/**
 * 访问码失败限流（规格 8：每 IP 每 10 分钟 10 次）。
 * 进程内实现：单实例部署足够；多实例部署需换共享存储（首版不涉及）。
 */
const WINDOW_MS = 10 * 60 * 1000
const MAX_FAILURES = 10

interface Bucket {
  failures: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

export function clientIpFromRequest(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return 'local'
}

export function registerFailure(ip: string): { limited: boolean; retryAfterSec: number } {
  const now = Date.now()
  const bucket = buckets.get(ip)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { failures: 1, resetAt: now + WINDOW_MS })
    return { limited: false, retryAfterSec: 0 }
  }
  bucket.failures += 1
  if (bucket.failures > MAX_FAILURES) {
    return { limited: true, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  return { limited: false, retryAfterSec: 0 }
}

export function clearFailures(ip: string): void {
  buckets.delete(ip)
}

/** 测试用：重置全部限流状态 */
export function resetRateLimiter(): void {
  buckets.clear()
}

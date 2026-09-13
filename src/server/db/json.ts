/**
 * jsonb 读取助手：PGlite socket 场景下 postgres.js 可能返回 JSON 字符串
 * 而非已解析对象（类型 OID 未透传），统一在此兼容两种形态。
 */
export function asJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return value as unknown as T
    }
  }
  return value as T
}

export function asJsonArray<T>(value: unknown): T[] {
  const parsed = asJson<T | T[] | null>(value)
  return Array.isArray(parsed) ? parsed : []
}

/** jsonb 写入助手：把业务对象转为 postgres.js JSON 参数 */
export function asPgJson(value: unknown): import('postgres').JSONValue {
  return value as unknown as import('postgres').JSONValue
}

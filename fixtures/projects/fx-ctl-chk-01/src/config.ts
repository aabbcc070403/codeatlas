export interface AppConfig {
  port: number
  host: string
}

export function loadConfig(raw: string): AppConfig {
  const parsed: unknown = JSON.parse(raw)
  const config = parsed as Partial<AppConfig>
  // @ts-expect-error 遗留响应缺少 host 字段，等待后端补齐后移除（issue #142）
  const host = config.host
  return { port: config.port ?? 8080, host }
}
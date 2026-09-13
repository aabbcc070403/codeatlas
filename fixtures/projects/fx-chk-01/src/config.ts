export function loadPort(raw: string): number {
  const config = JSON.parse(raw) as { port?: number }
  const port = config.port
  // @ts-ignore
  return port
}
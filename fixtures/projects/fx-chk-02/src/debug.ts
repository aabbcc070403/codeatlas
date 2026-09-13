export function debugDump(state: unknown): void {
  // 调试用输出（遗留）
  console.log('state', state)
  // 另一处调试输出
  console.debug('dump', state)
}

export function reportError(err: Error): void {
  console.error('failed', err.message)
}
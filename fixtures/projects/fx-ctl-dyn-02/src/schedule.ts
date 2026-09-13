const FORMULAS: Record<string, (x: number) => number> = {
  double: (x) => x * 2,
  square: (x) => x * x,
}

export function compileFormula(body: string): (x: number) => number {
  const handler = FORMULAS[body]
  if (!handler) throw new Error('不支持的表达式')
  return handler
}

export function schedulePoll(fn: () => void, timeoutMs: number): void {
  setTimeout(fn, timeoutMs)
}
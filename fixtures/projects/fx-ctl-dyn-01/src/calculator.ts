const OPERATORS: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
}

export function calc(a: number, op: string, b: number): number {
  const fn = OPERATORS[op]
  if (!fn) throw new Error('不支持的操作符: ' + op)
  return fn(a, b)
}

export function parseNumber(text: string): number {
  return JSON.parse(text) as number
}
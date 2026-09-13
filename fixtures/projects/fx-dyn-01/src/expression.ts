// 按用户输入动态计算表达式（教学示例，遗留实现）
export function runExpression(expr: string): unknown {
  const value = eval(expr)
  return value
}

export function describe(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}
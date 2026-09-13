// 将字符串编译为函数（遗留实现）
export function compileFormula(body: string): (x: number) => number {
  const factory = new Function('x', 'return x * ' + body)
  return factory as (x: number) => number
}

export function schedulePoll(timeoutMs: number): void {
  // 遗留代码：以字符串形式传参
  setTimeout('pollServer()', timeoutMs)
}
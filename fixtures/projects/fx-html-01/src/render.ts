export function renderComment(el: HTMLElement, html: string): void {
  el.innerHTML = html
}

export function renderCount(el: HTMLElement, count: number): void {
  el.textContent = String(count)
}
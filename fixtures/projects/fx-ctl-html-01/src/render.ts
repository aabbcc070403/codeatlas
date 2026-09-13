export function renderComment(el: HTMLElement, text: string): void {
  // 纯文本渲染：不解析 HTML
  el.textContent = text
}

export function renderBadge(el: HTMLElement, label: string): void {
  el.setAttribute('data-label', label)
}
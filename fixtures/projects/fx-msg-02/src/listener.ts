export function listenForTheme(apply: (theme: string) => void): void {
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: string; theme?: string }
    if (data.type === 'theme') apply(data.theme ?? 'light')
  })
}
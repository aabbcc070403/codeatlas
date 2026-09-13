const ALLOWED_ORIGINS = ['https://portal.example.com']

export function listenForTheme(apply: (theme: string) => void): void {
  window.addEventListener('message', (event) => {
    if (!ALLOWED_ORIGINS.includes(event.origin)) return
    const data = event.data as { type?: string; theme?: string }
    if (data.type === 'theme') apply(data.theme ?? 'light')
  })
}
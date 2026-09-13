const PARENT_ORIGIN = 'https://portal.example.com'

export interface HeightMessage {
  type: 'height'
  height: number
}

export function sendHeight(height: number): void {
  window.postMessage({ type: "height", height }, PARENT_ORIGIN)
}
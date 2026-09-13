export interface HeightMessage {
  type: 'height'
  height: number
}

export function sendHeight(height: number): void {
  window.postMessage({ type: 'height', height }, '*')
}
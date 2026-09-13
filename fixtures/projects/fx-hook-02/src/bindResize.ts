import { useEffect } from 'react'

export function bindResizeOnce(): void {
  useEffect(() => {
    const onResize = () => undefined
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
}
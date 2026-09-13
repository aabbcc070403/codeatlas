import { useEffect } from 'react'

export function useBindResize(onResize: () => void): void {
  useEffect(() => {
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [onResize])
}
import { useEffect } from 'react'
import { useSiteStatus } from '@/store/site-status'

export function useSiteStatusRefresh(): void {
  useEffect(() => {
    const refresh = () => { void useSiteStatus.getState().refresh() }
    const whenVisible = () => { if (document.visibilityState !== 'hidden') refresh() }
    const closed = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      useSiteStatus.getState().apply({ closed: true, message: detail?.message ?? '' })
    }
    refresh()
    const timer = window.setInterval(whenVisible, 5 * 60_000)
    window.addEventListener('focus', whenVisible)
    window.addEventListener('online', whenVisible)
    window.addEventListener('aivory:site-closed', closed)
    document.addEventListener('visibilitychange', whenVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', whenVisible)
      window.removeEventListener('online', whenVisible)
      window.removeEventListener('aivory:site-closed', closed)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [])
}

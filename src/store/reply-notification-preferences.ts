import { create } from 'zustand'

const KEY = 'aivory.reply-notification-preferences'

function read(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => enabled === true))
  } catch { return {} }
}

export const useReplyNotificationPreferences = create<{
  accounts: Record<string, boolean>
  setEnabled: (userId: string, enabled: boolean) => void
}>(() => ({
  accounts: read(),
  setEnabled(userId, enabled) {
    if (!userId) return
    // Merge disk state so another tab's account preference is preserved.
    const accounts = { ...read(), [userId]: enabled }
    try { localStorage.setItem(KEY, JSON.stringify(accounts)) } catch { /* Session-only when storage is unavailable. */ }
    useReplyNotificationPreferences.setState({ accounts })
  },
}))

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key === KEY || event.key === null) useReplyNotificationPreferences.setState({ accounts: read() })
})

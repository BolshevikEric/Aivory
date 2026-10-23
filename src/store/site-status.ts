import { create } from 'zustand'
import { api } from '@/api/client'

export interface SiteStatus {
  closed: boolean
  message: string
}

interface SiteStatusState extends SiteStatus {
  loaded: boolean
  refreshing: boolean
  refresh: () => Promise<void>
  apply: (status: SiteStatus) => void
}

let generation = 0
let pending: Promise<void> | null = null

export const useSiteStatus = create<SiteStatusState>((set) => ({
  closed: false,
  message: '',
  loaded: false,
  refreshing: false,
  apply(status) {
    generation += 1
    set({ ...status, loaded: true })
  },
  refresh() {
    if (pending) return pending
    const version = generation
    set({ refreshing: true })
    pending = api<SiteStatus>('/public/site-status', {
      anonymous: true,
      activity: 'background',
      signal: AbortSignal.timeout(10_000),
    }).then((status) => {
      if (version === generation) set({ ...status, loaded: true })
    }).catch(() => {
      // Keep the last known closure on transient network failures. API access
      // is independently enforced by the server even if this probe is offline.
      set({ loaded: true })
    }).finally(() => {
      pending = null
      set({ refreshing: false })
    })
    return pending
  },
}))

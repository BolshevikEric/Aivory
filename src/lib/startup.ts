declare global {
  interface Window {
    aivoryStartup?: {
      startedAt: number
      getState: () => 'loading' | 'slow' | 'failed' | 'ready'
      mount: () => void
      ready: () => void
      fail: () => void
    }
  }
}

let initialPageLoaded = false
let loadingScreens = 0

export function trackStartupScreen(): () => void {
  loadingScreens++
  return () => {
    loadingScreens--
    // A replacement Suspense/AuthGate screen mounts in the same effect flush.
    queueMicrotask(() => {
      if (loadingScreens === 0) initialPageLoaded = true
    })
  }
}

export function startupLoadingSince(): number {
  const startup = typeof window !== 'undefined' ? window.aivoryStartup : undefined
  return startup && !initialPageLoaded ? startup.startedAt : Date.now()
}

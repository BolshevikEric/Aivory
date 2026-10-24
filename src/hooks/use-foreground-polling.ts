import { useEffect, useRef } from 'react'

interface ForegroundPollingOptions {
  enabled?: boolean
  intervalMs: number
  /** Changing the resource cancels replies and scheduled work for its old owner. */
  resourceKey?: string
  immediate?: boolean
}

export function isPermanentPollingError(error: unknown): boolean {
  return error instanceof Object && 'status' in error &&
    [401, 403, 404, 410].includes(Number(error.status))
}

/** One cancellable request at a time, suspended while hidden or offline. */
export function useForegroundPolling(
  task: (signal: AbortSignal) => Promise<void>,
  { enabled = true, intervalMs, resourceKey, immediate = false }: ForegroundPollingOptions,
): void {
  const taskRef = useRef(task)
  useEffect(() => { taskRef.current = task }, [task])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let stopped = false
    let running = false
    let resumePending = false
    let failures = 0
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let requestTimeout: ReturnType<typeof setTimeout> | undefined
    const interval = Math.max(100, intervalMs)
    const available = () => document.visibilityState !== 'hidden' && navigator.onLine !== false
    let wasAvailable = available()
    const clearTimer = () => { clearTimeout(timer); timer = undefined }
    const schedule = () => {
      if (disposed || stopped || !available()) return
      const delay = failures
        ? Math.min(Math.max(interval, 30_000), interval * 2 ** Math.min(failures, 5))
        : interval
      timer = setTimeout(() => { timer = undefined; void tick() }, delay)
    }
    const tick = async () => {
      if (disposed || stopped || running || !available()) return
      clearTimer()
      resumePending = false
      running = true
      const current = new AbortController()
      controller = current
      let timedOut = false
      requestTimeout = setTimeout(() => { timedOut = true; current.abort() }, 15_000)
      try {
        await taskRef.current(current.signal)
        if (!current.signal.aborted) failures = 0
      } catch (error) {
        if (!current.signal.aborted) {
          stopped = isPermanentPollingError(error)
          failures += 1
        }
      } finally {
        clearTimeout(requestTimeout)
        if (timedOut) failures += 1
        controller = null
        running = false
        if (!disposed && !stopped) {
          if (resumePending && available()) void tick()
          else schedule()
        }
      }
    }
    const suspendOrResume = () => {
      const nowAvailable = available()
      if (nowAvailable === wasAvailable) return
      wasAvailable = nowAvailable
      clearTimer()
      if (!nowAvailable) {
        resumePending = false
        clearTimeout(requestTimeout)
        controller?.abort()
      } else {
        resumePending = true
        if (!running) void tick()
      }
    }
    document.addEventListener('visibilitychange', suspendOrResume)
    window.addEventListener('online', suspendOrResume)
    window.addEventListener('offline', suspendOrResume)
    if (immediate) void tick()
    else schedule()
    return () => {
      disposed = true
      clearTimer()
      clearTimeout(requestTimeout)
      controller?.abort()
      document.removeEventListener('visibilitychange', suspendOrResume)
      window.removeEventListener('online', suspendOrResume)
      window.removeEventListener('offline', suspendOrResume)
    }
  }, [enabled, intervalMs, resourceKey, immediate])
}

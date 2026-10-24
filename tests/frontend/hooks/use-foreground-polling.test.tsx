// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useForegroundPolling } from '@/hooks/use-foreground-polling'

let root: Root | null
let visibility: DocumentVisibilityState
let online: boolean

function Probe({ task, resourceKey = 'a', enabled = true, intervalMs = 1000 }: {
  task: (signal: AbortSignal) => Promise<void>; resourceKey?: string; enabled?: boolean; intervalMs?: number
}) {
  useForegroundPolling(task, { intervalMs, resourceKey, enabled })
  return null
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  visibility = 'visible'
  online = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root?.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('foreground polling lifecycle', () => {
  it('waits for a slow request to settle before starting the next interval', async () => {
    const pending = deferred()
    const task = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined)
    act(() => root!.render(createElement(Probe, { task })))
    await advance(10_000)
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve())
    await advance(999)
    expect(task).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight request on unmount and never restarts from its late reply', async () => {
    const pending = deferred()
    const task = vi.fn((_signal: AbortSignal) => pending.promise)
    act(() => root!.render(createElement(Probe, { task })))
    await advance(1000)
    const signal = task.mock.calls[0][0] as AbortSignal
    act(() => root!.unmount())
    root = null
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => pending.resolve())
    await advance(60_000)
    expect(task).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('suspends while hidden and resumes once without overlapping a cancelled request', async () => {
    const pending = deferred()
    const task = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined)
    visibility = 'hidden'
    act(() => root!.render(createElement(Probe, { task })))
    await advance(60_000)
    expect(task).not.toHaveBeenCalled()
    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(task).toHaveBeenCalledTimes(1)
    const signal = task.mock.calls[0][0] as AbortSignal
    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(signal.aborted).toBe(true)
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('online'))
    })
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve())
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('does not poll offline and immediately checks once when connectivity returns', async () => {
    const task = vi.fn().mockResolvedValue(undefined)
    online = false
    act(() => root!.render(createElement(Probe, { task })))
    await advance(60_000)
    expect(task).not.toHaveBeenCalled()
    online = true
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(task).toHaveBeenCalledTimes(1)
    await advance(1000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('backs off temporary failures and stops retrying a permanently missing resource', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('Temporary failure'))
      .mockRejectedValueOnce({ status: 404 })
    act(() => root!.render(createElement(Probe, { task })))
    await advance(1000)
    await advance(1999)
    expect(task).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(task).toHaveBeenCalledTimes(2)
    await advance(60_000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('aborts the old resource and releases every timer when polling is disabled', async () => {
    const pending = deferred()
    const task = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined)
    act(() => root!.render(createElement(Probe, { task })))
    await advance(1000)
    const oldSignal = task.mock.calls[0][0] as AbortSignal
    act(() => root!.render(createElement(Probe, { task, resourceKey: 'b' })))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => pending.resolve())
    await advance(1000)
    expect(task).toHaveBeenCalledTimes(2)
    act(() => root!.render(createElement(Probe, { task, resourceKey: 'b', enabled: false })))
    await advance(60_000)
    expect(task).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a five-minute poll from retrying faster after an error', async () => {
    const task = vi.fn().mockRejectedValue(new Error('Temporary failure'))
    act(() => root!.render(createElement(Probe, { task, intervalMs: 300_000 })))
    await advance(300_000)
    expect(task).toHaveBeenCalledTimes(1)
    await advance(299_999)
    expect(task).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('aborts a stalled request at its deadline and backs off before retrying', async () => {
    const task = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    act(() => root!.render(createElement(Probe, { task })))
    await advance(1000)
    const signal = task.mock.calls[0][0]
    await advance(15_000)
    expect(signal.aborted).toBe(true)
    await advance(1999)
    expect(task).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(task).toHaveBeenCalledTimes(2)
  })
})

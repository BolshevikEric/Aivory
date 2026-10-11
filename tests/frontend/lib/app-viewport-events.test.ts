// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAppViewport, readVisualViewport, subscribeAppViewport } from '@/lib/app-viewport'

const cleanup: Array<() => void> = []
const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
afterEach(() => {
  for (const unsubscribe of cleanup.splice(0)) unsubscribe()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport)
  else Reflect.deleteProperty(window, 'visualViewport')
})

function visualViewport(height = 320, top = 100, scale = 1) {
  const viewport = new EventTarget() as EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number; scale: number }
  Object.assign(viewport, { height, width: 390, offsetTop: top, offsetLeft: 0, scale })
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport })
  return viewport
}

describe('shared viewport lifecycle', () => {
  it('publishes viewport scroll offsets before notifying subscribers', () => {
    const viewport = visualViewport()
    const observed: string[] = []
    cleanup.push(subscribeAppViewport(() => observed.push(document.documentElement.style.getPropertyValue('--app-viewport-top'))))
    expect(observed).toEqual(['100px'])
    expect(readAppViewport().height).toBe(320)
    expect(readVisualViewport().top).toBe(viewport.offsetTop)
  })

  it('keeps layout dimensions when a user zooms without discarding raw visual geometry', () => {
    visualViewport(320, 100, 2)
    expect(readAppViewport().height).toBe(window.innerHeight)
    expect(readAppViewport().top).toBe(0)
    expect(readVisualViewport().height).toBe(320)
    expect(readVisualViewport().top).toBe(100)
  })

  it('cancels pending frames when another subscription synchronizes and both unmount', () => {
    const viewport = visualViewport()
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
    vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key))
    const first = subscribeAppViewport(() => {})
    viewport.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)
    const second = subscribeAppViewport(() => {})
    expect(frames.size).toBe(0)
    first()
    second()
    expect(document.querySelector('[data-app-safe-area]')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
    expect(frames.size).toBe(0)
  })
})

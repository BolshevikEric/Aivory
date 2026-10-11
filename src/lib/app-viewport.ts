export interface AppViewport {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
  layoutWidth: number
  layoutHeight: number
  scale: number
}

export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

const emptyViewport: AppViewport = {
  left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0,
  layoutWidth: 0, layoutHeight: 0, scale: 1,
}

export function readVisualViewport(): AppViewport {
  if (typeof window === 'undefined') return emptyViewport
  const layoutWidth = document.documentElement.clientWidth || window.innerWidth
  const layoutHeight = window.innerHeight
  const viewport = window.visualViewport
  const left = Math.max(0, viewport?.offsetLeft ?? 0)
  const top = Math.max(0, viewport?.offsetTop ?? 0)
  const width = Math.max(0, viewport?.width ?? layoutWidth)
  const height = Math.max(0, viewport?.height ?? layoutHeight)
  return {
    left, top, width, height, right: left + width, bottom: top + height,
    layoutWidth, layoutHeight, scale: viewport?.scale ?? 1,
  }
}

export function readAppViewport(): AppViewport {
  const viewport = readVisualViewport()
  if (Math.abs(viewport.scale - 1) < 0.01) return viewport
  // Keep layout dimensions stable when the user magnifies and pans the page.
  return {
    ...viewport, left: 0, top: 0, width: viewport.layoutWidth, height: viewport.layoutHeight,
    right: viewport.layoutWidth, bottom: viewport.layoutHeight,
  }
}

export function fitViewportToSafeArea(viewport: AppViewport, insets: SafeAreaInsets): AppViewport {
  const left = Math.max(viewport.left, insets.left)
  const top = Math.max(viewport.top, insets.top)
  const right = Math.max(left, Math.min(viewport.right, viewport.layoutWidth - insets.right))
  const bottom = Math.max(top, Math.min(viewport.bottom, viewport.layoutHeight - insets.bottom))
  return { ...viewport, left, top, right, bottom, width: right - left, height: bottom - top }
}

let safeAreaProbe: HTMLElement | null = null
function readSafeArea(): SafeAreaInsets {
  if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 }
  if (!safeAreaProbe?.isConnected) {
    safeAreaProbe = document.createElement('span')
    safeAreaProbe.dataset.appSafeArea = ''
    safeAreaProbe.setAttribute('aria-hidden', 'true')
    safeAreaProbe.style.cssText = 'display:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
    document.documentElement.append(safeAreaProbe)
  }
  const style = getComputedStyle(safeAreaProbe)
  return {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  }
}

export function readSurfaceViewport(): AppViewport {
  return fitViewportToSafeArea(readAppViewport(), readSafeArea())
}

const listeners = new Set<() => void>()
let frame = 0
let detach: (() => void) | null = null

function publishViewport() {
  frame = 0
  const viewport = readAppViewport()
  const surface = readSurfaceViewport()
  const root = document.documentElement
  root.style.setProperty('--app-height', `${viewport.height}px`)
  for (const [prefix, rectangle] of [['app', viewport], ['surface', surface]] as const) {
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      root.style.setProperty(`--${prefix}-viewport-${key}`, `${rectangle[key]}px`)
    }
  }
  for (const listener of listeners) listener()
}

/** One subscription serves the app shell and every portalled surface. */
export function subscribeAppViewport(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!detach) {
    const viewport = window.visualViewport
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(publishViewport)
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    detach = () => {
      cancelAnimationFrame(frame)
      frame = 0
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
    }
  }
  listeners.add(listener)
  if (frame) cancelAnimationFrame(frame)
  publishViewport()
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    detach?.()
    detach = null
    safeAreaProbe?.remove()
    safeAreaProbe = null
    const root = document.documentElement
    root.style.removeProperty('--app-height')
    for (const prefix of ['app', 'surface']) {
      for (const key of ['left', 'top', 'width', 'height']) root.style.removeProperty(`--${prefix}-viewport-${key}`)
    }
  }
}

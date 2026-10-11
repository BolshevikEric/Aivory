import { describe, expect, it, vi } from 'vitest'
import { composerCommandPosition, scrollCommandItemIntoView } from '@/lib/composer-command-position'

const viewport = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 }

describe('composer command menu position', () => {
  it('preserves the preferred direction when a full list fits below the composer', () => {
    const result = composerCommandPosition(
      { left: 16, top: 160, bottom: 240, width: 358 },
      viewport,
      'down',
    )

    expect(result.placement).toBe('down')
    expect(result.top).toBe(248)
    expect(result.maxHeight).toBe(280)
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(viewport.bottom - 12)
  })

  it('flips the home menu above the composer when the keyboard leaves more space there', () => {
    const visibleViewport = { ...viewport, height: 320, bottom: 320 }
    const result = composerCommandPosition(
      { left: 16, top: 160, bottom: 240, width: 358 },
      visibleViewport,
      'down',
    )

    expect(result.placement).toBe('up')
    expect(result.top).toBe(152)
    expect(result.maxHeight).toBe(140)
    expect(result.top - result.maxHeight).toBe(visibleViewport.top + 12)
    expect(result.top).toBeLessThanOrEqual(visibleViewport.bottom - 12)
  })

  it('flips a thread menu down when the composer is near the viewport top', () => {
    const result = composerCommandPosition(
      { left: 16, top: 100, bottom: 180, width: 358 },
      viewport,
      'up',
    )

    expect(result.placement).toBe('down')
    expect(result.top).toBe(188)
    expect(result.maxHeight).toBe(280)
  })

  it('keeps coordinates inside an offset visual viewport after panning or zooming', () => {
    const visibleViewport = { left: 60, top: 140, right: 340, bottom: 420, width: 280, height: 280 }
    const result = composerCommandPosition(
      { left: 0, top: 280, bottom: 360, width: 390 },
      visibleViewport,
      'down',
    )

    expect(result.placement).toBe('up')
    expect(result.left).toBe(72)
    expect(result.width).toBe(256)
    expect(result.left + result.width).toBe(visibleViewport.right - 12)
    expect(result.top - result.maxHeight).toBe(visibleViewport.top + 12)
  })

  it('clamps an offscreen anchor to the visible area without negative dimensions', () => {
    const visibleViewport = { left: 50, top: 200, right: 50, bottom: 200, width: 0, height: 0 }
    const result = composerCommandPosition(
      { left: 0, top: 500, bottom: 600, width: 390 },
      visibleViewport,
      'down',
    )

    expect(result).toEqual({ left: 50, top: 200, width: 0, maxHeight: 0, placement: 'down' })
  })

  it('reuses the current position when menu scrolling leaves its geometry unchanged', () => {
    const anchor = { left: 16, top: 160, bottom: 240, width: 358 }
    const current = composerCommandPosition(anchor, viewport, 'down')

    const next = composerCommandPosition({ ...anchor }, { ...viewport }, 'down', current)

    expect(next).toBe(current)
  })

  it('updates the current position when the visible viewport changes placement', () => {
    const anchor = { left: 16, top: 160, bottom: 240, width: 358 }
    const current = composerCommandPosition(anchor, viewport, 'down')

    const next = composerCommandPosition(anchor, { ...viewport, height: 320, bottom: 320 }, 'down', current)

    expect(next).not.toBe(current)
    expect(next.placement).toBe('up')
  })
})

function element(bounds: { top: number; bottom: number }): HTMLElement {
  return {
    getBoundingClientRect: () => bounds as DOMRect,
    scrollIntoView: vi.fn(),
    scrollTop: 80,
    clientTop: 1,
    clientHeight: 100,
  } as unknown as HTMLElement
}

describe('composer command selection scrolling', () => {
  it('scrolls only the menu to reveal a selected item above its viewport', () => {
    const menu = element({ top: 100, bottom: 202 })
    const item = element({ top: 75, bottom: 95 })

    scrollCommandItemIntoView(menu, item)

    expect(menu.scrollTop).toBe(54)
    expect(item.scrollIntoView).not.toHaveBeenCalled()
    expect(menu.scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls only the menu to reveal a selected item below its viewport', () => {
    const menu = element({ top: 100, bottom: 202 })
    const item = element({ top: 210, bottom: 230 })

    scrollCommandItemIntoView(menu, item)

    expect(menu.scrollTop).toBe(109)
    expect(item.scrollIntoView).not.toHaveBeenCalled()
  })

  it('leaves the menu and page still when the selected item is already visible', () => {
    const menu = element({ top: 100, bottom: 202 })
    const item = element({ top: 110, bottom: 130 })

    scrollCommandItemIntoView(menu, item)

    expect(menu.scrollTop).toBe(80)
    expect(item.scrollIntoView).not.toHaveBeenCalled()
  })
})

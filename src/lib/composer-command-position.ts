interface AnchorBounds {
  left: number
  top: number
  bottom: number
  width: number
}

interface ViewportBounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface ComposerCommandPosition {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'up' | 'down'
}

export function composerCommandPosition(
  anchor: AnchorBounds,
  viewport: ViewportBounds,
  preferredPlacement: 'up' | 'down',
  previous?: ComposerCommandPosition | null,
): ComposerCommandPosition {
  const gutterX = Math.min(12, viewport.width / 2)
  const gutterY = Math.min(12, viewport.height / 2)
  const gap = 8
  const heightLimit = 280
  const minLeft = viewport.left + gutterX
  const maxRight = viewport.right - gutterX
  const minTop = viewport.top + gutterY
  const maxBottom = viewport.bottom - gutterY
  const clampY = (value: number) => Math.min(Math.max(value, minTop), maxBottom)
  const upperAnchor = clampY(anchor.top - gap)
  const lowerAnchor = clampY(anchor.bottom + gap)
  const above = upperAnchor - minTop
  const below = maxBottom - lowerAnchor
  const preferredSpace = preferredPlacement === 'up' ? above : below
  const alternateSpace = preferredPlacement === 'up' ? below : above
  const placement = preferredSpace < heightLimit && alternateSpace > preferredSpace
    ? preferredPlacement === 'up' ? 'down' : 'up'
    : preferredPlacement
  const width = Math.max(0, Math.min(anchor.width, maxRight - minLeft))

  const next: ComposerCommandPosition = {
    left: Math.min(Math.max(anchor.left, minLeft), maxRight - width),
    top: placement === 'up' ? upperAnchor : lowerAnchor,
    width,
    maxHeight: Math.min(heightLimit, placement === 'up' ? above : below),
    placement,
  }

  // Menu scrolling emits viewport events too; keep selection effects still.
  return previous && previous.left === next.left && previous.top === next.top &&
    previous.width === next.width && previous.maxHeight === next.maxHeight &&
    previous.placement === next.placement ? previous : next
}

export function scrollCommandItemIntoView(menu: HTMLElement, item: HTMLElement): void {
  const menuBounds = menu.getBoundingClientRect()
  const itemBounds = item.getBoundingClientRect()
  const top = menuBounds.top + menu.clientTop
  const bottom = top + menu.clientHeight

  // Scroll the suggestion list only; scrollIntoView also moves page ancestors.
  if (itemBounds.top < top) {
    menu.scrollTop += itemBounds.top - top
  } else if (itemBounds.bottom > bottom) {
    menu.scrollTop += itemBounds.bottom - bottom
  }
}

import { useLayoutEffect, type RefObject } from 'react'

/** Measure natural content, letting CSS animate its container without scaling text. */
export function useAnimatedAutoHeight(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content || typeof ResizeObserver === 'undefined') return
    let previousHeight = -1
    const measure = () => {
      // Layout size stays correct during parent scale/view-transition effects.
      const height = content.offsetHeight
      if (height === previousHeight) return
      previousHeight = height
      container.style.height = `${height}px`
      container.dataset.heightReady = 'true'
    }
    // Set the initial size before paint; later CSS transitions start from the
    // currently displayed height, including during rapid additions/removals.
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => {
      observer.disconnect()
      container.style.removeProperty('height')
      delete container.dataset.heightReady
    }
  }, [containerRef, contentRef])
}

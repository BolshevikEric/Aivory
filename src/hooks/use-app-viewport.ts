import { useLayoutEffect, useState } from 'react'
import { readAppViewport, readSurfaceViewport, subscribeAppViewport } from '@/lib/app-viewport'

/** Safari's keyboard changes the visual viewport without resizing 100dvh. */
export function useAppViewport() {
  useLayoutEffect(() => subscribeAppViewport(() => {}), [])
}

export function useSurfaceViewport() {
  const [viewport, setViewport] = useState(readAppViewport)
  useLayoutEffect(() => subscribeAppViewport(() => {
    const next = readSurfaceViewport()
    setViewport((previous) =>
      previous.left === next.left && previous.top === next.top && previous.width === next.width &&
      previous.height === next.height && previous.scale === next.scale ? previous : next,
    )
  }), [])
  return viewport
}

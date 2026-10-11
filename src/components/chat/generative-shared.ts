import { useEffect, useRef, useState } from 'react'

export const visualizationPalette = ['var(--color-accent)', 'var(--color-fg)', 'var(--gui-violet)', 'var(--gui-amber)', 'var(--gui-blue)', 'var(--gui-rose)', 'var(--color-success)', 'var(--color-danger)']
export const visualFocus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]'
export const visualButton = `gui-button ${visualFocus}`
export const visualInput = `gui-input ${visualFocus}`
export const formatValue = (value: number, locale?: string, precision = 3) => new Intl.NumberFormat(locale, { maximumFractionDigits: precision }).format(value)

export function usePlotWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

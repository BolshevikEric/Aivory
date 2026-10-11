import { describe, expect, it } from 'vitest'
import { fitViewportToSafeArea, type AppViewport } from '@/lib/app-viewport'

function viewport(overrides: Partial<AppViewport> = {}): AppViewport {
  return {
    top: 0, left: 0, width: 390, height: 844, right: 390, bottom: 844,
    layoutWidth: 390, layoutHeight: 844, scale: 1, ...overrides,
  }
}

describe('safe visible viewport', () => {
  const insets = { top: 47, bottom: 34, left: 0, right: 0 }

  it('keeps hardware safe areas outside actionable surfaces', () => {
    const safe = fitViewportToSafeArea(viewport(), insets)
    expect(safe.top).toBe(47)
    expect(safe.bottom).toBe(810)
    expect(safe.height).toBe(763)
  })

  it('does not deduct a bottom safe area again above the keyboard', () => {
    const safe = fitViewportToSafeArea(viewport({ height: 320, bottom: 320 }), insets)
    expect(safe.height).toBe(273)
    expect(safe.bottom).toBe(320)
  })

  it('does not add a top safe area to a viewport already scrolled below it', () => {
    const safe = fitViewportToSafeArea(viewport({ top: 100, height: 320, bottom: 420 }), insets)
    expect(safe.top).toBe(100)
    expect(safe.height).toBe(320)
  })

  it('handles horizontal insets and a panned visual viewport', () => {
    const safe = fitViewportToSafeArea(viewport({ left: 50, width: 280, right: 330 }), { top: 0, bottom: 0, left: 40, right: 80 })
    expect(safe.left).toBe(50)
    expect(safe.right).toBe(310)
    expect(safe.width).toBe(260)
  })

  it('never produces negative available dimensions', () => {
    const safe = fitViewportToSafeArea(viewport({ width: 0, height: 0, right: 0, bottom: 0 }), insets)
    expect(safe.width).toBe(0)
    expect(safe.height).toBe(0)
  })
})

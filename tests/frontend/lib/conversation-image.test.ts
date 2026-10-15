import { describe, expect, it } from 'vitest'
import { conversationImageDimensions } from '@/lib/conversation-image'

describe('single conversation image dimensions', () => {
  it('exports short conversations at double resolution', () => {
    expect(conversationImageDimensions(500.5)).toEqual({ width: 760, height: 501, pixelRatio: 2 })
  })
  it('reduces canvas pixels for standard quality without changing layout', () => {
    expect(conversationImageDimensions(500.5, 'standard')).toEqual({ width: 760, height: 501, pixelRatio: 1.5 })
    expect(conversationImageDimensions(10000, 'standard')).toEqual(conversationImageDimensions(10000, 'high'))
  })
  it('keeps the full height of long conversations while bounding canvas memory', () => {
    for (const height of [6000, 10000, 16384]) {
      const dimensions = conversationImageDimensions(height)
      expect(dimensions.height).toBe(height)
      expect(dimensions.pixelRatio).toBeGreaterThanOrEqual(1)
      expect(dimensions.height * dimensions.pixelRatio).toBeLessThanOrEqual(16384)
      expect(dimensions.width * dimensions.height * dimensions.pixelRatio ** 2).toBeLessThanOrEqual(16_000_001)
    }
  })
  it('rejects excessive height instead of silently cropping or making multiple images', () => {
    expect(() => conversationImageDimensions(16384.1)).toThrow('image selection too large')
  })
  it('rejects invalid dimensions', () => {
    for (const height of [0, -1, Infinity, NaN]) expect(() => conversationImageDimensions(height)).toThrow(RangeError)
  })
})

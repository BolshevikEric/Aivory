import { describe, expect, it } from 'vitest'
import { conversationImageSlices } from '@/lib/conversation-image'

describe('conversation image pagination', () => {
  it('keeps normal messages together and covers the complete transcript in order', () => {
    const pages = conversationImageSlices([{ top: 0, height: 70 }, { top: 80, height: 70 }, { top: 160, height: 40 }], 200, 100)
    expect(pages).toEqual([{ top: 0, height: 80 }, { top: 80, height: 80 }, { top: 160, height: 40 }])
    expect(pages.reduce((height, page) => height + page.height, 0)).toBe(200)
  })
  it('splits a very long reply without dropping content or producing an oversized canvas', () => {
    const pages = conversationImageSlices([{ top: 0, height: 230 }], 230, 100)
    expect(pages).toEqual([{ top: 0, height: 100 }, { top: 100, height: 100 }, { top: 200, height: 30 }])
  })
  it('handles an exact page boundary, small rounding offsets and empty transcripts', () => {
    expect(conversationImageSlices([{ top: 0, height: 100 }, { top: 100, height: 100 }], 200, 100)).toEqual([{ top: 0, height: 100 }, { top: 100, height: 100 }])
    expect(conversationImageSlices([{ top: 0, height: 10.5 }], 11, 100)).toEqual([{ top: 0, height: 11 }])
    expect(conversationImageSlices([], 0)).toEqual([])
  })
  it('rejects invalid dimensions instead of looping indefinitely', () => {
    for (const [total, limit] of [[100, 0], [100, -1], [Infinity, 100], [NaN, 100], [-1, 100]]) expect(() => conversationImageSlices([], total, limit)).toThrow(RangeError)
  })
})

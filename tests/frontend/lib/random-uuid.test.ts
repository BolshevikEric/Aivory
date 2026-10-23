import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from '@/lib/random-uuid'

afterEach(() => vi.unstubAllGlobals())

describe('randomUUID', () => {
  it('uses the native method with its Crypto receiver when available', () => {
    const native = vi.fn(function (this: unknown) {
      expect(this).toBe(crypto)
      return '12345678-1234-4567-89ab-123456789abc'
    })
    const getRandomValues = vi.fn()
    vi.stubGlobal('crypto', { randomUUID: native, getRandomValues })

    expect(randomUUID()).toBe('12345678-1234-4567-89ab-123456789abc')
    expect(native).toHaveBeenCalledOnce()
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it.each([
    [0x00, '00000000-0000-4000-8000-000000000000'],
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])('uses secure random bytes and UUID v4 bits without the native method (%i)', (byte, expected) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      expect(bytes).toHaveLength(16)
      return bytes.fill(byte)
    })
    vi.stubGlobal('crypto', { getRandomValues })

    expect(randomUUID()).toBe(expected)
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})

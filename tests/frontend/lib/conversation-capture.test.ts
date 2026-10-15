// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boundedResource, embedConversationImages } from '@/lib/conversation-capture'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), headers: vi.fn() }))
vi.mock('@/lib/api-fetch', () => ({ apiFetch: mocks.fetch }))
vi.mock('@/api/client', () => ({ authenticatedRequestHeaders: mocks.headers }))
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')

describe('conversation capture resources', () => {
  beforeEach(() => {
    mocks.fetch.mockReset()
    mocks.headers.mockReset().mockResolvedValue({ authorization: 'Bearer private-account' })
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(async () => {}) })
  })
  afterEach(() => {
    vi.useRealTimers()
    if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode)
    else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
  })

  it('bounds image concurrency and only authenticates same-origin API resources', async () => {
    const root = document.createElement('div')
    const urls = [`${window.location.origin}/api/artifacts/private.png`, ...Array.from({ length: 5 }, (_, index) => `https://assets.example/${index}.png`)]
    root.innerHTML = urls.map(url => `<img src="${url}">`).join('')
    const complete: Array<() => void> = []
    mocks.fetch.mockImplementation(() => new Promise(resolve => complete.push(() => resolve({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))))
    const work = embedConversationImages(root, 'Image unavailable')
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(4))
    complete.slice(0, 4).forEach(finish => finish())
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(6))
    complete.slice(4).forEach(finish => finish())
    await work
    expect(mocks.headers).toHaveBeenCalledExactlyOnceWith('/api/artifacts/private.png')
    expect(mocks.fetch.mock.calls.find(([url]) => url === urls[0])?.[1]).toMatchObject({ headers: { authorization: 'Bearer private-account' }, credentials: 'same-origin' })
    expect(mocks.fetch.mock.calls.find(([url]) => url === urls[1])?.[1]).toMatchObject({ headers: {}, credentials: 'omit' })
    expect(root.querySelectorAll('img[src^="data:image/png"]').length).toBe(6)
  })

  it('replaces unavailable images with readable notices', async () => {
    mocks.fetch.mockResolvedValue({ ok: false })
    const root = document.createElement('div')
    root.innerHTML = '<img src="https://assets.example/missing.png" alt="chart.png">'
    await embedConversationImages(root, 'Image unavailable')
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toBe('Image unavailable (chart.png)')
  })

  it('stops waiting for a resource after eight seconds', async () => {
    vi.useFakeTimers()
    const pending = boundedResource(() => new Promise(() => {}))
    const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(8_000)
    await checked
  })

  it('does not start resource work for an already cancelled export', async () => {
    const controller = new AbortController(); controller.abort()
    const work = vi.fn(async () => 'private data')
    await expect(boundedResource(work, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(work).not.toHaveBeenCalled()
  })
})

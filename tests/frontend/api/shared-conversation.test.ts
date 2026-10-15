import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedApi } from '@/api/endpoints'
import { api, invalidateAccountRequests, setAccessToken, setRefreshHandler } from '@/api/client'

const snapshot = { title: 'Shared conversation', messages: [], created_at: 1 }

beforeEach(() => {
  setAccessToken(null)
})

afterEach(() => {
  setAccessToken(null)
  setRefreshHandler(async () => false)
  vi.unstubAllGlobals()
})

describe('public conversation requests', () => {
  it('finishes loading when session hydration changes the current account', async () => {
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })))

    const request = sharedApi.get('sh_public')
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'))
    setAccessToken('restored-session')
    invalidateAccountRequests()
    resolveFetch(Response.json(snapshot))

    await expect(request).resolves.toEqual(snapshot)
  })

  it('reads the public snapshot without session credentials or request signatures', async () => {
    setAccessToken('signed-in-session', 'signing-key')
    const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot))
    vi.stubGlobal('fetch', fetchMock)

    await sharedApi.get('sh_public')

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/public/shared/sh_public')
    expect(options.credentials).toBe('omit')
    const headers = new Headers(options.headers)
    for (const name of ['authorization', 'x-req-token', 'x-device-id', 'x-client-id']) {
      expect(headers.has(name), name).toBe(false)
    }
  })

  it('does not refresh the session after a public request is rejected', async () => {
    const refresh = vi.fn().mockResolvedValue(false)
    setRefreshHandler(refresh)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'auth required' }, { status: 401 })))

    await expect(sharedApi.get('sh_public')).rejects.toMatchObject({ status: 401 })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('still discards private responses after the current account changes', async () => {
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })))

    const request = api('/conversations/private')
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'))
    invalidateAccountRequests()
    resolveFetch(Response.json({ id: 'private' }))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})

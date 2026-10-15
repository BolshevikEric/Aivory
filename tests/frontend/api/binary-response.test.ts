import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, invalidateAccountRequests, resetAuthFailureState, setAccessToken, setRefreshHandler } from '@/api/client'

describe('authenticated binary downloads', () => {
  afterEach(() => {
    setAccessToken(null)
    setRefreshHandler(async () => false)
    resetAuthFailureState()
    vi.unstubAllGlobals()
  })

  it('refreshes an expired session and signs the retried PDF request', async () => {
    setAccessToken('expired', 'request-key')
    setRefreshHandler(async () => { setAccessToken('renewed', 'request-key'); return true })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"auth required"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('%PDF-real-binary', { headers: { 'content-type': 'application/pdf' } }))
    vi.stubGlobal('fetch', fetchMock)

    const file = await api<Blob>('/conversations/selected/export/pdf', { method: 'POST', body: { html: '<p>selected</p>' }, responseType: 'blob' })
    expect(file.type).toBe('application/pdf')
    expect(await file.text()).toBe('%PDF-real-binary')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.headers).toMatchObject({ authorization: 'Bearer renewed', 'x-req-content-sha256': expect.any(String), 'x-req-token': expect.any(String) })
    expect(init.body).toBe('{"html":"<p>selected</p>"}')
  })

  it('discards a PDF when the account changes while the response body is being read', async () => {
    let finish: (blob: Blob) => void = () => {}
    const response = new Response('')
    const read = vi.spyOn(response, 'blob').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const pending = api<Blob>('/conversations/selected/export/pdf', { responseType: 'blob' })
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    invalidateAccountRequests()
    finish(new Blob(['%PDF-private'], { type: 'application/pdf' }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Account changed' })
  })

  it('keeps JSON API errors readable when a binary response was requested', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"pdf_renderer_unavailable"}', { status: 503 })))
    await expect(api('/conversations/selected/export/pdf', { responseType: 'blob' })).rejects.toMatchObject({ status: 503, message: 'pdf_renderer_unavailable' })
  })
})

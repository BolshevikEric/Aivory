import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function dispatchFetch(path: string, method = 'GET') {
  const origin = 'https://aivory.test'
  const listeners = new Map<string, (event: unknown) => void>()
  const fetch = vi.fn(async () => new Response('private file'))
  vm.runInNewContext(readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8'), {
    URL,
    fetch,
    self: {
      location: new URL('/sw.js', origin),
      addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    },
  })
  const request = new Request(new URL(path, origin), { method })
  const respondWith = vi.fn()
  listeners.get('fetch')!({ request, respondWith })
  return { request, fetch, respondWith }
}

describe('service worker network routing', () => {
  it.each([
    ['/api/admin/backup/import', 'POST'],
    ['/api/admin/backup/import-jobs/job-a/chunks?offset=0', 'POST'],
    ['/api/admin/backup/import-jobs/job-a/start', 'POST'],
    ['/api/admin/backup/export?files=1', 'GET'],
    ['/api/admin/backup/export-jobs/job-a/download', 'GET'],
    ['/api/public/backup-import-jobs/job-a', 'GET'],
    ['/api/events', 'GET'],
    ['/api/files/file-a', 'DELETE'],
    ['/assets/app.js', 'GET'],
    ['https://other.test/api/files/file-a', 'GET'],
  ])('leaves %s (%s) outside the service worker event deadline', (path, method) => {
    const { fetch, respondWith } = dispatchFetch(path, method)
    expect(respondWith).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['/api/files/file-a', '/api/artifacts/artifact-a?download=1'])(
    'still bypasses old HTTP caches for private reads at %s',
    async (path) => {
      const { request, fetch, respondWith } = dispatchFetch(path)
      expect(fetch).toHaveBeenCalledExactlyOnceWith(request, { cache: 'no-store' })
      expect(respondWith).toHaveBeenCalledOnce()
      const response = await respondWith.mock.calls[0][0]
      expect(await response.text()).toBe('private file')
    },
  )
})

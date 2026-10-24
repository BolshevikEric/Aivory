/*
 * Aivory service worker: installability with network-only requests.
 * Private resources must reach the API on every read so account changes,
 * workspace revocations and resource deletions take effect immediately.
 */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove caches left by earlier releases, including cached private images.
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('aivory-img-')).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Earlier releases also allowed the browser's HTTP cache to retain private
  // images. Bypass it as well as Cache API, including after upgrading the SW.
  const privateResource = url.origin === self.location.origin &&
    /^\/api\/(files|artifacts)\//.test(url.pathname)
  // Let other requests use the browser's network stack directly. Wrapping a
  // long upload or restore in respondWith(fetch(...)) makes it subject to the
  // service worker fetch-event deadline (five minutes in Chromium).
  if (event.request.method !== 'GET' || !privateResource) return
  event.respondWith(fetch(event.request, { cache: 'no-store' }))
})

self.addEventListener('notificationclick', (event) => {
  if (!event.notification.tag.startsWith('aivory-reply:')) return
  const target = event.notification.data?.target
  event.notification.close()
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Return to an existing app session; its account and workspace checks own navigation.
    const client = clients.find((item) => item.id === event.notification.data?.clientId)
    if (!client) return
    await client.focus()
    client.postMessage({ type: 'aivory:reply-notification-click', target })
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'aivory:notification-client-id') {
    event.ports[0]?.postMessage(event.source?.id)
  }
})

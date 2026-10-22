import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function worker() {
  const listeners = new Map<string, (event: unknown) => void>()
  const clients = { matchAll: vi.fn() }
  vm.runInNewContext(readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback), clients },
  })
  return { listeners, clients }
}

describe('reply notification service worker', () => {
  it('identifies the originating client for mobile browser notifications', () => {
    const { listeners } = worker()
    const postMessage = vi.fn()
    listeners.get('message')!({ data: { type: 'aivory:notification-client-id' }, source: { id: 'original-tab' }, ports: [{ postMessage }] })
    expect(postMessage).toHaveBeenCalledWith('original-tab')
  })

  it('focuses only the originating tab and forwards the target to its account checks', async () => {
    const { listeners, clients } = worker()
    const original = { id: 'original-tab', focus: vi.fn(async () => {}), postMessage: vi.fn() }
    const unrelated = { id: 'other-tab', focus: vi.fn(), postMessage: vi.fn() }
    clients.matchAll.mockResolvedValue([unrelated, original])
    const target = { userId: 'user-a', conversationId: 'chat-a', workspaceId: null }
    let pending!: Promise<void>
    const close = vi.fn()
    listeners.get('notificationclick')!({
      notification: { tag: 'aivory-reply:reply-a', data: { clientId: original.id, target }, close },
      waitUntil: (promise: Promise<void>) => { pending = promise },
    })
    await pending
    expect(close).toHaveBeenCalledOnce()
    expect(original.focus).toHaveBeenCalledOnce()
    expect(original.postMessage).toHaveBeenCalledWith({ type: 'aivory:reply-notification-click', target })
    expect(unrelated.focus).not.toHaveBeenCalled()
  })

  it('does not open or focus another account tab when the source tab has closed', async () => {
    const { listeners, clients } = worker()
    const other = { id: 'other-tab', focus: vi.fn(), postMessage: vi.fn() }
    clients.matchAll.mockResolvedValue([other])
    let pending!: Promise<void>
    listeners.get('notificationclick')!({
      notification: { tag: 'aivory-reply:reply-a', data: { clientId: 'closed-tab' }, close: vi.fn() },
      waitUntil: (promise: Promise<void>) => { pending = promise },
    })
    await pending
    expect(other.focus).not.toHaveBeenCalled()
    expect(other.postMessage).not.toHaveBeenCalled()
  })
})

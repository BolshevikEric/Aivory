// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message } from '@/types/chat'

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/store/auth', async () => {
  const { create } = await import('zustand')
  return { useAuth: create(() => ({ user: { id: 'user-a' } as { id: string } | null })) }
})
vi.mock('@/store/workspaces', async () => {
  const { create } = await import('zustand')
  const useWorkspaces = create(() => ({ activeId: null as string | null, switchTo: vi.fn(async (id: string | null) => {
    useWorkspaces.setState({ activeId: id })
  }) }))
  return { useWorkspaces }
})

import { useAuth } from '@/store/auth'
import { useWorkspaces } from '@/store/workspaces'
import { useReplyNotificationPreferences } from '@/store/reply-notification-preferences'
import { isReplyNotificationTarget, publishPrivateReplyCompleted, publishReplyCompleted, replyNotificationPermission, startReplyNotifications } from '@/lib/reply-notifications'

const notices: FakeNotification[] = []
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  onclick: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn(() => this.onclose?.())
  constructor(public title: string, public options: NotificationOptions) { notices.push(this) }
}
const conversation = { id: 'chat-a', title: 'Private conversation title', messages: [], createdAt: 1, updatedAt: 1, modelId: 'm' } satisfies Conversation
const message = { id: 'reply-a', role: 'assistant', content: 'Private answer', createdAt: 1, streaming: false } satisfies Message
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
let stop: (() => void) | undefined
const navigate = vi.fn()

beforeEach(() => {
  localStorage.clear()
  useAuth.setState({ user: { id: 'user-a' } as never })
  useWorkspaces.setState({ activeId: null })
  useReplyNotificationPreferences.setState({ accounts: {} })
  FakeNotification.permission = 'granted'
  notices.length = 0
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('isSecureContext', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  vi.spyOn(window, 'focus').mockImplementation(() => {})
  navigate.mockClear()
  FakeNotification.requestPermission.mockClear()
  stop = startReplyNotifications(navigate)
})
afterEach(() => { stop?.(); delete window.aivoryDesktop; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const enable = () => useReplyNotificationPreferences.getState().setEnabled('user-a', true)

describe('reply completion notifications', () => {
  it('starts on HTTP origins without native UUID support and keeps notifications unsupported', async () => {
    stop?.()
    const getRandomValues = crypto.getRandomValues.bind(crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    vi.stubGlobal('isSecureContext', false)

    stop = startReplyNotifications(navigate)
    enable()
    publishReplyCompleted(conversation, message)
    await flush()

    expect(await replyNotificationPermission(true)).toBe('unsupported')
    expect(notices).toHaveLength(0)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })

  it('defaults off, persists per account, and never requests permission on delivery', async () => {
    publishReplyCompleted(conversation, message)
    await flush()
    expect(notices).toHaveLength(0)
    enable()
    expect(JSON.parse(localStorage.getItem('aivory.reply-notification-preferences')!)).toEqual({ 'user-a': true })
    publishReplyCompleted(conversation, { ...message, id: 'reply-b' })
    await flush()
    expect(notices).toHaveLength(1)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(notices[0].options.body).not.toContain('Private')
  })

  it('only requests browser permission on explicit enable, and handles denial and unsupported contexts', async () => {
    FakeNotification.permission = 'default'
    expect(await replyNotificationPermission()).toBe('default')
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    await replyNotificationPermission(true)
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce()
    FakeNotification.permission = 'denied'
    expect(await replyNotificationPermission(true)).toBe('denied')
    vi.stubGlobal('isSecureContext', false)
    expect(await replyNotificationPermission(true)).toBe('unsupported')
  })

  it('suppresses foreground replies and does not replay them after leaving the tab', async () => {
    enable()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    publishReplyCompleted(conversation, message)
    await flush()
    expect(notices).toHaveLength(0)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    publishReplyCompleted(conversation, message)
    await flush()
    expect(notices).toHaveLength(0)
  })

  it.each([
    { stopped: true }, { error: 'failed' }, { errorCode: 'generation_interrupted' },
    { moderation: true }, { quotaExceeded: true }, { streaming: true }, { content: '' },
  ])('does not notify incomplete or unsuccessful replies: %s', async (patch) => {
    enable()
    publishReplyCompleted(conversation, { ...message, ...patch })
    await flush()
    expect(notices).toHaveLength(0)
  })

  it('notifies artifact-only replies once, including after service restart', async () => {
    enable()
    const imageReply = { ...message, content: '', artifacts: [{ id: 'a', filename: 'image.png', url: '/image', mimeType: 'image/png' }] }
    publishReplyCompleted(conversation, imageReply)
    publishReplyCompleted(conversation, imageReply)
    await flush()
    expect(notices).toHaveLength(1)
    stop?.()
    stop = startReplyNotifications(navigate)
    publishReplyCompleted(conversation, imageReply)
    await flush()
    expect(notices).toHaveLength(1)
  })

  it('switches workspace on click, and closes notifications on disable or logout', async () => {
    enable()
    publishReplyCompleted({ ...conversation, workspaceId: 'space-a' }, message)
    await flush()
    notices[0].onclick?.()
    await flush()
    expect(useWorkspaces.getState().activeId).toBe('space-a')
    expect(navigate).toHaveBeenCalledWith('/chat/chat-a')
    publishReplyCompleted(conversation, { ...message, id: 'reply-b' })
    await flush()
    useReplyNotificationPreferences.getState().setEnabled('user-a', false)
    expect(notices[1].close).toHaveBeenCalled()
    notices[1].onclick?.()
    expect(navigate).toHaveBeenCalledTimes(1)
    enable()
    publishReplyCompleted(conversation, { ...message, id: 'reply-c' })
    await flush()
    useAuth.setState({ user: null })
    expect(notices[2].close).toHaveBeenCalled()
    notices[2].onclick?.()
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('uses only the native bridge in desktop apps and rejects stale account clicks', async () => {
    const showReplyNotification = vi.fn(async () => true)
    window.aivoryDesktop = { showReplyNotification, clearReplyNotifications: vi.fn(async () => {}),
      replyNotificationsSupported: vi.fn(async () => true) } as unknown as NonNullable<Window['aivoryDesktop']>
    enable()
    publishReplyCompleted(conversation, message)
    await flush()
    expect(showReplyNotification).toHaveBeenCalledOnce()
    expect(notices).toHaveLength(0)
    expect(await replyNotificationPermission(true)).toBe('granted')
    useAuth.setState({ user: { id: 'user-b' } as never })
    window.dispatchEvent(new CustomEvent('aivory:desktop-reply-notification', { detail: { userId: 'user-a', conversationId: 'chat-a', workspaceId: null } }))
    await flush()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('invalidates pending deliveries when returning to the foreground or signing out', async () => {
    enable()
    let resume!: () => void
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => Promise<void>) => {
      await new Promise<void>((resolve) => { resume = resolve })
      await callback()
    } } })
    publishReplyCompleted(conversation, message)
    useAuth.setState({ user: null })
    resume()
    await flush()
    expect(notices).toHaveLength(0)
  })

  it('validates click targets', () => {
    expect(isReplyNotificationTarget({ userId: 'u', conversationId: 'c', workspaceId: null })).toBe(true)
    for (const conversationId of ['https://evil.test', '../admin', 'a/b', '']) {
      expect(isReplyNotificationTarget({ userId: 'u', conversationId, workspaceId: null })).toBe(false)
    }
  })

  it('uses the private conversation route without exposing its content', async () => {
    enable()
    publishPrivateReplyCompleted(null, 'private-reply-a')
    await flush()
    expect(notices).toHaveLength(1)
    notices[0].onclick?.()
    await flush()
    expect(navigate).toHaveBeenCalledWith('/private-chat')
  })

  it('uses service worker notifications on mobile and scopes cleanup to its own deliveries', async () => {
    enable()
    const delivered: { tag: string; data: unknown; close: ReturnType<typeof vi.fn> }[] = []
    const unrelated = { tag: 'aivory-reply:other', data: { owner: 'other-tab', epoch: 0 }, close: vi.fn() }
    const worker = {
      active: { postMessage: (_message: unknown, ports: MessagePort[]) => ports[0].postMessage('tab-a') },
      getNotifications: vi.fn(async () => [...delivered, unrelated]),
      showNotification: vi.fn(async (_title: string, options: NotificationOptions) => {
        delivered.push({ tag: options.tag!, data: options.data, close: vi.fn() })
      }),
    }
    vi.stubGlobal('navigator', { serviceWorker: {
      getRegistration: vi.fn(async () => worker), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } })
    publishReplyCompleted(conversation, message)
    await vi.waitFor(() => expect(worker.showNotification).toHaveBeenCalledOnce())
    expect(worker.showNotification.mock.calls[0][1].data).toMatchObject({ clientId: 'tab-a', target: { conversationId: 'chat-a' } })
    expect(notices).toHaveLength(0)
    useReplyNotificationPreferences.getState().setEnabled('user-a', false)
    await flush()
    expect(delivered[0].close).toHaveBeenCalledOnce()
    expect(unrelated.close).not.toHaveBeenCalled()
  })
})

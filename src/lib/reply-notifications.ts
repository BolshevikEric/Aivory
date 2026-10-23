import '@/lib/desktop'
import i18n from '@/i18n'
import { randomUUID } from '@/lib/random-uuid'
import { useAuth } from '@/store/auth'
import { useWorkspaces } from '@/store/workspaces'
import { useReplyNotificationPreferences } from '@/store/reply-notification-preferences'
import type { Conversation, Message } from '@/types/chat'

export interface ReplyNotificationTarget {
  userId: string
  conversationId: string
  workspaceId: string | null
  privateChat?: boolean
}

export type ReplyNotificationPermission = NotificationPermission | 'unsupported' | 'desktop-update'
const listeners = new Set<(target: ReplyNotificationTarget, messageId: string) => void>()
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)

export function isReplyNotificationTarget(value: unknown): value is ReplyNotificationTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as ReplyNotificationTarget
  return validId(target.userId) && validId(target.conversationId) && (target.workspaceId === null || validId(target.workspaceId)) &&
    (target.privateChat === undefined || typeof target.privateChat === 'boolean')
}

/** Only terminal stream events publish here; history hydration never sends notifications. */
export function publishReplyCompleted(conversation: Conversation | undefined, message: Message | undefined) {
  const userId = useAuth.getState().user?.id
  if (!userId || !conversation || !message || message.role !== 'assistant' || message.streaming ||
    message.stopped || message.error || message.errorCode || message.moderation || message.quotaExceeded ||
    (!message.content.trim() && !message.artifacts?.length)) return
  const target = { userId, conversationId: conversation.id, workspaceId: conversation.workspaceId ?? null }
  if (!isReplyNotificationTarget(target)) return
  for (const listener of listeners) listener(target, message.id)
}

export function publishPrivateReplyCompleted(workspaceId: string | null, messageId: string) {
  const userId = useAuth.getState().user?.id
  if (!userId) return
  const target = { userId, conversationId: 'private-chat', workspaceId, privateChat: true }
  for (const listener of listeners) listener(target, messageId)
}

function workerClientId(worker: ServiceWorker): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const finish = (id?: string) => { clearTimeout(timeout); channel.port1.close(); resolve(id) }
    const timeout = setTimeout(() => finish(), 1000)
    channel.port1.onmessage = (event) => finish(typeof event.data === 'string' ? event.data : undefined)
    worker.postMessage({ type: 'aivory:notification-client-id' }, [channel.port2])
  })
}

export async function replyNotificationPermission(request = false): Promise<ReplyNotificationPermission> {
  if (window.aivoryDesktop) {
    if (!window.aivoryDesktop.replyNotificationsSupported) return 'desktop-update'
    try { return await window.aivoryDesktop.replyNotificationsSupported() ? 'granted' : 'unsupported' }
    catch { return 'unsupported' }
  }
  if (!window.isSecureContext || !('Notification' in window)) return 'unsupported'
  try {
    if (request && Notification.permission === 'default') return await Notification.requestPermission()
    return Notification.permission
  } catch { return 'denied' }
}

export function startReplyNotifications(navigate: (path: string) => void) {
  const owner = randomUUID()
  const active = new Set<Notification>()
  const seen = new Set<string>()
  let disposed = false
  let epoch = 0
  let accountEpoch = 0
  const enabled = (target: ReplyNotificationTarget) => !disposed &&
    useAuth.getState().user?.id === target.userId &&
    useReplyNotificationPreferences.getState().accounts[target.userId] === true
  const away = () => document.visibilityState !== 'visible' || !document.hasFocus()
  const registration = async () => {
    try { return 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined }
    catch { return undefined }
  }
  const clear = () => {
    const clearEpoch = ++epoch
    for (const notification of active) notification.close()
    active.clear()
    void window.aivoryDesktop?.clearReplyNotifications?.().catch(() => {})
    void registration().then(async (worker) => {
      const notifications = await worker?.getNotifications()
      notifications?.filter((item) => item.tag.startsWith('aivory-reply:') &&
        item.data?.owner === owner && item.data?.epoch < clearEpoch).forEach((item) => item.close())
    }).catch(() => {})
  }
  const open = async (target: ReplyNotificationTarget) => {
    if (!enabled(target)) return
    const currentEpoch = accountEpoch
    if (useWorkspaces.getState().activeId !== target.workspaceId) {
      await useWorkspaces.getState().switchTo(target.workspaceId)
    }
    if (!enabled(target) || currentEpoch !== accountEpoch || useWorkspaces.getState().activeId !== target.workspaceId) return
    navigate(target.privateChat ? '/private-chat' : `/chat/${encodeURIComponent(target.conversationId)}`)
  }
  const receiveClick = (event: Event) => {
    const target: unknown = (event as CustomEvent).detail
    if (isReplyNotificationTarget(target)) void open(target).catch(() => {})
  }
  const receiveWorkerClick = (event: MessageEvent) => {
    if (event.data?.type === 'aivory:reply-notification-click' && isReplyNotificationTarget(event.data.target)) {
      void open(event.data.target).catch(() => {})
    }
  }
  const foreground = () => { if (!away()) clear() }

  const deliver = async (target: ReplyNotificationTarget, messageId: string) => {
    const key = `${target.userId}:${target.conversationId}:${messageId}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 256) seen.delete(seen.values().next().value!)
    if (!enabled(target) || (!window.aivoryDesktop && !away())) return
    const deliveryEpoch = epoch
    const current = () => enabled(target) && epoch === deliveryEpoch
    const show = async () => {
      if (!current()) return
      const storageKey = `aivory.reply-notifications.delivered:${target.userId}`
      let delivered: string[] = []
      try {
        const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]')
        if (Array.isArray(value)) delivered = value.filter((item): item is string => typeof item === 'string').slice(-128)
      } catch { /* In-memory deduplication still applies. */ }
      if (delivered.includes(key)) return
      const title = i18n.t('settings:notifications.readyTitle')
      const body = i18n.t('settings:notifications.readyBody')
      let shown = false
      if (window.aivoryDesktop) {
        shown = await window.aivoryDesktop.showReplyNotification?.({ ...target, messageId, title, body }) ?? false
      } else {
        if (await replyNotificationPermission() !== 'granted' || !current() || !away()) return
        const tag = `aivory-reply:${key}`
        // Service-worker notifications also work in mobile browsers where the constructor is unavailable.
        const worker = await registration()
        if (!current() || !away()) return
        if (worker?.active) {
          const clientId = await workerClientId(worker.active)
          if (!current() || !away()) return
          await worker.showNotification(title, { body, tag, data: { target, clientId, owner, epoch: deliveryEpoch }, icon: '/icon-192.png' })
          if (!current() || !away()) { clear(); return }
        } else {
          const notification = new Notification(title, { body, tag })
          active.add(notification)
          notification.onclose = () => active.delete(notification)
          notification.onclick = () => {
            notification.close()
            window.focus()
            void open(target).catch(() => {})
          }
        }
        shown = true
      }
      if (shown) {
        try { localStorage.setItem(storageKey, JSON.stringify([...delivered, key].slice(-128))) } catch { /* Best effort. */ }
      }
    }
    try {
      if (navigator.locks) await navigator.locks.request('aivory-reply-notification', show)
      else await show()
    } catch { /* Notification delivery must never interrupt a completed reply. */ }
  }
  const listener = (target: ReplyNotificationTarget, messageId: string) => { void deliver(target, messageId) }
  listeners.add(listener)
  const unsubscribeAuth = useAuth.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) { accountEpoch++; clear(); seen.clear() }
  })
  const unsubscribePreferences = useReplyNotificationPreferences.subscribe(() => {
    const userId = useAuth.getState().user?.id
    if (!userId || !useReplyNotificationPreferences.getState().accounts[userId]) { accountEpoch++; clear() }
  })
  window.addEventListener('focus', foreground)
  document.addEventListener('visibilitychange', foreground)
  window.addEventListener('aivory:desktop-reply-notification', receiveClick)
  navigator.serviceWorker?.addEventListener('message', receiveWorkerClick)
  return () => {
    disposed = true
    clear()
    listeners.delete(listener)
    unsubscribeAuth()
    unsubscribePreferences()
    window.removeEventListener('focus', foreground)
    document.removeEventListener('visibilitychange', foreground)
    window.removeEventListener('aivory:desktop-reply-notification', receiveClick)
    navigator.serviceWorker?.removeEventListener('message', receiveWorkerClick)
  }
}

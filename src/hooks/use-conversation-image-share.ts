import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { captureAccountRequestGuard } from '@/api/client'
import { useAuth } from '@/store/auth'
import { useConversations } from '@/store/conversations'
import { useWorkspaces } from '@/store/workspaces'
import type { Conversation, Message } from '@/types/chat'
import type { ConversationImagePage } from '@/lib/conversation-image'

export interface ConversationImagePreview extends ConversationImagePage { url: string }
export interface MessageImageSelection {
  selected: ReadonlySet<string>
  toggle: (id: string) => void
  disabled: boolean
}

const selectable = (message: Message) => message.role !== 'system' && !message.streaming && !message.localOnly

export function useConversationImageShare(conversation: Conversation | undefined, allowed: boolean, scrollRef: RefObject<HTMLDivElement | null>) {
  const { t } = useTranslation('chat')
  const accountId = useAuth(state => state.user?.id ?? null)
  const workspaceId = useWorkspaces(state => state.activeId)
  const switching = useWorkspaces(state => state.switching)
  const [phase, setPhase] = useState<'idle' | 'selecting' | 'preview'>('idle')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pages, setPages] = useState<ConversationImagePreview[]>([])
  const previews = useRef<ConversationImagePreview[]>([])
  const epoch = useRef(0)
  const working = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const scope = useRef('')
  scope.current = `${accountId}:${workspaceId}:${conversation?.id}:${allowed}:${switching}`
  const conversationId = conversation?.id

  const dispose = useCallback(() => {
    abort.current?.abort()
    abort.current = null
    epoch.current++
    working.current = false
    previews.current.forEach(page => URL.revokeObjectURL(page.url))
    previews.current = []
  }, [])
  const cancel = useCallback(() => {
    dispose()
    setPages([])
    setSelected(new Set())
    setBusy(false)
    setError('')
    setPhase('idle')
  }, [dispose])
  useEffect(() => {
    cancel()
  }, [accountId, workspaceId, conversationId, allowed, switching, cancel])
  useEffect(() => dispose, [dispose])

  const begin = useCallback(() => {
    if (!allowed || switching || !conversation) return
    cancel()
    setPhase('selecting')
  }, [allowed, switching, conversation, cancel])
  const toggle = useCallback((id: string) => {
    if (working.current) return
    setError('')
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  useEffect(() => {
    if (phase !== 'selecting') return
    const ids = new Set(conversation?.messages.filter(selectable).map(message => message.id))
    setSelected(current => Array.from(current).some(id => !ids.has(id)) ? new Set(Array.from(current).filter(id => ids.has(id))) : current)
  }, [conversation?.messages, phase])
  useEffect(() => {
    if (phase !== 'selecting') return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [phase, cancel])

  async function selectAll() {
    if (working.current || !conversation || !allowed) return
    const token = ++epoch.current, currentScope = scope.current
    const accountGuard = captureAccountRequestGuard()
    working.current = true
    setBusy(true)
    setError('')
    try {
      if (conversation.hasOlder) await useConversations.getState().loadOne(conversation.id, { full: true })
      if (token !== epoch.current || scope.current !== currentScope || !accountGuard()) return
      const latest = useConversations.getState().conversations.find(item => item.id === conversation.id)
      if (!latest || latest.hasOlder) throw new Error('could not load all messages')
      setSelected(new Set(latest.messages.filter(selectable).map(message => message.id)))
    } catch {
      if (token === epoch.current && scope.current === currentScope && accountGuard()) setError(t('shareImage.loadFailed'))
    } finally {
      if (token === epoch.current) { working.current = false; setBusy(false) }
    }
  }

  async function generate() {
    if (working.current || !allowed || !conversation || !selected.size || !scrollRef.current) return
    const token = ++epoch.current, currentScope = scope.current
    const accountGuard = captureAccountRequestGuard()
    const chosen = conversation.messages.filter(message => selected.has(message.id) && selectable(message))
    const signature = JSON.stringify(chosen.map(message => [message.id, message.content, message.artifacts, message.attachments]))
    const controller = new AbortController()
    const assertActive = () => {
      const latest = useConversations.getState()
      const current = latest.conversations.find(item => item.id === conversation.id)
      if (controller.signal.aborted || token !== epoch.current || scope.current !== currentScope || !accountGuard() || latest.accountId !== accountId || !current ||
        JSON.stringify(current.messages.filter(message => selected.has(message.id) && selectable(message)).map(message => [message.id, message.content, message.artifacts, message.attachments])) !== signature) throw new DOMException('Conversation changed', 'AbortError')
    }
    working.current = true
    setBusy(true)
    setError('')
    const deadline = window.setTimeout(() => controller.abort(), 60_000)
    try {
      assertActive()
      abort.current = controller
      const sources = chosen.map(message => {
        const node = scrollRef.current!.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`)
        if (!node) throw new Error('selected message is not rendered')
        return { id: message.id, node }
      })
      const { createConversationImages } = await import('@/lib/conversation-image')
      const images = await createConversationImages({
        title: conversation.title || t('share.untitled'), messages: sources, assertActive,
        signal: controller.signal,
        interactiveLabel: t('shareImage.interactive'), pageLabel: (page, total) => t('shareImage.page', { page, total }),
      })
      assertActive()
      previews.current.forEach(page => URL.revokeObjectURL(page.url))
      previews.current = images.map(image => ({ ...image, url: URL.createObjectURL(image.blob) }))
      setPages(previews.current)
      setPhase('preview')
    } catch (error) {
      if (token === epoch.current && scope.current === currentScope && accountGuard()) setError(t(error instanceof Error && error.message === 'image selection too large' ? 'shareImage.tooLarge' : 'shareImage.failed'))
    } finally {
      window.clearTimeout(deadline)
      if (token === epoch.current) { working.current = false; setBusy(false) }
    }
  }

  return {
    phase, selected, busy, error, pages, begin, toggle, selectAll, generate, cancel,
    clear: () => { if (!working.current) setSelected(new Set()) },
    back: () => { if (allowed) setPhase('selecting') },
  }
}

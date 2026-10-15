import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { captureAccountRequestGuard } from '@/api/client'
import { useAuth } from '@/store/auth'
import { useConversations } from '@/store/conversations'
import { useWorkspaces } from '@/store/workspaces'
import type { Conversation } from '@/types/chat'
import { createConversationShareSnapshot, createConversationTextFile, isShareableMessage, type ConversationShareFormat, type ConversationShareQuality, type ConversationShareFile } from '@/lib/conversation-share'

export interface ConversationSharePreview extends ConversationShareFile { url: string }
export interface MessageShareSelection {
  selected: ReadonlySet<string>
  toggle: (id: string) => void
  disabled: boolean
}

const selectable = isShareableMessage

export function useConversationShare(conversation: Conversation | undefined, allowed: boolean) {
  const { t, i18n } = useTranslation('chat')
  const accountId = useAuth(state => state.user?.id ?? null)
  const workspaceId = useWorkspaces(state => state.activeId)
  const switching = useWorkspaces(state => state.switching)
  const [phase, setPhase] = useState<'idle' | 'selecting' | 'preview'>('idle')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<ConversationShareFormat>('image')
  const [quality, setQuality] = useState<ConversationShareQuality>('standard')
  const [stage, setStage] = useState('preparing')
  const cache = useRef(new Map<string, ConversationShareFile>())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pages, setPages] = useState<ConversationSharePreview[]>([])
  const previews = useRef<ConversationSharePreview[]>([])
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
    cache.current.clear()
    cancel()
  }, [accountId, workspaceId, conversationId, allowed, switching, cancel])
  useEffect(() => dispose, [dispose])

  const begin = useCallback((nextFormat: ConversationShareFormat = 'image') => {
    if (!allowed || switching || !conversation) return
    cancel()
    setFormat(nextFormat)
    if (nextFormat === 'image' || nextFormat === 'pdf') void import('@/lib/conversation-image').catch(() => {})
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
    if (working.current || !allowed || !conversation || !selected.size) return
    const token = ++epoch.current, currentScope = scope.current
    const accountGuard = captureAccountRequestGuard()
    const chosen = conversation.messages.filter(message => selected.has(message.id) && selectable(message))
    if (!chosen.length) return
    const snapshot = createConversationShareSnapshot(conversation, selected)
    // Compare only exported data and image references, avoiding large private reasoning/tool fields.
    const signatureOf = (current: Conversation) => {
      const messages = current.messages.filter(message => selected.has(message.id) && selectable(message))
      if (!messages.length) return ''
      return JSON.stringify([createConversationShareSnapshot(current, selected, new Date(0)), messages.map(message => message.attachments?.map(item => item.previewUrl))])
    }
    const signature = signatureOf(conversation)
    const cacheKey = JSON.stringify([scope.current, signature, format, quality, i18n.resolvedLanguage, document.documentElement.dataset.theme, document.documentElement.className, document.documentElement.dataset.accent])
    const labels = { user: t('shareFile.user'), assistant: t('assistant'), attachments: t('shareFile.attachments'), citations: t('shareFile.citations'), interactive: t('shareImage.interactive'), resourceFailed: t('shareFile.resourceFailed') }
    const controller = new AbortController()
    const assertActive = () => {
      const latest = useConversations.getState()
      const current = latest.conversations.find(item => item.id === conversation.id)
      if (controller.signal.aborted || token !== epoch.current || scope.current !== currentScope || !accountGuard() || latest.accountId !== accountId || !current ||
        signatureOf(current) !== signature) throw new DOMException('Conversation changed', 'AbortError')
    }
    working.current = true
    setBusy(true)
    setError('')
    setStage('preparing')
    const deadline = window.setTimeout(() => controller.abort(), 60_000)
    try {
      assertActive()
      abort.current = controller
      let file = cache.current.get(cacheKey)
      if (!file) {
        if (format === 'json' || format === 'txt') file = createConversationTextFile(snapshot, format, labels)
        else if (format === 'pdf') {
          setStage('rendering')
          const { createConversationPDF } = await import('@/lib/conversation-pdf')
          file = await createConversationPDF({ conversationId: conversation.id, snapshot, originals: chosen, labels, assertActive, signal: controller.signal })
        } else {
          const { renderConversationShareMessages } = await import('@/lib/conversation-share-document')
          const nodes = renderConversationShareMessages(snapshot, chosen, labels)
          const { createConversationImages } = await import('@/lib/conversation-image')
          const images = await createConversationImages({ title: snapshot.title || t('share.untitled'), messages: nodes.map((node, index) => ({ id: chosen[index].id, node })), assertActive, signal: controller.signal, interactiveLabel: labels.interactive, resourceFailedLabel: labels.resourceFailed, quality, onProgress: setStage })
          file = images[0]
        }
        assertActive()
        if (file.blob.size <= 24 * 1024 * 1024) {
          if (cache.current.size >= 2) cache.current.delete(cache.current.keys().next().value!)
          cache.current.set(cacheKey, file)
        }
      }
      assertActive()
      previews.current.forEach(page => URL.revokeObjectURL(page.url))
      previews.current = [{ ...file, url: URL.createObjectURL(file.blob) }]
      setPages(previews.current)
      setPhase('preview')
    } catch (error) {
      if (token === epoch.current && scope.current === currentScope && accountGuard()) setError(t(error instanceof Error && error.message === 'image selection too large' ? 'shareImage.tooLarge' : error instanceof Error && error.message === 'pdf_renderer_unavailable' ? 'shareFile.pdfUnavailable' : controller.signal.aborted ? 'shareFile.timeout' : format === 'image' ? 'shareImage.failed' : 'shareFile.failed'))
    } finally {
      window.clearTimeout(deadline)
      if (token === epoch.current) { working.current = false; setBusy(false) }
    }
  }

  return {
    phase, selected, busy, error, pages, begin, toggle, selectAll, generate, cancel, format, quality, stage,
    setFormat: (value: ConversationShareFormat) => { if (!working.current) { setFormat(value); setError(''); setPhase('selecting') } },
    setQuality: (value: ConversationShareQuality) => { if (!working.current) setQuality(value) },
    clear: () => { if (!working.current) setSelected(new Set()) },
    back: () => { if (allowed) setPhase('selecting') },
  }
}

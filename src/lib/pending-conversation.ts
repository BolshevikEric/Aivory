import { ApiError, conversationsApi } from '@/api'
import type { ApiConversation } from '@/api/types'
import i18n from '@/i18n'
import { useAuth } from '@/store/auth'

const PREFIX = 'aivory:pending-conversation:v1'
const pendingScopeOperations = new Map<string, Promise<unknown>>()

// Resolve lazily because the conversation store also imports the draft error
// helpers. Update history immediately without waiting for a realtime echo.
async function syncDraftHistory(userId: string, deletedIds: string[], conversation?: ApiConversation): Promise<void> {
  const { useConversations } = await import('@/store/conversations')
  if (useAuth.getState().user?.id !== userId) return
  const deleted = new Set(deletedIds)
  useConversations.setState((state) => ({
    conversations: state.conversations.filter((row) => !deleted.has(row.id) && !(
      conversation && row.id !== conversation.id && row.creatorId === userId && row.isDraft && row.messages.length === 0
    )),
  }))
  if (conversation && !useConversations.getState().conversations.find((row) => row.id === conversation.id)?.messages.length) {
    useConversations.getState().adoptConversation(conversation)
  }
}

/** Keep page switches and reservations ordered; rapid navigation cannot issue a stale create last. */
function serializeDraftScope<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingScopeOperations.get(userId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  pendingScopeOperations.set(userId, next)
  void next.finally(() => {
    if (pendingScopeOperations.get(userId) === next) pendingScopeOperations.delete(userId)
  }).catch(() => {})
  return next
}

function clearDeletedPendingConversations(userId: string, ids: string[]): void {
  if (ids.length === 0) return
  const deleted = new Set(ids)
  try {
    const keys = Object.keys(window.localStorage)
    for (const key of keys) {
      if (key.startsWith(`${PREFIX}:${userId}:`) && deleted.has(window.localStorage.getItem(key) || '')) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    // A stale local id is harmless: ownership and draft checks remain server-side.
  }
}

export function pendingConversationKey(userId: string | undefined, scope: string, workspaceId?: string): string {
  return [PREFIX, userId || 'anonymous', workspaceId || 'personal', scope].join(':')
}

export function readPendingConversation(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) || undefined
  } catch {
    return undefined
  }
}

export function writePendingConversation(key: string, conversationId: string): void {
  try {
    window.localStorage.setItem(key, conversationId)
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // Server-side drafts remain recoverable through history and scope lookup.
  }
}

export function clearPendingConversation(key: string, expectedId?: string): void {
  try {
    if (expectedId && window.localStorage.getItem(key) !== expectedId) return
    window.localStorage.removeItem(key)
  } catch {
    // Best effort; ownership checks make a stale id harmless on the next load.
  }
}

interface PendingScope {
  userId?: string
  workspaceId?: string
  projectId?: string
  scope: 'chat' | 'draw'
}

function matchesPendingScope(conversation: ApiConversation, scope: PendingScope): boolean {
  return conversation.user_id === scope.userId &&
    (conversation.workspace_id || '') === (scope.workspaceId || '') &&
    (conversation.project_id || '') === (scope.projectId || '') &&
    !conversation.title.trim() && !conversation.pinned && !conversation.starred && !conversation.archived &&
    !conversation.inline_source_conv
}

/** A scope switch silently discards only existing drafts in other scopes and never creates one. */
export async function recoverPendingConversation(
  key: string,
  scope: PendingScope,
  isCurrent: () => boolean = () => true,
): Promise<ApiConversation | undefined> {
  if (!scope.userId) return undefined
  const userId = scope.userId
  const selection = await serializeDraftScope(userId, async () => {
    if (!isCurrent()) return undefined
    const result = await conversationsApi.switchDraftScope({
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      draft_scope: scope.scope,
    })
    clearDeletedPendingConversations(userId, result.deleted_ids)
    await syncDraftHistory(userId, result.deleted_ids)
    return result
  })
  if (!selection) return undefined
  const savedId = readPendingConversation(key)
  if (savedId) {
    try {
      const loaded = await conversationsApi.get(savedId, { limit: 1 })
      const conversation = loaded.conversation
      if (loaded.messages.length === 0 && matchesPendingScope(conversation, scope)) {
        if (isCurrent()) await syncDraftHistory(userId, [], conversation)
        return conversation
      }
    } catch (error) {
      // A temporary disconnect/500 must retain the recovery id for retry.
      if (!(error instanceof ApiError) || error.status !== 404) throw error
    }
    clearPendingConversation(key, savedId)
  }
  const conversation = selection.conversation
  if (!conversation || !matchesPendingScope(conversation, scope)) return undefined
  // A concurrent first send may have committed since the scope switch.
  // Never adopt a saved conversation as an upload reservation.
  try {
    const loaded = await conversationsApi.get(conversation.id, { limit: 1 })
    if (loaded.messages.length > 0 || !matchesPendingScope(loaded.conversation, scope)) return undefined
    writePendingConversation(key, conversation.id)
    if (isCurrent()) await syncDraftHistory(userId, [], loaded.conversation)
    return loaded.conversation
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined
    throw error
  }
}

export async function reservePendingConversation(
  userId: string | undefined,
  body: { model_id?: string; workspace_id?: string; project_id?: string; fast?: boolean },
  isCurrent: () => boolean,
): Promise<ApiConversation | undefined> {
  if (!userId) return undefined
  return serializeDraftScope(userId, async () => {
    if (!isCurrent()) return undefined
    const conversation = await conversationsApi.create({ ...body, draft: true })
    if (isCurrent()) await syncDraftHistory(userId, [], conversation)
    return conversation
  })
}

/** Forget the id only after the explicit discard succeeds, so failures remain recoverable. */
export async function discardPendingConversation(key: string, id: string): Promise<void> {
  const userId = useAuth.getState().user?.id
  const savedId = readPendingConversation(key)
  if (!savedId || savedId === id) writePendingConversation(key, id)
  await conversationsApi.discardDraft(id)
  clearPendingConversation(key, id)
  if (userId) await syncDraftHistory(userId, [id])
}

export function isConversationDraftLimit(error: unknown): boolean {
  return error instanceof ApiError && typeof error.body === 'object' && error.body !== null &&
    'code' in error.body && error.body.code === 'conversation_draft_limit'
}

export function conversationDraftErrorMessage(error: unknown): string {
  if (isConversationDraftLimit(error)) {
    return i18n.t('chat:composer.draftLimitReached', {
      defaultValue: 'Each account can keep only one unsent conversation draft. Send or delete the existing draft before starting another.',
    })
  }
  return error instanceof Error ? error.message : i18n.t('common:common.error')
}

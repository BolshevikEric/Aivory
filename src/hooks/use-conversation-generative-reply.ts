import { useCallback } from 'react'
import { useAuth } from '@/store/auth'
import { resolveArmedTurnFlags, useConversations } from '@/store/conversations'
import { activeWorkspaceId, useWorkspaces } from '@/store/workspaces'
import type { Conversation } from '@/types/chat'
import type { GenerativeReplyHandler } from '@/components/chat/generative-reply'

/** Reply through the ordinary turn pipeline, preserving its limits, tools and billing. */
export function useConversationGenerativeReply(conversation: Conversation | undefined, readOnly: boolean, onAccepted?: () => void): GenerativeReplyHandler {
  const accountId = useAuth(state => state.user?.id)
  const conversationId = conversation?.id
  return useCallback(async (messageId, text) => {
    const state = useConversations.getState()
    const current = state.conversations.find(item => item.id === conversationId)
    const spaces = useWorkspaces.getState()
    const source = current?.messages.at(-1)
    if (readOnly || !accountId || useAuth.getState().user?.id !== accountId || state.accountId !== accountId ||
      !current || current.archived || spaces.switching || (current.workspaceId || '') !== (activeWorkspaceId() || '') ||
      (current.workspaceId && spaces.workspaces.find(space => space.id === current.workspaceId)?.role === 'guest') ||
      source?.id !== messageId || source.role !== 'assistant' || current.messages.some(message => message.streaming) || !text.trim()) return false

    const armed = resolveArmedTurnFlags(current.modelId, current.id)
    return new Promise<boolean>(resolve => {
      let accepted = false
      void state.sendMessage({
        conversationId: current.id,
        modelId: current.modelId,
        parentId: messageId,
        text,
        fast: current.fast,
        mode: current.fast ? undefined : armed.mode,
        verify: current.fast ? undefined : armed.verify,
        toolMode: current.fast ? 'enabled' : armed.toolMode,
        webSearch: current.fast ? undefined : armed.webSearch,
        selectedToolIds: armed.selectedToolIds,
        onAccepted: () => { accepted = true; onAccepted?.(); resolve(true) },
      }).then(() => { if (!accepted) resolve(false) }, () => resolve(false))
    })
  }, [accountId, conversationId, onAccepted, readOnly])
}

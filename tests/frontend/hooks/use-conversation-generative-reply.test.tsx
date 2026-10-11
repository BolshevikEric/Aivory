import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationGenerativeReply } from '@/hooks/use-conversation-generative-reply'
import type { GenerativeReplyHandler } from '@/components/chat/generative-reply'
import type { Conversation } from '@/types/chat'

interface SendInput { text: string; conversationId: string; onAccepted?: () => void }
const state = vi.hoisted(() => ({
  user: { id: 'user-a' },
  accountId: 'user-a',
  conversation: { id: 'conv', modelId: 'model', fast: false, archived: false, workspaceId: '', messages: [{ id: 'assistant', role: 'assistant', streaming: false }] },
  spaces: { activeId: '', switching: false, workspaces: [] as { id: string; role: string }[] },
  sendMessage: vi.fn<(input: SendInput) => Promise<void>>(),
  armed: { mode: 'deep-research', verify: true, toolMode: 'enabled', webSearch: undefined, selectedToolIds: ['search'], optimizeImagePrompt: false },
}))
vi.mock('@/store/auth', () => ({
  useAuth: Object.assign((selector: (value: { user: typeof state.user }) => unknown) => selector({ user: state.user }), { getState: () => ({ user: state.user }) }),
}))
vi.mock('@/store/conversations', () => ({
  useConversations: { getState: () => ({ accountId: state.accountId, conversations: [state.conversation], sendMessage: state.sendMessage }) },
  resolveArmedTurnFlags: () => state.armed,
}))
vi.mock('@/store/workspaces', () => ({ useWorkspaces: { getState: () => state.spaces }, activeWorkspaceId: () => state.spaces.activeId }))

function handler(readOnly = false): GenerativeReplyHandler {
  let reply: GenerativeReplyHandler | undefined
  function Probe() {
    reply = useConversationGenerativeReply(state.conversation as unknown as Conversation, readOnly)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return reply!
}

beforeEach(() => {
  state.user.id = 'user-a'
  state.accountId = 'user-a'
  state.conversation = { id: 'conv', modelId: 'model', fast: false, archived: false, workspaceId: '', messages: [{ id: 'assistant', role: 'assistant', streaming: false }] }
  state.spaces = { activeId: '', switching: false, workspaces: [] }
  state.sendMessage.mockReset()
  state.sendMessage.mockImplementation(async input => { input.onAccepted?.() })
})

describe('generative clarification reply transport', () => {
  it('uses the current model, branch and armed tool settings through normal send', async () => {
    expect(await handler()('assistant', 'My answers')).toBe(true)
    expect(state.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv', parentId: 'assistant', modelId: 'model', text: 'My answers',
      mode: 'deep-research', verify: true, toolMode: 'enabled', selectedToolIds: ['search'],
    }))
  })
  it('confirms acceptance without waiting for the entire model response', async () => {
    state.sendMessage.mockImplementation(input => { input.onAccepted?.(); return new Promise(() => {}) })
    expect(await handler()('assistant', 'My answers')).toBe(true)
  })
  it('preserves fast mode when answering a clarification', async () => {
    state.conversation.fast = true
    expect(await handler()('assistant', 'My answers')).toBe(true)
    expect(state.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ fast: true, mode: undefined, verify: undefined, toolMode: 'enabled' }))
  })
  it('rejects a callback captured before an account or workspace change', async () => {
    const reply = handler()
    state.user.id = 'user-b'
    state.accountId = 'user-b'
    expect(await reply('assistant', 'My answers')).toBe(false)
    state.user.id = state.accountId = 'user-a'
    state.spaces.activeId = 'other-space'
    expect(await reply('assistant', 'My answers')).toBe(false)
    expect(state.sendMessage).not.toHaveBeenCalled()
  })
  it('rejects historical questions, archived conversations, guests and active streams', async () => {
    expect(await handler(true)('assistant', 'My answers')).toBe(false)
    const reply = handler()
    expect(await reply('old-message', 'My answers')).toBe(false)
    state.conversation.archived = true
    expect(await reply('assistant', 'My answers')).toBe(false)
    state.conversation.archived = false
    state.conversation.messages[0].streaming = true
    expect(await reply('assistant', 'My answers')).toBe(false)
    state.conversation.messages[0].streaming = false
    state.conversation.workspaceId = state.spaces.activeId = 'workspace'
    state.spaces.workspaces = [{ id: 'workspace', role: 'guest' }]
    expect(await reply('assistant', 'My answers')).toBe(false)
    expect(state.sendMessage).not.toHaveBeenCalled()
  })
  it('does not mark a refused or failed turn as successfully sent', async () => {
    state.sendMessage.mockResolvedValue(undefined)
    expect(await handler()('assistant', 'My answers')).toBe(false)
    state.sendMessage.mockRejectedValue(new Error('network disconnected'))
    expect(await handler()('assistant', 'My answers')).toBe(false)
  })
})

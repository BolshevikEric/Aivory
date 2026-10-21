import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiMessage, ApiUser, ApiWorkspace, ApiWorkspacePolicy } from '@/api/types'
import type { Conversation, Message } from '@/types/chat'
import { DEFAULT_USER_PERMISSIONS } from '@/lib/user-permissions'
import { useAuth } from '@/store/auth'
import { useWorkspaces } from '@/store/workspaces'

const apiMocks = vi.hoisted(() => ({
  editMessage: vi.fn(),
}))

vi.mock('@/api', () => {
  class ApiError extends Error {
    status: number

    constructor(message: string, status = 500) {
      super(message)
      this.status = status
    }
  }

  return {
    ApiError,
    conversationsApi: {
      editMessage: apiMocks.editMessage,
    },
    streamSSE: vi.fn(),
    streamSSEGet: vi.fn(),
  }
})

vi.mock('@/hooks/use-toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    danger: vi.fn(),
    error: vi.fn(),
    custom: vi.fn(),
  },
}))

import { useConversations } from '@/store/conversations'

function feedbackMessage(
  id: string,
  role: Message['role'],
  parentId: string,
  content: string,
): Message {
  return {
    id,
    role,
    parentId,
    content,
    createdAt: 1_700_000_000_000,
    liked: false,
    disliked: true,
    feedbackReasons: ['incorrect_fact'],
    feedbackComment: 'Old feedback',
  }
}

function resetStore(messages: Message[]) {
  const conversation: Conversation = {
    id: 'conv_feedback_edit',
    title: 'Feedback edit',
    modelId: 'model_1',
    messages,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
  useConversations.setState({ conversations: [conversation] })
}

function editResponse(id: string, role: ApiMessage['role'], feedback: ApiMessage['feedback'] = ''): ApiMessage {
  return {
    id,
    conversation_id: 'conv_feedback_edit',
    parent_id: '',
    role,
    provider: 'openai',
    model_id: 'model_1',
    blocks: [],
    attachments: [],
    citations: [],
    stop_reason: '',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0,
    currency: 'USD',
    status: 'complete',
    error: '',
    feedback,
    feedback_reasons: [],
    feedback_comment: '',
    created_at: 1_700_000_000,
  }
}

describe('feedback invalidation after editing a message in place', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuth.setState({ user: null })
    useWorkspaces.setState({ workspaces: [], policies: {}, loaded: true, switching: false, policyLoading: {}, policyErrors: {} })
  })

  it.each(['policy', 'member', 'unavailable'] as const)('rejects an edit denied by the workspace %s before changing local state', async (restriction) => {
    const original = feedbackMessage('workspace-message', 'assistant', '', 'Original text')
    resetStore([original])
    useConversations.setState((state) => ({ conversations: state.conversations.map((conversation) => ({ ...conversation, workspaceId: 'space' })) }))
    useWorkspaces.setState({
      workspaces: [{ id: 'space', role: 'member', can_edit_messages: restriction !== 'member' } as ApiWorkspace],
      policies: restriction === 'unavailable' ? {} : { space: { AllowMessageEditing: restriction !== 'policy' } as ApiWorkspacePolicy },
    })
    await expect(useConversations.getState().editMessageInPlace('conv_feedback_edit', original.id, 'Denied edit')).rejects.toThrow('permission denied')
    expect(apiMocks.editMessage).not.toHaveBeenCalled()
    expect(useConversations.getState().conversations[0].messages[0]).toEqual(original)
  })

  it.each(['user', 'assistant'] as const)('rejects a denied %s edit before changing local state or calling the API', async (role) => {
    useAuth.setState({ user: {
      id: 'restricted-editor', role: 'user', permissions: { ...DEFAULT_USER_PERMISSIONS, allow_message_editing: false },
    } as ApiUser })
    const original = feedbackMessage('restricted-message', role, '', 'Original text')
    resetStore([original])

    await expect(useConversations.getState().editMessageInPlace('conv_feedback_edit', original.id, 'Denied edit'))
      .rejects.toThrow('permission denied')

    expect(apiMocks.editMessage).not.toHaveBeenCalled()
    expect(useConversations.getState().conversations[0].messages[0]).toEqual(original)
  })

  it('reconciles an edited assistant with the feedback returned by the API', async () => {
    resetStore([feedbackMessage('assistant_1', 'assistant', 'user_1', 'Original answer')])
    apiMocks.editMessage.mockResolvedValue(editResponse('assistant_1', 'assistant'))

    await useConversations
      .getState()
      .editMessageInPlace('conv_feedback_edit', 'assistant_1', 'Edited answer')

    expect(useConversations.getState().conversations[0].messages[0]).toMatchObject({
      content: 'Edited answer',
      liked: false,
      disliked: false,
      feedbackReasons: [],
      feedbackComment: '',
    })
  })

  it('clears feedback only from direct assistant children of an edited question', async () => {
    const user = feedbackMessage('user_1', 'user', '', 'Original question')
    const direct = feedbackMessage('assistant_direct', 'assistant', 'user_1', 'Direct answer')
    const sibling = feedbackMessage('assistant_sibling', 'assistant', 'user_1', 'Sibling answer')
    const later = feedbackMessage('assistant_later', 'assistant', 'user_2', 'Later answer')
    resetStore([user, direct, sibling, later])
    apiMocks.editMessage.mockResolvedValue(editResponse('user_1', 'user'))

    await useConversations
      .getState()
      .editMessageInPlace('conv_feedback_edit', 'user_1', 'Edited question')

    const messages = useConversations.getState().conversations[0].messages
    expect(messages.find((message) => message.id === 'assistant_direct')?.disliked).toBe(false)
    expect(messages.find((message) => message.id === 'assistant_sibling')?.disliked).toBe(false)
    expect(messages.find((message) => message.id === 'assistant_later')).toMatchObject({
      disliked: true,
      feedbackReasons: ['incorrect_fact'],
      feedbackComment: 'Old feedback',
    })
  })

  it('rolls back only content when the edit request fails', async () => {
    resetStore([feedbackMessage('assistant_1', 'assistant', 'user_1', 'Original answer')])
    apiMocks.editMessage.mockRejectedValue(new Error('network failure'))

    await expect(
      useConversations
        .getState()
        .editMessageInPlace('conv_feedback_edit', 'assistant_1', 'Rejected edit'),
    ).rejects.toThrow('network failure')

    expect(useConversations.getState().conversations[0].messages[0]).toMatchObject({
      content: 'Original answer',
      disliked: true,
      feedbackReasons: ['incorrect_fact'],
      feedbackComment: 'Old feedback',
    })
  })
})

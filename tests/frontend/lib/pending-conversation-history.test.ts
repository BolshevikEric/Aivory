import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userId: 'owner',
  rows: [] as { id: string; creatorId?: string; isDraft?: boolean; messages: unknown[] }[],
  create: vi.fn(),
  discardDraft: vi.fn(),
  switchDraftScope: vi.fn(),
  get: vi.fn(),
  adopt: vi.fn(),
}))

vi.mock('@/api', () => ({
  ApiError: class extends Error {},
  conversationsApi: mocks,
}))
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/store/auth', () => ({ useAuth: { getState: () => ({ user: { id: mocks.userId } }) } }))
vi.mock('@/store/conversations', () => ({
  useConversations: {
    getState: () => ({ conversations: mocks.rows, adoptConversation: mocks.adopt }),
    setState: (update: (state: { conversations: typeof mocks.rows }) => { conversations: typeof mocks.rows }) => {
      mocks.rows = update({ conversations: mocks.rows }).conversations
    },
  },
}))

import { discardPendingConversation, recoverPendingConversation, reservePendingConversation } from '@/lib/pending-conversation'

function draft(id: string) {
  return { id, user_id: 'owner', title: '', pinned: false, starred: false, archived: false,
    workspace_id: '', project_id: '', is_draft: true, draft_scope: 'chat' }
}

describe('draft sidebar history synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.userId = 'owner'
    mocks.rows = []
    const storage: Record<string, string> = {}
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value },
      removeItem: (key: string) => { delete storage[key] },
    } })
    mocks.adopt.mockImplementation((row: ReturnType<typeof draft>) => {
      mocks.rows = [...mocks.rows.filter((existing) => existing.id !== row.id),
        { id: row.id, creatorId: row.user_id, isDraft: row.is_draft, messages: [] }]
    })
    mocks.discardDraft.mockResolvedValue({ ok: true })
  })

  it('shows newly reserved drafts immediately and replaces the previous empty draft', async () => {
    mocks.rows = [{ id: 'old', creatorId: 'owner', isDraft: true, messages: [] }]
    mocks.create.mockResolvedValue(draft('new'))
    await reservePendingConversation('owner', {}, () => true)
    expect(mocks.rows.map((row) => row.id)).toEqual(['new'])
    expect(mocks.adopt).toHaveBeenCalledWith(expect.objectContaining({ is_draft: true }))
  })

  it('removes discarded drafts without waiting for a realtime event', async () => {
    mocks.rows = [{ id: 'old', creatorId: 'owner', isDraft: true, messages: [] }]
    await discardPendingConversation('key', 'old')
    expect(mocks.rows).toEqual([])
  })

  it('restores a server draft and removes drafts deleted by the scope switch', async () => {
    mocks.rows = [{ id: 'old', creatorId: 'owner', isDraft: true, messages: [] }]
    mocks.switchDraftScope.mockResolvedValue({ conversation: draft('restored'), deleted_ids: ['old'] })
    mocks.get.mockResolvedValue({ conversation: draft('restored'), messages: [] })
    await recoverPendingConversation('key', { userId: 'owner', scope: 'chat' })
    expect(mocks.rows.map((row) => row.id)).toEqual(['restored'])
  })

  it('preserves a concurrent first send instead of replacing its messages with an empty draft', async () => {
    mocks.rows = [{ id: 'new', creatorId: 'owner', isDraft: false, messages: [{ content: 'sending' }] }]
    mocks.create.mockResolvedValue(draft('new'))
    await reservePendingConversation('owner', {}, () => true)
    expect(mocks.adopt).not.toHaveBeenCalled()
    expect(mocks.rows[0].messages).toEqual([{ content: 'sending' }])
  })

  it('does not put a delayed reservation into another account or an abandoned page', async () => {
    mocks.create.mockImplementation(async () => { mocks.userId = 'other'; return draft('late') })
    await reservePendingConversation('owner', {}, () => true)
    expect(mocks.adopt).not.toHaveBeenCalled()
    mocks.userId = 'owner'
    mocks.create.mockResolvedValue(draft('abandoned'))
    let checks = 0
    await reservePendingConversation('owner', {}, () => ++checks === 1)
    expect(mocks.adopt).not.toHaveBeenCalled()
  })
})

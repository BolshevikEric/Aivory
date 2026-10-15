// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '@/api/client'
import type { ApiSharedConversation } from '@/api/types'
import SharedConversation from '@/pages/share/SharedConversation'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api', async () => ({
  ApiError: (await import('@/api/client')).ApiError,
  sharedApi: { get: mocks.get },
}))
vi.mock('@/store/auth', () => ({
  useAuth: (select: (state: unknown) => unknown) => select({ status: 'unauthenticated', user: null }),
}))
vi.mock('@/store/conversations', () => ({
  useConversations: (select: (state: unknown) => unknown) => select({ adoptConversation: vi.fn() }),
}))
vi.mock('@/components/chat/markdown', () => ({ Markdown: ({ content }: { content: string }) => <p>{content}</p> }))

const snapshot: ApiSharedConversation = {
  title: 'Shared title', created_at: 1,
  messages: [{ role: 'assistant', blocks: [{ kind: 'text', text: 'Shared answer' }], citations: [], created_at: 1 }],
}
let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.get.mockReset().mockResolvedValue(snapshot)
  await i18n.changeLanguage('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/share/first']}>
        <Link data-next to="/share/second">Next</Link>
        <Routes><Route path="/share/:token" element={<SharedConversation />} /></Routes>
      </MemoryRouter>,
    )
  })
}

async function click(selector: string) {
  const button = container.querySelector<HTMLElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

describe('shared conversation loading', () => {
  it('renders a conversation for an anonymous visitor', async () => {
    await mount()
    expect(mocks.get).toHaveBeenCalledWith('first')
    expect(container.textContent).toContain('Shared title')
    expect(container.textContent).toContain('Shared answer')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the unavailable state only for a missing share', async () => {
    mocks.get.mockRejectedValue(new ApiError(404, 'not found', null))
    await mount()
    expect(container.textContent).toContain(i18n.t('chat:share.missingTitle'))
    expect(container.textContent).not.toContain(i18n.t('chat:share.viewLoadFailedTitle'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it.each([
    ['network failure', new TypeError('Failed to fetch')],
    ['rate limit', new ApiError(429, 'rate limited', null)],
    ['server failure', new ApiError(500, 'server error', null)],
  ])('lets a visitor retry after a %s', async (_name, error) => {
    mocks.get.mockRejectedValueOnce(error)
    await mount()
    expect(container.textContent).toContain(i18n.t('chat:share.viewLoadFailedTitle'))
    expect(container.textContent).not.toContain(i18n.t('chat:share.missingTitle'))

    await click('[role="alert"] button')

    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Shared answer')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('clears the old conversation while a different share loads', async () => {
    await mount()
    let resolve!: (value: ApiSharedConversation) => void
    mocks.get.mockReturnValueOnce(new Promise<ApiSharedConversation>((done) => { resolve = done }))

    await click('[data-next]')

    expect(mocks.get).toHaveBeenLastCalledWith('second')
    expect(container.textContent).toContain(i18n.t('common:common.loading'))
    expect(container.textContent).not.toContain('Shared answer')
    await act(async () => resolve({ ...snapshot, title: 'Second share' }))
    expect(container.textContent).toContain('Second share')
  })

  it('ignores a late error from the previous share', async () => {
    let reject!: (error: Error) => void
    mocks.get.mockReturnValueOnce(new Promise<ApiSharedConversation>((_resolve, fail) => { reject = fail }))
    await mount()
    await click('[data-next]')
    expect(container.textContent).toContain('Shared answer')

    await act(async () => reject(new ApiError(404, 'not found', null)))

    expect(container.textContent).toContain('Shared answer')
    expect(container.textContent).not.toContain(i18n.t('chat:share.missingTitle'))
  })
})

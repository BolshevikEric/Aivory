// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminConversationShares from '@/pages/admin/AdminConversationShares'
import { TooltipProvider } from '@/components/ui/tooltip'

const { conversationShares, copyText, translate } = vi.hoisted(() => ({
  conversationShares: vi.fn(),
  copyText: vi.fn(),
  translate: (key: string) => key,
}))
vi.mock('@/api', () => ({ adminApi: { conversationShares }, ApiError: class extends Error {} }))
vi.mock('@/lib/utils', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/utils')>(), copyText }))
vi.mock('@/hooks/use-toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))

const item = {
  id: 'sh_public', conversation_id: 'conv-42', title: 'Shared research plan',
  user_id: 'user-9', user_name: 'Example Author', user_email: 'author@example.test', created_at: 1_780_000_000,
}
const page = { items: [item], total: 51, limit: 50, offset: 0 }
let root: Root
let container: HTMLDivElement

async function render() {
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(AdminConversationShares))))
  })
}

async function enter(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  conversationShares.mockReset().mockResolvedValue(page)
  copyText.mockReset().mockResolvedValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('admin shared conversations', () => {
  it('opens snapshots, copies server links on desktop, and links to the original conversation', async () => {
    Object.defineProperty(window, 'aivoryDesktop', { configurable: true, value: { serverBaseUrl: 'https://chat.example.test' } })
    try {
      await render()
      expect(container.textContent).toContain(item.title)
      expect(container.textContent).toContain(item.user_email)
      expect(container.querySelector<HTMLAnchorElement>('a[aria-label="admin:conversationShares.open"]')?.href).toBe('https://chat.example.test/share/sh_public')
      expect(container.querySelector<HTMLAnchorElement>('a[aria-label="admin:conversationShares.viewConversation"]')?.getAttribute('href')).toBe('/admin/users/user-9/conversations/conv-42')
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="admin:conversationShares.copyLink"]')!.click() })
      expect(copyText).toHaveBeenCalledWith('https://chat.example.test/share/sh_public')
    } finally {
      Reflect.deleteProperty(window, 'aivoryDesktop')
    }
  })

  it('paginates on the server and resets to page one when the user filter changes', async () => {
    await render()
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="pagination.next"]')!.click() })
    expect(conversationShares).toHaveBeenLastCalledWith({ search: '', user: '', limit: 50, offset: 50 })
    await enter('input[aria-label="admin:usage.filters.user"]', '  author@example.test  ')
    expect(conversationShares).toHaveBeenLastCalledWith({ search: '', user: 'author@example.test', limit: 50, offset: 0 })
    await enter('input[aria-label="admin:conversationShares.searchPlaceholder"]', 'research')
    expect(conversationShares).toHaveBeenLastCalledWith({ search: 'research', user: 'author@example.test', limit: 50, offset: 0 })
  })

  it('ignores stale responses after filters change', async () => {
    let resolveOld!: (value: unknown) => void
    conversationShares.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    conversationShares.mockResolvedValueOnce({ ...page, items: [{ ...item, title: 'New filtered result' }] })
    await render()
    await enter('input[aria-label="admin:usage.filters.user"]', 'other user')
    await act(async () => { resolveOld(page) })
    expect(container.textContent).toContain('New filtered result')
    expect(container.textContent).not.toContain(item.title)
  })

  it('retries failed requests and distinguishes an empty filtered list', async () => {
    conversationShares.mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(container.textContent).toContain('admin:conversationShares.loadFailed')
    conversationShares.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 })
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(container.textContent).toContain('admin:conversationShares.empty')
    await enter('input[aria-label="admin:usage.filters.user"]', 'no-such-user')
    expect(container.textContent).toContain('admin:conversationShares.emptyFiltered')
  })
})

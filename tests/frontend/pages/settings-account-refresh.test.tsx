// @vitest-environment jsdom
import { act, createElement, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Account from '@/pages/settings/Account'
import { useAuth } from '@/store/auth'
import type { ApiUser } from '@/api/types'

vi.mock('@/store/auth', async () => {
  const { create } = await import('zustand')
  return { useAuth: create(() => ({ user: null, authPolicy: {}, updateProfile: vi.fn(), setUser: vi.fn(), logout: vi.fn() })) }
})
vi.mock('@/api', () => ({ authApi: {}, ApiError: class extends Error {} }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/use-toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/hooks/use-clipboard', () => ({ useCopy: () => ({ copy: vi.fn() }) }))
vi.mock('@/components/settings/active-sessions', () => ({ ActiveSessions: () => null }))
vi.mock('@/components/settings/identity-sources', () => ({ IdentitySources: () => null }))
vi.mock('@/components/settings/passkey-settings', () => ({ PasskeySettings: () => null }))
vi.mock('@/pages/settings/SettingsLayout', () => ({
  SettingsSection: ({ children }: PropsWithChildren) => createElement('section', null, children),
  SettingsRow: ({ children }: PropsWithChildren) => createElement('div', null, children),
}))

const profile = { id: 'admin-a', name: 'Original name', email: 'admin@example.test', role: 'admin', status: 'active', created_at: 1, settings: {} } as ApiUser
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAuth.setState({ user: { ...profile } })
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
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(Account))))
}
function nameInput() {
  return container.querySelector<HTMLInputElement>('#account-name')!
}
async function editName(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput(), value)
    nameInput().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('account draft during foreground profile synchronization', () => {
  it('preserves an unsaved name when the same profile is refreshed', async () => {
    await mount()
    await editName('Unsaved name')
    act(() => useAuth.setState({ user: { ...profile, settings: { language: 'zh' } } }))
    expect(nameInput().value).toBe('Unsaved name')
  })

  it('preserves a dirty name while accepting the latest locked email', async () => {
    await mount()
    await editName('Unsaved name')
    act(() => useAuth.setState({ user: { ...profile, name: 'Remote name', email: 'updated@example.test' } }))
    expect(nameInput().value).toBe('Unsaved name')
    expect(container.querySelector<HTMLInputElement>('#account-email')?.value).toBe('updated@example.test')
  })

  it('updates an untouched name from the server', async () => {
    await mount()
    act(() => useAuth.setState({ user: { ...profile, name: 'Remote name' } }))
    expect(nameInput().value).toBe('Remote name')
  })

  it('clears a draft when the authenticated account changes', async () => {
    await mount()
    await editName('Unsaved name')
    act(() => useAuth.setState({ user: { ...profile, id: 'admin-b', name: 'Other account' } }))
    expect(nameInput().value).toBe('Other account')
  })
})

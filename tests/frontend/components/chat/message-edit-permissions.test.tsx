// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from '@/components/chat/message-row'
import { useAuth } from '@/store/auth'
import { DEFAULT_USER_PERMISSIONS } from '@/lib/user-permissions'
import type { ApiUser } from '@/api/types'
import type { Message } from '@/types/chat'

const viewport = vi.hoisted(() => {
  window.matchMedia = vi.fn((media: string) => ({
    matches: false, media, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  return { phone: false }
})
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => viewport.phone }))
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/chat/markdown', () => ({ Markdown: ({ content }: { content: string }) => content }))
vi.mock('@/components/chat/rich-composer-editor', () => ({
  RichComposerEditor: forwardRef(function Editor({ value }: { value: string }, ref) {
    useImperativeHandle(ref, () => ({ focus: () => undefined }))
    return createElement('textarea', { 'aria-label': 'user editor', value, readOnly: true })
  }),
}))

let root: Root
let container: HTMLDivElement
const resend = vi.fn()
const save = vi.fn()

function setPermission(allowed: boolean, role: ApiUser['role'] = 'user') {
  act(() => useAuth.setState({ user: {
    id: 'editor', role, permissions: { ...DEFAULT_USER_PERMISSIONS, allow_message_editing: allowed },
  } as ApiUser }))
}

function render(role: Message['role']) {
  const message: Message = { id: `message-${role}`, role, authorId: role === 'user' ? 'editor' : undefined, content: 'Original text', createdAt: 1 }
  act(() => root.render(createElement(MemoryRouter, null, createElement(MessageRow, { message, onEdit: resend, onSaveEdit: save }))))
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.getAttribute('aria-label') === label || element.textContent === label)
}

function openActions() {
  if (viewport.phone) act(() => button('actions.more')!.click())
}

describe.each([false, true])('message editing permission (phone=%s)', (phone) => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    viewport.phone = phone
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useAuth.setState({ user: null })
    vi.unstubAllGlobals()
  })

  it('hides assistant editing when denied', () => {
    setPermission(false)
    render('assistant')
    openActions()
    expect(button('actions.edit')).toBeUndefined()
  })

  it('keeps user editing and resend available while hiding direct save', () => {
    setPermission(false)
    render('user')
    openActions()
    act(() => button('actions.edit')!.click())
    expect(button('actions.saveInPlace')).toBeUndefined()
    expect(button('actions.saveEdit')).toBeDefined()
    act(() => button('actions.saveEdit')!.click())
    expect(resend).toHaveBeenCalledWith('message-user', 'Original text', [])
    expect(save).not.toHaveBeenCalled()
  })

  it('removes direct save but retains resend if permission changes in a user editor', () => {
    setPermission(true)
    render('user')
    openActions()
    act(() => button('actions.edit')!.click())
    expect(button('actions.saveInPlace')).toBeDefined()
    setPermission(false)
    expect(button('actions.saveInPlace')).toBeUndefined()
    expect(button('actions.saveEdit')).toBeDefined()
  })

  it('closes an assistant editor when its permission is revoked', () => {
    setPermission(true)
    render('assistant')
    openActions()
    act(() => button('actions.edit')!.click())
    expect(document.querySelector('[aria-label="actions.editReplySource"]')).not.toBeNull()
    setPermission(false)
    expect(document.querySelector('[aria-label="actions.editReplySource"]')).toBeNull()
    expect(button('actions.saveInPlace')).toBeUndefined()
  })

  it('retains administrator access even if the group denies editing', () => {
    setPermission(false, 'admin')
    render('assistant')
    openActions()
    expect(button('actions.edit')).toBeDefined()
  })
})

// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import KnowledgeBaseDetail from '@/pages/kb/KnowledgeBaseDetail'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), listDocs: vi.fn(), uploaders: vi.fn(), loadPolicy: vi.fn(),
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}))
vi.mock('@/api', () => ({
  kbsApi: mocks,
  ApiError: class extends Error { constructor(public status: number) { super('Request failed') } },
}))
vi.mock('@/api/client', () => ({ apiUpload: vi.fn(), apiUrl: (path: string) => path }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: mocks.t }),
}))
vi.mock('@/store/auth', () => ({ useAuth: (select: (state: unknown) => unknown) =>
  select({ user: { id: 'owner', role: 'user' } }) }))
vi.mock('@/store/workspaces', () => ({ useWorkspaces: (select: (state: unknown) => unknown) =>
  select({ activeId: '', policies: {}, loaded: true, workspaces: [], loadPolicy: mocks.loadPolicy }) }))
vi.mock('@/store/artifact-panel', () => ({ useArtifactPanel: { getState: () => ({ close: vi.fn() }) } }))
vi.mock('@/lib/user-permissions', () => ({ userCan: () => true }))
vi.mock('@/lib/workspace-permissions', () => ({ workspaceCapabilitiesForScope: () => ({
  knowledgeBases: true, fileUpload: true,
}) }))
vi.mock('@/components/layout/content-header', () => ({ ContentHeader: ({ title }: { title: string }) =>
  createElement('h1', null, title) }))

const doc = { id: 'doc', filename: 'file.txt', mime_type: 'text/plain', status: 'parsing',
  size_bytes: 50, chunk_count: 0, created_at: 1, uploaded_by_user_id: 'owner' }
let root: Root
let container: HTMLDivElement
let visibility: DocumentVisibilityState
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
async function mount() {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/kb/library'] },
    createElement(TooltipProvider, null, createElement(Routes, null,
      createElement(Route, { path: '/kb/:id', element: createElement(KnowledgeBaseDetail) }))))))
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  mocks.get.mockReset().mockResolvedValue({ id: 'library', name: 'Library', can_upload: true })
  mocks.listDocs.mockReset().mockResolvedValue([doc])
  mocks.uploaders.mockReset().mockResolvedValue([])
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('knowledge-base processing requests', () => {
  it('loads metadata once, polls only documents, and stops when processing finishes', async () => {
    await mount()
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.uploaders).toHaveBeenCalledTimes(1)
    mocks.listDocs.mockResolvedValue([{ ...doc, status: 'ready' }])
    await advance(2200)
    expect(mocks.listDocs).toHaveBeenCalledTimes(2)
    expect(mocks.listDocs.mock.calls[1][2]).toMatchObject({ activity: 'background' })
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.uploaders).toHaveBeenCalledTimes(1)
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(2)
  })

  it('does not overlap slow probes and cancels them while hidden', async () => {
    await mount()
    let resolve!: (docs: unknown[]) => void
    mocks.listDocs.mockReturnValue(new Promise((done) => { resolve = done }))
    await advance(10_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(2)
    const signal = mocks.listDocs.mock.calls[1][2].signal as AbortSignal
    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(signal.aborted).toBe(true)
    await act(async () => resolve([{ ...doc, status: 'ready' }]))
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(2)
    mocks.listDocs.mockResolvedValue([{ ...doc, status: 'ready' }])
    visibility = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.listDocs).toHaveBeenCalledTimes(3)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.uploaders).toHaveBeenCalledTimes(1)
  })
})

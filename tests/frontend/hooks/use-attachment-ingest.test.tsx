// @vitest-environment jsdom
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttachmentIngest } from '@/hooks/use-attachment-ingest'

const mocks = vi.hoisted(() => ({ listDocs: vi.fn(), error: vi.fn() }))
vi.mock('@/api/endpoints', () => ({ conversationsApi: { listDocs: mocks.listDocs } }))
vi.mock('@/hooks/use-toast', () => ({ toast: { error: mocks.error } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
}) }))

interface Attachment {
  id: string; documentId: string; uploadScopeId: string
  ingest: 'parsing' | 'embedding' | 'ready' | 'failed'
  ingestRetrying?: boolean
}
let root: Root | null
let container: HTMLDivElement
let update: Dispatch<SetStateAction<Attachment[]>>
let visibility: DocumentVisibilityState
const attachment = (id: string, scope = 'conversation-a'): Attachment => ({
  id, documentId: `doc-${id}`, uploadScopeId: scope, ingest: 'parsing',
})
function Probe({ initial, resourceKey = 'a' }: { initial: Attachment[]; resourceKey?: string }) {
  const [attachments, setAttachments] = useState(initial)
  update = setAttachments
  useAttachmentIngest(attachments, setAttachments, true, resourceKey)
  return createElement('output', null, JSON.stringify(attachments))
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const state = () => JSON.parse(container.textContent ?? '[]') as Attachment[]
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  mocks.listDocs.mockReset()
  mocks.error.mockReset()
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root?.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('conversation attachment progress', () => {
  it('queries once for five attachments and stops once all documents are ready', async () => {
    const initial = ['1', '2', '3', '4', '5'].map((id) => attachment(id))
    mocks.listDocs.mockResolvedValue(initial.map((a) => ({ id: a.documentId, status: 'ready' })))
    act(() => root!.render(createElement(Probe, { initial })))
    await advance(1200)
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
    expect(mocks.listDocs).toHaveBeenCalledWith('conversation-a', {
      signal: expect.any(AbortSignal), activity: 'background',
    })
    expect(state().every((a) => a.ingest === 'ready')).toBe(true)
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect a removed attachment or restart its in-flight poll', async () => {
    let resolve!: (docs: unknown[]) => void
    mocks.listDocs.mockReturnValue(new Promise((done) => { resolve = done }))
    act(() => root!.render(createElement(Probe, { initial: [attachment('1')] })))
    await advance(1200)
    const signal = mocks.listDocs.mock.calls[0][1].signal as AbortSignal
    act(() => update([]))
    expect(signal.aborted).toBe(true)
    await act(async () => resolve([{ id: 'doc-1', status: 'failed' }]))
    await advance(60_000)
    expect(state()).toEqual([])
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
  })

  it('ignores a removed attachment while applying the same reply to remaining attachments', async () => {
    let resolve!: (docs: unknown[]) => void
    mocks.listDocs.mockReturnValue(new Promise((done) => { resolve = done }))
    act(() => root!.render(createElement(Probe, { initial: [attachment('1'), attachment('2')] })))
    await advance(1200)
    act(() => update((current) => current.filter((a) => a.id !== '1')))
    await act(async () => resolve([
      { id: 'doc-1', status: 'failed' }, { id: 'doc-2', status: 'ready' },
    ]))
    expect(state()).toEqual([{ ...attachment('2'), ingest: 'ready' }])
    expect(mocks.error).not.toHaveBeenCalled()
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
  })

  it('pauses in the background and updates every attachment on return', async () => {
    visibility = 'hidden'
    mocks.listDocs.mockResolvedValue([{ id: 'doc-1', status: 'ready' }])
    act(() => root!.render(createElement(Probe, { initial: [attachment('1')] })))
    await advance(60_000)
    expect(mocks.listDocs).not.toHaveBeenCalled()
    visibility = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
    expect(state()[0].ingest).toBe('ready')
  })

  it('stops probing missing documents after three successful list responses', async () => {
    mocks.listDocs.mockResolvedValue([])
    act(() => root!.render(createElement(Probe, { initial: [attachment('1')] })))
    await advance(3600)
    expect(state()[0].ingest).toBe('failed')
    expect(mocks.listDocs).toHaveBeenCalledTimes(3)
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(3)
  })

  it('does not restart after unmount even if the server returns a pending document', async () => {
    let resolve!: (docs: unknown[]) => void
    mocks.listDocs.mockReturnValue(new Promise((done) => { resolve = done }))
    act(() => root!.render(createElement(Probe, { initial: [attachment('1')] })))
    await advance(1200)
    const signal = mocks.listDocs.mock.calls[0][1].signal as AbortSignal
    act(() => root!.unmount())
    root = null
    await act(async () => resolve([{ id: 'doc-1', status: 'pending' }]))
    expect(signal.aborted).toBe(true)
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
  })

  it('waits until an ingest retry is accepted before polling the document', async () => {
    mocks.listDocs.mockResolvedValue([{ id: 'doc-1', status: 'ready' }])
    act(() => root!.render(createElement(Probe, { initial: [{ ...attachment('1'), ingestRetrying: true }] })))
    await advance(60_000)
    expect(mocks.listDocs).not.toHaveBeenCalled()
    act(() => update((current) => current.map((a) => ({ ...a, ingestRetrying: false }))))
    await advance(1200)
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
    expect(state()[0].ingest).toBe('ready')
  })

  it('stops polling after access to a conversation is revoked', async () => {
    mocks.listDocs.mockRejectedValue({ status: 403 })
    act(() => root!.render(createElement(Probe, { initial: [attachment('1')] })))
    await advance(1200)
    expect(state()[0].ingest).toBe('failed')
    await advance(60_000)
    expect(mocks.listDocs).toHaveBeenCalledTimes(1)
  })
})

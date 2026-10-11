import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  sandboxFiles: vi.fn(),
}))

vi.mock('@/api/endpoints', () => ({
  conversationsApi: apiMocks,
}))

import { useConversationFiles } from '@/store/conversation-files'
import { useArtifactPanel } from '@/store/artifact-panel'
import { useInlineThreadDrawer } from '@/store/inline-thread'
import { useSandboxFiles } from '@/store/sandbox-files'

describe('sandbox files drawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.sandboxFiles.mockResolvedValue({
      session: 'sid',
      files: [{ path: 'outputs/report.pdf', size: 100 }],
    })
    useConversationFiles.setState({ open: false })
    useArtifactPanel.setState({ open: false, source: null })
    useInlineThreadDrawer.setState({ open: false })
    useSandboxFiles.setState({
      open: false,
      conversationId: null,
      files: [],
      session: '',
      currentPath: '',
      loading: false,
      unavailable: false,
      unavailableReason: '',
      error: false,
    })
  })

  it('opens read-only data for one conversation and closes the other side panels', async () => {
    useConversationFiles.setState({ open: true })
    useArtifactPanel.setState({
      open: true,
      source: { type: 'html', sourceKey: 'block-1', html: '<p>hi</p>', shareable: false },
    })
    useInlineThreadDrawer.setState({ open: true })

    useSandboxFiles.getState().openDrawer('conv-1')
    await vi.waitFor(() => expect(useSandboxFiles.getState().loading).toBe(false))

    expect(apiMocks.sandboxFiles).toHaveBeenCalledWith('conv-1')
    expect(useSandboxFiles.getState()).toMatchObject({
      open: true,
      conversationId: 'conv-1',
      session: 'sid',
      files: [{ path: 'outputs/report.pdf', size: 100 }],
    })
    expect(useConversationFiles.getState().open).toBe(false)
    expect(useArtifactPanel.getState().open).toBe(false)
    expect(useInlineThreadDrawer.getState().open).toBe(false)
  })

  it('shows saved files normally and clears a previous unavailable reason', async () => {
    apiMocks.sandboxFiles.mockResolvedValueOnce({ session: 'sid', files: [], unavailable: true, unavailable_reason: 'archive_missing' })
    useSandboxFiles.getState().openDrawer('conv-1')
    await vi.waitFor(() => expect(useSandboxFiles.getState().loading).toBe(false))
    expect(useSandboxFiles.getState().unavailableReason).toBe('archive_missing')
    apiMocks.sandboxFiles.mockResolvedValueOnce({ session: 'sid', archived: true, files: [{ path: 'uploads/data.csv', size: 6 }] })
    await useSandboxFiles.getState().load()
    expect(useSandboxFiles.getState()).toMatchObject({ unavailable: false, unavailableReason: '', error: false, files: [{ path: 'uploads/data.csv', size: 6 }] })
  })

  it('distinguishes service failures and resets status when changing conversations', async () => {
    apiMocks.sandboxFiles.mockRejectedValueOnce(new Error('network failure'))
    useSandboxFiles.getState().openDrawer('conv-1')
    await vi.waitFor(() => expect(useSandboxFiles.getState().loading).toBe(false))
    expect(useSandboxFiles.getState()).toMatchObject({ error: true, unavailableReason: 'service_unavailable', files: [] })
    useSandboxFiles.getState().openDrawer('conv-2')
    expect(useSandboxFiles.getState()).toMatchObject({ error: false, unavailableReason: '', conversationId: 'conv-2' })
    await vi.waitFor(() => expect(useSandboxFiles.getState().loading).toBe(false))
  })

  it('ignores a delayed result from a previously opened conversation', async () => {
    let finish!: (value: unknown) => void
    apiMocks.sandboxFiles.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    useSandboxFiles.getState().openDrawer('conv-1')
    useSandboxFiles.getState().openDrawer('conv-2')
    await vi.waitFor(() => expect(useSandboxFiles.getState().loading).toBe(false))
    finish({ session: 'old', files: [], unavailable: true, unavailable_reason: 'archive_missing' })
    await Promise.resolve()
    expect(useSandboxFiles.getState()).toMatchObject({ conversationId: 'conv-2', session: 'sid', unavailableReason: '', unavailable: false })
  })
})

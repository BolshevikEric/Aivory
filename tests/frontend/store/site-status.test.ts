import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/api/client', () => ({ api: mocks.api }))
import { useSiteStatus } from '@/store/site-status'

describe('site availability', () => {
  beforeEach(() => {
    mocks.api.mockReset()
    useSiteStatus.setState({ loaded: false, closed: false, message: '', refreshing: false })
  })
  afterEach(() => vi.restoreAllMocks())

  it('coalesces probes and does not overwrite a newer closure with an older open response', async () => {
    let resolve!: (value: unknown) => void
    mocks.api.mockReturnValue(new Promise((done) => { resolve = done }))
    const first = useSiteStatus.getState().refresh()
    const second = useSiteStatus.getState().refresh()
    expect(first).toBe(second)
    expect(mocks.api).toHaveBeenCalledTimes(1)
    useSiteStatus.getState().apply({ closed: true, message: 'Maintenance' })
    resolve({ closed: false, message: '' })
    await first
    expect(useSiteStatus.getState()).toMatchObject({ loaded: true, closed: true, message: 'Maintenance', refreshing: false })
  })

  it('keeps maintenance visible on network failure and reopens on the next successful probe', async () => {
    useSiteStatus.getState().apply({ closed: true, message: 'Come back later' })
    mocks.api.mockRejectedValueOnce(new Error('Offline'))
    await useSiteStatus.getState().refresh()
    expect(useSiteStatus.getState().closed).toBe(true)
    mocks.api.mockResolvedValueOnce({ closed: false, message: '' })
    await useSiteStatus.getState().refresh()
    expect(useSiteStatus.getState()).toMatchObject({ closed: false, message: '', loaded: true })
  })
})

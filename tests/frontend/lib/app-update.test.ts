import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  streaming: false, blocked: false, online: true, failStore: false,
}))
vi.mock('@/store/conversations', () => ({ useConversations: { getState: () => {
  if (mocks.failStore) throw new Error('store unavailable')
  return { conversations: [{ messages: [{ streaming: mocks.streaming }] }] }
} } }))
vi.mock('@/api/client', () => ({ isNetworkOnline: () => mocks.online }))
vi.mock('@/lib/sync-guards', () => ({ isReloadBlocked: () => mocks.blocked }))

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
  }
}
let visibility: DocumentVisibilityState
let fakeDocument: EventTarget & { visibilityState: DocumentVisibilityState }
let fakeWindow: EventTarget & { location: { reload: ReturnType<typeof vi.fn> }; setInterval: typeof setInterval; aivoryDesktop?: object }
let local: ReturnType<typeof storage>
let session: ReturnType<typeof storage>
let fetchVersion: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.stubEnv('PROD', true)
  mocks.streaming = false
  mocks.blocked = false
  mocks.online = true
  mocks.failStore = false
  visibility = 'visible'
  fakeDocument = new class extends EventTarget {
    get visibilityState() { return visibility }
  }()
  fakeWindow = Object.assign(new EventTarget(), { location: { reload: vi.fn() }, setInterval })
  local = storage()
  session = storage()
  fetchVersion = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 'next-deploy' }) })
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('fetch', fetchVersion)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function broadcast(version = 'next-deploy') {
  const event = new Event('storage')
  Object.assign(event, { key: 'aivory.update-ready', newValue: version })
  fakeWindow.dispatchEvent(event)
}
async function transition(next: DocumentVisibilityState) {
  visibility = next
  fakeDocument.dispatchEvent(new Event('visibilitychange'))
  await Promise.resolve()
  await Promise.resolve()
}

describe('deployment updates during mobile app switching', () => {
  it('preserves a pending update across app switching and applies it only on visible navigation', async () => {
    const update = await import('@/lib/app-update')
    update.initAppUpdate()
    await update.checkForUpdate()
    expect(fetchVersion).toHaveBeenCalledWith('/version.json', { cache: 'no-store' })
    expect(local.setItem).toHaveBeenCalledWith('aivory.update-ready', 'next-deploy')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    await transition('hidden')
    update.maybeApplyUpdate('navigation')
    await transition('visible')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(session.getItem('aivory.version-reload')!)).toEqual({ v: 'next-deploy', at: Date.now() })
  })

  it('does not reload when the reconnect check discovers an update while hidden', async () => {
    const update = await import('@/lib/app-update')
    update.initAppUpdate()
    await transition('hidden')
    await update.checkForUpdate()
    update.maybeApplyUpdate('armed')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    await transition('visible')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
  })

  it('holds a sibling-tab update without rebroadcasting or reloading in the background', async () => {
    const update = await import('@/lib/app-update')
    update.initAppUpdate()
    await transition('hidden')
    broadcast()
    update.maybeApplyUpdate('storage')
    expect(local.setItem).not.toHaveBeenCalled()
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    await transition('visible')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
  })

  it('continues blocking updates during generation and unsaved work, including a failed store read', async () => {
    const update = await import('@/lib/app-update')
    await update.checkForUpdate()
    mocks.streaming = true
    update.maybeApplyUpdate('navigation')
    mocks.streaming = false
    mocks.blocked = true
    update.maybeApplyUpdate('navigation')
    mocks.blocked = false
    mocks.failStore = true
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    mocks.failStore = false
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores the current deployed version, throttles checks, and checks again after 30 seconds', async () => {
    const update = await import('@/lib/app-update')
    fetchVersion.mockResolvedValue({ ok: true, json: async () => ({ version: __APP_VERSION__ }) })
    update.initAppUpdate()
    broadcast(__APP_VERSION__)
    await update.checkForUpdate()
    await transition('hidden')
    await transition('visible')
    expect(fetchVersion).toHaveBeenCalledTimes(1)
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_001)
    fetchVersion.mockResolvedValue({ ok: true, json: async () => ({ version: 'next-deploy' }) })
    await update.checkForUpdate()
    expect(fetchVersion).toHaveBeenCalledTimes(2)
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
  })

  it('backs off repeated reloads of the same unavailable build for five minutes', async () => {
    const update = await import('@/lib/app-update')
    update.initAppUpdate()
    session.setItem('aivory.version-reload', JSON.stringify({ v: 'next-deploy', at: Date.now() }))
    broadcast()
    await update.checkForUpdate()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5 * 60_000)
    broadcast()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
  })

  it('continues version detection when returning after a failed check, without reloading the page', async () => {
    const update = await import('@/lib/app-update')
    update.initAppUpdate()
    mocks.online = false
    await update.checkForUpdate()
    expect(fetchVersion).not.toHaveBeenCalled()
    mocks.online = true
    vi.advanceTimersByTime(31_000)
    fetchVersion.mockRejectedValueOnce(new Error('offline'))
    await update.checkForUpdate()
    vi.advanceTimersByTime(31_000)
    await transition('hidden')
    await transition('visible')
    await update.checkForUpdate()
    expect(fetchVersion).toHaveBeenCalledTimes(2)
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
    update.maybeApplyUpdate('navigation')
    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1)
  })

  it('initializes once and only performs the safety check while visible', async () => {
    const update = await import('@/lib/app-update')
    fetchVersion.mockResolvedValue({ ok: false })
    const listen = vi.spyOn(fakeDocument, 'addEventListener')
    update.initAppUpdate()
    update.initAppUpdate()
    expect(listen).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchVersion).toHaveBeenCalledTimes(1)
    await transition('hidden')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchVersion).toHaveBeenCalledTimes(1)
  })

  it('leaves desktop updates to the desktop bridge', async () => {
    const update = await import('@/lib/app-update')
    fakeWindow.aivoryDesktop = {}
    const listen = vi.spyOn(fakeDocument, 'addEventListener')
    update.initAppUpdate()
    await update.checkForUpdate()
    broadcast()
    update.maybeApplyUpdate('navigation')
    expect(listen).not.toHaveBeenCalled()
    expect(fetchVersion).not.toHaveBeenCalled()
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()
  })

  it('skips deployment checks in development', async () => {
    vi.stubEnv('PROD', false)
    const update = await import('@/lib/app-update')
    update.initAppUpdate()
    await update.checkForUpdate()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchVersion).not.toHaveBeenCalled()
  })
})

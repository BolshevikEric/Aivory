// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminTools from '@/pages/admin/AdminTools'

const { settings, updateSettings, builtinTools, mcpServers, errorToast } = vi.hoisted(() => ({
  settings: vi.fn(), updateSettings: vi.fn(), builtinTools: vi.fn(), mcpServers: vi.fn(), errorToast: vi.fn(),
}))
vi.mock('@/api', () => ({
  adminApi: { settings, updateSettings, builtinTools, mcpServers }, ApiError: class extends Error {},
}))
vi.mock('@/hooks/use-toast', () => ({ toast: { error: errorToast, success: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  settings.mockResolvedValue({ search_provider: 'searxng', search_base_url: 'https://search.example.test', search_result_count: 20 })
  updateSettings.mockImplementation(async (patch: Record<string, unknown>) => patch)
  builtinTools.mockResolvedValue([])
  mcpServers.mockResolvedValue([])
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
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminTools))) })
}

async function setCount(value: string) {
  const input = container.querySelector<HTMLInputElement>('#search-result-count')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function save() {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'common:actions.save')!
  await act(async () => { button.click() })
}

describe('SearXNG administrator result count', () => {
  it('loads the stored count and saves edits as an integer', async () => {
    await mount()
    expect(container.querySelector<HTMLInputElement>('#search-result-count')?.value).toBe('20')
    expect(container.querySelector('label[for="search-result-count"]')?.textContent).toBe('admin:settings.fields.searchResultCount')
    await setCount('30')
    await save()
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ search_result_count: 30 }))
    expect(errorToast).not.toHaveBeenCalled()
  })

  it('defaults old settings to five and persists that value on save', async () => {
    settings.mockResolvedValue({ search_provider: 'searxng', search_base_url: 'https://search.example.test' })
    await mount()
    expect(container.querySelector<HTMLInputElement>('#search-result-count')?.value).toBe('5')
    await save()
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ search_result_count: 5 }))
  })

  it('rejects empty, fractional, and out-of-range values before saving', async () => {
    await mount()
    for (const value of ['', '1.5', '0', '51']) {
      await setCount(value)
      await save()
      expect(updateSettings).not.toHaveBeenCalled()
      expect(errorToast).toHaveBeenLastCalledWith('admin:settings.fields.searchResultCountInvalid')
    }
  })

  it('keeps SearXNG configuration out of other provider forms and save patches', async () => {
    settings.mockResolvedValue({ search_provider: 'brave', search_result_count: 20 })
    await mount()
    expect(container.querySelector('#search-result-count')).toBeNull()
    await save()
    expect(updateSettings.mock.calls[0][0]).not.toHaveProperty('search_result_count')
  })
})

describe('AnySearch administrator configuration', () => {
  it('allows anonymous calls using the official endpoint with empty configuration', async () => {
    settings.mockResolvedValue({ search_provider: 'anysearch', search_api_key: '', search_base_url: '' })
    await mount()
    expect(container.querySelector('#search-url')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('#search-key')?.type).toBe('password')
    expect(container.querySelector('#search-result-count')).toBeNull()
    expect(container.querySelector('label[for="search-key"]')?.textContent).toBe('admin:settings.fields.searchApiKeyOptional')
    await save()
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ search_provider: 'anysearch', search_api_key: '' }))
    expect(updateSettings.mock.calls[0][0]).not.toHaveProperty('search_base_url')
    expect(errorToast).not.toHaveBeenCalled()
  })

  it('keeps a legacy base URL out of the AnySearch form and save patch', async () => {
    settings.mockResolvedValue({ search_provider: 'anysearch', search_api_key: 'test-key', search_base_url: 'https://search.example.test/v1/search' })
    await mount()
    expect(container.querySelector('#search-url')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('#search-key')?.value).toBe('test-key')
    await save()
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ search_api_key: 'test-key' }))
    expect(updateSettings.mock.calls[0][0]).not.toHaveProperty('search_base_url')
  })

  it('saves an optional API key without sending a base URL', async () => {
    settings.mockResolvedValue({ search_provider: 'anysearch', search_api_key: '', search_base_url: '' })
    await mount()
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#search-key')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-key')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await save()
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ search_api_key: 'test-key' }))
    expect(updateSettings.mock.calls[0][0]).not.toHaveProperty('search_base_url')
  })
})

describe('Administrator map provider configuration', () => {
  it('defaults to the keyless provider with no credential fields', async () => {
    await mount()
    expect(container.querySelector('#map-provider')?.textContent).toBe('admin:tools.mapOSM')
    expect(container.querySelector('#map-amap-web-key')).toBeNull()
  })

  it('loads masked AMap credentials and saves only the tools settings', async () => {
    settings.mockResolvedValue({ map_provider: 'amap', map_amap_web_api_key: '••••••', map_amap_js_api_key: '••••••', map_amap_security_secret: '••••••', site_name: 'Other settings' })
    await mount()
    for (const id of ['map-amap-web-key', 'map-amap-js-key', 'map-amap-security-code']) expect(container.querySelector<HTMLInputElement>(`#${id}`)?.type).toBe('password')
    const input = container.querySelector<HTMLInputElement>('#map-amap-web-key')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'replacement-key')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await save()
    expect(updateSettings).toHaveBeenCalledWith({ map_provider: 'amap', map_amap_web_api_key: 'replacement-key', map_amap_js_api_key: '••••••', map_amap_security_secret: '••••••' })
  })

  it('validates all three required AMap credentials', async () => {
    settings.mockResolvedValue({ map_provider: 'amap', map_amap_web_api_key: 'web-test', map_amap_js_api_key: '', map_amap_security_secret: '' })
    await mount()
    await save()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledWith('admin:tools.mapCredentialsRequired')
  })
})

describe('Yuanbao administrator configuration', () => {
  it('swaps the API key for Tencent Cloud credentials and returns the mask on save', async () => {
    settings.mockResolvedValue({ search_provider: 'yuanbao', search_secret_id: '••••••', search_secret_key: '••••••' })
    await mount()
    expect(container.querySelector<HTMLInputElement>('#search-secret-id')?.type).toBe('password')
    expect(container.querySelector<HTMLInputElement>('#search-secret-key')?.type).toBe('password')
    expect(container.querySelector('#search-key')).toBeNull()
    expect(container.querySelector('#search-url')).toBeNull()
    expect(container.querySelector('label[for="search-secret-id"]')?.textContent).toBe('admin:settings.fields.searchSecretId')
    await save()
    // The masked sentinel is echoed back on purpose; the server treats it as
    // "keep the stored credential".
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      search_provider: 'yuanbao',
      search_secret_id: '••••••',
      search_secret_key: '••••••',
    }))
    expect(errorToast).not.toHaveBeenCalled()
  })
})

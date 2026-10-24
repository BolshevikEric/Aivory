// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importBackupArchive } from '@/api/backup-import'
import { api, apiUpload, ApiError } from '@/api/client'
import { isReloadBlocked } from '@/lib/sync-guards'

vi.mock('@/api/client', () => ({
  api: vi.fn(), apiUpload: vi.fn(),
  ApiError: class extends Error {
    constructor(readonly status: number, message: string, readonly body: unknown) { super(message) }
  },
}))

const chunkBytes = 4 * 1024 * 1024
const result = { ok: true, tables: { users: 2 }, files_restored: 1, includes_files: true, relogin_required: true }
const state = (status: string, uploaded = 0) => ({ id: 'job', status, token: 'scoped-secret', chunk_bytes: chunkBytes, uploaded_bytes: uploaded })

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(apiUpload).mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('chunked backup import', () => {
  it('uploads bounded chunks with total byte progress and polls independently of login sessions', async () => {
    const file = new File([new Uint8Array(chunkBytes + 16)], 'backup.zip')
    const progress = vi.fn()
    const uploaded = vi.fn()
    const reconnecting = vi.fn()
    let polls = 0
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith('/import-jobs')) return state('uploading')
      if (path.endsWith('/start')) return state('restoring', file.size)
      if (++polls === 1) throw new ApiError(504, 'proxy timeout', null)
      return { ...state('completed', file.size), result }
    })
    vi.mocked(apiUpload).mockImplementation(async (path, form, opts) => {
      const offset = Number(new URL(path, 'https://example.test').searchParams.get('offset'))
      const chunk = form.get('file') as File
      expect(chunk.size).toBeLessThanOrEqual(chunkBytes)
      opts?.onProgress?.({ loaded: 512, total: 1024, percent: 50 })
      return state('uploading', offset + chunk.size)
    })
    let completed = false
    const promise = importBackupArchive(file, { onProgress: progress, onUploaded: uploaded, onReconnecting: reconnecting })
      .then((value) => { completed = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(uploaded).toHaveBeenCalledOnce()
    expect(completed).toBe(false)
    expect(isReloadBlocked()).toBe(true)
    expect(progress).toHaveBeenCalledWith({ loaded: chunkBytes / 2, total: file.size, percent: 49 })
    expect(progress).toHaveBeenLastCalledWith({ loaded: file.size, total: file.size, percent: 100 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(reconnecting).toHaveBeenCalledWith(true)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toEqual(result)
    expect(apiUpload).toHaveBeenCalledTimes(2)
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining('/public/backup-import-jobs/'), {
      anonymous: true, activity: 'background', headers: { Authorization: 'BackupImport scoped-secret' },
    })
    expect(isReloadBlocked()).toBe(false)
  })

  it('retries a lost chunk response at the same offset before starting restore', async () => {
    const file = new File(['archive'], 'backup.zip')
    vi.mocked(api).mockImplementation(async (path) => path.endsWith('/import-jobs') ? state('uploading') : { ...state('completed'), result })
    vi.mocked(apiUpload).mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValueOnce(state('uploading', file.size))
    const promise = importBackupArchive(file)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toEqual(result)
    expect(apiUpload).toHaveBeenCalledTimes(2)
    expect(vi.mocked(apiUpload).mock.calls[0][0]).toEqual(vi.mocked(apiUpload).mock.calls[1][0])
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/start'))).toHaveLength(1)
  })

  it('checks status after a lost start response and never starts the same restore twice', async () => {
    const file = new File(['archive'], 'backup.zip')
    let polls = 0
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith('/import-jobs')) return state('uploading')
      if (path.endsWith('/start')) throw new ApiError(524, 'CF timeout', null)
      if (++polls === 1) return state('restoring', file.size)
      return { ...state('completed'), result }
    })
    vi.mocked(apiUpload).mockResolvedValue(state('uploading', file.size))
    const promise = importBackupArchive(file)
    await vi.advanceTimersByTimeAsync(2500)
    await expect(promise).resolves.toEqual(result)
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/start'))).toHaveLength(1)
  })

  it('rejects storage exhaustion without retrying or submitting a restore', async () => {
    const file = new File(['archive'], 'backup.zip')
    vi.mocked(api).mockResolvedValue(state('uploading'))
    vi.mocked(apiUpload).mockRejectedValue(new ApiError(507, 'insufficient storage', null))
    await expect(importBackupArchive(file)).rejects.toMatchObject({ status: 507 })
    expect(apiUpload).toHaveBeenCalledOnce()
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/start'))).toBe(false)
    expect(isReloadBlocked()).toBe(false)
  })

  it('reports a failed restore rather than treating upload completion as success', async () => {
    const file = new File(['bad archive'], 'backup.zip')
    vi.mocked(api).mockImplementation(async (path) => path.endsWith('/import-jobs') ? state('uploading') : {
      ...state('failed'), error: 'invalid backup archive', http_status: 400,
    })
    vi.mocked(apiUpload).mockResolvedValue(state('uploading', file.size))
    await expect(importBackupArchive(file)).rejects.toMatchObject({ status: 400, message: 'invalid backup archive' })
    expect(isReloadBlocked()).toBe(false)
  })

  it('reuses the upload ID and acknowledged offset when both upload and cleanup lost the network', async () => {
    const file = new File([new Uint8Array(chunkBytes + 16)], 'retry.zip')
    let connected = false
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === 'DELETE') throw new TypeError('offline')
      if (path.endsWith('/import-jobs')) return state('uploading', connected ? chunkBytes : 0)
      return { ...state('completed'), result }
    })
    vi.mocked(apiUpload).mockImplementation(async () => {
      if (!connected) throw new TypeError('offline')
      return state('uploading', file.size)
    })
    const failed = importBackupArchive(file).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3500)
    expect(await failed).toBeInstanceOf(TypeError)
    connected = true
    await expect(importBackupArchive(file)).resolves.toEqual(result)
    const creations = vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/import-jobs'))
    expect(creations).toHaveLength(2)
    expect(creations[0][1]?.body).toEqual(creations[1][1]?.body)
    expect(vi.mocked(apiUpload).mock.calls.at(-1)?.[0]).toContain(`offset=${chunkBytes}`)
  })

  it('marks a lost server job as an unknown outcome without submitting another restore', async () => {
    const file = new File(['archive'], 'backup.zip')
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith('/import-jobs')) return state('uploading')
      if (path.endsWith('/start')) return state('restoring', file.size)
      throw new ApiError(404, 'server restarted', null)
    })
    vi.mocked(apiUpload).mockResolvedValue(state('uploading', file.size))
    const failed = importBackupArchive(file).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2500)
    expect(await failed).toMatchObject({ status: 0, body: { code: 'backup_import_status_unknown' } })
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/start'))).toHaveLength(1)
    expect(isReloadBlocked()).toBe(false)
  })
})

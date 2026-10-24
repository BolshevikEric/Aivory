import { api, apiUpload, ApiError, type UploadProgress } from './client'
import type { BackupImportResult } from './endpoints'
import { randomUUID } from '@/lib/random-uuid'
import { blockReload } from '@/lib/sync-guards'

export interface BackupImportOptions {
  onProgress?: (progress: UploadProgress) => void
  onUploaded?: () => void
  onReconnecting?: (reconnecting: boolean) => void
}

interface ImportJob {
  id: string
  token?: string
  status: 'uploading' | 'restoring' | 'completed' | 'failed'
  total_bytes: number
  uploaded_bytes: number
  chunk_bytes: number
  result?: BackupImportResult
  error?: string
  error_code?: string
  http_status?: number
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
const transient = (error: unknown) => !(error instanceof ApiError)
  || [0, 408, 429, 500, 502, 503, 504, 520, 522, 524].includes(error.status)

// If an upload and its cleanup both lose the connection, retrying the same
// selected File reuses its upload ID and the server's acknowledged offset.
// Never reuse an ID once a destructive start has been attempted.
let pendingUpload: { file: File; id: string } | undefined

async function discardUpload(id: string): Promise<void> {
  try {
    await api(`/admin/backup/import-jobs/${encodeURIComponent(id)}`, { method: 'DELETE', activity: 'background' })
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error
  }
}

async function retry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action()
    } catch (error) {
      if (attempt >= 2 || !transient(error)) throw error
      await wait(1000 * (attempt + 1))
    }
  }
}

/** Keep every upload request small enough for proxied deployments. Only the
 * final acknowledged byte count advances progress; retries never append twice.
 * Restore runs independently of the browser and its login session. */
export async function importBackupArchive(file: File, options: BackupImportOptions = {}): Promise<BackupImportResult> {
  const releaseReloadBlock = blockReload()
  const previousUpload = pendingUpload
  const id = previousUpload?.file === file ? previousUpload.id : randomUUID()
  const path = `/admin/backup/import-jobs/${encodeURIComponent(id)}`
  let token: string | undefined
  let startAttempted = false
  let outcomeKnown = false
  const status = () => api<ImportJob>(`/public/backup-import-jobs/${encodeURIComponent(id)}`, {
    anonymous: true,
    activity: 'background',
    headers: { Authorization: `BackupImport ${token}` },
  })
  try {
    if (previousUpload && previousUpload.id !== id) {
      // The server only permits cancellation while the old job is uploading.
      await discardUpload(previousUpload.id)
    }
    pendingUpload = { file, id }
    let job = await retry(() => api<ImportJob>('/admin/backup/import-jobs', {
      method: 'POST', body: { id, size_bytes: file.size, confirm: 'REPLACE' },
    }))
    token = job.token
    if (!token || !Number.isSafeInteger(job.chunk_bytes) || job.chunk_bytes <= 0) {
      throw new Error('Invalid backup upload response')
    }
    if (job.status !== 'uploading') {
      pendingUpload = undefined
      throw new ApiError(409, 'backup upload is no longer accepting chunks; select the file again', null)
    }
    // Use at most 4 MiB even if a newer backend offers a larger chunk size.
    const chunkBytes = Math.min(job.chunk_bytes, 4 * 1024 * 1024)
    while (job.uploaded_bytes < file.size) {
      const offset = job.uploaded_bytes
      const end = Math.min(file.size, offset + chunkBytes)
      const chunk = file.slice(offset, end)
      options.onProgress?.({ loaded: offset, total: file.size, percent: Math.floor(offset / file.size * 100) })
      job = await retry(() => {
        const form = new FormData()
        form.append('confirm', 'REPLACE')
        form.append('file', chunk, 'backup.part')
        return apiUpload<ImportJob>(`${path}/chunks?offset=${offset}`, form, {
          onProgress: (progress) => {
            // XHR totals include multipart headers. Scale each request to the
            // actual chunk so the page reports archive bytes, not form bytes.
            if (!progress.total) return
            const loaded = offset + Math.min(chunk.size, Math.floor(progress.loaded / progress.total * chunk.size))
            options.onProgress?.({ loaded, total: file.size, percent: Math.floor(loaded / file.size * 100) })
          },
        })
      })
      if (job.uploaded_bytes !== end) throw new Error('Invalid backup upload offset')
    }
    options.onProgress?.({ loaded: file.size, total: file.size, percent: 100 })
    options.onUploaded?.()
    startAttempted = true
    pendingUpload = undefined
    // A lost start response is ambiguous: query the capability endpoint before
    // resending. The server also makes start idempotent.
    try {
      job = await api<ImportJob>(`${path}/start`, { method: 'POST' })
    } catch (error) {
      if (!transient(error)) throw error
      job = await retry(status)
      if (job.status === 'uploading') job = await retry(() => api<ImportJob>(`${path}/start`, { method: 'POST' }))
    }
    while (job.status === 'restoring') {
      await wait(2000)
      try {
        job = await status()
        options.onReconnecting?.(false)
      } catch (error) {
        if (!transient(error)) throw error
        // The restore continues even if CF or the connection temporarily fails.
        // Keep checking; never silently submit another destructive restore.
        options.onReconnecting?.(true)
      }
    }
    outcomeKnown = job.status === 'completed' || job.status === 'failed'
    if (job.status === 'completed' && job.result?.ok) return job.result
    throw new ApiError(job.http_status || 500, job.error || 'backup restore failed', { code: job.error_code })
  } catch (error) {
    if (!startAttempted) {
      // Only discard an upload that has never been submitted for restore.
      try {
        await discardUpload(id)
        if (pendingUpload?.id === id) pendingUpload = undefined
      } catch { /* Reuse this upload ID if the same file is retried. */ }
    } else if (!outcomeKnown) {
      throw new ApiError(0, 'backup restore status could not be verified', { code: 'backup_import_status_unknown' })
    }
    throw error
  } finally {
    releaseReloadBlock()
  }
}

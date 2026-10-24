import { api, apiUpload, ApiError, type UploadProgress } from './client'
import type { BackupArchiveFile, BackupImportResult } from './endpoints'
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

// If creation/upload and cleanup both lose the connection, retrying the same
// source reuses its job ID and the server's acknowledged offset or pinned ZIP.
// Never reuse an ID once a destructive start has been attempted.
let pendingImport: { file?: File; archive?: BackupArchiveFile; id: string } | undefined

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
  return importBackupSource({ file }, options)
}

export async function restoreServerBackupArchive(archive: BackupArchiveFile, options: BackupImportOptions = {}): Promise<BackupImportResult> {
  return importBackupSource({ archive }, options)
}

async function importBackupSource(source: { file: File; archive?: never } | { archive: BackupArchiveFile; file?: never }, options: BackupImportOptions): Promise<BackupImportResult> {
  const file = source.file
  const size = file?.size ?? source.archive!.size_bytes
  const releaseReloadBlock = blockReload()
  const previousUpload = pendingImport
  const sameSource = previousUpload && (file
    ? previousUpload.file === file
    : previousUpload.archive?.name === source.archive?.name
      && previousUpload.archive?.size_bytes === size
      && previousUpload.archive?.created_at === source.archive?.created_at)
  const id = sameSource ? previousUpload.id : randomUUID()
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
    pendingImport = { ...source, id }
    let job = await retry(() => api<ImportJob>('/admin/backup/import-jobs', {
      method: 'POST', body: { id, size_bytes: size, confirm: 'REPLACE', ...(source.archive ? { archive_name: source.archive.name } : {}) },
    }))
    token = job.token
    if (!token || !Number.isSafeInteger(job.chunk_bytes) || job.chunk_bytes <= 0) {
      throw new Error('Invalid backup upload response')
    }
    if (job.status !== 'uploading') {
      pendingImport = undefined
      throw new ApiError(409, 'backup upload is no longer accepting chunks; select the file again', null)
    }
    // Use at most 4 MiB even if a newer backend offers a larger chunk size.
    let chunkBytes = Math.min(job.chunk_bytes, 4 * 1024 * 1024)
    while (file && job.uploaded_bytes < file.size) {
      const offset = job.uploaded_bytes
      const end = Math.min(file.size, offset + chunkBytes)
      const chunk = file.slice(offset, end)
      options.onProgress?.({ loaded: offset, total: file.size, percent: Math.floor(offset / file.size * 100) })
      try {
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
      } catch (error) {
        // A proxy can reject 4 MiB even though the API accepts it (Nginx often
        // defaults to 1 MiB including multipart headers). Retry a smaller chunk
        // at the same acknowledged offset, down to 256 KiB.
        if (error instanceof ApiError && error.status === 413 && chunkBytes > 256 * 1024) {
          chunkBytes = Math.max(256 * 1024, Math.floor(chunkBytes / 2))
          continue
        }
        throw error
      }
      if (job.uploaded_bytes !== end) throw new Error('Invalid backup upload offset')
    }
    if (job.uploaded_bytes !== size) throw new Error('Invalid backup source size')
    if (file) options.onProgress?.({ loaded: size, total: size, percent: 100 })
    options.onUploaded?.()
    startAttempted = true
    pendingImport = undefined
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
        if (pendingImport?.id === id) pendingImport = undefined
      } catch { /* Reuse this upload ID if the same file is retried. */ }
    } else if (!outcomeKnown) {
      throw new ApiError(0, 'backup restore status could not be verified', { code: 'backup_import_status_unknown' })
    }
    throw error
  } finally {
    releaseReloadBlock()
  }
}

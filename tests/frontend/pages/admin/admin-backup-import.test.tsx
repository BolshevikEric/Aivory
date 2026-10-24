// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminBackup from '@/pages/admin/AdminBackup'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BackupImportOptions } from '@/api/backup-import'

const { backupImport, backupRestoreServerArchive, backupExportState, success, error } = vi.hoisted(() => ({
  backupImport: vi.fn(), backupRestoreServerArchive: vi.fn(), backupExportState: vi.fn(), success: vi.fn(), error: vi.fn(),
}))
vi.mock('@/api', () => ({
  adminApi: { backupImport, backupRestoreServerArchive, backupExportState, vectorMaintenanceState: async () => ({ running: null, jobs: [] }) },
  ApiError: class extends Error {},
}))
vi.mock('@/hooks/use-toast', () => ({ toast: { error, success } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => key + (opts ? ` ${JSON.stringify(opts)}` : '') }),
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  backupImport.mockReset(); backupRestoreServerArchive.mockReset(); backupExportState.mockReset(); success.mockReset(); error.mockReset()
  backupExportState.mockResolvedValue({ running: null, jobs: [], archives: [], max_import_bytes: 1024 * 1024 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent === text)
  if (!found) throw new Error(`missing button: ${text}`)
  return found
}

async function mountAndPick(size = 1024) {
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(AdminBackup)))))
  const input = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="admin:backup.import.choose"]')!
  const file = new File([new Uint8Array(size)], 'backup.zip', { type: 'application/zip' })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  return file
}

async function confirmImport() {
  await act(async () => button('admin:backup.import.action').click())
  const confirmation = document.querySelector<HTMLInputElement>('input[placeholder="REPLACE"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(confirmation, 'REPLACE')
    confirmation.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('admin:backup.confirm.action').click())
}

describe('backup upload progress', () => {
  it('confirms a server archive and waits for restore without uploading a browser file', async () => {
    const archive = { name: 'server-migration.zip', size_bytes: 1024, created_at: 123 }
    backupExportState.mockResolvedValue({ running: null, jobs: [], archives: [], server_archives: [archive], backup_directory: '/app/data/backups' })
    let rejectRestore!: (error: unknown) => void
    backupRestoreServerArchive.mockImplementation(() => new Promise((_resolve, reject) => { rejectRestore = reject }))
    await act(async () => root.render(createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(AdminBackup)))))
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"][value="server"]')!.click())
    expect(container.textContent).toContain('/app/data/backups')
    const select = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => { select.value = archive.name; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await confirmImport()
    expect(backupRestoreServerArchive).toHaveBeenCalledWith(archive, expect.any(Object))
    expect(backupImport).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(archive.name)
    expect(document.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
    expect(document.body.textContent).toContain('admin:backup.import.serverRestoringHint')
    expect(success).not.toHaveBeenCalled()
    await act(async () => rejectRestore(new TypeError('connection failed before start')))
  })

  it('refreshes server archives without choosing or restoring one automatically', async () => {
    await mountAndPick()
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"][value="server"]')!.click())
    expect(button('admin:backup.import.action').disabled).toBe(true)
    backupExportState.mockResolvedValue({ running: null, jobs: [], archives: [], server_archives: [{ name: 'copied.zip', size_bytes: 123, created_at: 456 }] })
    await act(async () => button('admin:backup.import.serverRefresh').click())
    expect(container.querySelector('select')?.textContent).toContain('copied.zip')
    expect(button('admin:backup.import.action').disabled).toBe(true)
    expect(backupRestoreServerArchive).not.toHaveBeenCalled()
  })

  it('shows real bytes in the dialog and switches to indeterminate restore until the server finishes', async () => {
    let callbacks!: BackupImportOptions
    let rejectImport!: (error: unknown) => void
    backupImport.mockImplementation((_file: File, opts: BackupImportOptions) => {
      callbacks = opts
      return new Promise((_resolve, reject) => { rejectImport = reject })
    })
    const file = await mountAndPick()
    await confirmImport()
    expect(backupImport).toHaveBeenCalledWith(file, expect.any(Object))
    await act(async () => callbacks.onProgress?.({ loaded: 512, total: 1024, percent: 50 }))
    let progress = document.querySelector('[role="progressbar"]')!
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
    expect(document.body.textContent).toContain('50%')
    expect(document.body.textContent).toContain('512 B')
    expect(document.querySelector<HTMLInputElement>('input[placeholder="REPLACE"]')?.disabled).toBe(true)
    await act(async () => callbacks.onUploaded?.())
    progress = document.querySelector('[role="progressbar"]')!
    expect(progress.hasAttribute('aria-valuenow')).toBe(false)
    expect(document.body.textContent).toContain('admin:backup.import.restoringHint')
    expect(success).not.toHaveBeenCalled()
    await act(async () => callbacks.onReconnecting?.(true))
    expect(document.body.textContent).toContain('admin:backup.import.reconnecting')
    await act(async () => rejectImport(new TypeError('connection lost')))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('admin:backup.import.statusLost')
    expect(button('admin:backup.confirm.action').disabled).toBe(true)
  })

  it('rejects a known oversized archive before starting any upload', async () => {
    await mountAndPick(1024 * 1024 + 1)
    expect(button('admin:backup.import.action').disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('admin:backup.import.tooLarge')
    expect(backupImport).not.toHaveBeenCalled()
  })

  it('keeps an upload failure visible and permits a retry before restore starts', async () => {
    backupImport.mockRejectedValue(new TypeError('network failure'))
    await mountAndPick()
    await confirmImport()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('admin:backup.import.connectionFailed')
    expect(button('admin:backup.confirm.action').disabled).toBe(false)
    expect(success).not.toHaveBeenCalled()
  })
})

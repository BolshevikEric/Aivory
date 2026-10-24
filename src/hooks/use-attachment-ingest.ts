import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { conversationsApi } from '@/api/endpoints'
import { DOCUMENT_PARSER_NOT_CONFIGURED } from '@/lib/document-errors'
import { envNum } from '@/lib/env-config'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from 'react-i18next'
import { isPermanentPollingError, useForegroundPolling } from './use-foreground-polling'

interface IngestAttachment {
  id: string
  uploadScopeId?: string
  documentId?: string
  ingest?: 'parsing' | 'embedding' | 'ready' | 'failed'
  ingestErrorCode?: string
  ingestRetrying?: boolean
}

const INGEST_POLL_MS = envNum('VITE_AIVORY_INGEST_POLL_MS', 1200)

export function useAttachmentIngest<T extends IngestAttachment>(
  attachments: T[],
  setAttachments: Dispatch<SetStateAction<T[]>>,
  enabled: boolean,
  resourceKey?: string,
): void {
  const { t } = useTranslation('chat')
  const missing = useRef(new Map<string, number>())
  const latest = useRef(attachments)
  const pending = attachments.filter((a) => a.uploadScopeId && a.documentId && !a.ingestRetrying &&
    (a.ingest === 'parsing' || a.ingest === 'embedding'))
  useEffect(() => {
    latest.current = attachments
    const ids = new Set(pending.map((a) => a.id))
    for (const id of missing.current.keys()) if (!ids.has(id)) missing.current.delete(id)
  })

  useForegroundPolling(async (signal) => {
    const updates = new Map<string, Pick<IngestAttachment, 'ingest' | 'ingestErrorCode'>>()
    const failures: string[] = []
    // Every attachment in a scope shares this one list request.
    for (const scopeId of new Set(pending.map((a) => a.uploadScopeId!))) {
      const targets = pending.filter((a) => a.uploadScopeId === scopeId)
      try {
        const docs = await conversationsApi.listDocs(scopeId, { signal, activity: 'background' })
        if (signal.aborted) return
        const byId = new Map(docs.map((doc) => [doc.id, doc]))
        for (const target of targets) {
          if (!latest.current.some((a) => a.id === target.id && a.documentId === target.documentId && !a.ingestRetrying &&
            (a.ingest === 'parsing' || a.ingest === 'embedding'))) continue
          const doc = byId.get(target.documentId!)
          if (!doc) {
            const attempts = (missing.current.get(target.id) ?? 0) + 1
            missing.current.set(target.id, attempts)
            if (attempts < 3) continue
            updates.set(target.id, { ingest: 'failed' })
            failures.push(target.id)
            continue
          }
          missing.current.delete(target.id)
          updates.set(target.id, {
            ingest: doc.status === 'ready' || doc.status === 'failed' ? doc.status :
              doc.status === 'embedding' ? 'embedding' : 'parsing',
            ingestErrorCode: doc.error_code,
          })
          if (doc.status === 'failed') failures.push(target.id)
        }
      } catch (error) {
        if (signal.aborted) return
        if (!isPermanentPollingError(error)) throw error
        for (const target of targets) updates.set(target.id, { ingest: 'failed' })
      }
    }
    if (signal.aborted) return
    setAttachments((current) => {
      if (signal.aborted) return current
      return current.map((a) => {
        const update = updates.get(a.id)
        // Removed, retried or completed attachments cannot be restored by an old reply.
        return update && !a.ingestRetrying && (a.ingest === 'parsing' || a.ingest === 'embedding') ? { ...a, ...update } : a
      })
    })
    for (const id of failures) {
      const parserMissing = updates.get(id)?.ingestErrorCode === DOCUMENT_PARSER_NOT_CONFIGURED
      toast.error(parserMissing
        ? t('composer.parserNotConfiguredToast', { defaultValue: 'Document parsing (OCR) is not configured on this server' })
        : t('composer.ingestFailed', { defaultValue: 'Could not read this file' }))
    }
  }, { enabled: enabled && pending.length > 0, intervalMs: INGEST_POLL_MS, resourceKey })
}

import { lazy, Suspense, useEffect, useState } from 'react'
import { Download, Image, FileText, Share2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import type { ConversationSharePreview } from '@/hooks/use-conversation-share'
import { saveConversationShareFile, type ConversationShareFormat, type ConversationShareQuality } from '@/lib/conversation-share'

const PdfPreview = lazy(() => import('@/components/files/pdf-native-preview').then(module => ({ default: module.PdfNativePreview })))
const formats: ConversationShareFormat[] = ['image', 'pdf', 'json', 'txt']

export function ImageShareToolbar({ count, busy, error, format, quality, stage, onFormat, onQuality, onSelectAll, onClear, onCancel, onGenerate }: {
  count: number; busy: boolean; error?: string; format: ConversationShareFormat; quality: ConversationShareQuality; stage: string
  onFormat: (format: ConversationShareFormat) => void; onQuality: (quality: ConversationShareQuality) => void
  onSelectAll: () => void; onClear: () => void; onCancel: () => void; onGenerate: () => void
}) {
  const { t } = useTranslation(['chat', 'common'])
  const selectClass = 'h-8 max-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-fg)]'
  return <div data-image-share-toolbar className="mx-auto flex w-full max-w-[var(--layout-message-max-w)] flex-col gap-3 px-3 py-3 sm:px-6 lg:px-8" aria-busy={busy}>
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1"><span className="text-sm font-medium">{t('chat:shareImage.selected', { count })}</span><span role={error ? 'alert' : 'status'} className={`text-xs ${error ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]'}`}>{error || t(busy ? `chat:shareFile.${stage}` : 'chat:shareImage.selectHint')}</span></div>
      <Button variant="ghost" size="sm" onClick={onCancel} leadingIcon={<X size={14} />}>{t('common:actions.cancel')}</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={t('chat:shareFile.format')} className={selectClass} disabled={busy} value={format} onChange={event => onFormat(event.target.value as ConversationShareFormat)}>{formats.map(value => <option key={value} value={value}>{t(`chat:shareFile.${value}`)}</option>)}</select>
      {format === 'image' && <select aria-label={t('chat:shareFile.quality')} className={selectClass} disabled={busy} value={quality} onChange={event => onQuality(event.target.value as ConversationShareQuality)}><option value="standard">{t('chat:shareFile.standard')}</option><option value="high">{t('chat:shareFile.high')}</option></select>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={onSelectAll}>{t('chat:shareImage.selectAll')}</Button>
      <Button variant="ghost" size="sm" disabled={busy || !count} onClick={onClear}>{t('chat:shareImage.clear')}</Button>
      <span className="flex-1" />
      <Button size="sm" disabled={!count || busy} loading={busy} leadingIcon={format === 'image' ? <Image size={14} /> : <FileText size={14} />} onClick={onGenerate}>{t(format === 'image' ? busy ? 'chat:shareImage.generating' : 'chat:shareImage.generate' : busy ? 'chat:shareFile.generating' : 'chat:shareFile.generate')}</Button>
    </div>
  </div>
}

export function ConversationImagePreviewDialog({ pages, format, onClose, onBack }: { pages: ConversationSharePreview[]; format: ConversationShareFormat; onClose: () => void; onBack: () => void }) {
  const { t } = useTranslation('chat')
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [text, setText] = useState('')
  const current = pages[0]
  useEffect(() => {
    let active = true
    setData(null); setText('')
    if (current && format === 'pdf') void current.blob.arrayBuffer().then(value => { if (active) setData(value) })
    if (current && (format === 'json' || format === 'txt')) void current.blob.slice(0, 200_000).text().then(value => { if (active) setText(value + (current.blob.size > 200_000 ? `\n\n${t('shareFile.previewTruncated')}` : '')) })
    return () => { active = false }
  }, [current, format, t])
  const file = current && typeof File !== 'undefined' ? new File([current.blob], current.filename, { type: current.blob.type }) : null
  const canShare = file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  async function share() {
    if (!file || saving) return
    setSaving(true)
    try { await navigator.share({ files: [file], title: current.filename }) }
    catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) toast.error(t('shareFile.shareFailed')) }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent size="lg" className="border-0" data-image-share-preview data-share-format={format}>
      <DialogHeader className="pr-14"><DialogTitle>{t(format === 'image' ? 'shareImage.previewTitle' : `shareFile.as${format.toUpperCase()}`)}</DialogTitle><DialogDescription>{t(format === 'image' ? 'shareImage.previewHint' : 'shareFile.previewHint')}</DialogDescription></DialogHeader>
      <DialogBody className="bg-[var(--color-bg-muted)] px-4 py-4">
        {current && format === 'image' && <img src={current.url} alt={t('shareImage.previewAlt')} className="mx-auto block h-auto w-full max-w-[760px] rounded-lg" />}
        {current && format === 'pdf' && data && <Suspense fallback={<p role="status">{t('shareFile.preparing')}</p>}><PdfPreview data={data} name={current.filename} className="h-[60dvh] min-h-64" labels={{ loading: t('shareFile.preparing'), previousPage: t('shareFile.previousPage'), nextPage: t('shareFile.nextPage'), page: page => String(page), of: total => `/ ${total}`, zoomOut: t('shareFile.zoomOut'), zoomIn: t('shareFile.zoomIn'), fitWidth: t('shareFile.fitWidth'), renderFailed: t('shareFile.previewFailed') }} /></Suspense>}
        {(format === 'json' || format === 'txt') && <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed" data-share-text-preview>{text}</pre>}
      </DialogBody>
      <DialogFooter className="flex-wrap border-0">
        <Button variant="ghost" size="sm" onClick={onBack}>{t('shareImage.reselect')}</Button>
        {canShare && <Button variant="ghost" size="sm" loading={saving} leadingIcon={<Share2 size={14} />} onClick={() => void share()}>{t('shareFile.systemShare')}</Button>}
        <Button size="sm" disabled={!current} leadingIcon={<Download size={14} />} onClick={() => current && saveConversationShareFile(current)}>{t(format === 'image' ? 'shareImage.save' : 'shareFile.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

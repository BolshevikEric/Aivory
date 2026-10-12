import { useState } from 'react'
import { Download, Image, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ConversationImagePreview } from '@/hooks/use-conversation-image-share'

export function ImageShareToolbar({ count, busy, error, onSelectAll, onClear, onCancel, onGenerate }: {
  count: number; busy: boolean; error?: string; onSelectAll: () => void; onClear: () => void; onCancel: () => void; onGenerate: () => void
}) {
  const { t } = useTranslation(['chat', 'common'])
  return <div data-image-share-toolbar className="mx-auto flex w-full max-w-[var(--layout-message-max-w)] flex-col gap-3 px-3 py-3 sm:px-6 lg:px-8" aria-busy={busy}>
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1"><span className="text-sm font-medium">{t('chat:shareImage.selected', { count })}</span><span role={error ? 'alert' : undefined} className={`text-xs ${error ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]'}`}>{error || t('chat:shareImage.selectHint')}</span></div>
      <Button variant="ghost" size="sm" onClick={onCancel} leadingIcon={<X size={14} />}>{t('common:actions.cancel')}</Button>
    </div>
    <div className="flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" disabled={busy} onClick={onSelectAll}>{t('chat:shareImage.selectAll')}</Button>
      <Button variant="ghost" size="sm" disabled={busy || !count} onClick={onClear}>{t('chat:shareImage.clear')}</Button>
      <span className="flex-1" />
      <Button size="sm" disabled={!count || busy} loading={busy} leadingIcon={<Image size={14} />} onClick={onGenerate}>{t(busy ? 'chat:shareImage.generating' : 'chat:shareImage.generate')}</Button>
    </div>
  </div>
}

export function ConversationImagePreviewDialog({ pages, onClose, onBack }: { pages: ConversationImagePreview[]; onClose: () => void; onBack: () => void }) {
  const { t } = useTranslation('chat')
  const [saving, setSaving] = useState(false)
  const current = pages[0]
  async function save() {
    if (!current || saving) return
    setSaving(true)
    try {
      const { saveConversationImage } = await import('@/lib/conversation-image')
      saveConversationImage(current)
    } finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent size="lg" className="border-0" data-image-share-preview>
      <DialogHeader className="pr-14"><DialogTitle>{t('shareImage.previewTitle')}</DialogTitle><DialogDescription>{t('shareImage.previewHint')}</DialogDescription></DialogHeader>
      <DialogBody className="bg-[var(--color-bg-muted)] px-4 py-4">
        {current && <img src={current.url} alt={t('shareImage.previewAlt')} className="mx-auto block h-auto w-full max-w-[760px] rounded-lg" />}
      </DialogBody>
      <DialogFooter className="flex-wrap border-0">
        <Button variant="ghost" size="sm" onClick={onBack}>{t('shareImage.reselect')}</Button>
        <Button size="sm" loading={saving} leadingIcon={<Download size={14} />} onClick={() => void save()}>{t('shareImage.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

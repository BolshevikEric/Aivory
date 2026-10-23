import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, ApiError } from '@/api'
import { AdminPageHeader } from '@/components/admin/admin-page-header'
import { SettingsActions, SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/settings-section'
import { PanelFallback } from '@/components/ui/panel-fallback'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/components/ui/label'
import { toast } from '@/hooks/use-toast'
import { useSiteStatus, type SiteStatus } from '@/store/site-status'

export default function AdminSiteAccess({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation(['admin', 'auth', 'common'])
  const [closed, setClosed] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    adminApi.settings().then((settings) => {
      if (!active) return
      const cfg = settings.site_access as SiteStatus | undefined
      setClosed(cfg?.closed === true)
      setMessage(typeof cfg?.message === 'string' ? cfg.message : '')
    }).catch((error) => {
      if (!active) return
      setFailed(true)
      toast.error(error instanceof ApiError ? error.message : t('admin:common.failed'))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // A language sync must not replace an unsaved closure message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  async function save() {
    setSaving(true)
    try {
      const cfg = { closed, message: message.trim() }
      await adminApi.updateSettings({ site_access: cfg })
      useSiteStatus.getState().apply(cfg)
      setMessage(cfg.message)
      toast.success(t('admin:settings.saved'))
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t('admin:common.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <AdminPageHeader headingLevel={embedded ? 2 : 1} title={t('admin:siteAccess.title')} description={t('admin:siteAccess.description')} />
      {loading ? <PanelFallback /> : (
        <div className="mt-8">
          <SettingsSection>
            <SettingsRow label={t('admin:siteAccess.closed')} description={t('admin:siteAccess.closedHint')} htmlFor="site-closed">
              <Switch id="site-closed" checked={closed} onCheckedChange={setClosed} disabled={saving || failed} />
            </SettingsRow>
            <SettingsBlock>
              <Field label={t('admin:siteAccess.message')} htmlFor="site-closed-message" hint={t('admin:siteAccess.messageHint')}>
                <Textarea id="site-closed-message" rows={5} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('auth:siteClosed.description')} disabled={saving || failed} />
              </Field>
            </SettingsBlock>
          </SettingsSection>
          <SettingsActions>
            {failed ? <Button variant="secondary" onClick={() => setRevision((v) => v + 1)}>{t('common:actions.tryAgain')}</Button> : null}
            <Button loading={saving} disabled={failed} onClick={() => void save()}>{t('common:actions.save')}</Button>
          </SettingsActions>
        </div>
      )}
    </div>
  )
}

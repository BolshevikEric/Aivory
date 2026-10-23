import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Eye, LockKeyhole, Mail, Plus, Trash2 } from 'lucide-react'
import { adminApi, ApiError } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { PanelFallback } from '@/components/ui/panel-fallback'
import { AdminPageHeader } from '@/components/admin/admin-page-header'
import { SettingsActions, SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/settings-section'
import { EMAIL_PURPOSES, emailDeliveryFromSettings, isRequiredEmail, type EmailDeliveryConfig, type EmailPurpose, type SMTPAccount } from '@/lib/email-delivery'
import { randomUUID } from '@/lib/random-uuid'

export default function AdminSystemEmail() {
  const { t, i18n } = useTranslation(['admin', 'common'])
  const [draft, setDraft] = useState<EmailDeliveryConfig>(() => emailDeliveryFromSettings({}))
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [expandedAccount, setExpandedAccount] = useState('')
  const [previewPurpose, setPreviewPurpose] = useState<EmailPurpose | null>(null)

  async function load() {
    setLoading(true)
    setLoadFailed(false)
    try {
      const settings = await adminApi.settings()
      if (settings.email_delivery_invalid) throw new Error('invalid configuration')
      const config = emailDeliveryFromSettings(settings)
      setDraft(config)
      setExpandedAccount(config.accounts[0]?.id ?? '')
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  function updateAccount(id: string, patch: Partial<SMTPAccount>) {
    setError('')
    setDraft((current) => ({ ...current, accounts: current.accounts.map((account) => account.id === id ? { ...account, ...patch } : account) }))
  }

  function addAccount() {
    const id = randomUUID()
    const account: SMTPAccount = { id, name: '', host: '', port: '587', user: '', password: '', from: '', tls: false }
    setDraft((current) => ({
      accounts: [...current.accounts, account],
      rules: Object.fromEntries(EMAIL_PURPOSES.map((purpose) => [purpose, {
        ...current.rules[purpose], account_id: current.rules[purpose].account_id || id,
      }])) as EmailDeliveryConfig['rules'],
    }))
    setExpandedAccount(id)
    setError('')
  }

  function updateRule(purpose: EmailPurpose, patch: Partial<EmailDeliveryConfig['rules'][EmailPurpose]>) {
    setError('')
    setDraft((current) => ({ ...current, rules: { ...current.rules, [purpose]: { ...current.rules[purpose], ...patch, ...(isRequiredEmail(purpose) ? { enabled: true } : {}) } } }))
  }

  async function save() {
    if (saving) return
    if (!draft.accounts.length || draft.accounts.some((a) => !a.name.trim() || !a.host.trim() || !(/^\d+$/.test(a.port) && Number(a.port) >= 1 && Number(a.port) <= 65535) || !(a.from.trim() || a.user.trim())) ||
      EMAIL_PURPOSES.some((purpose) => !draft.accounts.some((a) => a.id === draft.rules[purpose].account_id))) {
      setError(t('admin:emailDelivery.invalid'))
      return
    }
    setSaving(true)
    setError('')
    try {
      const settings = await adminApi.updateSettings({ email_delivery: draft })
      setDraft(emailDeliveryFromSettings(settings))
      toast.success(t('admin:settings.saved'))
    } catch (err) {
      setError(err instanceof ApiError && ['invalid_input', 'invalid input'].includes(err.message) ? t('admin:emailDelivery.invalid') : t('admin:common.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <AdminPageHeader title={t('admin:menu.emailService')} description={t('admin:emailDelivery.lead')} />
      {loading ? <PanelFallback /> : loadFailed ? (
        <SettingsBlock>
          <p role="alert" className="mb-4 text-sm text-[var(--color-danger)]">{t('admin:emailDelivery.loadFailed')}</p>
          <Button variant="secondary" onClick={() => void load()}>{t('common:actions.tryAgain')}</Button>
        </SettingsBlock>
      ) : (
        <div className="mt-8">
          <SettingsSection id="email-accounts-title" title={t('admin:emailDelivery.accounts')} description={t('admin:emailDelivery.accountsHint')}
            actions={<Button variant="secondary" disabled={saving || draft.accounts.length >= 20} onClick={addAccount}><Plus size={15} aria-hidden />{t('admin:emailDelivery.addAccount')}</Button>}>
            {draft.accounts.length === 0 ? (
              <p className="py-5 text-sm text-[var(--color-fg-muted)]">{t('admin:emailDelivery.empty')}</p>
            ) : draft.accounts.map((account, index) => {
              const usedBy = EMAIL_PURPOSES.filter((purpose) => draft.rules[purpose].account_id === account.id)
              return (
                <div key={account.id} className="border-b border-[var(--color-border-subtle)] last:border-b-0" data-email-account={account.id}>
                  <button type="button" aria-expanded={expandedAccount === account.id} aria-controls={`email-account-${account.id}`} onClick={() => setExpandedAccount(expandedAccount === account.id ? '' : account.id)}
                    className="flex w-full min-w-0 items-center gap-3 rounded-lg py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
                    <Mail size={18} className="shrink-0 text-[var(--color-fg-muted)]" aria-hidden />
                    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{account.name || t('admin:emailDelivery.untitled', { number: index + 1 })}</span>
                      <span className="mt-0.5 block break-all text-xs text-[var(--color-fg-muted)]">{account.from || account.user || t('admin:emailDelivery.notConfigured')}</span></span>
                    <ChevronDown size={16} aria-hidden className={`shrink-0 text-[var(--color-fg-muted)] transition-transform ${expandedAccount === account.id ? 'rotate-180' : ''}`} />
                  </button>
                  <div id={`email-account-${account.id}`} hidden={expandedAccount !== account.id}>
                    <SettingsBlock className="flex flex-col gap-5 pb-5">
                      <Field label={t('admin:emailDelivery.accountName')} htmlFor={`name-${account.id}`}>
                        <Input id={`name-${account.id}`} value={account.name} maxLength={100} disabled={saving} placeholder={t('admin:emailDelivery.namePlaceholder')} onChange={(e) => updateAccount(account.id, { name: e.target.value })} />
                      </Field>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Field label={t('admin:settings.fields.smtpHost')} htmlFor={`host-${account.id}`} className="sm:col-span-2">
                          <Input id={`host-${account.id}`} data-admin-tour={index === 0 ? 'email-smtp-host' : undefined} value={account.host} disabled={saving} placeholder="smtp.example.com" onChange={(e) => updateAccount(account.id, { host: e.target.value })} />
                        </Field>
                        <Field label={t('admin:settings.fields.smtpPort')} htmlFor={`port-${account.id}`} hint={t('admin:settings.fields.smtpPortHint')}>
                          <Input id={`port-${account.id}`} inputMode="numeric" value={account.port} disabled={saving} onChange={(e) => updateAccount(account.id, { port: e.target.value })} />
                        </Field>
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Field label={t('admin:settings.fields.smtpUser')} htmlFor={`user-${account.id}`}>
                          <Input id={`user-${account.id}`} autoComplete="off" value={account.user} disabled={saving} onChange={(e) => updateAccount(account.id, { user: e.target.value })} />
                        </Field>
                        <Field label={t('admin:settings.fields.smtpPassword')} htmlFor={`password-${account.id}`} hint={t('admin:emailDelivery.passwordHint')}>
                          <Input id={`password-${account.id}`} type="password" autoComplete="new-password" value={account.password} disabled={saving} onFocus={(e) => e.target.select()} onChange={(e) => updateAccount(account.id, { password: e.target.value })} />
                        </Field>
                      </div>
                      <Field label={t('admin:settings.fields.smtpFrom')} htmlFor={`from-${account.id}`} hint={t('admin:settings.fields.smtpFromHint')}>
                        <Input id={`from-${account.id}`} value={account.from} disabled={saving} placeholder="Aivory <noreply@example.com>" onChange={(e) => updateAccount(account.id, { from: e.target.value })} />
                      </Field>
                      <SettingsRow label={t('admin:settings.fields.smtpTls')} description={t('admin:settings.fields.smtpTlsHint')} htmlFor={`tls-${account.id}`}>
                        <Switch id={`tls-${account.id}`} checked={account.tls} disabled={saving} onCheckedChange={(tls) => updateAccount(account.id, { tls })} />
                      </SettingsRow>
                      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-[var(--color-fg-muted)]">{usedBy.length ? t('admin:emailDelivery.usedBy', { types: usedBy.map((purpose) => t(`admin:emailDelivery.types.${purpose}.title`)).join(' · ') }) : t('admin:emailDelivery.unused')}</p>
                        <Button variant="ghost" disabled={saving || usedBy.length > 0} onClick={() => setDraft((current) => ({ ...current, accounts: current.accounts.filter((a) => a.id !== account.id) }))}>
                          <Trash2 size={14} aria-hidden />{t('common:actions.delete')}
                        </Button>
                      </div>
                      {usedBy.length ? <p className="text-xs text-[var(--color-fg-muted)]">{t('admin:emailDelivery.removeHint')}</p> : null}
                    </SettingsBlock>
                  </div>
                </div>
              )
            })}
          </SettingsSection>

          <SettingsSection id="email-types-title" title={t('admin:emailDelivery.typesTitle')} description={t('admin:emailDelivery.typesHint')}>
            {EMAIL_PURPOSES.map((purpose) => {
              const required = isRequiredEmail(purpose)
              const rule = draft.rules[purpose]
              return (
                <div key={purpose} data-email-purpose={purpose} className="flex flex-col gap-4 border-b border-[var(--color-border-subtle)] py-5 last:border-b-0 lg:flex-row lg:items-start lg:gap-8">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-sm font-medium">{t(`admin:emailDelivery.types.${purpose}.title`)}</h3>
                      {required ? <span className="inline-flex items-center gap-1 text-xs text-[var(--color-fg-muted)]"><LockKeyhole size={12} aria-hidden />{t('admin:emailDelivery.required')}</span> : null}
                    </div>
                    <p className="mt-1 max-w-xl text-xs leading-relaxed text-[var(--color-fg-muted)]">{t(`admin:emailDelivery.types.${purpose}.description`)}</p>
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPreviewPurpose(purpose)}><Eye size={14} aria-hidden />{t('admin:emailDelivery.preview')}</Button>
                  </div>
                  <div className="flex w-full flex-col gap-3 lg:w-72 lg:shrink-0">
                    <Field label={t('admin:emailDelivery.sender')} htmlFor={`sender-${purpose}`}>
                      <Select value={rule.account_id || undefined} disabled={saving || !draft.accounts.length} onValueChange={(account_id) => updateRule(purpose, { account_id })}>
                        <SelectTrigger id={`sender-${purpose}`} className="min-w-0 [&>span:first-child]:min-w-0 [&>span:first-child]:truncate"><SelectValue placeholder={t('admin:emailDelivery.chooseAccount')} /></SelectTrigger>
                        <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">{draft.accounts.map((account, index) => <SelectItem key={account.id} value={account.id} className="[overflow-wrap:anywhere]">{account.name || t('admin:emailDelivery.untitled', { number: index + 1 })}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    {!required ? <div className="flex items-center justify-between gap-3"><label htmlFor={`enabled-${purpose}`} className="text-xs text-[var(--color-fg-muted)]">{t('admin:emailDelivery.sendEnabled')}</label><Switch id={`enabled-${purpose}`} checked={rule.enabled} disabled={saving} onCheckedChange={(enabled) => updateRule(purpose, { enabled })} /></div> : null}
                  </div>
                </div>
              )
            })}
          </SettingsSection>
          {error ? <p role="alert" className="mt-5 text-sm text-[var(--color-danger)]">{error}</p> : null}
          <SettingsActions><Button loading={saving} onClick={() => void save()}>{t('common:actions.save')}</Button></SettingsActions>
        </div>
      )}
      <EmailPreview purpose={previewPurpose} locale={i18n.resolvedLanguage ?? i18n.language} onClose={() => setPreviewPurpose(null)} />
    </div>
  )
}

function EmailPreview({ purpose, locale, onClose }: { purpose: EmailPurpose | null; locale: string; onClose: () => void }) {
  const { t } = useTranslation('admin')
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setPreview(null)
    setFailed(false)
    if (purpose) void adminApi.emailPreview(purpose, locale).then((value) => { if (active) setPreview(value) }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [purpose, locale])
  return (
    <Dialog open={purpose !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="lg" mobileFullscreen>
        <DialogHeader><DialogTitle>{purpose ? t(`emailDelivery.types.${purpose}.title`) : t('emailDelivery.preview')}</DialogTitle><DialogDescription>{t('emailDelivery.previewHint')}</DialogDescription></DialogHeader>
        {failed ? <p role="alert" className="text-sm text-[var(--color-danger)]">{t('emailDelivery.previewFailed')}</p> : preview ? <>
          <p className="text-sm font-medium">{preview.subject}</p>
          <iframe title={t('emailDelivery.preview')} sandbox="" srcDoc={preview.html} className="h-[min(65dvh,680px)] w-full rounded-lg border border-[var(--color-border)] bg-white" />
        </> : <PanelFallback />}
      </DialogContent>
    </Dialog>
  )
}

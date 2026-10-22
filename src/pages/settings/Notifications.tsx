import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsRow, SettingsSection } from './SettingsLayout'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/store/auth'
import { useReplyNotificationPreferences } from '@/store/reply-notification-preferences'
import { replyNotificationPermission, type ReplyNotificationPermission } from '@/lib/reply-notifications'

export default function Notifications() {
  const { t } = useTranslation('settings')
  const userId = useAuth((state) => state.user?.id)
  const enabled = useReplyNotificationPreferences((state) => Boolean(userId && state.accounts[userId]))
  const [permission, setPermission] = useState<ReplyNotificationPermission | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const refresh = () => { void replyNotificationPermission().then((value) => { if (alive) setPermission(value) }) }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { alive = false; window.removeEventListener('focus', refresh) }
  }, [])

  async function toggle(value: boolean) {
    if (!userId || busy) return
    if (!value) { useReplyNotificationPreferences.getState().setEnabled(userId, false); return }
    setBusy(true)
    try {
      const result = await replyNotificationPermission(true)
      if (useAuth.getState().user?.id !== userId) return
      setPermission(result)
      if (result === 'granted') useReplyNotificationPreferences.getState().setEnabled(userId, true)
    } finally { setBusy(false) }
  }

  const blocked = permission === 'unsupported' || permission === 'desktop-update' || permission === 'denied'
  return (
    <div className="mx-auto max-w-[60rem]">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-normal text-[var(--color-fg)]">{t('notifications.title')}</h1>
        <p className="mt-1.5 text-sm text-[var(--color-fg-muted)]">{t('notifications.subtitle')}</p>
      </header>
      <SettingsSection title={t('notifications.section')} description={t('notifications.deviceOnly')}>
        <SettingsRow label={t('notifications.enabled')} description={t(window.aivoryDesktop ? 'notifications.desktopBody' : 'notifications.browserBody')}>
          <Switch
            checked={enabled}
            disabled={busy || permission === null || (blocked && !enabled)}
            onCheckedChange={(value) => { void toggle(value) }}
            aria-label={t('notifications.enabled')}
            aria-busy={busy}
          />
        </SettingsRow>
        <p role="status" className="py-3 text-xs leading-relaxed text-[var(--color-fg-muted)]">
          {permission === 'denied' ? t('notifications.denied')
            : permission === 'unsupported' ? t('notifications.unsupported')
              : permission === 'desktop-update' ? t('notifications.desktopUpdate')
                : permission === 'default' ? t('notifications.permissionHint')
                  : enabled ? t('notifications.active') : t('notifications.off')}
        </p>
      </SettingsSection>
    </div>
  )
}

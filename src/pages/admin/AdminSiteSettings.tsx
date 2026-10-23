import { useTranslation } from 'react-i18next'
import { AdminPageHeader } from '@/components/admin/admin-page-header'
import AdminSiteAccess from './AdminSiteAccess'
import AdminAnnouncement from './AdminAnnouncement'
import AdminNotifications from './AdminNotifications'

export default function AdminSiteSettings() {
  const { t } = useTranslation('admin')
  return (
    <div>
      <AdminPageHeader title={t('siteAccess.groupTitle')} />
      <div className="mt-8 space-y-10 divide-y divide-[var(--color-border)] [&>section:not(:first-child)]:pt-10">
        <section aria-label={t('siteAccess.title')}><AdminSiteAccess embedded /></section>
        <section aria-label={t('announcement.title')}><AdminAnnouncement embedded /></section>
        <section aria-label={t('notifications.title')}><AdminNotifications embedded /></section>
      </div>
    </div>
  )
}

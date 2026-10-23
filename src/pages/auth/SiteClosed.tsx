import { useTranslation } from 'react-i18next'
import { RefreshCw, Wrench } from 'lucide-react'
import { TracedLogo } from '@/components/brand/logo'
import { LanguageToggle } from '@/components/ui/language-toggle'
import { Button } from '@/components/ui/button'
import { useSiteStatus } from '@/store/site-status'
import './site-closed.css'

export default function SiteClosed() {
  const { t } = useTranslation('auth')
  const message = useSiteStatus((s) => s.message)
  const refreshing = useSiteStatus((s) => s.refreshing)
  const refresh = useSiteStatus((s) => s.refresh)

  return (
    <div className="site-closed-page">
      <header className="site-closed-header">
        <TracedLogo tone="system" />
        <LanguageToggle variant="pill" />
      </header>
      <main className="site-closed-main" aria-labelledby="site-closed-title">
        <div className="site-closed-icon"><Wrench size={28} strokeWidth={1.5} aria-hidden /></div>
        <h1 id="site-closed-title">{t('siteClosed.title')}</h1>
        <p className="site-closed-message">{message || t('siteClosed.description')}</p>
        <Button variant="secondary" loading={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={16} aria-hidden />{t('siteClosed.retry')}
        </Button>
        <p className="site-closed-hint">{t('siteClosed.autoRefresh')}</p>
      </main>
      <footer className="site-closed-footer">
        <span>© {new Date().getFullYear()} Aivory</span>
      </footer>
    </div>
  )
}

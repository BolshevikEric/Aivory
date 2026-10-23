import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Mail, ShieldBan } from 'lucide-react'
import { authApi } from '@/api'
import { TracedLogo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { LanguageToggle } from '@/components/ui/language-toggle'
import { useAuth } from '@/store/auth'
import './account-suspended.css'

export default function AccountSuspended() {
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const [contact, setContact] = useState('')
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    // Cancel an in-flight session probe from the previous route. An older
    // browser session must not restore another identity behind this page.
    useAuth.getState().markSuspended()
    let active = true
    void authApi.legalConfig().then(({ contact_email }) => {
      const email = contact_email.trim()
      if (active && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && !email.toLowerCase().endsWith('.local')) setContact(email)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  async function switchAccount() {
    if (leaving) return
    setLeaving(true)
    await useAuth.getState().logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="account-suspended-page">
      <header className="account-suspended-header">
        <TracedLogo tone="system" />
        <LanguageToggle variant="pill" />
      </header>
      <main className="account-suspended-main" aria-labelledby="suspension-title">
        <div className="account-suspended-icon"><ShieldBan size={30} strokeWidth={1.5} aria-hidden /></div>
        <p className="account-suspended-label">{t('suspended.label')}</p>
        <h1 id="suspension-title">{t('suspended.title')}</h1>
        <p className="account-suspended-intro">{t('suspended.description')}</p>
        <dl className="account-suspended-status">
          <dt>{t('suspended.statusLabel')}</dt>
          <dd><span aria-hidden />{t('suspended.status')}</dd>
        </dl>
        <div className="account-suspended-help">
          <h2>{t('suspended.helpTitle')}</h2>
          <p>{t('suspended.helpBody')}</p>
          {contact ? <a className="account-suspended-contact" href={`mailto:${encodeURIComponent(contact)}`}><Mail size={16} aria-hidden />{contact}</a> : <p>{t('suspended.contactFallback')}</p>}
        </div>
        <Button variant="secondary" size="lg" loading={leaving} onClick={() => void switchAccount()} className="account-suspended-switch">
          <ArrowLeft size={16} aria-hidden />{t('suspended.switchAccount')}
        </Button>
      </main>
      <footer className="account-suspended-footer">
        <span>© {new Date().getFullYear()} Aivory</span>
        <nav aria-label={t('suspended.legalLabel')}><Link to="/terms">{t('legal.terms.title')}</Link><Link to="/privacy">{t('legal.privacy.title')}</Link></nav>
      </footer>
    </div>
  )
}

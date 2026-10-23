import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { ArrowLeft, Mail } from 'lucide-react'
import { AuthField } from '@/components/auth/auth-field'
import { Button } from '@/components/ui/button'
import { authApi, ApiError } from '@/api'
import { emailRetryAfterFromBody, useEmailCooldown } from '@/hooks/use-email-cooldown'

export default function ForgotPassword() {
  const { t } = useTranslation(['auth', 'common'])
  const [sent, setSent] = useState(false)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const { remaining: cooldown, start: startCooldown } = useEmailCooldown()

  async function sendLink(e?: React.FormEvent) {
    e?.preventDefault()
    if (loading || cooldown > 0) return
    const recipient = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      setError(t('errors.invalidEmail'))
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const resp = await authApi.forgotPassword(recipient)
      setEmail(recipient)
      startCooldown(resp.retry_after)
      setSent(true)
    } catch (err) {
      const retryAfter = err instanceof ApiError ? emailRetryAfterFromBody(err.body) : 0
      if (retryAfter > 0) startCooldown(retryAfter)
      setError(err instanceof ApiError ? t(`errorCodes.${err.message}`, { defaultValue: t('forgot.sendFailed') }) : t('forgot.sendFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-content">
      {sent ? <Mail size={28} className="login-twofa-icon" aria-hidden /> : null}
      <h1 id="login-title" className="login-title">{t(sent ? 'forgot.sentTitle' : 'forgot.title')}</h1>
      <p className="login-intro">
        {sent ? <Trans i18nKey="forgot.sentBody" t={t} values={{ email }} components={{ strong: <strong /> }} /> : t('forgot.subtitle')}
      </p>
      {sent ? (
        <div aria-live="polite">
          <p className="login-delivery-hint">{t('emailDeliveryHint')}</p>
          <p className="login-delivery-hint">{t('forgot.linkHint')}</p>
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          <Button className="login-submit" loading={loading} disabled={cooldown > 0} onClick={() => void sendLink()}>
            {cooldown > 0 ? t('forgot.resendCountdown', { seconds: cooldown }) : t('forgot.resendLink')}
          </Button>
          <button type="button" className="login-resend" disabled={loading} onClick={() => { setSent(false); setError(undefined); startCooldown(0) }}>{t('forgot.changeEmail')}</button>
        </div>
      ) : (
        <form onSubmit={(e) => void sendLink(e)} noValidate>
          <AuthField
            id="forgot-email"
            name="email"
            type="email"
            label={t('login.emailLabel')}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(undefined) }}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            error={error}
          />
          <Button type="submit" loading={loading} disabled={cooldown > 0} className="login-submit">
            {cooldown > 0 ? t('forgot.resendCountdown', { seconds: cooldown }) : t('forgot.submit')}
          </Button>
        </form>
      )}
      <Link to="/login" className="login-back"><ArrowLeft size={12} aria-hidden />{t('forgot.back')}</Link>
    </div>
  )
}

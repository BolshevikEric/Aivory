import { useLayoutEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, KeyRound, Link2Off } from 'lucide-react'
import { AuthField } from '@/components/auth/auth-field'
import { Button } from '@/components/ui/button'
import { authApi, ApiError } from '@/api'
import { useAuth } from '@/store/auth'
import { useAuthFormLayout } from '@/hooks/use-auth-form-layout'
import { useLanguage, toSupportedLanguage } from '@/store/language'

export default function ResetPassword() {
  const { t } = useTranslation(['auth', 'common'])
  const { short, passwordStep: confirmStep, setPasswordStep: setConfirmStep } = useAuthFormLayout()
  const location = useLocation()
  // A fragment keeps the secret out of HTTP requests, access logs and referrers.
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState<string>()

  useLayoutEffect(() => {
    const locale = toSupportedLanguage(new URLSearchParams(location.search).get('lang'))
    if (locale) useLanguage.getState().applyLang(locale)
  }, [location.search])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    if (password.length < 8) { setError(t('errors.minPassword')); return }
    if (short && !confirmStep) { setConfirmStep(true); setError(undefined); return }
    if (password !== confirm) { setError(t('forgot.passwordMismatch')); return }
    setLoading(true)
    setError(undefined)
    try {
      await authApi.resetPassword(token, password)
      // Remove the consumed secret from the current history entry.
      window.history.replaceState(window.history.state, '', location.pathname + location.search)
      setPassword('')
      setConfirm('')
      setDone(true)
      if (useAuth.getState().user) void useAuth.getState().hydrate()
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid_or_expired_reset_link') setInvalid(true)
      else setError(err instanceof ApiError ? t(`errorCodes.${err.message}`, { defaultValue: t('forgot.resetFailed') }) : t('forgot.resetFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (done) return (
    <div className="login-content" role="status">
      <Check size={28} className="login-success-icon" aria-hidden />
      <h1 id="login-title" className="login-title">{t('forgot.resetSuccess')}</h1>
      <p className="login-intro">{t('forgot.resetSuccessBody')}</p>
      <Button asChild className="login-submit"><Link to="/login">{t('forgot.back')}</Link></Button>
    </div>
  )

  if (invalid || !/^[A-Za-z0-9_-]{43}$/.test(token)) return (
    <div className="login-content" role="status">
      <Link2Off size={28} className="login-twofa-icon" aria-hidden />
      <h1 id="login-title" className="login-title">{t('forgot.invalidTitle')}</h1>
      <p className="login-intro">{t('forgot.invalidBody')}</p>
      <Button asChild className="login-submit"><Link to="/forgot-password">{t('forgot.requestNewLink')}</Link></Button>
      <Link to="/login" className="login-back"><ArrowLeft size={12} aria-hidden />{t('forgot.back')}</Link>
    </div>
  )

  return (
    <div className="login-content">
      <KeyRound size={28} className="login-twofa-icon" aria-hidden />
      <h1 id="login-title" className="login-title">{t('forgot.resetTitle')}</h1>
      <p className="login-intro" data-auth-intro="optional">{t('forgot.resetSubtitle')}</p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        {error ? <p id="reset-error" className="login-error" role="alert">{error}</p> : null}
        <div hidden={short && confirmStep}>
          <AuthField id="new-pw" name="password" type="password" label={t('forgot.newPassword')}
            value={password} onChange={(e) => { setPassword(e.target.value); setError(undefined) }}
            autoComplete="new-password" description={t('fields.passwordHint')} required minLength={8}
            aria-describedby={error ? 'reset-error' : undefined} />
        </div>
        <div hidden={short && !confirmStep}>
          <AuthField id="confirm-pw" name="confirm_password" type="password" label={t('forgot.confirmPassword')}
            value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(undefined) }}
            autoComplete="new-password" required minLength={8} aria-describedby={error ? 'reset-error' : undefined} />
        </div>
        <div className={short && confirmStep ? 'login-step-actions' : undefined}>
          {short && confirmStep ? <Button variant="ghost" disabled={loading} onClick={() => { setConfirmStep(false); setError(undefined) }}>{t('common:actions.back')}</Button> : null}
          <Button type="submit" loading={loading} className="login-submit">{t(short && !confirmStep ? 'common:actions.continue' : 'forgot.resetSubmit')}</Button>
        </div>
      </form>
      <Link to="/login" className="login-back"><ArrowLeft size={12} aria-hidden />{t('forgot.back')}</Link>
    </div>
  )
}

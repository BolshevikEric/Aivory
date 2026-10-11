import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AuthField } from '@/components/auth/auth-field'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/store/auth'
import { authErrorText } from '@/lib/auth-errors'
import { useAuthFormLayout } from '@/hooks/use-auth-form-layout'

/**
 * Setup — first-run screen for a fresh deployment with no accounts yet. The
 * details entered here create the very first user, which becomes the admin
 * (§ first-run setup). AuthGate routes every path here until it's done.
 */
export default function Setup() {
  const navigate = useNavigate()
  const { t } = useTranslation(['auth', 'common'])
  const { split, passwordStep, showIdentity, showPassword, setPasswordStep } = useAuthFormLayout()
  const setup = useAuth((s) => s.setup)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<{ name?: string; email?: string; pw?: string; general?: string }>({})

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    const next: typeof errors = {}
    if (!name.trim()) next.name = t('errors.required')
    if (!email) next.email = t('errors.required')
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = t('errors.invalidEmail')
    if (showPassword) {
      if (!pw) next.pw = t('errors.required')
      else if (pw.length < 8) next.pw = t('errors.minPassword')
    }
    setErrors(next)
    if (Object.values(next).some(Boolean)) {
      if (next.name || next.email) setPasswordStep(false)
      return
    }
    if (split && !passwordStep) {
      setPasswordStep(true)
      return
    }
    setLoading(true)
    const ok = await setup(name.trim(), email, pw)
    setLoading(false)
    if (!ok) {
      setErrors({ general: authErrorText(t, useAuth.getState().error, t('errors.required')) })
      return
    }
    navigate('/', { replace: true })
  }

  const formError = errors.general || (split ? errors.name || errors.email || errors.pw : undefined)

  return (
    <div className="login-content" data-auth-split={split}>
      <h1 id="login-title" className="login-title">{t('setup.title')}</h1>
      <p className="login-intro" data-auth-intro="optional">{t('setup.subtitle')}</p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        {formError ? <p className="login-error" role="alert">{formError}</p> : null}
        <div hidden={!showIdentity}>
          <AuthField
            id="setup-name"
            name="name"
            label={t('register.name')}
            value={name}
            onChange={(e) => { setName(e.target.value); setErrors({}) }}
            onFocus={() => setPasswordStep(false)}
            placeholder={t('register.namePlaceholder')}
            autoComplete="name"
            required
            error={errors.name}
          />
          <AuthField
            id="setup-email"
            name="email"
            type="email"
            inputMode="email"
            label={t('login.emailLabel')}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setErrors({}) }}
            onFocus={() => setPasswordStep(false)}
            placeholder="you@example.com"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            error={errors.email}
          />
        </div>
        <div hidden={!showPassword}>
          <AuthField
            id="setup-pw"
            name="password"
            type="password"
            label={t('fields.password')}
            value={pw}
            onChange={(e) => { setPw(e.target.value); setErrors({}) }}
            onFocus={() => setPasswordStep(true)}
            autoComplete="new-password"
            placeholder={t('fields.passwordHint')}
            description={t('fields.passwordHint')}
            required
            minLength={8}
            error={errors.pw}
          />
        </div>
        <div className={passwordStep ? 'login-step-actions' : undefined}>
          {passwordStep ? <Button variant="ghost" disabled={loading} onClick={() => { setPasswordStep(false); setErrors({}) }}>{t('common:actions.back')}</Button> : null}
          <Button type="submit" loading={loading} className="login-submit">{t(split && !passwordStep ? 'common:actions.continue' : 'setup.submit')}</Button>
        </div>
      </form>
    </div>
  )
}

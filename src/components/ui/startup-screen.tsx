import { Component, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LogoMark } from '@/components/brand/logo'
import { startupLoadingSince, trackStartupScreen } from '@/lib/startup'
import wordmarkUrl from '@/assets/brand/aivory-wordmark.svg'

export function StartupScreen({ failed = false }: { failed?: boolean }) {
  const { t } = useTranslation('common')
  const [since] = useState(startupLoadingSince)
  const [slow, setSlow] = useState(() => Date.now() - since >= 5000)

  useEffect(trackStartupScreen, [])

  useEffect(() => {
    if (failed || slow) return
    const timer = window.setTimeout(() => setSlow(true), Math.max(0, 5000 - (Date.now() - since)))
    return () => window.clearTimeout(timer)
  }, [failed, since, slow])

  return (
    <div
      className="aivory-startup"
      data-startup-screen="react"
      data-state={failed ? 'failed' : slow ? 'slow' : 'loading'}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={!failed}
      aria-label={t(failed ? 'startup.failed' : slow ? 'startup.slow' : 'startup.loading')}
    >
      <div className="aivory-startup-brand" aria-hidden="true">
        <LogoMark size={40} className="aivory-startup-mark" />
        <span className="aivory-startup-wordmark" style={{
          maskImage: `var(--aivory-startup-wordmark, url(${wordmarkUrl}))`,
          WebkitMaskImage: `var(--aivory-startup-wordmark, url(${wordmarkUrl}))`,
        }} />
      </div>
      <div className="aivory-startup-status">
        <div className="aivory-startup-dots" aria-hidden="true" style={{ visibility: failed ? 'hidden' : 'visible' }}>
          <span /><span /><span />
        </div>
        <p className="aivory-startup-message">{failed ? t('startup.failed') : slow ? t('startup.slow') : ''}</p>
        {failed && <button type="button" className="aivory-startup-reload" onClick={() => window.location.reload()}>{t('startup.reload')}</button>}
      </div>
    </div>
  )
}

export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidMount() {
    window.aivoryStartup?.ready()
  }

  render() {
    return this.state.failed ? <StartupScreen failed /> : this.props.children
  }
}

/**
 * OAuthButtons groups long provider lists in a menu on compact auth forms.
 * Clicking does a full-page navigation to the backend
 * `/start` endpoint, which 302-redirects to the provider (a fetch can't follow
 * a cross-origin auth redirect, so this must be a real navigation).
 *
 * Renders nothing when no providers are configured; callers gate the
 * surrounding divider on `providers.length` so the section disappears cleanly.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { apiUrl } from '@/api'
import type { ApiPublicOAuthProvider } from '@/api/types'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { oauthStartPath } from '@/lib/oauth'
import { PuzzleCaptchaDialog } from './puzzle-captcha-dialog'
import { OAuthBrandGlyph } from './oauth-glyph'

interface OAuthButtonsProps {
  providers: ApiPublicOAuthProvider[]
  captchaRequired?: boolean
  compact?: boolean
}

export function OAuthButtons({ providers, captchaRequired = false, compact = false }: OAuthButtonsProps) {
  const { t } = useTranslation('auth')
  const [pendingProvider, setPendingProvider] = useState<ApiPublicOAuthProvider | null>(null)

  function start(provider: ApiPublicOAuthProvider, captchaToken?: string) {
    window.location.href = apiUrl(oauthStartPath(provider.id, captchaToken))
  }

  function selectProvider(provider: ApiPublicOAuthProvider) {
    if (captchaRequired) setPendingProvider(provider)
    else start(provider)
  }

  if (window.aivoryDesktop || providers.length === 0) return null
  return (
    <>
      {(compact && providers.length > 1) || providers.length > 4 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" className="login-provider-picker" trailingIcon={<ChevronDown size={14} aria-hidden />}>
              {t('login.otherProviders')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-0 w-[var(--radix-dropdown-menu-trigger-width)] border-0">
            {providers.map((provider) => (
              <DropdownMenuItem key={provider.id} onSelect={() => selectProvider(provider)} title={provider.name}>
                <OAuthBrandGlyph kind={provider.kind} icon={provider.icon} />
                <span className="min-w-0 truncate">{provider.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : providers.map((p) => (
        <Button
          key={p.id}
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => selectProvider(p)}
        >
          <OAuthBrandGlyph kind={p.kind} icon={p.icon} />
          {p.name}
        </Button>
      ))}
      <PuzzleCaptchaDialog
        open={pendingProvider !== null}
        purpose="register"
        onOpenChange={(open) => {
          if (!open) setPendingProvider(null)
        }}
        onSolved={(token) => {
          const provider = pendingProvider
          setPendingProvider(null)
          if (provider) start(provider, token)
        }}
      />
    </>
  )
}

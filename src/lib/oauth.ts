import type { OAuthKind } from '@/api/types'

export const OAUTH_PROVIDER_KINDS = ['google', 'github', 'apple', 'wecom', 'oauth2', 'oidc'] as const satisfies readonly OAuthKind[]

export function getOAuthProviderFormCapabilities(kind: OAuthKind) {
  const isGeneric = kind === 'oauth2' || kind === 'oidc'

  return {
    usesAppleCredentials: kind === 'apple',
    usesWeComCredentials: kind === 'wecom',
    usesCustomIcon: isGeneric,
    showsCustomEndpoints: isGeneric,
    showsOidcMetadata: kind === 'oidc',
    showsUserInfoEndpoint: kind === 'oauth2',
  }
}

export function oauthProviderErrorTranslationKey(code: string) {
  if (code === 'oauth_provider_changed') {
    return 'admin:oauth.errors.providerChanged' as const
  }
  if (code === 'oauth_client_secret_reentry_required') {
    return 'admin:oauth.errors.secretReentryRequired' as const
  }
  if (code === 'oauth_provider_id_exists') {
    return 'admin:oauth.errors.idConflict' as const
  }
  return null
}

export function oauthStartPath(providerId: string, captchaToken?: string, locale?: string): string {
  const base = `/auth/oauth/${encodeURIComponent(providerId)}/start`
  const params = new URLSearchParams()
  if (captchaToken) params.set('captcha_token', captchaToken)
  if (locale) params.set('lang', locale)
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

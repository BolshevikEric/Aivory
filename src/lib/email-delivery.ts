export const EMAIL_PURPOSES = ['verify', 'reset', 'welcome', 'membership'] as const
export type EmailPurpose = typeof EMAIL_PURPOSES[number]
export interface SMTPAccount {
  id: string
  name: string
  host: string
  port: string
  user: string
  password: string
  from: string
  tls: boolean
}
export interface EmailDeliveryConfig {
  accounts: SMTPAccount[]
  rules: Record<EmailPurpose, { account_id: string; enabled: boolean }>
}

export function isRequiredEmail(purpose: EmailPurpose): boolean {
  return purpose === 'verify' || purpose === 'reset'
}

export function emailDeliveryFromSettings(settings: Record<string, unknown>): EmailDeliveryConfig {
  const value = settings.email_delivery as EmailDeliveryConfig | undefined
  if (value && Array.isArray(value.accounts) && value.rules) return value
  const string = (key: string) => typeof settings[key] === 'string' ? settings[key] as string : ''
  const accounts: SMTPAccount[] = string('smtp_host') ? [{
    id: 'legacy', name: string('smtp_from') || string('smtp_user') || string('smtp_host'),
    host: string('smtp_host'), port: string('smtp_port') || '587', user: string('smtp_user'),
    password: string('smtp_password'), from: string('smtp_from'), tls: settings.smtp_tls === true,
  }] : []
  return {
    accounts,
    rules: Object.fromEntries(EMAIL_PURPOSES.map((purpose) => [purpose, { account_id: accounts[0]?.id ?? '', enabled: true }])) as EmailDeliveryConfig['rules'],
  }
}

export function emailSecurityReady(settings: Record<string, unknown>): boolean {
  const config = emailDeliveryFromSettings(settings)
  return (['verify', 'reset'] as const).every((purpose) => {
    const account = config.accounts.find((candidate) => candidate.id === config.rules[purpose]?.account_id)
    return Boolean(account?.host.trim() && (account.from.trim() || account.user.trim()))
  })
}

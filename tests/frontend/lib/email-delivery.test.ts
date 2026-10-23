import { describe, expect, it } from 'vitest'
import { EMAIL_PURPOSES, emailDeliveryFromSettings, emailSecurityReady, isRequiredEmail } from '@/lib/email-delivery'
import en from '@/i18n/locales/en/admin.json'
import zh from '@/i18n/locales/zh/admin.json'
import zhHant from '@/i18n/locales/zh-Hant/admin.json'
import ja from '@/i18n/locales/ja/admin.json'
import fr from '@/i18n/locales/fr/admin.json'

describe('email delivery settings', () => {
  it('keeps registration and recovery mandatory and supports optional notifications', () => {
    expect(EMAIL_PURPOSES.filter(isRequiredEmail)).toEqual(['verify', 'reset'])
    expect(EMAIL_PURPOSES.filter((purpose) => !isRequiredEmail(purpose))).toEqual(['welcome', 'membership'])
  })

  it('loads the old SMTP account with all email types still enabled', () => {
    const config = emailDeliveryFromSettings({ smtp_host: 'smtp.example.test', smtp_user: 'sender@example.test', smtp_password: '••••••' })
    expect(config.accounts).toHaveLength(1)
    expect(config.accounts[0]).toMatchObject({ id: 'legacy', port: '587', user: 'sender@example.test', password: '••••••' })
    for (const rule of Object.values(config.rules)) expect(rule).toEqual({ account_id: 'legacy', enabled: true })
    expect(emailSecurityReady({ smtp_host: 'smtp.example.test', smtp_user: 'sender@example.test' })).toBe(true)
  })

  it('recognizes separate security accounts and rejects missing required senders', () => {
    const config = emailDeliveryFromSettings({ smtp_host: 'smtp.example.test', smtp_from: 'sender@example.test' })
    config.accounts.push({ ...config.accounts[0], id: 'other', name: 'Other' })
    config.rules.reset.account_id = 'other'
    config.rules.membership.enabled = false
    expect(emailSecurityReady({ email_delivery: config })).toBe(true)
    config.accounts.pop()
    expect(emailSecurityReady({ email_delivery: config })).toBe(false)
    expect(emailSecurityReady({})).toBe(false)
  })

  it('describes every email type and the account controls in all website languages', () => {
    for (const locale of [en, zh, zhHant, ja, fr]) {
      for (const purpose of EMAIL_PURPOSES) {
        expect(locale.emailDelivery.types[purpose].title).toBeTruthy()
        expect(locale.emailDelivery.types[purpose].description).toBeTruthy()
      }
      for (const key of ['addAccount', 'passwordHint', 'required', 'preview', 'invalid', 'removeHint'] as const) expect(locale.emailDelivery[key]).toBeTruthy()
    }
  })
})

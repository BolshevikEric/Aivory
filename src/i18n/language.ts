export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'zh', label: '简体中文', short: '简' },
  { code: 'zh-Hant', label: '繁體中文', short: '繁' },
  { code: 'ja', label: '日本語', short: '日' },
  { code: 'fr', label: 'Français', short: 'FR' },
] as const

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code']

/** Shared by the preboot screen, language detector, and language store. */
export function normalizeLanguage(code: unknown): LanguageCode | null {
  if (typeof code !== 'string' || !code) return null
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly string[]
  if (codes.includes(code)) return code as LanguageCode
  const lower = code.toLowerCase().replace('_', '-')
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') return 'zh-Hant'
  if (lower === 'zh-cn' || lower === 'zh-sg' || lower === 'zh-hans') return 'zh'
  const base = lower.split('-')[0]
  const found = codes.find((c) => c.toLowerCase().split('-')[0] === base)
  return (found as LanguageCode) ?? null
}

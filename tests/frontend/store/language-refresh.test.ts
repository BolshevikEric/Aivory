// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { useLanguage } from '@/store/language'

const { persist } = vi.hoisted(() => ({ persist: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/user-settings', () => ({ persistUserSettings: persist }))

describe('language synchronization after profile refresh', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    useLanguage.setState({ lang: 'zh' })
    persist.mockClear()
    persist.mockResolvedValue(null)
  })
  afterEach(() => vi.restoreAllMocks())

  it('does not emit a language change for an unchanged cloud preference', () => {
    const changed = vi.fn()
    i18n.on('languageChanged', changed)
    try {
      useLanguage.getState().applyLang('zh')
      useLanguage.getState().applyLang('zh')
      expect(changed).not.toHaveBeenCalled()
      expect(localStorage.getItem('aivory.lang')).toBe('zh')
      expect(document.documentElement.lang).toBe('zh')
      expect(persist).not.toHaveBeenCalled()
    } finally {
      i18n.off('languageChanged', changed)
    }
  })

  it('applies a changed cloud preference without writing it back', () => {
    useLanguage.getState().applyLang('en')
    expect(i18n.language).toBe('en')
    expect(useLanguage.getState().lang).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(persist).not.toHaveBeenCalled()
  })

  it('persists an explicit selection even when the local language is already selected', () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')
    useLanguage.getState().setLang('zh')
    expect(changeLanguage).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledWith({ language: 'zh' })
  })
})

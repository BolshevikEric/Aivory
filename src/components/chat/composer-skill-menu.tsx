import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Search } from 'lucide-react'
import type { ApiPublicSkill, ApiUserSkill } from '@/api/types'
import { SkillIcon } from '@/components/ui/skill-icon'
import { skillDisplayDescription } from '@/lib/skill-description'
import { MAX_SELECTED_USER_SKILLS } from '@/lib/composer-commands'
import { cn } from '@/lib/utils'

interface Props {
  defaults: ApiPublicSkill[]
  available: ApiUserSkill[]
  selected: ApiUserSkill[]
  disabledIds: readonly string[]
  defaultsEnabled: boolean
  loading: boolean
  failed: boolean
  onRetry: () => void
  onToggleDefault: (skill: ApiPublicSkill) => void
  onToggleManual: (skill: ApiUserSkill) => void
}

/** Inline skill controls share the slash selector's state and permissions. */
export function ComposerSkillMenu({ defaults, available, selected, disabledIds, defaultsEnabled, loading, failed, onRetry, onToggleDefault, onToggleManual }: Props) {
  const { t } = useTranslation('chat')
  const [query, setQuery] = useState('')
  const matches = (name: string, description: string) => !query.trim() || `${name} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const defaultSourceIds = new Set(defaults.map(skill => skill.id))
  const manual = [...selected, ...available.filter(skill => !selected.some(item => item.id === skill.id))]
    .filter(skill => !skill.source_skill_id || !defaultSourceIds.has(skill.source_skill_id))
    .filter(skill => matches(skill.name, skillDisplayDescription(skill)))
  const modelDefaults = defaults.filter(skill => {
    const explicit = selected.find(item => item.source_skill_id === skill.id)
    return matches(explicit?.name ?? skill.name, explicit ? skillDisplayDescription(explicit) : skill.display_description)
  })

  const row = (id: string, name: string, icon: string, active: boolean, toggle: () => void, unavailable = false) => (
    <div key={id} className="py-0.5">
      <button type="button" role="checkbox" aria-checked={active} aria-label={t('composer.skills.toggle', { name })} disabled={unavailable} onClick={toggle} className={cn('flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left interactive hover:bg-[var(--color-bg-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-40 disabled:cursor-not-allowed', active && 'bg-[var(--color-tool-selection-soft)]')}>
        <SkillIcon name={icon} size={15} className="shrink-0 text-[var(--color-fg-muted)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        <span className={cn('inline-flex size-7 shrink-0 items-center justify-center', active ? 'text-[var(--color-tool-selection-text)]' : 'text-[var(--color-fg-muted)]')}>
          {active ? <Check size={15} aria-hidden /> : <Plus size={15} aria-hidden />}
        </span>
      </button>
    </div>
  )

  return <div className="min-w-0">
    <label className="mb-2 flex h-9 items-center gap-2 rounded-[8px] bg-[var(--color-bg-muted)] px-2.5">
      <Search size={14} className="shrink-0 text-[var(--color-fg-muted)]" aria-hidden />
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('composer.skills.search')} aria-label={t('composer.skills.search')} className="min-w-0 w-full bg-transparent text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] outline-none" />
    </label>
    <div className="max-h-[min(22rem,45dvh)] overflow-y-auto overscroll-contain scrollbar-thin">
      {modelDefaults.length ? <section aria-label={t('composer.skills.modelDefaults')}>
        <p className="px-2.5 pb-1 pt-1 text-xs font-medium text-[var(--color-fg-muted)]">{t('composer.skills.modelDefaults')}</p>
        {!defaultsEnabled ? <p className="px-2.5 pb-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('composer.skills.defaultsUnavailable')}</p> : null}
        {modelDefaults.map(skill => {
          const explicit = selected.find(item => item.source_skill_id === skill.id)
          const active = Boolean(explicit) || (defaultsEnabled && !disabledIds.includes(skill.id))
          return row(`model:${skill.id}`, explicit?.name ?? skill.name, explicit?.icon ?? skill.icon, active, () => onToggleDefault(skill), !defaultsEnabled && !explicit && (selected.length >= MAX_SELECTED_USER_SKILLS || !available.some(item => item.source_skill_id === skill.id)))
        })}
      </section> : null}
      {manual.length ? <section aria-label={t('composer.skills.addSkills')} className={modelDefaults.length ? 'mt-3' : undefined}>
        <p className="px-2.5 pb-1 pt-1 text-xs font-medium text-[var(--color-fg-muted)]">{t('composer.skills.addSkills')}</p>
        {manual.map(skill => {
          const active = selected.some(item => item.id === skill.id)
          return row(skill.id, skill.name, skill.icon, active, () => onToggleManual(skill), !active && selected.length >= MAX_SELECTED_USER_SKILLS)
        })}
      </section> : null}
      {loading ? <div role="status" className="space-y-2 px-2.5 py-3" aria-label={t('composer.skills.loading')}><div className="h-8 animate-pulse rounded-[8px] bg-[var(--color-bg-muted)] motion-reduce:animate-none" /><div className="h-8 animate-pulse rounded-[8px] bg-[var(--color-bg-muted)] motion-reduce:animate-none" /></div> : null}
      {failed ? <div role="alert" className="px-2.5 py-3 text-xs text-[var(--color-fg-muted)]"><p>{t('composer.skills.loadFailed')}</p><button type="button" onClick={onRetry} className="mt-2 rounded px-1 py-1 text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">{t('composer.skills.retry')}</button></div> : null}
      {!loading && !failed && !modelDefaults.length && !manual.length ? <p className="px-2.5 py-3 text-sm text-[var(--color-fg-muted)]">{t(query ? 'composer.skills.noResults' : 'composer.skills.empty')}</p> : null}
    </div>
  </div>
}

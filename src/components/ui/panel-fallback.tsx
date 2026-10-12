import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { StartupScreen } from '@/components/ui/startup-screen'

/**
 * The canonical page-loading state.
 * Full-screen startup uses the brand lockup; smaller panels keep a compact
 * indicator. Both announce the same localized state and respect reduced motion.
 */
export function PanelFallback({ scope = 'panel' }: { scope?: 'panel' | 'screen' | 'fill' }) {
  const { t } = useTranslation('common')
  if (scope === 'screen') {
    return typeof document !== 'undefined' ? createPortal(<StartupScreen />, document.body) : <StartupScreen />
  }
  return (
    <div
      className={cn(
        'w-full flex flex-col items-center justify-center gap-3 text-[var(--color-fg-subtle)]',
        scope === 'panel' && 'min-h-48 flex-1 py-24',
        scope === 'fill' && 'h-full min-h-0 flex-1',
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-atomic="true"
    >
      <span
        aria-hidden
        className="inline-block size-5 rounded-full border-2 border-[var(--color-fg-faint)] border-r-transparent animate-[spin_900ms_linear_infinite] motion-reduce:animate-none"
      />
      <span className="text-[13px]">{t('common.loading', { defaultValue: 'Loading…' })}</span>
    </div>
  )
}

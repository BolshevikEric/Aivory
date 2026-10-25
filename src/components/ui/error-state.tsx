import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import { EmptyState } from './empty-state'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
  title?: ReactNode
  description?: ReactNode
  retry?: () => void
  className?: string
  size?: 'page' | 'panel' | 'table' | 'inline'
}

export function ErrorState({ title, description, retry, size = 'page', className }: ErrorStateProps) {
  const { t } = useTranslation('common')
  const heading = title ?? t('startup.failed')
  const action = retry ? (
    <Button
      variant="secondary"
      size="sm"
      className="shrink-0 [@media(pointer:coarse)]:min-h-[var(--tap-min)]"
      onClick={retry}
      leadingIcon={<RefreshCw size={14} aria-hidden />}
    >
      {t('actions.tryAgain')}
    </Button>
  ) : undefined
  if (size === 'inline') return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-[8px] bg-[var(--color-danger-soft)] p-4 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-2.5 text-sm text-[var(--color-danger)]">
        <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{description ?? heading}</span>
      </div>
      {action}
    </div>
  )
  return (
    <EmptyState
      role="alert"
      size={size}
      tone="danger"
      icon={<AlertTriangle size={20} aria-hidden />}
      title={heading}
      description={description}
      action={action}
      className={className}
    />
  )
}

/**
 * AdminUserMemories — read-only view of one user's long-term memories.
 * The admin route bypasses user ownership checks server-side, so this page
 * intentionally exposes no edit or delete controls.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { Brain } from 'lucide-react'
import { adminApi, ApiError } from '@/api'
import type { ApiMemory, ApiUser } from '@/api/types'
import { AdminDetailHeader } from '@/components/admin/admin-detail-header'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Badge } from '@/components/ui/badge'
import { AdminTable } from '@/components/admin/AdminTable'
import { PanelFallback } from '@/components/ui/panel-fallback'
import { formatDateTime } from '@/lib/utils'
import { AdminPageHeader } from '@/components/admin/admin-page-header'

function statusVariant(status: ApiMemory['status']) {
  switch (status) {
    case 'ACTIVE':
      return 'sage' as const
    case 'STALE':
    case 'HISTORICAL_ONLY':
      return 'neutral' as const
    default:
      return 'accent' as const
  }
}

export default function AdminUserMemories({ userId, embedded = false }: { userId?: string; embedded?: boolean } = {}) {
  const { t } = useTranslation(['admin', 'memory', 'common'])
  const { id: routeId = '' } = useParams<{ id: string }>()
  const id = userId ?? routeId
  const [user, setUser] = useState<ApiUser | null>(null)
  const [rows, setRows] = useState<ApiMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [loadedId, setLoadedId] = useState('')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      setUser(null)
      setRows([])
      try {
        const [targetUser, memories] = await Promise.all([
          embedded ? Promise.resolve(null) : adminApi.user(id),
          adminApi.userMemories(id),
        ])
        if (cancelled) return
        setUser(targetUser)
        setRows(memories)
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof ApiError ? loadError.message : t('admin:users.memoriesLoadFailed'))
      } finally {
        if (!cancelled) {
          setLoadedId(id)
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [id, embedded, reloadKey, t])

  const currentUser = user?.id === id ? user : null
  const pageLoading = loading || loadedId !== id
  const headerName = currentUser?.name.trim() || currentUser?.email.trim() || ''

  return (
    <div>
      {!embedded ? (
        <>
          <AdminDetailHeader backTo="/admin/users" backLabel={t('admin:users.backToUsers')} />
          <AdminPageHeader
            title={pageLoading ? (
              <span className="block" role="status" aria-live="polite">
                <span className="sr-only">{t('admin:common.loading')}</span>
                <span
                  aria-hidden
                  className="block h-9 w-[min(16rem,70vw)] animate-pulse rounded-[8px] bg-[var(--color-bg-muted)]"
                />
              </span>
            ) : headerName ? (
              t('admin:users.memoriesTitle', { name: headerName })
            ) : (
              t('admin:users.memoriesFallbackTitle')
            )}
            titleBusy={pageLoading}
            description={t('admin:users.memoriesLead')}
          />
        </>
      ) : null}

      <section className={embedded ? undefined : 'mt-6 sm:mt-8'} aria-label={t('admin:users.viewMemories')}>
        {pageLoading ? (
          <PanelFallback />
        ) : error ? (
          <ErrorState size="panel" description={error} retry={() => setReloadKey((key) => key + 1)} />
        ) : rows.length === 0 ? (
          <EmptyState
            size="panel"
            icon={<Brain size={20} aria-hidden />}
            title={t('admin:users.noMemories')}
            description={t('admin:users.noMemoriesBody')}
          />
        ) : (
          <AdminTable
            items={rows}
            rowKey={(memory) => memory.id}
            label={t('admin:users.viewMemories')}
            columns={[
              { id: 'memory', header: t('memory:fields.text'), width: 420, render: (memory) => <p className="text-pretty">{memory.memory_text}</p> },
              { id: 'slot', header: t('memory:fields.slot'), width: 230, render: (memory) => <code className="block break-all font-mono text-[12px] text-[var(--color-fg-muted)]">{memory.slot ? `${memory.slot}${memory.value ? ` = ${memory.value}` : ''}` : '—'}</code> },
              { id: 'status', header: t('admin:common.status'), width: 110, render: (memory) => <Badge size="xs" variant={statusVariant(memory.status)}>{t(`memory:status.${memory.status}`)}</Badge> },
              { id: 'updated', header: t('admin:common.lastActive'), width: 170, render: (memory) => <span className="text-[12px] tabular-nums text-[var(--color-fg-muted)]">{memory.updated_at || memory.created_at ? formatDateTime((memory.updated_at || memory.created_at) * 1000) : '—'}</span> },
            ]}
          />
        )}
      </section>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ExternalLink, Link2, MessageSquare, Search } from 'lucide-react'
import { adminApi, ApiError } from '@/api'
import type { ApiAdminConversationShare, ApiAdminConversationSharePage } from '@/api/types'
import { AdminPageHeader } from '@/components/admin/admin-page-header'
import { AdminTable } from '@/components/admin/AdminTable'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { toast } from '@/hooks/use-toast'
import { publicServerUrl } from '@/lib/server-url'
import { copyText } from '@/lib/utils'

const PAGE_SIZE = 50

function shareURL(id: string): string {
  return publicServerUrl(`/share/${encodeURIComponent(id)}`)
}

export default function AdminConversationShares() {
  const { t, i18n } = useTranslation(['admin', 'common'])
  const [search, setSearch] = useState('')
  const [user, setUser] = useState('')
  const [filters, setFilters] = useState({ search: '', user: '' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ApiAdminConversationSharePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedID, setCopiedID] = useState('')
  const requestRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (search.trim() === filters.search && user.trim() === filters.user) return
    const timer = window.setTimeout(() => {
      setFilters({ search: search.trim(), user: user.trim() })
      setPage(1)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [search, user, filters.search, filters.user])

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
  }, [])

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const result = await adminApi.conversationShares({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      if (request !== requestRef.current) return
      setData(result)
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      if (page > lastPage) setPage(lastPage)
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof ApiError ? cause.message : t('admin:conversationShares.loadFailed'))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [filters, page, t])

  useEffect(() => {
    void load()
    return () => { requestRef.current += 1 }
  }, [load])

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  )
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))
  const filtered = Boolean(filters.search || filters.user)

  async function copyLink(item: ApiAdminConversationShare) {
    if (!(await copyText(shareURL(item.id)))) {
      toast.error(t('admin:conversationShares.copyFailed'))
      return
    }
    setCopiedID(item.id)
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedID(''), 1800)
    toast.success(t('common:actions.copied'))
  }

  return (
    <div className="min-w-0 pb-10">
      <AdminPageHeader title={t('admin:conversationShares.title')} />

      <div className="mt-5 grid gap-3 sm:mt-6 sm:max-w-2xl sm:grid-cols-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          leadingIcon={<Search size={16} aria-hidden />}
          placeholder={t('admin:conversationShares.searchPlaceholder')}
          aria-label={t('admin:conversationShares.searchPlaceholder')}
          wrapperClassName="h-11 sm:h-10"
        />
        <Input
          value={user}
          onChange={(event) => setUser(event.target.value)}
          placeholder={t('admin:usage.filters.userPlaceholder')}
          aria-label={t('admin:usage.filters.user')}
          wrapperClassName="h-11 sm:h-10"
        />
      </div>

      <section className="mt-5" aria-label={t('admin:conversationShares.title')} aria-busy={loading}>
        <p className="mb-3 text-[12.5px] tabular-nums text-[var(--color-fg-subtle)]" aria-live="polite">
          {t('admin:conversationShares.total', { count: data?.total ?? 0 })}
        </p>
        {loading && !data ? (
          <div className="space-y-4 py-4" aria-label={t('admin:common.loading')}>
            {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}
          </div>
        ) : error ? (
          <ErrorState size="panel"
            description={error}
            retry={() => void load()}
          />
        ) : data && data.items.length > 0 ? (
          <div className={loading ? 'pointer-events-none opacity-60' : undefined}>
            <AdminTable
              items={data.items}
              rowKey={(item) => item.id}
              label={t('admin:conversationShares.title')}
              columns={[
                {
                  id: 'title', header: t('admin:conversationShares.table.title'), width: 240,
                  render: (item) => (
                    <div className="min-w-0">
                      <a className="block truncate font-medium hover:underline" href={shareURL(item.id)} target="_blank" rel="noreferrer" title={item.title}>
                        {item.title || t('admin:users.untitledConversation')}
                      </a>
                      <div className="mt-1 space-y-1 text-[12px] text-[var(--color-fg-muted)] sm:hidden">
                        <span className="block truncate" title={item.user_email}>{item.user_name || item.user_email || item.user_id}</span>
                        <a className="block truncate font-mono hover:underline" href={shareURL(item.id)} target="_blank" rel="noreferrer">{shareURL(item.id)}</a>
                        <time className="block tabular-nums" dateTime={new Date(item.created_at * 1000).toISOString()}>{dateFormatter.format(new Date(item.created_at * 1000))}</time>
                      </div>
                    </div>
                  ),
                },
                {
                  id: 'user', header: t('admin:conversationShares.table.user'), width: 220,
                  render: (item) => (
                    <div className="min-w-0" title={[item.user_name, item.user_email, item.user_id].filter(Boolean).join(' / ')}>
                      <span className="block truncate">{item.user_name || item.user_email || item.user_id}</span>
                      <span className="block truncate text-[12px] text-[var(--color-fg-muted)]">{item.user_email || item.user_id}</span>
                    </div>
                  ),
                },
                {
                  id: 'link', header: t('admin:conversationShares.table.link'), width: 320,
                  render: (item) => <a className="block truncate font-mono text-[12px] text-[var(--color-fg-muted)] hover:underline" href={shareURL(item.id)} target="_blank" rel="noreferrer" title={shareURL(item.id)}>{shareURL(item.id)}</a>,
                },
                {
                  id: 'created', header: t('admin:conversationShares.table.created'), width: 170,
                  render: (item) => <time dateTime={new Date(item.created_at * 1000).toISOString()} className="text-[12px] tabular-nums text-[var(--color-fg-muted)]">{dateFormatter.format(new Date(item.created_at * 1000))}</time>,
                },
                {
                  id: 'actions', header: t('admin:common.actions'), align: 'right', width: 132,
                  render: (item) => (
                    <>
                      <Tooltip content={t('admin:conversationShares.copyLink')}>
                        <Button variant="ghost" size="icon-sm" className="max-sm:size-11" aria-label={t('admin:conversationShares.copyLink')} onClick={() => void copyLink(item)}>
                          {copiedID === item.id ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
                        </Button>
                      </Tooltip>
                      <Tooltip content={t('admin:conversationShares.open')}>
                        <Button asChild variant="ghost" size="icon-sm" className="max-sm:size-11">
                          <a href={shareURL(item.id)} target="_blank" rel="noreferrer" aria-label={t('admin:conversationShares.open')}><ExternalLink size={15} aria-hidden /></a>
                        </Button>
                      </Tooltip>
                      <Tooltip content={t('admin:conversationShares.viewConversation')}>
                        <Button asChild variant="ghost" size="icon-sm" className="max-sm:size-11">
                          <Link to={`/admin/users/${encodeURIComponent(item.user_id)}/conversations/${encodeURIComponent(item.conversation_id)}`} aria-label={t('admin:conversationShares.viewConversation')}><MessageSquare size={15} aria-hidden /></Link>
                        </Button>
                      </Tooltip>
                    </>
                  ),
                },
              ]}
            />
            <Pagination page={page} pageCount={pageCount} onPage={setPage} />
          </div>
        ) : (
          <EmptyState size="panel" icon={<Link2 size={24} aria-hidden />} title={t(filtered ? 'admin:conversationShares.emptyFiltered' : 'admin:conversationShares.empty')} />
        )}
      </section>
    </div>
  )
}

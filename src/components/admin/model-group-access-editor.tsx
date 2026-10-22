import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { adminApi } from '@/api'
import type { ApiUserGroup } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { AdminTable } from './AdminTable'

export function ModelGroupAccessEditor({
  deniedGroupIDs,
  onChange,
  disabled = false,
}: {
  deniedGroupIDs: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('admin')
  const [groups, setGroups] = useState<ApiUserGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    adminApi.userGroups()
      .then((items) => { if (active) setGroups(items) })
      .catch(() => { if (active) setFailed(true) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [attempt])

  if (loading) return <p role="status" className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
  if (failed) return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-[var(--color-danger)]">{t('models.groupAccess.loadFailed')}</p>
      <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
        <RefreshCw className="size-4" />{t('models.groupAccess.retry')}
      </Button>
    </div>
  )

  return (
    <div className="grid gap-3">
      <AdminTable
        items={groups}
        rowKey={(group) => group.id}
        label={t('models.groupAccess.title')}
        emptyMessage={t('models.groupAccess.empty')}
        columns={[
          { id: 'group', header: t('users.fields.group'), width: 180, render: (group) => <span className="font-medium">{group.name}</span> },
          {
            id: 'access', header: t('models.groupAccess.allowed'), width: 140,
            render: (group) => (
              <Switch
                aria-label={t('models.groupAccess.switchLabel', { group: group.name })}
                checked={!deniedGroupIDs.includes(group.id)}
                disabled={disabled}
                onCheckedChange={(allowed) => onChange(allowed
                  ? deniedGroupIDs.filter((id) => id !== group.id)
                  : [...new Set([...deniedGroupIDs, group.id])])}
              />
            ),
          },
        ]}
      />
      <p className="text-xs text-[var(--color-fg-muted)]">{t('models.groupAccess.saveHint')}</p>
    </div>
  )
}

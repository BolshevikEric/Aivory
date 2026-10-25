// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import AdminUsage from '@/pages/admin/AdminUsage'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ApiUsageRecord } from '@/api/types'

const { usage, models, translate } = vi.hoisted(() => ({
  usage: vi.fn(),
  models: vi.fn(),
  translate: (key: string) => key,
}))
vi.mock('@/api', () => ({ adminApi: { usage, models }, ApiError: class extends Error {} }))
vi.mock('@/hooks/use-toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))

describe('admin usage cache tokens', () => {
  it('shows provider cache counts in both the table and call details', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const record: ApiUsageRecord = {
      id: 42, user_id: 'u1', user_name: 'Operator', user_email: 'operator@example.test',
      conversation_id: '', conversation_title: '', conversation_deleted: false,
      model_id: 'claude-test', purpose: 'chat', input_tokens: 100, output_tokens: 7,
      cache_read_tokens: 1240, cache_write_tokens: 520, cost: 0.001, currency: 'USD',
      credits: 0, created_at: 1_780_000_000, status: 'ok',
    }
    usage.mockResolvedValue({ records: [record], total: 1, total_cost: record.cost, page: 1, page_size: 50 })
    models.mockResolvedValue([{ id: record.model_id, label: 'Claude test' }])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(AdminUsage))))
      })
      const row = container.querySelector<HTMLTableRowElement>('tbody tr')
      expect(row?.querySelector('[data-column="cache-read"]')?.textContent).toBe(record.cache_read_tokens.toLocaleString())
      expect(row?.querySelector('[data-column="cache-write"]')?.textContent).toBe(record.cache_write_tokens.toLocaleString())

      await act(async () => { row?.click() })
      const detail = document.querySelector('[data-slot="sheet-content"]')
      expect(detail).not.toBeNull()
      const valueFor = (key: string) => Array.from(detail!.querySelectorAll('dt'))
        .find((label) => label.textContent === key)?.nextElementSibling?.textContent
      expect(valueFor('usage.table.cacheReadTokens')).toBe(record.cache_read_tokens.toLocaleString())
      expect(valueFor('usage.table.cacheWriteTokens')).toBe(record.cache_write_tokens.toLocaleString())
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
      vi.unstubAllGlobals()
    }
  })
})

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface AdminTableColumn<T> {
  id: string
  header: ReactNode
  /** Minimum column width in pixels; wide tables scroll within their frame. */
  width?: number
  align?: 'left' | 'center' | 'right'
  render: (item: T, index: number) => ReactNode
}

interface AdminTableProps<T> {
  items: readonly T[]
  columns: AdminTableColumn<T>[]
  rowKey: (item: T) => string
  label?: string
  className?: string
  emptyMessage?: ReactNode
  renderRow?: (item: T, index: number, cells: ReactNode) => ReactNode
  framed?: boolean
  hideHeader?: boolean
  embedded?: boolean
}

export function AdminTableFrame({ children, className, embedded, label }: { children: ReactNode; className?: string; embedded?: boolean; label?: string }) {
  return (
    <div
      className={cn('admin-table-scroll', className)}
      data-embedded={embedded || undefined}
      tabIndex={0}
      role={label ? 'region' : undefined}
      aria-label={label}
    >
      {children}
    </div>
  )
}

/** Shared layout and semantics for sortable lists and read-only admin tables. */
export function AdminTable<T>({ items, columns, rowKey, label, className, emptyMessage, renderRow, framed = true, hideHeader = false, embedded }: AdminTableProps<T>) {
  const { t } = useTranslation('admin')
  const tableRef = useRef<HTMLTableElement>(null)
  const [actionsWidth, setActionsWidth] = useState<number | null>(null)
  const hasActions = columns.some((column) => column.id === 'actions')

  useLayoutEffect(() => {
    const cells = [...(tableRef.current?.querySelectorAll<HTMLElement>('[data-column="actions"] > .admin-table-cell') ?? [])]
    if (cells.length === 0) return

    function measureActions() {
      const width = Math.ceil(Math.max(...cells.map((cell) => {
        const style = getComputedStyle(cell.parentElement!)
        return cell.getBoundingClientRect().width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      })))
      setActionsWidth((current) => current === width ? current : width)
    }

    measureActions()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureActions)
    cells.forEach((cell) => observer.observe(cell))
    return () => observer.disconnect()
  }, [items, columns, hideHeader])

  const columnWidth = (column: AdminTableColumn<T>) => column.id === 'actions' ? actionsWidth ?? column.width ?? 240 : column.width ?? 240
  const fixedWidth = columns.reduce((total, column) => total + (column.id === 'actions' || column.id === 'order' ? columnWidth(column) : 0), 0)
  const flexibleWidth = columns.reduce((total, column) => total + (column.id !== 'actions' && column.id !== 'order' ? columnWidth(column) : 0), 0)
  const table = (
    <table ref={tableRef} className="admin-data-table" aria-label={label} style={{ minWidth: columns.reduce((total, column) => total + columnWidth(column), 0) }}>
      <colgroup>{columns.map((column) => {
        // Keep controls compact; distribute surplus space among the data columns.
        const flexible = hasActions && column.id !== 'actions' && column.id !== 'order'
        const share = flexibleWidth > 0 ? columnWidth(column) / flexibleWidth : 0
        const width = !hasActions ? column.width : flexible ? `calc(${share * 100}% - ${share * fixedWidth}px)` : columnWidth(column)
        return <col key={column.id} style={{ width }} />
      })}</colgroup>
      {!hideHeader ? (
        <thead><tr>{columns.map((column) => <th key={column.id} scope="col" data-column={column.id} data-align={column.align}>{column.id === 'actions' ? <div className="admin-table-cell">{column.header}</div> : column.header}</th>)}</tr></thead>
      ) : null}
      <tbody>
        {items.map((item, index) => {
          const cells = columns.map((column) => (
            <td key={column.id} data-column={column.id} data-align={column.align}>
              <div className="admin-table-cell">{column.render(item, index)}</div>
            </td>
          ))
          return renderRow ? renderRow(item, index, cells) : <tr key={rowKey(item)}>{cells}</tr>
        })}
        {items.length === 0 ? <tr><td colSpan={columns.length} className="admin-table-empty">{emptyMessage ?? t('common.noResults')}</td></tr> : null}
      </tbody>
    </table>
  )
  return framed ? <AdminTableFrame className={className} embedded={embedded} label={label}>{table}</AdminTableFrame> : table
}

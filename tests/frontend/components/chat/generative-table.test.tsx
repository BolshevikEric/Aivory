// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GenerativeUI } from '@/components/chat/generative-ui'
import { markupAttribute, markupElements, parseUIMarkup } from '@/lib/generative-markup'
import { markupTableParts, markupTableSpan } from '@/lib/generative-markup-table'
import { fitConversationShareTables } from '@/lib/conversation-share-table'
import { complexTable } from '../../fixtures/generative-table'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function render(source: string) {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<GenerativeUI code={source} lang="aivory-ui" />)
  return root
}

describe('composable complex tables', () => {
  it('preserves multi-level headers, all body groups, merged cells and a total row', () => {
    const root = render(complexTable)
    const table = root.querySelector('table')!
    expect(table.tHead?.rows.length).toBe(2)
    expect(table.tBodies.length).toBe(2)
    expect(table.tBodies[0].rows.length).toBe(3)
    expect(table.tBodies[1].rows.length).toBe(2)
    expect(table.tHead?.rows[0].cells[0].rowSpan).toBe(2)
    expect(table.tHead?.rows[0].cells[3].colSpan).toBe(3)
    expect(table.tHead?.rows[0].cells[3].scope).toBe('colgroup')
    expect(table.tBodies[0].rows[0].cells[0].colSpan).toBe(6)
    expect(table.tBodies[0].rows[1].cells[1].rowSpan).toBe(2)
    expect(table.tBodies[0].rows[2].cells.length).toBe(5)
    expect(table.tFoot?.rows[0].cells[0].colSpan).toBe(2)
    expect(table.tFoot?.rows[0].cells[2].colSpan).toBe(3)
    expect(table.tFoot?.textContent).toContain('全部通过')
    expect(root.querySelector('input,button')).toBeNull()
  })
  it('supports repeated column widths, table sizing, alignment and grid borders', () => {
    const root = render(complexTable)
    const table = root.querySelector('table')!
    const cols = table.querySelectorAll('col')
    expect(cols[0].style.width).toBe('320px')
    expect(cols[1].span).toBe(5)
    expect(cols[1].style.width).toBe('80px')
    expect(table.style.tableLayout).toBe('fixed')
    expect(table.style.minWidth).toBe('720px')
    expect(table.style.textAlign).toBe('center')
    expect(table.dataset.borders).toBe('all')
    expect(table.tHead?.rows[0].cells[0].style.verticalAlign).toBe('middle')
    expect(table.tBodies[0].rows[1].cells[0].style.textAlign).toBe('left')
  })
  it('does not flatten multi-row headers even without merged cells', () => {
    const root = render('<table sortable><thead><tr><th width="40%">A</th><th>B</th></tr><tr><th>A detail</th><th>B detail</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    expect(root.querySelectorAll('thead tr')).toHaveLength(2)
    expect(root.querySelector('button')).toBeNull()
    expect(root.querySelector('th')?.style.width).toBe('40%')
  })
  it('keeps ordinary sortable header attributes and safe cell sizing', () => {
    const root = render('<table sortable><thead><tr><th width="30%" align="right">A</th><th>B</th></tr></thead><tbody><tr><td minWidth="8rem" valign="bottom" nowrap>1</td><td width="url(https://evil.test)">2</td></tr></tbody></table>')
    expect(root.querySelectorAll('th button')).toHaveLength(2)
    expect(root.querySelector('th')?.style.width).toBe('30%')
    expect(root.querySelector('th')?.style.textAlign).toBe('right')
    expect(root.querySelector('td')?.style.minWidth).toBe('8rem')
    expect(root.querySelector('td')?.style.verticalAlign).toBe('bottom')
    expect(root.querySelector('td')?.style.whiteSpace).toBe('nowrap')
    expect(root.querySelectorAll('td')[1].style.width).toBe('')
  })
  it('accepts native col void tags and mixed-case span attributes', () => {
    const doc = parseUIMarkup('<table><colgroup><col width="60%"><col width="40%"></colgroup><tbody><tr><td colSpan={2}>A</td></tr></tbody></table>')!
    expect(doc).not.toBeNull()
    expect(render('<table><tr><td rowSpan={0}>A</td><td>B</td></tr><tr><td>C</td></tr></table>').querySelector('td')?.rowSpan).toBe(0)
    const row = markupElements(markupElements(markupElements(doc.children)[0].children, 'tbody')[0].children, 'tr')[0]
    expect(markupAttribute(markupElements(row.children)[0], 'colspan')).toBe(2)
  })
  it('counts logical columns across occupied row spans and preserves direct rows', () => {
    const table = markupElements(parseUIMarkup('<table><thead><tr><th rowspan={2}>A</th></tr><tr><th>B</th><th>C</th></tr></thead><tr><td colspan={3}>Direct</td></tr><tbody><tr><td colspan={3}>Group</td></tr></tbody><tr><td colspan={3}>Last</td></tr></table>')!.children)[0]
    const parts = markupTableParts(table, {})
    expect(parts.columns).toBe(3)
    expect(parts.bodies).toHaveLength(3)
    expect(parts.flat).toBe(false)
  })
  it('normalizes invalid span values to bounded integers', () => {
    for (const value of [undefined, null, true, [], '', 'oops', -1, Infinity]) expect(markupTableSpan(value)).toBe(1)
    expect(markupTableSpan(2.9)).toBe(2)
    expect(markupTableSpan(99999)).toBe(100)
    expect(markupTableSpan(0)).toBe(1)
    expect(markupTableSpan(0, true)).toBe(0)
    expect(markupTableSpan('3', true)).toBe(3)
    expect(markupTableSpan(99999, true)).toBe(1000)
  })
  it('uses the declared column count for empty-table placeholders', () => {
    const root = render('<table><colgroup><col width="40%"/><col span={3} width="20%"/></colgroup><tbody/></table>')
    expect(root.querySelector<HTMLTableCellElement>('tbody td')?.colSpan).toBe(4)
  })
  it('expands repeated export columns so computed capture widths cannot multiply spans', () => {
    const root = render(complexTable)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.tagName === 'TABLE' ? 720 : parseFloat((this as HTMLElement).style.width) || 80
      return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }
    })
    try {
      fitConversationShareTables(root)
      const table = root.querySelector('table')!
      const cols = Array.from(table.querySelectorAll('col'))
      expect(cols).toHaveLength(6)
      expect(cols.every(col => col.span === 1)).toBe(true)
      expect(parseFloat(cols[0].style.width)).toBeCloseTo(44.4444)
      expect(parseFloat(cols[1].style.width)).toBeCloseTo(11.1111)
      expect(table.style.getPropertyPriority('width')).toBe('important')
      expect(parseFloat(table.style.minWidth)).toBe(0)
      expect(table.tHead?.rows[0].cells[3].colSpan).toBe(3)
    } finally { rect.mockRestore() }
  })
})

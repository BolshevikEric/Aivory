import { markupAttribute, markupElements, type MarkupElement, type MarkupValue } from './generative-markup'

/** Bound browser table dimensions and accept the HTML rowspan=0 convention. */
export function markupTableSpan(value: MarkupValue | undefined, row = false): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 1
  if (value === '') return 1
  const number = Number(value)
  if (!Number.isFinite(number) || number < (row ? 0 : 1)) return 1
  return Math.min(row ? 1000 : 100, Math.max(row && number === 0 ? 0 : 1, Math.floor(number)))
}

export function markupTableParts(node: MarkupElement, state: Record<string, MarkupValue>) {
  const elements = markupElements(node.children)
  const head = elements.find(child => child.tag === 'thead')
  const foot = elements.find(child => child.tag === 'tfoot')
  const bodies: MarkupElement[] = []
  let direct: MarkupElement | undefined
  for (const child of elements) {
    if (child.tag === 'tr') {
      if (!direct) {
        direct = { tag: 'tbody', attrs: {}, children: [] }
        bodies.push(direct)
      }
      direct.children.push(child)
    } else {
      direct = undefined
      if (child.tag === 'tbody') bodies.push(child)
    }
  }
  if (!bodies.length) bodies.push({ tag: 'tbody', attrs: {}, children: [] })
  const headers = markupElements(head?.children ?? [], 'tr')
  const groups = [head, ...bodies, foot].filter((group): group is MarkupElement => !!group)
  const declaredColumns = elements.reduce((count, child) => {
    if (child.tag === 'col') return count + markupTableSpan(markupAttribute(child, 'span', state))
    if (child.tag !== 'colgroup') return count
    const cols = markupElements(child.children, 'col')
    return count + (cols.length ? cols.reduce((total, col) => total + markupTableSpan(markupAttribute(col, 'span', state)), 0) : markupTableSpan(markupAttribute(child, 'span', state)))
  }, 0)
  let columns = Math.max(1, Math.min(1000, declaredColumns)), merged = false
  // Occupied columns reset at each row group, as they do in a real HTML table.
  for (const group of groups) {
    const rows = markupElements(group.children, 'tr')
    const occupied: number[] = []
    rows.forEach((row, rowIndex) => {
      let column = 0
      for (const cell of markupElements(row.children).filter(cell => ['th', 'td'].includes(cell.tag))) {
        while ((occupied[column] ?? 0) > rowIndex) column++
        const colSpan = markupTableSpan(markupAttribute(cell, 'colspan', state))
        const rowSpan = markupTableSpan(markupAttribute(cell, 'rowspan', state), true)
        merged ||= colSpan !== 1 || rowSpan !== 1
        const end = Math.min(1000, column + colSpan)
        for (; column < end; column++) occupied[column] = rowSpan === 0 ? rows.length : rowIndex + rowSpan
        columns = Math.max(columns, end)
      }
    })
  }
  // Reordering individual rows would tear apart spans and section headings.
  const flat = !merged && headers.length <= 1 && bodies.length === 1
  return { head, headers, foot, bodies, columns, flat }
}

import { parseUIDocument, type UIBlock } from './generative-ui'
import { markupAttribute, markupElements, markupText, type MarkupElement, type MarkupValue } from './generative-markup'

/** Reuse the existing validated chart/math engines without exposing their JSON protocol. */
export function markupPreset(node: MarkupElement, state: Record<string, MarkupValue>): UIBlock | null {
  const a = (name: string) => markupAttribute(node, name, state)
  const children = markupElements(node.children)
  const attributes = (child: MarkupElement, names: string[]) => Object.fromEntries(names.map(name => [name, markupAttribute(child, name, state)]))
  const control = (child: MarkupElement) => ({ ...attributes(child, ['id', 'label', 'min', 'max', 'step', 'value', 'unit']), type: markupAttribute(child, 'type') ?? 'range', id: markupAttribute(child, 'id') ?? markupAttribute(child, 'name') })
  let block: unknown
  switch (node.tag) {
    case 'chart': {
      const series = children.filter(child => child.tag === 'series')
      const points = series.map(child => markupElements(child.children, 'point'))
      block = { type: 'chart', title: a('title'), kind: a('kind') ?? 'bar', xLabel: a('xlabel'), yLabel: a('ylabel'),
        labels: (points[0] ?? []).map((point, i) => String(markupAttribute(point, 'label', state) ?? i + 1)),
        series: series.map((child, i) => ({ name: markupAttribute(child, 'name', state) ?? `Series ${i + 1}`, values: points[i].map(point => markupAttribute(point, 'value', state)), xValues: a('kind') === 'scatter' ? points[i].map(point => markupAttribute(point, 'x', state)) : undefined })) }
      break
    }
    case 'heatmap': {
      const rows = children.filter(child => child.tag === 'heat-row')
      block = { type: 'heatmap', title: a('title'), xLabels: markupElements(rows[0]?.children ?? [], 'cell').map((cell, i) => String(markupAttribute(cell, 'label', state) ?? i + 1)), yLabels: rows.map((row, i) => String(markupAttribute(row, 'label', state) ?? i + 1)), values: rows.map(row => markupElements(row.children, 'cell').map(cell => markupAttribute(cell, 'value', state))) }
      break
    }
    case 'gauge': block = { type: 'gauge', title: a('title'), label: a('label') ?? '', value: a('value'), min: a('min') ?? 0, max: a('max') ?? 100, unit: a('unit') }; break
    case 'function': block = { type: 'function', title: a('title'), variable: a('variable') ?? 'x', expression: a('expression'),
      functions: children.some(child => child.tag === 'curve') ? children.filter(child => child.tag === 'curve').map(child => attributes(child, ['expression', 'label'])) : undefined,
      range: { min: a('min') ?? -10, max: a('max') ?? 10 }, controls: children.filter(child => child.tag === 'parameter').map(control) }; break
    case 'calculator': block = { type: 'calculator', title: a('title'), description: a('description'), inputs: children.filter(child => child.tag === 'input' || child.tag === 'parameter').map(control), outputs: children.filter(child => child.tag === 'output').map(child => ({ ...attributes(child, ['label', 'expression', 'unit']), label: markupAttribute(child, 'label') ?? markupText(child.children), precision: markupAttribute(child, 'precision') ?? 2 })) }; break
    default: return null
  }
  return parseUIDocument(JSON.stringify({ version: 1, blocks: [block] }))?.blocks[0] ?? null
}

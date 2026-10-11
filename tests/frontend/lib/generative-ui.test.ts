import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compileFunctionExpression, evaluateFunction } from '@/lib/function-expression'
import { generativeLanguage, MAX_GENERATIVE_SOURCE, parseUIDocument } from '@/lib/generative-ui'

const parse = (blocks: unknown[]) => parseUIDocument(JSON.stringify({ version: 1, blocks }))
describe('generative UI protocol', () => {
  it('supports themed components and nested interactive sections', () => {
    expect(parse([{ type: 'tabs', items: [{ title: 'Usage', blocks: [{ type: 'chart', kind: 'line', labels: ['A', 'B'], series: [{ name: 'Tokens', values: [12, -2] }] }] }] }])?.blocks[0].type).toBe('tabs')
    expect(parse([{ type: 'table', columns: ['Name', 'Value'], rows: [['A', 1], [null, true]] }])?.blocks).toHaveLength(1)
  })
  it('supports common visualizations, controls, and editable function plots', () => {
    const result = parse([
      { type: 'chart', kind: 'donut', labels: ['A', 'B'], series: [{ name: 'Share', values: [2, 3] }] },
      { type: 'heatmap', xLabels: ['Mon', 'Tue'], yLabels: ['AM', 'PM'], values: [[1, 2], [3, 4]] },
      { type: 'gauge', label: 'Completion', value: 72, min: 0, max: 100, unit: '%' },
      { type: 'calculator', inputs: [{ type: 'range', id: 'rate', label: 'Rate', min: 0, max: 1, step: .1, value: .5 }, { type: 'toggle', id: 'enabled', label: 'Enabled', value: true }], outputs: [{ label: 'Result', expression: 'rate * enabled', precision: 2 }] },
      { type: 'function', expression: 'a * sin(x) + offset', variable: 'x', range: { min: -3.14, max: 3.14 }, samples: 120, controls: [{ type: 'range', id: 'a', label: 'Amplitude', min: 0, max: 3, step: .1, value: 1 }, { type: 'number', id: 'offset', label: 'Offset', min: -2, max: 2, step: .1, value: 0 }] },
    ])
    expect(result?.blocks.map(block => block.type)).toEqual(['chart', 'heatmap', 'gauge', 'calculator', 'function'])
  })
  it('keeps shipped skill examples compatible with the actual UI protocol', () => {
    const prompt = readFileSync('server/internal/store/skills/generative-ui.md', 'utf8')
    const supported = new Set(['text', 'metrics', 'chart', 'heatmap', 'gauge', 'table', 'card', 'cards', 'steps', 'calculator', 'checklist', 'quiz', 'question', 'form', 'function', 'tabs', 'accordion'])
    let examples = 0
    for (const match of prompt.matchAll(/`(\{[^`]+\})`/g)) {
      const example = JSON.parse(match[1])
      // Table cells and input controls are fragments, not standalone blocks.
      if (!supported.has(example.type) || (example.type === 'text' && example.description)) continue
      expect(parse([example]), match[1]).not.toBeNull()
      examples++
    }
    expect(examples).toBeGreaterThanOrEqual(15)
  })
  it('supports optional card content and safe images/links in nested sections', () => {
    const item = { title: 'Search result', description: 'Summary', meta: 'Source · Today', image: { url: 'https://images.example.test/photo.png', alt: 'Photo' }, link: { url: 'https://example.test/article', label: 'Read more' } }
    expect(parse([{ type: 'card', ...item }])?.blocks[0]).toEqual({ type: 'card', ...item })
    const block = parse([{ type: 'cards', items: [item, { title: 'Text only' }] }])?.blocks[0]
    expect(block?.type === 'cards' && block.items).toEqual([item, { title: 'Text only' }])
    expect(parse([{ type: 'tabs', items: [{ title: 'Results', blocks: [{ type: 'cards', items: [item] }] }] }])).not.toBeNull()
    const sanitized = parse([{ type: 'card', ...item, html: '<script/>', onclick: 'alert(1)', style: { width: '999vw' } }])?.blocks[0]
    expect(sanitized).not.toHaveProperty('html')
    expect(sanitized).not.toHaveProperty('onclick')
    expect(sanitized).not.toHaveProperty('style')
  })
  it('rejects unsafe card URLs, missing titles and unbounded card content', () => {
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///etc/passwd', '/api/admin/delete', 'https://user:password@example.test/image.png']) {
      expect(parse([{ type: 'card', title: 'Result', image: { url } }])).toBeNull()
      expect(parse([{ type: 'cards', items: [{ title: 'Result', link: { url } }] }])).toBeNull()
    }
    for (const item of [{}, { title: '  ' }, { title: 123 }, { title: 'a'.repeat(241) }, { title: 'A', description: 'a'.repeat(2001) }, { title: 'A', image: 'https://example.test/image.png' }, { title: 'A', link: { url: 'https://example.test', label: [] } }]) {
      expect(parse([{ type: 'cards', items: [item] }])).toBeNull()
    }
    expect(parse([{ type: 'cards', items: [] }])).toBeNull()
    expect(parse([{ type: 'cards', items: Array(21).fill({ title: 'Result' }) }])).toBeNull()
  })
  it('preserves calculator assumptions and evaluates AI-defined numeric choices safely', () => {
    const calculator = parse([{ type: 'calculator', description: '10% tax when selected.', inputs: [
      { type: 'number', id: 'quantity', label: 'Quantity', min: 0, max: 100, step: 1, value: 5 },
      { type: 'select', id: 'price', label: 'Plan', value: '12', options: [{ label: 'Basic', value: '12' }, { label: 'Pro', value: '24' }] },
      { type: 'toggle', id: 'tax', label: 'Tax', value: true },
    ], outputs: [{ label: 'Total', expression: 'quantity * price * (1 + tax * 0.1)', unit: 'USD', precision: 2 }] }])?.blocks[0]
    if (calculator?.type !== 'calculator') throw new Error('missing calculator')
    expect(calculator.description).toBe('10% tax when selected.')
    const expression = compileFunctionExpression(calculator.outputs[0].expression, 'quantity', ['price', 'tax'])!
    expect(evaluateFunction(expression, { quantity: 5, price: 12, tax: 1 })).toBeCloseTo(66)
    expect(evaluateFunction(expression, { quantity: 5, price: 24, tax: 0 })).toBe(120)
    expect(parse([{ ...calculator, outputs: [{ label: 'Unsafe', expression: 'fetch(quantity)' }] }])).toBeNull()
  })
  it('supports clarification selectors with single, multiple and custom answers', () => {
    const result = parse([{ type: 'question', questions: [
      { id: 'platform', question: 'Which platform?', options: ['Windows', { label: 'macOS', description: 'Apple computers' }] },
      { id: 'features', question: 'Which features?', options: ['Charts', 'Tables'], multiple: true, allowCustom: false },
    ] }])?.blocks[0]
    expect(result?.type).toBe('question')
    if (result?.type !== 'question') throw new Error('missing question')
    expect(result.questions[0].multiple).toBe(false)
    expect(result.questions[0].allowCustom).toBe(true)
    expect(result.questions[1].multiple).toBe(true)
    expect(result.questions[1].allowCustom).toBe(false)
    expect(result.questions[0].options[1].description).toBe('Apple computers')
  })
  it('rejects ambiguous, malformed and excessive clarification questions', () => {
    const question = { id: 'platform', question: 'Which platform?', options: ['Windows', 'macOS'] }
    for (const invalid of [
      { ...question, id: '__proto__' }, { ...question, question: '  ' },
      { ...question, options: ['Windows'] }, { ...question, options: ['Windows', 'Windows'] },
      { ...question, options: ['Windows', ' '] }, { ...question, options: [{ label: 1 }, 'macOS'] },
      { ...question, multiple: 'true' }, { ...question, allowCustom: 1 },
      { ...question, options: Array.from({ length: 9 }, (_, index) => `Option ${index}`) },
    ]) expect(parse([{ type: 'question', questions: [invalid] }])).toBeNull()
    expect(parse([{ type: 'question', questions: [question, question] }])).toBeNull()
    expect(parse([{ type: 'question', questions: Array.from({ length: 5 }, (_, index) => ({ ...question, id: `q${index}` })) }])).toBeNull()
  })
  it('supports common HTML form fields and meaningful string option values', () => {
    const result = parse([{ type: 'form', title: 'Trip brief', submitLabel: 'Plan my trip', fields: [
      { id: 'city', type: 'text', label: 'City', required: true, maxLength: 200 },
      { id: 'budget', type: 'number', label: 'Budget', min: 0, max: 5000, step: 100, value: 1000 },
      { id: 'pace', type: 'select', label: 'Pace', options: [{ label: 'Relaxed', value: 'relaxed' }, { label: 'Packed', value: 'packed' }], value: 'relaxed' },
      { id: 'travel', type: 'radio', label: 'Transport', options: ['Train', 'Plane'] },
      { id: 'interests', type: 'checkboxes', label: 'Interests', options: ['Nature', 'Food'], value: ['Nature'] },
      { id: 'flexible', type: 'checkbox', label: 'Flexible' },
      ...(['textarea', 'email', 'url', 'tel', 'date', 'time', 'datetime-local'] as const).map((type, index) => ({ id: `field${index}`, type, label: type })),
    ] }])?.blocks[0]
    expect(result?.type).toBe('form')
    if (result?.type !== 'form') throw new Error('missing form')
    expect(result.fields).toHaveLength(13)
    expect(result.fields[0].required).toBe(true)
    expect(result.fields[2]).toMatchObject({ value: 'relaxed', options: [{ label: 'Relaxed', value: 'relaxed' }, { label: 'Packed', value: 'packed' }] })
    expect(result.fields[5]).toMatchObject({ value: false, required: false })
    expect(result.fields[6]).toMatchObject({ maxLength: 4000 })
    expect(result.fields[7]).toMatchObject({ maxLength: 1000 })
  })
  it('rejects malformed forms, unsafe field names and incompatible defaults', () => {
    const field = { id: 'name', type: 'text', label: 'Name' }
    for (const invalid of [
      { ...field, id: '__proto__' }, { ...field, id: 'constructor' }, { ...field, label: ' ' }, { ...field, required: 'true' },
      { ...field, type: 'password' }, { ...field, type: 'file' }, { ...field, maxLength: 0 }, { ...field, maxLength: 12001 },
      { ...field, maxLength: 1.5 }, { ...field, maxLength: 2, value: 'Long' },
      { ...field, type: 'number', min: 10, max: 1 }, { ...field, type: 'number', min: 10, value: 1 },
      { ...field, type: 'number', step: 0 }, { ...field, type: 'number', value: '100' },
      { ...field, type: 'checkbox', value: 'false' }, { ...field, type: 'select', options: [] },
      { ...field, type: 'select', options: ['A', 'A'] }, { ...field, type: 'radio', options: ['A'], value: 'B' },
      { ...field, type: 'checkboxes', options: ['A'], value: ['B'] }, { ...field, type: 'checkboxes', options: ['A', 'B'], value: ['A', 'A'] },
      { ...field, type: 'checkboxes', options: ['A'], value: true },
      { ...field, type: 'date', value: '2026-02-30' }, { ...field, type: 'time', value: '25:60' },
      { ...field, type: 'datetime-local', value: '2026-10-11' },
    ]) expect(parse([{ type: 'form', fields: [invalid] }]), JSON.stringify(invalid)).toBeNull()
    expect(parse([{ type: 'form', fields: [field, field] }])).toBeNull()
    expect(parse([{ type: 'form', fields: Array.from({ length: 21 }, (_, i) => ({ ...field, id: `f${i}` })) }])).toBeNull()
    const parsed = parse([{ type: 'form', action: 'https://evil.test', onSubmit: 'alert(1)', fields: [{ ...field, onclick: 'alert(1)', style: { width: '999vw' } }] }])?.blocks[0]
    expect(parsed).not.toHaveProperty('action')
    expect(parsed).not.toHaveProperty('onSubmit')
    expect(parsed?.type === 'form' && parsed.fields[0]).not.toHaveProperty('onclick')
    expect(parsed?.type === 'form' && parsed.fields[0]).not.toHaveProperty('style')
    expect(parse([{ type: 'form', fields: [{ ...field, type: 'date', value: '2026-10-11' }, { ...field, id: 'time', type: 'time', value: '09:30:15' }, { ...field, id: 'datetime', type: 'datetime-local', value: '2026-10-11T09:30' }] }])).not.toBeNull()
  })
  it('supports multiple functions and real scatter coordinates for every series', () => {
    const functions = parse([{ type: 'function', functions: [{ expression: 'sin(x)', label: 'Wave' }, { expression: 'x^2' }], range: { min: -5, max: 5 } }])?.blocks[0]
    expect(functions?.type === 'function' && functions.functions.map(fn => fn.expression)).toEqual(['sin(x)', 'x^2'])
    const scatter = parse([{ type: 'chart', kind: 'scatter', labels: ['A', 'B'], series: [{ name: 'One', xValues: [1, 3], values: [2, 4] }, { name: 'Two', xValues: [2, 5], values: [5, 9] }] }])?.blocks[0]
    expect(scatter?.type === 'chart' && scatter.series[1].xValues).toEqual([2, 5])
    expect(parse([{ type: 'function', expression: 'x', range: { min: 0, max: 1e-12 } }])).toBeNull()
    expect(parse([{ type: 'function', expression: 'x', range: { min: -1, max: 1 }, controls: [{ type: 'number', id: 'x', label: 'X', min: -1, max: 1, step: .1, value: 0 }] }])).toBeNull()
  })
  it('supports rich table columns and mixed cell types without changing legacy tables', () => {
    const table = {
      type: 'table', title: 'Product comparison',
      columns: ['Product', { label: 'Photo', width: 'compact', align: 'center' }, { label: 'Details', width: 'wide' }, { label: 'Price', align: 'right' }, 'Link'],
      rows: [[
        { type: 'text', text: 'Camera', description: 'Travel kit' },
        { type: 'image', url: 'https://cdn.example.test/camera.jpg?size=large&signature=abc', alt: 'Camera', caption: 'Front view' },
        { type: 'list', items: ['Lightweight', 'Weather sealed'] },
        120,
        { type: 'link', url: 'https://example.test/product', text: 'Product page' },
      ]],
    }
    const result = parse([table])?.blocks[0]
    expect(result).toEqual(table)
    expect(parse([{ type: 'table', columns: ['A', 'B'], rows: [[null, false], ['Plain text', 0]] }])).not.toBeNull()
    expect(parse([{ type: 'tabs', items: [{ title: 'Products', blocks: [table] }] }])).not.toBeNull()
  })
  it('allows only absolute HTTP(S) URLs for table images and links', () => {
    for (const type of ['image', 'link']) {
      for (const url of ['http://images.example.test/a.png', 'https://images.example.test/a.png']) {
        expect(parse([{ type: 'table', columns: ['A'], rows: [[{ type, url, text: 'Open' }]] }])).not.toBeNull()
      }
      for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///etc/passwd', 'blob:https://example.test/id', '//example.test/image.png', '/api/admin/delete', 'https://user:password@example.test/image.png', 'not a url']) {
        expect(parse([{ type: 'table', columns: ['A'], rows: [[{ type, url, text: 'Open' }]] }])).toBeNull()
      }
    }
  })
  it('rejects malformed rich cells, column styles and unbounded cell lists', () => {
    for (const value of [{ type: 'image', url: 42 }, { type: 'html', html: '<img>' }, { type: 'link', url: 'https://example.test' }, { type: 'text', text: [] }, { type: 'list', items: [1] }, { type: 'list', items: Array(21).fill('Item') }]) {
      expect(parse([{ type: 'table', columns: ['A'], rows: [[value]] }])).toBeNull()
    }
    for (const column of [{ label: 'A', align: 'justify' }, { label: 'A', width: 1000 }, { label: 'A', width: '100vw' }, { label: [] }]) {
      expect(parse([{ type: 'table', columns: [column], rows: [['A']] }])).toBeNull()
    }
    expect(parse([{ type: 'metrics', items: [{ label: 'Image', value: { type: 'image', url: 'https://example.test/a.png' } }] }])).toBeNull()
  })
  it('rejects malformed, incomplete, oversized and unsupported data', () => {
    for (const source of ['{', '{"version":2,"blocks":[]}', 'a'.repeat(MAX_GENERATIVE_SOURCE + 1)]) expect(parseUIDocument(source)).toBeNull()
    expect(parse([{ type: 'script', code: 'alert(1)' }])).toBeNull()
    expect(parse([{ type: 'chart', kind: 'line', labels: ['A'], series: [{ name: 'X', values: [1, 2] }] }])).toBeNull()
    expect(parse([{ type: 'table', columns: ['A'], rows: [['a', 'b']] }])).toBeNull()
    expect(parse([{ type: 'metrics', items: [{ label: 'A', value: { html: '<img>' } }] }])).toBeNull()
  })
  it('rejects invalid charts, parameter values, and formula references', () => {
    for (const block of [
      { type: 'chart', kind: 'scatter', labels: ['A'], series: [{ name: 'X', values: [2] }] },
      { type: 'chart', kind: 'pie', labels: ['A'], series: [{ name: 'X', values: [-2] }] },
      { type: 'heatmap', xLabels: ['A', 'B'], yLabels: ['C'], values: [[1]] },
      { type: 'gauge', label: 'Progress', min: 0, max: 100, value: 101 },
      { type: 'calculator', inputs: [{ type: 'number', id: 'a', label: 'A', min: 1, max: 10, step: 1, value: 0 }], outputs: [{ label: 'A', expression: 'a' }] },
      { type: 'calculator', inputs: [{ type: 'toggle', id: 'flag', label: 'Flag', value: 'true' }], outputs: [{ label: 'Flag', expression: 'flag' }] },
      { type: 'calculator', inputs: [{ type: 'toggle', id: 'flag', label: 'Flag', value: true }], outputs: [{ label: 'Flag', expression: 'other' }] },
      { type: 'quiz', question: 'A?', options: ['A', 'B'], answer: 2 },
    ]) expect(parse([block])).toBeNull()
  })
  it('bounds recursion and total rendering work', () => {
    let blocks: unknown[] = [{ type: 'text', text: 'leaf' }]
    for (let i = 0; i < 6; i++) blocks = [{ type: 'accordion', items: [{ title: 'Nested', blocks }] }]
    expect(parse(blocks)).toBeNull()
    expect(parse(Array.from({ length: 33 }, () => ({ type: 'text', text: 'a' })))).toBeNull()
    expect(parse([{ type: 'chart', kind: 'bar', labels: ['A'], series: [{ name: 'X', values: [1e20] }] }])).toBeNull()
  })
  it('only recognizes explicit generative fences', () => {
    expect(generativeLanguage('AIVORY-UI extra')).toBe('aivory-ui')
    expect(generativeLanguage('aivory-html')).toBe('aivory-html')
    expect(generativeLanguage('html')).toBeNull()
    expect(generativeLanguage('json')).toBeNull()
  })
})

describe('safe function expressions', () => {
  it('evaluates arithmetic, math functions, and declared parameters', () => {
    const expression = compileFunctionExpression('a * sin(x) + offset', 'x', ['a', 'offset'])
    expect(expression).not.toBeNull()
    expect(evaluateFunction(expression!, { x: Math.PI / 2, a: 2, offset: 3 })).toBeCloseTo(5)
  })
  it('rejects executable syntax and unknown names', () => {
    expect(compileFunctionExpression('alert(x)')).toBeNull()
    expect(compileFunctionExpression('window.location')).toBeNull()
    expect(compileFunctionExpression('x + secret')).toBeNull()
    expect(compileFunctionExpression('x; 1')).toBeNull()
  })
  it('returns null for non-finite samples', () => {
    const expression = compileFunctionExpression('1 / x')
    expect(evaluateFunction(expression!, { x: 0 })).toBeNull()
    expect(evaluateFunction(expression!, { x: 2 })).toBe(.5)
  })
  it('uses mathematical unary/exponent precedence and accepts domain-limited functions', () => {
    expect(evaluateFunction(compileFunctionExpression('-x^2')!, { x: 3 })).toBe(-9)
    expect(evaluateFunction(compileFunctionExpression('2^-2')!, { x: 0 })).toBe(.25)
    expect(evaluateFunction(compileFunctionExpression('2^3^2')!, { x: 0 })).toBe(512)
    expect(compileFunctionExpression('sqrt(x - 1)')).not.toBeNull()
    expect(evaluateFunction(compileFunctionExpression('sqrt(x - 1)')!, { x: 0 })).toBeNull()
  })
  it('rejects prototype names, oversized work, and invalid function arity', () => {
    for (const source of ['constructor(x)', '__proto__', 'toString(x)', 'sin(x, x)', 'sin()', '('.repeat(121) + 'x' + ')'.repeat(121)]) expect(compileFunctionExpression(source)).toBeNull()
  })
})

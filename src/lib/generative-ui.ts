/** Versioned, deliberately small protocol. Model output is untrusted input. */
import { jsonrepair } from 'jsonrepair'
import { compileExpression, compileFunctionExpression, validExpressionVariable } from './function-expression'

type PrimitiveCell = string | number | boolean | null
export type UITableCell =
  | PrimitiveCell
  | { type: 'text'; text: string; description?: string }
  | { type: 'image'; url: string; alt?: string; caption?: string }
  | { type: 'link'; url: string; text: string }
  | { type: 'list'; items: string[] }
export type UITableColumn = string | {
  label: string
  align?: 'left' | 'center' | 'right'
  width?: 'compact' | 'normal' | 'wide'
}

export type UIChartKind = 'line' | 'bar' | 'area' | 'stacked-bar' | 'horizontal-bar' | 'pie' | 'donut' | 'scatter'
export interface UINumericControl {
  type: 'range' | 'number'
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
}
export type UIControl =
  | UINumericControl
  | { type: 'toggle'; id: string; label: string; value: boolean }
  | { type: 'select'; id: string; label: string; value: string; options: { label: string; value: string }[] }

export interface UIFunction { expression: string; label?: string }
export interface UIOutput { label: string; expression: string; unit?: string; precision: number }
export interface UICard {
  title: string
  description?: string
  meta?: string
  image?: { url: string; alt?: string }
  link?: { url: string; label?: string }
}
export interface UIQuestion {
  id: string
  question: string
  options: { label: string; description?: string }[]
  multiple: boolean
  allowCustom: boolean
}

interface UIFormFieldBase {
  id: string
  label: string
  required: boolean
  description?: string
}
export type UIFormField =
  | (UIFormFieldBase & { type: 'text' | 'textarea' | 'email' | 'url' | 'tel' | 'date' | 'time' | 'datetime-local'; placeholder?: string; maxLength: number; value?: string })
  | (UIFormFieldBase & { type: 'number'; placeholder?: string; min?: number; max?: number; step?: number; value?: number })
  | (UIFormFieldBase & { type: 'select' | 'radio'; options: { label: string; value: string }[]; value?: string })
  | (UIFormFieldBase & { type: 'checkboxes'; options: { label: string; value: string }[]; value: string[] })
  | (UIFormFieldBase & { type: 'checkbox'; value: boolean })

export type UIBlock =
  | { type: 'text'; text: string }
  | { type: 'metrics'; items: { label: string; value: string | number; hint?: string }[] }
  | { type: 'chart'; kind: UIChartKind; title?: string; labels: string[]; series: { name: string; values: number[]; xValues?: number[] }[]; xLabel?: string; yLabel?: string }
  | { type: 'heatmap'; title?: string; xLabels: string[]; yLabels: string[]; values: number[][] }
  | { type: 'gauge'; title?: string; label: string; value: number; min: number; max: number; unit?: string }
  | { type: 'table'; title?: string; columns: UITableColumn[]; rows: UITableCell[][] }
  | ({ type: 'card' } & UICard)
  | { type: 'cards'; title?: string; description?: string; items: UICard[] }
  | { type: 'steps'; items: { title: string; description?: string }[] }
  | { type: 'calculator'; title?: string; description?: string; inputs: UIControl[]; outputs: UIOutput[] }
  | { type: 'checklist'; title?: string; items: { text: string; checked: boolean }[] }
  | { type: 'quiz'; question: string; options: string[]; answer: number; explanation?: string }
  | { type: 'question'; title?: string; questions: UIQuestion[] }
  | { type: 'form'; title?: string; description?: string; fields: UIFormField[]; submitLabel?: string }
  | { type: 'function'; title?: string; functions: UIFunction[]; variable: string; min: number; max: number; samples: number; controls: UINumericControl[] }
  | { type: 'tabs' | 'accordion'; items: { title: string; blocks: UIBlock[] }[] }

export interface UIDocument { version: 1; title?: string; description?: string; blocks: UIBlock[] }
export const MAX_GENERATIVE_SOURCE = 128 * 1024

function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object')
  return v as Record<string, unknown>
}
function str(v: unknown, max = 4000): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('text')
  return v
}
function optional(v: unknown): string | undefined { return v === undefined ? undefined : str(v) }
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || !v.length || v.length > max) throw new Error('array')
  return v
}
function cell(v: unknown): PrimitiveCell {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15) return v
  return str(v)
}
function webURL(v: unknown): string {
  const url = new URL(str(v))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('url')
  return url.href
}
function card(v: unknown): UICard {
  const c = record(v)
  const title = str(c.title, 240).trim()
  if (!title) throw new Error('card-title')
  const image = c.image === undefined ? undefined : record(c.image)
  const link = c.link === undefined ? undefined : record(c.link)
  return {
    title,
    description: c.description === undefined ? undefined : str(c.description, 2000),
    meta: c.meta === undefined ? undefined : str(c.meta, 240),
    image: image && { url: webURL(image.url), alt: image.alt === undefined ? undefined : str(image.alt, 240) },
    link: link && { url: webURL(link.url), label: link.label === undefined ? undefined : str(link.label, 80) },
  }
}
function tableCell(v: unknown): UITableCell {
  if (v === null || typeof v !== 'object') return cell(v)
  const c = record(v)
  switch (c.type) {
    case 'text': return { type: c.type, text: str(c.text), description: optional(c.description) }
    case 'image': return { type: c.type, url: webURL(c.url), alt: optional(c.alt), caption: optional(c.caption) }
    case 'link': return { type: c.type, url: webURL(c.url), text: str(c.text) }
    case 'list': return { type: c.type, items: array(c.items, 20).map(v => str(v)) }
    default: throw new Error('cell')
  }
}
function tableColumn(v: unknown): UITableColumn {
  if (typeof v === 'string') return str(v, 160)
  const c = record(v)
  const { align, width } = c
  if (align !== undefined && align !== 'left' && align !== 'center' && align !== 'right') throw new Error('align')
  if (width !== undefined && width !== 'compact' && width !== 'normal' && width !== 'wide') throw new Error('width')
  return { label: str(c.label, 160), align, width }
}
function finiteNumber(v: unknown, max = 1e15): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw new Error('number')
  return v
}
function identifier(v: unknown): string {
  const value = str(v, 32).trim().toLowerCase()
  if (!validExpressionVariable(value)) throw new Error('identifier')
  return value
}
function control(v: unknown): UIControl {
  const c = record(v)
  const type = c.type
  const id = identifier(c.id)
  const label = str(c.label, 160)
  if (type === 'toggle') {
    if (typeof c.value !== 'boolean') throw new Error('toggle')
    return { type, id, label, value: c.value }
  }
  if (type === 'select') {
    const options = array(c.options, 12).map(option => {
      const item = record(option)
      return { label: str(item.label, 160), value: str(item.value, 160) }
    })
    const value = str(c.value, 160)
    if (!options.some(option => option.value === value) || options.some(option => !option.value.trim() || !Number.isFinite(Number(option.value)) || Math.abs(Number(option.value)) > 1e9) || new Set(options.map(option => option.value)).size !== options.length) throw new Error('control')
    return { type, id, label, value, options }
  }
  if (type !== 'range' && type !== 'number') throw new Error('control')
  const min = finiteNumber(c.min, 1e9), max = finiteNumber(c.max, 1e9), step = finiteNumber(c.step, 1e6), value = finiteNumber(c.value, 1e9)
  if (max <= min || step <= 0 || value < min || value > max) throw new Error('control')
  return { type, id, label, min, max, step, value, unit: optional(c.unit) }
}
function functionControl(v: unknown): UINumericControl {
  const item = control(v)
  if (item.type !== 'range' && item.type !== 'number') throw new Error('function-control')
  return item
}
function formField(v: unknown): UIFormField {
  const f = record(v)
  const id = str(f.id, 32), label = str(f.label, 160).trim()
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || ['constructor', 'prototype'].includes(id) || !label) throw new Error('field')
  if (f.required !== undefined && typeof f.required !== 'boolean') throw new Error('required')
  const base = { id, label, required: f.required === true, description: optional(f.description) }
  if (f.type === 'checkbox') {
    if (f.value !== undefined && typeof f.value !== 'boolean') throw new Error('checkbox')
    return { ...base, type: f.type, value: f.value === true }
  }
  if (f.type === 'select' || f.type === 'radio' || f.type === 'checkboxes') {
    const options = array(f.options, 30).map(raw => {
      if (typeof raw === 'string') {
        const label = str(raw, 240).trim()
        return { label, value: label }
      }
      const option = record(raw)
      return { label: str(option.label, 240).trim(), value: str(option.value, 240) }
    })
    if (options.some(option => !option.label || !option.value.trim()) || new Set(options.map(option => option.value)).size !== options.length) throw new Error('options')
    if (f.type === 'checkboxes') {
      const value = f.value === undefined ? [] : Array.isArray(f.value) && f.value.length <= options.length ? f.value.map(v => str(v, 240)) : null
      if (!value || new Set(value).size !== value.length || value.some(v => !options.some(option => option.value === v))) throw new Error('value')
      return { ...base, type: f.type, options, value }
    }
    const value = f.value === undefined ? undefined : str(f.value, 240)
    if (value !== undefined && !options.some(option => option.value === value)) throw new Error('value')
    return { ...base, type: f.type, options, value }
  }
  if (f.type === 'number') {
    const min = f.min === undefined ? undefined : finiteNumber(f.min)
    const max = f.max === undefined ? undefined : finiteNumber(f.max)
    const step = f.step === undefined ? undefined : finiteNumber(f.step)
    const value = f.value === undefined ? undefined : finiteNumber(f.value)
    if ((min !== undefined && max !== undefined && max < min) || (step !== undefined && step <= 0) || (value !== undefined && ((min !== undefined && value < min) || (max !== undefined && value > max)))) throw new Error('number-field')
    return { ...base, type: f.type, min, max, step, value, placeholder: optional(f.placeholder) }
  }
  if (!['text', 'textarea', 'email', 'url', 'tel', 'date', 'time', 'datetime-local'].includes(String(f.type))) throw new Error('field-type')
  const type = f.type as Extract<UIFormField, { maxLength: number }>['type']
  const maxLength = f.maxLength === undefined ? (type === 'textarea' ? 4000 : 1000) : finiteNumber(f.maxLength, 12000)
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('length')
  const value = f.value === undefined ? undefined : str(f.value, maxLength)
  if (value) {
    const date = type === 'date' ? value : type === 'datetime-local' ? value.split('T')[0] : undefined
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('date')
    const time = type === 'time' ? value : type === 'datetime-local' ? value.split('T')[1] : undefined
    if ((type === 'time' || type === 'datetime-local') && (!time || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))) throw new Error('time')
    if (type === 'datetime-local' && value.split('T').length !== 2) throw new Error('datetime')
  }
  return { ...base, type, maxLength, value, placeholder: optional(f.placeholder) }
}
// Consecutive quoted phrases can be ambiguous to the general JSON repair parser.
function escapeEmbeddedQuotes(source: string): string {
  let quoted = false
  let repaired = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted && char === '\\') {
      repaired += char + (source[++i] ?? '')
      continue
    }
    if (char === '"') {
      if (!quoted) quoted = true
      else {
        let next = i + 1
        while (/\s/.test(source[next] ?? '') && next < source.length) next++
        if (next < source.length && !':,}]'.includes(source[next])) {
          repaired += '\\"'
          continue
        }
        quoted = false
      }
    }
    repaired += char
  }
  return repaired
}

export function parseUIDocument(source: string): UIDocument | null {
  if (source.length > MAX_GENERATIVE_SOURCE) return null
  try {
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      try {
        value = JSON.parse(jsonrepair(source))
      } catch {
        value = JSON.parse(jsonrepair(escapeEmbeddedQuotes(source)))
      }
    }
    const input = record(value)
    // A single preset inside an explicit UI fence has the same validation as a document.
    const root: Record<string, unknown> = input.version === undefined && typeof input.type === 'string'
      ? { version: 1, blocks: [input] }
      : input
    if (root.version !== 1) return null
    let count = 0
    function blocks(v: unknown, depth = 0): UIBlock[] {
      if (depth > 4) throw new Error('depth')
      return array(v, 32).map((raw): UIBlock => {
        if (++count > 100) throw new Error('blocks')
        const b = record(raw)
        switch (b.type) {
          case 'text': return { type: b.type, text: str(b.text, 12000) }
          case 'metrics': return { type: b.type, items: array(b.items, 12).map(v => {
            const i = record(v)
            const value = cell(i.value)
            if (value === null || typeof value === 'boolean') throw new Error('value')
            return { label: str(i.label, 160), value, hint: optional(i.hint) }
          }) }
          case 'chart': {
            if (!['line', 'bar', 'area', 'stacked-bar', 'horizontal-bar', 'pie', 'donut', 'scatter'].includes(String(b.kind))) throw new Error('chart')
            const kind = b.kind as UIChartKind
            const labels = array(b.labels, 120).map(v => str(v, 160))
            const series = array(b.series, 6).map(v => {
              const s = record(v)
              const values = array(s.values, 120).map(v => {
                if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e15) throw new Error('number')
                return v
              })
              if (values.length !== labels.length) throw new Error('length')
              const xValues = s.xValues === undefined ? undefined : array(s.xValues, 120).map(v => finiteNumber(v))
              if (xValues && xValues.length !== labels.length) throw new Error('length')
              if (kind === 'scatter' && !xValues) throw new Error('scatter')
              return { name: str(s.name, 160), values, ...(xValues ? { xValues } : {}) }
            })
            if ((kind === 'pie' || kind === 'donut') && (series.length !== 1 || series[0].values.some(value => value < 0))) throw new Error('pie')
            return { type: b.type, kind, title: optional(b.title), labels, series, ...(b.xLabel === undefined ? {} : { xLabel: str(b.xLabel, 160) }), ...(b.yLabel === undefined ? {} : { yLabel: str(b.yLabel, 160) }) }
          }
          case 'heatmap': {
            const xLabels = array(b.xLabels, 40).map(v => str(v, 120))
            const yLabels = array(b.yLabels, 40).map(v => str(v, 120))
            const values = array(b.values, 40).map(row => {
              const cells = array(row, 40).map(v => finiteNumber(v))
              if (cells.length !== xLabels.length) throw new Error('heatmap')
              return cells
            })
            if (values.length !== yLabels.length) throw new Error('heatmap')
            return { type: b.type, title: optional(b.title), xLabels, yLabels, values }
          }
          case 'gauge': {
            const min = finiteNumber(b.min), max = finiteNumber(b.max), value = finiteNumber(b.value)
            if (max <= min || value < min || value > max) throw new Error('gauge')
            return { type: b.type, title: optional(b.title), label: str(b.label, 160), value, min, max, unit: optional(b.unit) }
          }
          case 'table': {
            const columns = array(b.columns, 16).map(tableColumn)
            const rows = Array.isArray(b.rows) && b.rows.length <= 200 ? b.rows : null
            if (!rows) throw new Error('rows')
            return { type: b.type, title: optional(b.title), columns, rows: rows.map(v => {
              const row = array(v, 16).map(tableCell)
              if (row.length !== columns.length) throw new Error('columns')
              return row
            }) }
          }
          case 'card': return { type: b.type, ...card(b) }
          case 'cards': return { type: b.type, title: optional(b.title), description: optional(b.description), items: array(b.items, 20).map(card) }
          case 'steps': return { type: b.type, items: array(b.items, 40).map(v => {
            const i = record(v)
            return { title: str(i.title, 240), description: optional(i.description) }
          }) }
          case 'calculator': {
            const inputs = array(b.inputs, 12).map(control)
            const ids = inputs.map(item => item.id)
            if (new Set(ids).size !== ids.length) throw new Error('control')
            const outputs = array(b.outputs, 12).map(raw => {
              const item = record(raw)
              const expression = str(item.expression, 240)
              if (!compileExpression(expression, ids)) throw new Error('expression')
              const precision = item.precision === undefined ? 2 : finiteNumber(item.precision, 8)
              if (precision < 0 || !Number.isInteger(precision)) throw new Error('precision')
              return { label: str(item.label, 160), expression, unit: optional(item.unit), precision }
            })
            return { type: b.type, title: optional(b.title), description: optional(b.description), inputs, outputs }
          }
          case 'checklist': return { type: b.type, title: optional(b.title), items: array(b.items, 40).map(raw => {
            const item = record(raw)
            if (item.checked !== undefined && typeof item.checked !== 'boolean') throw new Error('checked')
            return { text: str(item.text, 1000), checked: item.checked === true }
          }) }
          case 'quiz': {
            const options = array(b.options, 8).map(v => str(v, 1000))
            const answer = finiteNumber(b.answer, 8)
            if (!Number.isInteger(answer) || answer < 0 || answer >= options.length || options.length < 2) throw new Error('answer')
            return { type: b.type, question: str(b.question, 2000), options, answer, explanation: optional(b.explanation) }
          }
          case 'question': {
            const questions = array(b.questions, 4).map(raw => {
              const item = record(raw)
              const id = str(item.id, 32)
              const question = str(item.question, 1000).trim()
              if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !question) throw new Error('question')
              if (item.multiple !== undefined && typeof item.multiple !== 'boolean') throw new Error('multiple')
              if (item.allowCustom !== undefined && typeof item.allowCustom !== 'boolean') throw new Error('custom')
              const options = array(item.options, 8).map(rawOption => {
                if (typeof rawOption === 'string') return { label: str(rawOption, 240).trim() }
                const option = record(rawOption)
                return { label: str(option.label, 240).trim(), description: option.description === undefined ? undefined : str(option.description, 600) }
              })
              if (options.length < 2 || options.some(option => !option.label) || new Set(options.map(option => option.label)).size !== options.length) throw new Error('options')
              return { id, question, options, multiple: item.multiple === true, allowCustom: item.allowCustom !== false }
            })
            if (new Set(questions.map(question => question.id)).size !== questions.length) throw new Error('question-id')
            return { type: b.type, title: optional(b.title), questions }
          }
          case 'form': {
            const fields = array(b.fields, 20).map(formField)
            if (new Set(fields.map(field => field.id)).size !== fields.length) throw new Error('field-id')
            const submitLabel = b.submitLabel === undefined ? undefined : str(b.submitLabel, 80).trim()
            if (submitLabel === '') throw new Error('submit-label')
            return { type: b.type, title: optional(b.title), description: optional(b.description), fields, submitLabel }
          }
          case 'function': {
            const variable = identifier(b.variable === undefined ? 'x' : b.variable)
            const functions = array(b.functions === undefined ? [{ expression: b.expression }] : b.functions, 8).map(raw => {
              const item = record(raw)
              return { expression: str(item.expression, 240).trim(), label: item.label === undefined ? undefined : str(item.label, 160) }
            })
            const min = finiteNumber(record(b.range).min, 1e6)
            const max = finiteNumber(record(b.range).max, 1e6)
            const samples = b.samples === undefined ? 240 : finiteNumber(b.samples, 600)
            if (max - min < 1e-9 || !Number.isInteger(samples) || samples < 24 || samples > 600) throw new Error('function')
            const controls = b.controls === undefined || (Array.isArray(b.controls) && b.controls.length === 0) ? [] : array(b.controls, 8).map(functionControl)
            if (new Set(controls.map(item => item.id)).size !== controls.length || controls.some(item => item.id === variable)) throw new Error('function')
            if (functions.some(fn => !compileFunctionExpression(fn.expression, variable, controls.map(item => item.id)))) throw new Error('function')
            return { type: b.type, title: optional(b.title), functions, variable, min, max, samples, controls }
          }
          case 'tabs': case 'accordion': return { type: b.type, items: array(b.items, 8).map(v => {
            const i = record(v)
            return { title: str(i.title, 160), blocks: blocks(i.blocks, depth + 1) }
          }) }
          default: throw new Error('type')
        }
      })
    }
    return { version: 1, title: optional(root.title), description: optional(root.description), blocks: blocks(root.blocks) }
  } catch { return null }
}

export function generativeLanguage(lang?: string): 'aivory-ui' | 'aivory-html' | null {
  const value = lang?.trim().split(/\s+/)[0].toLowerCase()
  return value === 'aivory-ui' || value === 'aivory-html' ? value : null
}

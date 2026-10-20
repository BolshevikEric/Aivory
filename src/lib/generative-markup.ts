import { marked, type Token, type Tokens } from 'marked'
import { markupSVGTags } from './generative-svg'

/** A small, non-executable component language. Never compile model output as JSX. */
export const MAX_MARKUP_SOURCE = 128 * 1024
export type MarkupValue = string | number | boolean | null | MarkupValue[]
export type MarkupAttribute = { literal: MarkupValue } | { expression: string }
export interface MarkupElement { tag: string; attrs: Record<string, MarkupAttribute>; children: MarkupNode[] }
export type MarkupNode = string | MarkupElement
export interface MarkupDocument { children: MarkupNode[]; initial: Record<string, MarkupValue>; setters: Record<string, string> }

/** Exported so the protocol documentation and tests can check the actual registry. */
const presetComponents = new Set((
  'box row column stack grid section spacer divider separator text heading p span strong b em i small code pre kbd mark blockquote br ' +
  'h1 h2 h3 h4 h5 h6 card card-header card-content card-footer badge tag alert callout image img asyncimage avatar figure figcaption ' +
  'metric stats list ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td link a button button-group ' +
  'form label field fieldset legend input textarea select option radio-group radio checkbox switch slider range rating ' +
  'progress meter gauge tabs tab accordion item details summary steps step timeline tooltip skeleton spinner empty ' +
  'chart series point heatmap heat-row cell function curve parameter calculator output state cite map mapwidget map-widget map-point'
).split(/\s+/))
export const markupComponents = new Set([...presetComponents, ...markupSVGTags.keys()])
const voidTags = new Set(['spacer', 'divider', 'separator', 'br', 'col', 'image', 'img', 'asyncimage', 'avatar', 'input', 'slider', 'range', 'progress', 'meter', 'gauge', 'metric', 'skeleton', 'spinner', 'point', 'cell', 'curve', 'parameter', 'output', 'state', 'cite'])
const validName = (name: string) => /^[a-zA-Z_][\w]{0,39}$/.test(name) && !['__proto__', 'prototype', 'constructor', 'window', 'document', 'globalThis', 'eval', 'Function'].includes(name)
export const isMarkupName = validName

function quoted(source: string, start: number): { value: string; end: number } {
  const quote = source[start]
  let value = '', i = start + 1
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === quote) return { value, end: i + 1 }
    if (c === '\\') {
      const escaped = source[++i]
      if (escaped === undefined) break
      if (escaped === 'u') {
        const hex = source.slice(i + 1, i + 5)
        if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('escape')
        value += String.fromCharCode(parseInt(hex, 16)); i += 4
      } else value += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escaped] ?? escaped
    } else value += c
  }
  throw new Error('unfinished string')
}

/** Braces and arrows inside quoted attributes do not terminate a tag. */
function braces(source: string, start: number): { value: string; end: number } {
  let depth = 1, i = start + 1
  for (; i < source.length; i++) {
    if ('"\'`'.includes(source[i])) { i = quoted(source, i).end - 1; continue }
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return { value: source.slice(start + 1, i), end: i + 1 }
  }
  throw new Error('unfinished expression')
}

type ExpressionToken = { value: string; literal?: MarkupValue }
/** Only literals, own state names, arrays and scalar operators; no calls or member access. */
export function evaluateMarkupExpression(source: string, state: Record<string, MarkupValue> = {}): MarkupValue | undefined {
  if (source.length > 4000) return undefined
  try {
    const tokens: ExpressionToken[] = []
    for (let i = 0; i < source.length;) {
      const c = source[i]
      if (/\s/.test(c)) { i++; continue }
      if ('"\'`'.includes(c)) { const s = quoted(source, i); tokens.push({ value: 'literal', literal: s.value }); i = s.end; continue }
      const number = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
      if (number) { tokens.push({ value: 'literal', literal: Number(number[0]) }); i += number[0].length; continue }
      const name = source.slice(i).match(/^[A-Za-z_]\w*/)
      if (name) { tokens.push({ value: name[0] }); i += name[0].length; continue }
      const op = source.slice(i).match(/^(?:===|!==|==|!=|>=|<=|&&|\|\||[+*/%<>!?:(),[\]-])/)
      if (!op) throw new Error('expression token')
      tokens.push({ value: op[0] }); i += op[0].length
      if (tokens.length > 512) throw new Error('expression size')
    }
    let index = 0
    const peek = () => tokens[index]?.value
    const take = (value: string) => { if (peek() !== value) throw new Error('expression syntax'); index++ }
    const priority: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '===': 3, '!==': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }
    function atom(depth: number): MarkupValue {
      if (depth > 32) throw new Error('expression depth')
      const token = tokens[index++]
      if (!token) throw new Error('expression end')
      if (token.value === 'literal') return token.literal!
      if (token.value === '(') { const value = expression(0, depth + 1); take(')'); return value }
      if (token.value === '[') {
        const values: MarkupValue[] = []
        while (peek() !== ']') { values.push(expression(0, depth + 1)); if (peek() !== ',') break; take(',') }
        take(']'); return values
      }
      if (token.value === '!') return !atom(depth + 1)
      if (token.value === '-') return -Number(atom(depth + 1))
      if (token.value === '+') return Number(atom(depth + 1))
      if (token.value === 'true' || token.value === 'false') return token.value === 'true'
      if (token.value === 'null') return null
      if (!validName(token.value) || !Object.hasOwn(state, token.value)) throw new Error('unknown state')
      return state[token.value]
    }
    function expression(min: number, depth: number): MarkupValue {
      let left = atom(depth)
      while (priority[peek()] >= min) {
        const op = tokens[index++].value
        const right = expression(priority[op] + 1, depth + 1)
        switch (op) {
          case '+': left = typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right); break
          case '-': left = Number(left) - Number(right); break
          case '*': left = Number(left) * Number(right); break
          case '/': left = Number(left) / Number(right); break
          case '%': left = Number(left) % Number(right); break
          case '==': case '===': left = left === right; break
          case '!=': case '!==': left = left !== right; break
          case '<': left = Number(left) < Number(right); break
          case '>': left = Number(left) > Number(right); break
          case '<=': left = Number(left) <= Number(right); break
          case '>=': left = Number(left) >= Number(right); break
          case '&&': left = left ? right : left; break
          case '||': left = left ? left : right; break
        }
        if (typeof left === 'string' && left.length > 16000) throw new Error('expression output')
      }
      if (min === 0 && peek() === '?') { take('?'); const yes = expression(0, depth + 1); take(':'); const no = expression(0, depth + 1); left = left ? yes : no }
      return left
    }
    const result = expression(0, 0)
    if (index !== tokens.length || (typeof result === 'number' && !Number.isFinite(result))) return undefined
    return result
  } catch { return undefined }
}

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]
    const n = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
  })
}

function readTag(source: string, start: number) {
  const head = source.slice(start).match(/^<(\/?)([A-Za-z][\w-]*)/)
  if (!head) throw new Error('tag')
  const tag = head[2].toLowerCase(), closing = !!head[1]
  const attrs: Record<string, MarkupAttribute> = Object.create(null)
  let i = start + head[0].length, count = 0
  while (i < source.length) {
    while (/\s/.test(source[i] || '') && i < source.length) i++
    if (source[i] === '>') return { tag, attrs, closing, selfClosing: voidTags.has(tag), end: i + 1 }
    if (source.slice(i, i + 2) === '/>') return { tag, attrs, closing, selfClosing: true, end: i + 2 }
    if (closing || ++count > 40) throw new Error('attributes')
    const name = source.slice(i).match(/^[A-Za-z][\w:-]*/)?.[0].toLowerCase()
    if (!name || Object.hasOwn(attrs, name)) throw new Error('attribute name')
    i += name.length
    while (/\s/.test(source[i] || '') && i < source.length) i++
    let attr: MarkupAttribute = { literal: true }
    if (source[i] === '=') {
      i++; while (/\s/.test(source[i] || '') && i < source.length) i++
      if (source[i] === '{') { const value = braces(source, i); attr = { expression: value.value.trim() }; i = value.end }
      else if ('"\''.includes(source[i] || '\0')) {
        // HTML quoted attributes preserve backslashes (unlike expression strings).
        const end = source.indexOf(source[i], i + 1)
        if (end < 0) throw new Error('attribute quote')
        attr = { literal: decode(source.slice(i + 1, end)) }; i = end + 1
      } else {
        const value = source.slice(i).match(/^[^\s>]+/)?.[0].replace(/\/$/, '')
        if (!value) throw new Error('attribute value')
        attr = { literal: decode(value) }; i += value.length
      }
    }
    attrs[name] = attr
  }
  throw new Error('unfinished tag')
}

export function markupAttribute(node: MarkupElement, name: string, state: Record<string, MarkupValue> = {}): MarkupValue | undefined {
  const value = node.attrs[name.toLowerCase()]
  return value && ('literal' in value ? value.literal : evaluateMarkupExpression(value.expression, state))
}
export function markupText(nodes: MarkupNode[]): string { return nodes.map(node => typeof node === 'string' ? node : markupText(node.children)).join('').trim() }
export function markupElements(nodes: MarkupNode[], tag?: string): MarkupElement[] { return nodes.filter((node): node is MarkupElement => typeof node !== 'string' && (!tag || node.tag === tag)) }

export function markupBinding(node: MarkupElement, setters: Record<string, string> = {}): string | undefined {
  const change = node.attrs.onchange
  if (change && 'expression' in change && Object.hasOwn(setters, change.expression)) return setters[change.expression]
  const value = node.attrs.value ?? node.attrs.checked
  if (value && 'expression' in value && validName(value.expression)) return value.expression
  const name = markupAttribute(node, 'name') ?? markupAttribute(node, 'bind')
  return typeof name === 'string' && validName(name) ? name : undefined
}

export function parseUIMarkup(source: string, live = false): MarkupDocument | null {
  if (!source.trim() || source.length > MAX_MARKUP_SOURCE) return null
  try {
    const doc: MarkupDocument = { children: [], initial: Object.create(null), setters: Object.create(null) }
    const stack: MarkupElement[] = []
    let i = 0, count = 0, components = 0
    const children = () => stack.at(-1)?.children ?? doc.children
    const addState = (name: string, value: MarkupValue) => {
      if (!validName(name) || Object.hasOwn(doc.initial, name) || Object.keys(doc.initial).length >= 60) throw new Error('state')
      doc.initial[name] = value
    }
    while (i < source.length) {
      if (++count > 8000) throw new Error('nodes')
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4)
        if (end < 0) { if (live) break; throw new Error('unfinished comment') }
        i = end + 3; continue
      }
      if (source.startsWith('{@body', i)) {
        let declaration: ReturnType<typeof braces>
        try { declaration = braces(source, i) } catch (e) { if (live) break; throw e }
        const match = declaration.value.match(/^@body\s+const\s+\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*DIL\.useState\(([\s\S]*)\)\s*;?\s*$/)
        if (!match || !validName(match[2])) throw new Error('state declaration')
        const value = evaluateMarkupExpression(match[3])
        if (value === undefined || Object.hasOwn(doc.setters, match[2])) throw new Error('state initializer')
        addState(match[1], value); doc.setters[match[2]] = match[1]; i = declaration.end; continue
      }
      if (/^<\/?[A-Za-z]/.test(source.slice(i))) {
        let token: ReturnType<typeof readTag>
        try { token = readTag(source, i) } catch (e) { if (live && !source.slice(i).includes('>')) break; throw e }
        const inSVG = stack.some(parent => parent.tag === 'svg')
        if (inSVG ? !markupSVGTags.has(token.tag) : !presetComponents.has(token.tag) && token.tag !== 'svg') throw new Error('unsupported component')
        if ((inSVG || token.tag === 'svg') && Object.keys(token.attrs).some(name => name.startsWith('on'))) throw new Error('SVG event handler')
        if (token.closing) {
          if (stack.at(-1)?.tag !== token.tag) throw new Error('unbalanced tag')
          stack.pop()
        } else {
          const node: MarkupElement = { tag: token.tag, attrs: token.attrs, children: [] }
          children().push(node); components++
          if (components > 3000) throw new Error('components')
          if (token.tag === 'state') {
            const name = markupAttribute(node, 'name'), value = markupAttribute(node, 'value')
            if (typeof name !== 'string' || value === undefined) throw new Error('state declaration')
            addState(name, value)
          }
          if (!token.selfClosing) { stack.push(node); if (stack.length > 24) throw new Error('depth') }
        }
        i = token.end; continue
      }
      const start = i++
      if (source[start] === '`') {
        const ticks = source.slice(start).match(/^`+/)![0]
        const end = source.indexOf(ticks, i + ticks.length - 1)
        i = end < 0 ? source.length : end + ticks.length
      } else while (i < source.length && source[i] !== '<' && source[i] !== '`' && !source.startsWith('{@body', i)) i++
      children().push(decode(source.slice(start, i)))
    }
    if ((!live && stack.length) || !components) return null
    function initialize(nodes: MarkupNode[]) {
      for (const node of markupElements(nodes)) {
        if (node.tag === 'svg') continue
        const name = markupBinding(node, doc.setters)
        if (name && !Object.hasOwn(doc.initial, name)) {
          const value = markupAttribute(node, 'value') ?? markupAttribute(node, 'checked')
          if (Object.keys(doc.initial).length >= 60) throw new Error('state limit')
          doc.initial[name] = value ?? (['checkbox', 'switch'].includes(node.tag) ? false : '')
        }
        initialize(node.children)
      }
    }
    initialize(doc.children)
    return doc
  } catch { return null }
}

/** Compatibility with the example's one approved callback, interpreted as data. */
export function markupReply(node: MarkupElement, state: Record<string, MarkupValue>): string | undefined {
  const prompt = markupAttribute(node, 'prompt', state)
  if (typeof prompt === 'string') return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => Object.hasOwn(state, name) ? String(state[name]) : '').trim().slice(0, 16000)
  const handler = node.attrs.onclick ?? node.attrs.onsubmit
  if (!handler || !('expression' in handler)) return undefined
  const match = handler.expression.match(/^\(\s*\)\s*=>\s*GenUI\.issueNewTurn\(([\s\S]*)\)\s*;?$/)
  const value = match && evaluateMarkupExpression(match[1], state)
  return typeof value === 'string' ? value.trim().slice(0, 16000) : undefined
}

const inlineComponents = new Set('text span small strong b em i code kbd mark br badge tag link a button tooltip cite svg state'.split(' '))
const proseMath = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|(?<!\\)\$(?!\s)[^$\n]+?\$|\\\([\s\S]*?\\\)/g
const escapeMarkup = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function componentFence(source: string): string {
  const fenceLength = Math.max(3, ...Array.from(source.matchAll(/`+/g), match => match[0].length + 1))
  const ticks = '`'.repeat(fenceLength)
  return `\n${ticks}aivory-ui\n${source.trimEnd()}\n${ticks}\n\n`
}

function serializeMarkup(node: MarkupNode): string {
  if (typeof node === 'string') return escapeMarkup(node)
  const attrs = Object.entries(node.attrs).map(([name, value]) => 'expression' in value
    ? ` ${name}={${value.expression}}`
    : typeof value.literal === 'string' ? ` ${name}="${escapeMarkup(value.literal)}"` : ` ${name}={${JSON.stringify(value.literal)}}`).join('')
  return voidTags.has(node.tag) ? `<${node.tag}${attrs}/>` : `<${node.tag}${attrs}>${node.children.map(serializeMarkup).join('')}</${node.tag}>`
}

/** Parse emphasis/links across component boundaries without exposing tag attributes to Markdown. */
function formatProseRun(nodes: MarkupNode[]): MarkupNode[] {
  const text = nodes.filter(node => typeof node === 'string').join('')
  let prefix = 'AIVORYCOMPONENTTOKEN'
  while (text.includes(prefix)) prefix += 'X'
  const elements: MarkupElement[] = []
  const source = nodes.map(node => typeof node === 'string' ? node : `${prefix}${elements.push(node) - 1}Z`).join('')
  const marker = new RegExp(`${prefix}(\\d+)Z`, 'g')
  const restore = (raw: string): MarkupNode[] => {
    const parts: MarkupNode[] = []
    let offset = 0
    for (const match of raw.matchAll(marker)) {
      if (match.index! > offset) parts.push(raw.slice(offset, match.index))
      parts.push(elements[Number(match[1])]); offset = match.index! + match[0].length
    }
    if (offset < raw.length) parts.push(raw.slice(offset))
    return parts
  }
  const convert = (tokens: Token[], depth = 0): MarkupNode[] => tokens.flatMap(token => {
    if (depth < 24 && (token.type === 'strong' || token.type === 'em')) return [{ tag: token.type, attrs: {}, children: convert(token.tokens ?? [], depth + 1) }]
    if (depth < 24 && token.type === 'link') return [{ tag: 'link', attrs: { href: { literal: token.href } }, children: convert(token.tokens ?? [], depth + 1) }]
    return restore(token.raw)
  })
  return convert(marked.Lexer.lexInline(source))
}

/** Preserve the prose container around inline tags, splitting around block components. */
function proseMarkup(source: string, wrapper = 'p'): string | null {
  const protectedSource = source.replace(proseMath, value => value.replace(/</g, '&lt;').replace(/>/g, '&gt;')).replace(/\\([<>])/g, (_, value: string) => value === '<' ? '&lt;' : '&gt;')
  const doc = parseUIMarkup(protectedSource, true) ?? parseUIMarkup(`<span>${protectedSource}</span>`)
  if (!doc) return null
  const nodes = doc.children.length === 1 && typeof doc.children[0] !== 'string' && doc.children[0].tag === 'span' && !Object.keys(doc.children[0].attrs).length
    ? doc.children[0].children : doc.children
  let result = '', run: MarkupNode[] = []
  const flush = () => {
    if (run.some(node => typeof node !== 'string' || node.trim())) result += `<${wrapper}>${formatProseRun(run).map(serializeMarkup).join('')}</${wrapper}>`
    run = []
  }
  for (const node of nodes) {
    if (typeof node === 'string' || inlineComponents.has(node.tag)) run.push(node)
    else { flush(); result += serializeMarkup(node) }
  }
  flush()
  const declarations = Object.entries(doc.setters).map(([setter, name]) => `{@body const [${name},${setter}] = DIL.useState(${JSON.stringify(doc.initial[name])})}`).join('\n')
  return declarations + result
}

function hasProseComponents(source: string): boolean {
  if (!source.includes('<') && !source.includes('{@body')) return false
  let found = false
  marked.walkTokens(marked.lexer(source.replace(proseMath, '')), token => {
    const tag = token.type === 'html' ? token.raw.match(/^<([A-Za-z][\w-]*)[\s/>]/)?.[1].toLowerCase() : undefined
    if (tag && (presetComponents.has(tag) || tag === 'svg')) found = true
    if (token.type === 'text' && token.raw.includes('{@body')) found = true
  })
  return found
}

function proseTokenMarkup(token: Token, depth = 0): string | null {
  if (depth > 24) return null
  const children = (tokens: Token[]) => {
    const parts = tokens.map(child => proseTokenMarkup(child, depth + 1))
    return parts.some(part => part === null) ? null : parts.join('')
  }
  switch (token.type) {
    case 'space': return '\n'
    case 'paragraph': case 'text': return proseMarkup(token.text)
    case 'heading': return proseMarkup(token.text, `h${token.depth}`)
    case 'blockquote': {
      const body = children(token.tokens ?? [])
      return body === null ? null : `<blockquote>${body}</blockquote>`
    }
    case 'list': {
      const parts = (token as Tokens.List).items.map(item => {
        const body = children(item.tokens)
        const checkbox = item.task ? `<checkbox disabled value={${Boolean(item.checked)}}/>` : ''
        return body === null ? null : `<li>${checkbox}${body}</li>`
      })
      const tag = token.ordered ? 'ol' : 'ul'
      return parts.some(part => part === null) ? null : `<${tag}${token.ordered ? ` start={${Number(token.start) || 1}}` : ''}>${parts.join('')}</${tag}>`
    }
    case 'table': {
      const table = token as Tokens.Table
      const row = (cells: Tokens.TableCell[], tag: string) => {
        const parts = cells.map((cell, i) => {
          const content = proseMarkup(cell.text, 'span')
          return content === null ? null : `<${tag}${table.align[i] ? ` align="${table.align[i]}"` : ''}>${content}</${tag}>`
        })
        return parts.some(part => part === null) ? null : `<tr>${parts.join('')}</tr>`
      }
      const head = row(table.header, 'th'), rows = table.rows.map(cells => row(cells, 'td'))
      return head === null || rows.some(part => part === null) ? null : `<table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`
    }
    case 'hr': return '<divider/>'
    case 'code': return escapeMarkup(token.raw)
    case 'html': return parseUIMarkup(token.raw, true) ? token.raw : null
    default: return proseMarkup(token.raw)
  }
}

/** Protect raw component trees before Markdown sees blank lines or JSX attributes.
 * Code examples stay source; mixed prose retains its heading/list/table structure.
 */
export function prepareGenerativeMarkup(source: string): string {
  if (source.length > MAX_MARKUP_SOURCE * 4) return source
  const lines = source.split('\n')
  let sourceOffset = 0
  const lineOffsets = lines.map(line => { const offset = sourceOffset; sourceOffset += line.length + 1; return offset })
  const nestedRanges: [number, number][] = []
  let tokenOffset = 0
  for (const token of marked.lexer(source, { gfm: true })) {
    const start = source.indexOf(token.raw, tokenOffset)
    if (start < 0) continue
    tokenOffset = start + token.raw.length
    if (token.type === 'list' || token.type === 'blockquote') nestedRanges.push([start, tokenOffset])
  }
  let fence = '', result = ''
  for (let line = 0; line < lines.length; line++) {
    const current = lines[line], marker = current.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(current)) fence = ''
    }
    const startTag = current.trimStart().match(/^<([A-Za-z][\w-]*)[\s/>]/)?.[1].toLowerCase()
    if (fence || nestedRanges.some(([start, end]) => lineOffsets[line] >= start && lineOffsets[line] < end) || /^(?: {4}|\t)/.test(current) || (!current.trimStart().startsWith('{@body') && (!startTag || !markupComponents.has(startTag)))) { result += current + '\n'; continue }
    let chunk = '', depth = 0, started = false, cursor = 0
    // Scan progressively so each source character is visited only once.
    for (; line < lines.length; line++) {
      chunk += lines[line] + '\n'
      let incomplete = false
      while (cursor < chunk.length) {
        if (chunk.startsWith('<!--', cursor)) {
          const end = chunk.indexOf('-->', cursor + 4)
          if (end < 0) { incomplete = true; break }
          cursor = end + 3
        } else if (chunk.startsWith('{@body', cursor)) {
          try { cursor = braces(chunk, cursor).end } catch { incomplete = true; break }
        } else if (/^<\/?[A-Za-z]/.test(chunk.slice(cursor))) {
          try { const tag = readTag(chunk, cursor); depth += tag.closing ? -1 : tag.selfClosing ? 0 : 1; started = true; cursor = tag.end } catch { incomplete = true; break }
        } else if (chunk[cursor] === '`') {
          const ticks = chunk.slice(cursor).match(/^`+/)![0], end = chunk.indexOf(ticks, cursor + ticks.length)
          if (end < 0) { incomplete = true; break }
          cursor = end + ticks.length
        } else cursor++
      }
      if (!incomplete && started && depth <= 0) {
        const next = lines.slice(line + 1).find(value => value.trim())?.trimStart() ?? ''
        const nextTag = next.match(/^<([A-Za-z][\w-]*)[\s/>]/)?.[1].toLowerCase()
        if (!next.startsWith('{@body') && (!nextTag || !markupComponents.has(nextTag))) break
      }
    }
    const doc = parseUIMarkup(chunk, true)
    const mixed = doc?.children.some(node => typeof node === 'string' && node.trim())
    result += componentFence(mixed ? proseMarkup(chunk) ?? chunk : chunk)
  }
  let promoted = '', offset = 0
  for (const token of marked.lexer(result, { gfm: true })) {
    const start = result.indexOf(token.raw, offset)
    if (start < 0) continue
    promoted += result.slice(offset, start)
    offset = start + token.raw.length
    if (!['paragraph', 'heading', 'list', 'blockquote', 'table'].includes(token.type) || !hasProseComponents(token.raw)) { promoted += token.raw; continue }
    const markup = proseTokenMarkup(token)
    promoted += markup === null ? token.raw : componentFence(markup)
  }
  return (promoted + result.slice(offset)).trimEnd()
}

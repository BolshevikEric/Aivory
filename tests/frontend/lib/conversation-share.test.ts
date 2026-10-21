// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createConversationShareSnapshot, createConversationTextFile, conversationShareFilename, markdownToShareText } from '@/lib/conversation-share'
import { renderConversationShareMessages } from '@/lib/conversation-share-document'
import type { Conversation, Message } from '@/types/chat'
import { complexTable } from '../fixtures/generative-table'
import { nestedComponents } from '../fixtures/generative-nesting'
import { sampleMap, samplePlaces } from '../fixtures/generative-map'
import { recoveredComponents, evolvingState } from '../fixtures/generative-robustness'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const message = (id: string, content: string, extra: Partial<Message> = {}): Message => ({ id, content, role: 'assistant', createdAt: 1, ...extra })
const conversation: Conversation = { id: 'conversation', title: '中文 / Share', createdAt: 1, updatedAt: 1, modelId: 'private-model', messages: [
  message('system', 'SYSTEM SECRET', { role: 'system' }),
  message('first', 'Question', { role: 'user' }),
  message('excluded', 'UNSELECTED SECRET'),
  message('last', '**Answer**\n\n```ts\nconst text = "<hello>"\n```', { cost: 123, reasoning: [{ id: 'thinking', kind: 'thinking', text: 'THINKING SECRET' }], attachments: [{ id: 'private-file', name: '文档.pdf', kind: 'pdf', size: 100, documentId: 'private-document' }], citations: [{ id: 'citation', index: 1, title: 'Source', url: 'https://example.com', domain: 'example.com' }] }),
  message('streaming', 'INCOMPLETE SECRET', { streaming: true }), message('local', 'OPTIMISTIC SECRET', { localOnly: true }),
] }
const labels = { user: 'User', assistant: 'Assistant', attachments: 'Attachments', citations: 'Sources', interactive: 'Interactive content', resourceFailed: 'Image unavailable' }

describe('selected conversation file sharing', () => {
  it('freezes only explicit public fields in conversation order', () => {
    const snapshot = createConversationShareSnapshot(conversation, new Set(['last', 'system', 'first', 'streaming', 'local']))
    expect(snapshot.messages.map(message => message.id)).toEqual(['first', 'last'])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toMatch(/SECRET|private-model|private-file|private-document|reasoning|cost/)
    expect(snapshot.messages[1].attachments).toEqual([{ name: '文档.pdf', kind: 'pdf' }])
    conversation.messages[3].attachments![0].name = 'changed.pdf'
    expect(snapshot.messages[1].attachments[0].name).toBe('文档.pdf')
  })
  it('rejects empty or non-exportable selections', () => {
    expect(() => createConversationShareSnapshot(conversation, new Set(['system', 'streaming']))).toThrow('empty selection')
  })
  it('preserves readable links, tables, code, lists and formula source in TXT', () => {
    const text = markdownToShareText('# Heading\n\n**Bold** [link](https://example.com) $x^2$\n\n3. first\n4. second\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\n  const x = "**literal**"\n```')
    expect(text).toContain('Bold link (https://example.com) $x^2$')
    expect(text).toContain('3. first\n4. second')
    expect(text).toContain('A\tB\n1\t2')
    expect(text).toContain('  const x = "**literal**"')
    expect(text).not.toContain('```')
  })
  it('creates versioned JSON and UTF-8 TXT files', () => {
    const snapshot = createConversationShareSnapshot(conversation, new Set(['first', 'last']), new Date('2026-10-16T00:00:00Z'))
    const json = createConversationTextFile(snapshot, 'json', labels)
    expect(json.blob.type).toBe('application/json;charset=utf-8')
    expect(json.filename).toBe('中文  Share.json')
    expect(createConversationTextFile(snapshot, 'txt', labels).blob.type).toBe('text/plain;charset=utf-8')
    expect(conversationShareFilename('../<>:*', 'pdf')).not.toMatch(/[<>:*]/)
    expect(conversationShareFilename('../<>:*', 'pdf')).not.toContain('/')
  })
  it('renders math and code from message data without mounted chat nodes or executable HTML', () => {
    const rich = { ...conversation, messages: [message('rich', '## Title\n\n$x^2$\n\n$$\\frac{a}{b}$$\n\n<script>alert(1)</script>\n\n```html\n<script>literal()</script>\n```')] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['rich']))
    const rows = renderConversationShareMessages(snapshot, rich.messages, labels)
    expect(rows[0].querySelectorAll('.katex').length).toBe(2)
    expect(rows[0].querySelector('pre code')?.textContent).toBe('<script>literal()</script>')
    expect(rows[0].querySelector('script,button,iframe,.katex-mathml')).toBeNull()
    expect(rows[0].querySelector('.katex-html')).not.toBeNull()
  })
  it('exports composed markup as readable components with no live actions', () => {
    const rich = { ...conversation, messages: [message('markup', '<box gap={3}><heading level={2}>Options</heading><table><tbody><tr><td>Basic</td><td>12</td></tr></tbody></table><text><strong>Inline</strong> <em>spacing</em></text><button prompt="Choose Basic">Choose</button></box>')] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['markup']))
    const [row] = renderConversationShareMessages(snapshot, rich.messages, labels)
    expect(row.querySelector('h2')?.textContent).toBe('Options')
    expect(row.querySelector('td')?.textContent).toBe('Basic')
    expect(row.querySelector('button,iframe,script')).toBeNull()
    expect(row.textContent).toContain('Choose')
    expect(row.textContent).toContain('Inline spacing')
  })
  it('resolves generated image and document references in the static export tree', () => {
    const rich = { ...conversation, messages: [message('artifacts', '[Download](attachment://report.docx)\n\n<card><image src="attachment://diagram.png"/></card>', { artifacts: [
      { id: 'report', filename: 'report.docx', url: '/api/artifacts/report', mimeType: 'application/octet-stream' },
      { id: 'diagram', filename: 'diagram.png', url: '/api/artifacts/diagram', mimeType: 'image/png' },
    ] })] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['artifacts']))
    rich.messages[0].artifacts![0].url = '/api/artifacts/changed-after-snapshot'
    const [row] = renderConversationShareMessages(snapshot, rich.messages, labels)
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/api/artifacts/report')
    expect(row.querySelector('article img')?.getAttribute('src')).toBe('/api/artifacts/diagram')
  })
  it('preserves recovered components and literal expressions in static exports', () => {
    const rich = { ...conversation, messages: [message('recovered', recoveredComponents), message('state', evolvingState)] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['recovered', 'state']))
    const rows = renderConversationShareMessages(snapshot, rich.messages, labels)
    expect(rows[0].textContent).toContain('Result: Pending')
    expect(rows[0].querySelector('.gui-markup-badge')?.textContent).toBe('Available')
    expect(rows[1].querySelector('code')?.textContent).toBe('{done}')
    expect(rows[1].textContent).toContain('Notes: Draft')
    for (const row of rows) expect(row.querySelector('script,style,iframe,button,input,foreignObject')).toBeNull()
  })
  it('retains complex table columns and spans in the static image/PDF tree', () => {
    const rich = { ...conversation, messages: [message('transcript', complexTable)] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['transcript']))
    const [row] = renderConversationShareMessages(snapshot, rich.messages, labels)
    const table = row.querySelector('table')!
    expect(table.tHead?.rows.length).toBe(2)
    expect(table.tBodies.length).toBe(2)
    expect(table.querySelectorAll('col')[1].span).toBe(5)
    expect(table.tBodies[0].rows[0].cells[0].colSpan).toBe(6)
    expect(table.tBodies[0].rows[1].cells[1].rowSpan).toBe(2)
    expect(table.tFoot?.textContent).toContain('全部通过')
    expect(row.querySelector('input,button')).toBeNull()
  })
  it('exports place names and links without a never-mounted map loading area', () => {
    const rich = { ...conversation, messages: [message('map', sampleMap)] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['map']))
    const [row] = renderConversationShareMessages(snapshot, rich.messages, labels)
    expect(row.querySelectorAll('.gui-map-external')).toHaveLength(8)
    expect(row.querySelectorAll('.gui-map-point')).toHaveLength(8)
    expect(row.querySelector('[data-generative-map-canvas],button')).toBeNull()
    for (const point of samplePlaces) expect(row.textContent).toContain(point.name)
  })
  it('keeps nested components and isolated SVG definitions in the static export tree', () => {
    const rich = { ...conversation, messages: [message('nested', nestedComponents), message('repeated', nestedComponents)] }
    const snapshot = createConversationShareSnapshot(rich, new Set(['nested', 'repeated']))
    const rows = renderConversationShareMessages(snapshot, rich.messages, labels)
    const ids = rows.flatMap(row => Array.from(row.querySelectorAll('svg [id]'), node => node.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const row of rows) {
      expect(row.querySelector('td article table td:last-child')?.textContent).toBe('12')
      expect(row.querySelector('td .gui-markup-image img')).not.toBeNull()
      expect(row.querySelector('td svg linearGradient')).not.toBeNull()
      expect(row.querySelector('td svg path[stroke]')?.getAttribute('stroke')).toMatch(/^url\(#gui-svg-/)
      expect(row.querySelector('button,input,script,iframe')).toBeNull()
      expect(row.textContent).toContain('分析报告')
    }
  })
})

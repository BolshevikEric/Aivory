// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createConversationShareSnapshot, createConversationTextFile, conversationShareFilename, markdownToShareText } from '@/lib/conversation-share'
import { renderConversationShareMessages } from '@/lib/conversation-share-document'
import type { Conversation, Message } from '@/types/chat'

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
})

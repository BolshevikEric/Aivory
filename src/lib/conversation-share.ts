import { marked, type Token, type Tokens } from 'marked'
import type { Conversation, Message } from '@/types/chat'

export type ConversationShareFormat = 'image' | 'pdf' | 'txt'
export type ConversationShareQuality = 'standard' | 'high'
export interface ConversationShareFile { blob: Blob; filename: string }
export interface ConversationShareSnapshot {
  format: 'aivory-conversation-share'
  version: 1
  title: string
  exported_at: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    created_at: number
    attachments: Array<{ name: string; kind: string; deleted?: boolean }>
    artifacts: Array<{ filename: string; url: string; mime_type: string }>
    citations: Array<{ index: number; title: string; url: string }>
  }>
}

export const isShareableMessage = (message: Message) =>
  (message.role === 'user' || message.role === 'assistant') && !message.streaming && !message.localOnly

/** Explicit public fields: never serialize store objects, reasoning or other branches. */
export function createConversationShareSnapshot(conversation: Conversation, selected: ReadonlySet<string>, now = new Date()): ConversationShareSnapshot {
  const messages = conversation.messages.filter(message => selected.has(message.id) && isShareableMessage(message))
  if (!messages.length) throw new Error('empty selection')
  return {
    format: 'aivory-conversation-share', version: 1, title: conversation.title, exported_at: now.toISOString(),
    messages: messages.map(message => ({
      id: message.id, role: message.role as 'user' | 'assistant', content: message.content, created_at: message.createdAt,
      attachments: (message.attachments ?? []).map(item => ({ name: item.name, kind: item.kind, ...(item.deleted ? { deleted: true } : {}) })),
      artifacts: (message.artifacts ?? []).map(item => ({ filename: item.filename, url: item.url, mime_type: item.mimeType })),
      citations: (message.citations ?? []).map(item => ({ index: item.index, title: item.title, url: item.url })),
    })),
  }
}

export function conversationShareFilename(title: string, extension: string): string {
  const name = Array.from(title.replace(/[<>:"/\\|?*]/g, '').trim()).filter(char => char.codePointAt(0)! >= 32).slice(0, 80).join('') || 'Aivory'
  return `${name}.${extension}`
}

function plainTokens(tokens: Token[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'space': return '\n'
      case 'code': return `${(token as Tokens.Code).text}\n\n`
      case 'codespan': case 'escape': return (token as Tokens.Codespan).text
      case 'br': return '\n'
      case 'hr': return '\n---\n\n'
      case 'html': return (token as Tokens.HTML).text.replace(/<[^>]*>/g, '')
      case 'link': {
        const link = token as Tokens.Link
        const text = plainTokens(link.tokens)
        return text === link.href ? text : `${text} (${link.href})`
      }
      case 'image': { const image = token as Tokens.Image; return `[${image.text || 'Image'}] (${image.href})` }
      case 'list': return (token as Tokens.List).items.map((item, index) => `${(token as Tokens.List).ordered ? `${Number((token as Tokens.List).start) + index}.` : '-'} ${item.task ? `[${item.checked ? 'x' : ' '}] ` : ''}${plainTokens(item.tokens).trim()}\n`).join('') + '\n'
      case 'table': {
        const table = token as Tokens.Table
        return [table.header, ...table.rows].map(row => row.map(cell => plainTokens(cell.tokens)).join('\t')).join('\n') + '\n\n'
      }
      default: {
        const value = token as Token & { tokens?: Token[]; text?: string }
        const text = value.tokens ? plainTokens(value.tokens) : value.text ?? ''
        return text + (['heading', 'paragraph', 'blockquote'].includes(token.type) ? '\n\n' : '')
      }
    }
  }).join('')
}

export function markdownToShareText(content: string): string {
  return plainTokens(marked.lexer(content)).replace(/\n{3,}/g, '\n\n').trim()
}

export interface ConversationShareLabels { user: string; assistant: string; attachments: string; citations: string; interactive: string; resourceFailed: string }

export function createConversationTextFile(snapshot: ConversationShareSnapshot, format: 'json' | 'txt', labels: ConversationShareLabels): ConversationShareFile {
  const text = format === 'json' ? JSON.stringify(snapshot, null, 2) : [snapshot.title, snapshot.exported_at, '', ...snapshot.messages.map(message => [
    `${message.role === 'user' ? labels.user : labels.assistant}:`, markdownToShareText(message.content),
    message.attachments.length || message.artifacts.length ? `\n${labels.attachments}:\n${[...message.attachments.map(item => item.name), ...message.artifacts.map(item => `${item.filename} (${item.url})`)].join('\n')}` : '',
    message.citations.length ? `\n${labels.citations}:\n${message.citations.map(item => `[${item.index}] ${item.title}: ${item.url}`).join('\n')}` : '',
  ].filter(Boolean).join('\n'))].join('\n\n')
  return { blob: new Blob([text], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' }), filename: conversationShareFilename(snapshot.title, format) }
}

export function saveConversationShareFile(file: ConversationShareFile): void {
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')
  link.href = url; link.download = file.filename
  document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

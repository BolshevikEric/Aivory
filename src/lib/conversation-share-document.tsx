import { renderToStaticMarkup } from 'react-dom/server'
import { GenerativeUI } from '@/components/chat/generative-ui'
import { blockMarkdownToHtml, tokenizeMarkdown, renderMathToHtml } from '@/lib/markdown'
import type { ConversationShareLabels, ConversationShareSnapshot } from './conversation-share'
import type { Message } from '@/types/chat'

/** Small, data-driven export tree. No message actions, reasoning panels or chat layout. */
export function renderConversationShareMessages(snapshot: ConversationShareSnapshot, originals: Message[], labels: ConversationShareLabels): HTMLElement[] {
  return snapshot.messages.map(message => {
    const row = document.createElement('div')
    row.className = 'conversation-share-row'
    const heading = document.createElement('div')
    heading.className = 'conversation-share-role'
    heading.textContent = message.role === 'user' ? labels.user : labels.assistant
    const body = document.createElement('div')
    body.className = 'conversation-share-content'
    const content = document.createElement('div')
    content.innerHTML = tokenizeMarkdown(message.content, message.role === 'user', message.role === 'assistant').map((block, index) => {
      if (block.type === 'math') return renderMathToHtml(block.content, true) ?? escapeText(block.content)
      if (block.type === 'code' && (block.lang === 'aivory-ui' || block.lang === 'aivory-html')) {
        return block.lang === 'aivory-ui' ? renderToStaticMarkup(<GenerativeUI code={block.content} lang="aivory-ui" />, { identifierPrefix: `share-${message.id}-${index}-` }) : `<p>${escapeText(labels.interactive)}</p>`
      }
      if (block.type === 'code') return `<pre><code>${escapeText(block.content)}</code></pre>`
      if (block.type === 'heading') return `<h${block.depth ?? 2}>${blockMarkdownToHtml(block.content)}</h${block.depth ?? 2}>`
      if (block.type === 'hr') return '<hr>'
      if (block.type === 'blockquote') return `<blockquote>${blockMarkdownToHtml(block.content)}</blockquote>`
      return blockMarkdownToHtml(block.content, undefined, message.role === 'user')
    }).join('')
    content.querySelectorAll('[data-math-copy] > button, .katex-mathml, [data-generative-table-controls], .gui-question-submit, .gui-button, button[aria-expanded]').forEach(node => node.remove())
    // Static exports preserve place names and links without a never-mounted map loader.
    content.querySelectorAll('[data-generative-map]').forEach(map => {
      if (map.querySelector('.gui-map-points')) map.querySelectorAll('[data-generative-map-canvas], .gui-map-status').forEach(node => node.remove())
    })
    // Static React markup cannot advance image loading state after decode.
    content.querySelectorAll('[data-generative-ui] img.invisible').forEach(image => {
      image.classList.remove('invisible')
      if (image.nextElementSibling?.matches('svg.lucide')) image.nextElementSibling.remove()
    })
    // Turn remaining interactive labels into static content without losing legends or table headers.
    content.querySelectorAll('button,input,select,textarea').forEach(node => {
      const text = document.createElement('span')
      if (node.classList.contains('gui-map-point')) text.className = 'gui-map-point'
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) text.textContent = node.value
      else text.append(...Array.from(node.childNodes))
      node.replaceWith(text)
    })
    body.append(content)
    const original = originals.find(item => item.id === message.id)
    for (const attachment of original?.attachments ?? []) {
      if (attachment.kind === 'image' && attachment.previewUrl && !attachment.deleted) {
        const image = document.createElement('img'); image.src = attachment.previewUrl; image.alt = attachment.name; body.append(image)
      } else { const line = document.createElement('p'); line.textContent = `${labels.attachments}: ${attachment.name}`; body.append(line) }
    }
    for (const artifact of message.artifacts) {
      if (artifact.mime_type.startsWith('image/')) { const image = document.createElement('img'); image.src = artifact.url; image.alt = artifact.filename; body.append(image) }
      else { const line = document.createElement('p'); line.textContent = `${labels.attachments}: ${artifact.filename}`; body.append(line) }
    }
    if (message.citations.length) {
      const citations = document.createElement('div'); citations.className = 'conversation-share-citations'
      for (const item of message.citations) {
        const line = document.createElement('p'); line.textContent = `[${item.index}] ${item.title}: ${item.url}`; citations.append(line)
      }
      body.append(citations)
    }
    row.append(heading, body)
    return row
  })
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

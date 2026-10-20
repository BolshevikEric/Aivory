import { api } from '@/api/client'
import { conversationFontCSS, embedConversationImages } from './conversation-capture'
import { conversationShareBrand } from './conversation-image'
import { renderConversationShareMessages } from './conversation-share-document'
import { fitConversationShareTables } from './conversation-share-table'
import { conversationShareFilename, type ConversationShareFile, type ConversationShareSnapshot, type ConversationShareLabels } from './conversation-share'
import type { Message } from '@/types/chat'

export async function createConversationPDF(input: {
  conversationId: string; snapshot: ConversationShareSnapshot; originals: Message[]; labels: ConversationShareLabels
  assertActive: () => void; signal: AbortSignal
}): Promise<ConversationShareFile> {
  input.assertActive()
  const started = performance.now()
  const root = document.createElement('section')
  root.className = 'conversation-image-document'
  root.style.width = '680px'
  root.setAttribute('aria-hidden', 'true'); root.inert = true
  const heading = document.createElement('header'); heading.className = 'conversation-image-heading'
  const title = document.createElement('h1'); title.className = 'conversation-image-title'; title.textContent = input.snapshot.title
  heading.append(conversationShareBrand(), title)
  const messages = document.createElement('div'); messages.className = 'conversation-image-messages'
  messages.append(...renderConversationShareMessages(input.snapshot, input.originals, input.labels))
  root.append(heading, messages); document.body.append(root)
  const remove = () => root.remove()
  input.signal.addEventListener('abort', remove, { once: true })
  try {
    await embedConversationImages(root, input.labels.resourceFailed, input.signal)
    const fonts = await conversationFontCSS(root, input.signal)
    fitConversationShareTables(root)
    input.assertActive()
    // Carry local styles, including KaTeX and static charts. Fonts/images are
    // already inlined; the server renderer has scripting and network disabled.
    const styles = Array.from(document.styleSheets).map(sheet => {
      try { return Array.from(sheet.cssRules).filter(rule => rule.type !== CSSRule.FONT_FACE_RULE && rule.type !== CSSRule.IMPORT_RULE).map(rule => rule.cssText).join('\n') }
      catch { return '' }
    }).join('\n')
    const printCSS = `@page{size:A4;margin:14mm}html,body{margin:0;background:#fff;color:#222;color-scheme:light}.conversation-image-document{position:static!important;inset:auto!important;z-index:auto!important;width:auto!important;padding:0!important;background:#fff!important;color:#222!important;--color-fg:#222;--color-fg-muted:#666;--color-bg:#fff;--color-bg-muted:#f5f5f5;--color-border:#ddd;--color-accent:#7c3aed}.conversation-image-messages{display:block}.conversation-share-row{margin-bottom:24px}h1,h2,h3,.conversation-share-role{break-after:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere}thead{display:table-header-group}tr,img,.katex-display{break-inside:avoid}img{max-height:230mm;object-fit:contain}a{overflow-wrap:anywhere}`
    // Escape the HTML raw-text end tag even when a message/code example contains it.
    const css = `${styles}\n${fonts}\n${printCSS}`.replace(/<\/style/gi, '<\\/style')
    const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${css}</style></head><body>${root.outerHTML}</body></html>`
    const prepared = performance.now()
    const blob = await api<Blob>(`/conversations/${encodeURIComponent(input.conversationId)}/export/pdf`, { method: 'POST', body: { html }, responseType: 'blob', signal: input.signal })
    input.assertActive()
    if (blob.type.split(';')[0] !== 'application/pdf' || (await blob.slice(0, 5).text()) !== '%PDF-') throw new Error('invalid PDF response')
    window.dispatchEvent(new CustomEvent('aivory:conversation-export', { detail: { format: 'pdf', timings: { prepare: prepared - started, print: performance.now() - prepared, total: performance.now() - started } } }))
    return { blob, filename: conversationShareFilename(input.snapshot.title, 'pdf') }
  } finally { input.signal.removeEventListener('abort', remove); root.remove() }
}

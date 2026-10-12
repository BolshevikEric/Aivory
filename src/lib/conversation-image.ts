import { AIVORY_MARK_PATH } from '@/components/brand/logo'
import wordmarkSource from '@/assets/brand/aivory-wordmark.svg?raw'
import '@/styles/conversation-image.css'

const IMAGE_WIDTH = 760
const MAX_IMAGE_EDGE = 16384
const MAX_IMAGE_PIXELS = 16_000_000

export interface ConversationImageSource { id: string; node: HTMLElement }
export interface ConversationImagePage { blob: Blob; filename: string }

/** Keep a single complete image readable while bounding canvas memory on mobile. */
export function conversationImageDimensions(height: number): { width: number; height: number; pixelRatio: number } {
  if (!Number.isFinite(height) || height <= 0) throw new RangeError('invalid image size')
  const roundedHeight = Math.ceil(height)
  if (roundedHeight > MAX_IMAGE_EDGE) throw new Error('image selection too large')
  return {
    width: IMAGE_WIDTH,
    height: roundedHeight,
    pixelRatio: Math.min(2, MAX_IMAGE_EDGE / roundedHeight, Math.sqrt(MAX_IMAGE_PIXELS / (IMAGE_WIDTH * roundedHeight))),
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Image capture cancelled', 'AbortError'))
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function brand(): HTMLElement {
  const group = element('div', 'conversation-image-brand')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('width', '30')
  svg.setAttribute('height', '30')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', AIVORY_MARK_PATH)
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('fill', 'var(--color-accent)')
  const circle = document.createElementNS(svg.namespaceURI, 'circle')
  circle.setAttribute('cx', '16')
  circle.setAttribute('cy', '20.9')
  circle.setAttribute('r', '1.4')
  circle.setAttribute('fill', 'var(--color-accent)')
  svg.append(path, circle)
  const wordmark = new DOMParser().parseFromString(wordmarkSource, 'image/svg+xml').documentElement
  wordmark.setAttribute('width', '85')
  wordmark.setAttribute('height', '26')
  wordmark.setAttribute('fill', 'var(--color-fg)')
  wordmark.querySelector('defs')?.remove()
  group.append(svg, document.importNode(wordmark, true))
  group.setAttribute('aria-label', 'Aivory')
  return group
}

function cloneMessage(source: HTMLElement, interactiveLabel: string): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  // Native values and canvas pixels live in properties, not cloned attributes.
  const originalControls = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')
  clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select').forEach((control, index) => {
    const original = originalControls[index]
    control.value = original.value
    if (control instanceof HTMLInputElement && original instanceof HTMLInputElement) {
      control.checked = original.checked
      control.setAttribute('value', original.value)
      if (original.checked) control.setAttribute('checked', '')
      else control.removeAttribute('checked')
    } else if (control instanceof HTMLTextAreaElement) control.textContent = original.value
  })
  const originalCanvases = source.querySelectorAll('canvas')
  clone.querySelectorAll('canvas').forEach((canvas, index) => {
    try {
      const image = document.createElement('img')
      image.src = originalCanvases[index].toDataURL()
      image.style.width = `${originalCanvases[index].clientWidth}px`
      image.style.maxWidth = '100%'
      canvas.replaceWith(image)
    } catch { canvas.replaceWith(element('p', 'conversation-image-note', interactiveLabel)) }
  })
  // Opaque HTML sandboxes stay isolated; never read or execute their documents.
  clone.querySelectorAll('iframe,video,audio').forEach(node => node.replaceWith(element('p', 'conversation-image-note', interactiveLabel)))
  clone.querySelectorAll('[data-image-share-ignore], [role="tooltip"], [data-generative-table-controls], .gui-question-submit, .gui-button, button[aria-expanded], .katex-mathml').forEach(node => node.remove())
  clone.querySelectorAll('[data-math-copy]').forEach(node => node.removeAttribute('data-copied'))
  clone.querySelectorAll('img').forEach(image => { image.loading = 'eager'; image.removeAttribute('srcset') })
  clone.querySelectorAll('[id]').forEach(node => { if (node instanceof HTMLElement) node.removeAttribute('id') })
  clone.removeAttribute('data-message-id')
  return clone
}

export async function createConversationImages(input: {
  title: string
  messages: ConversationImageSource[]
  interactiveLabel: string
  assertActive: () => void
  signal?: AbortSignal
}): Promise<ConversationImagePage[]> {
  if (!input.messages.length) throw new Error('empty selection')
  input.assertActive()
  const { toBlob, getFontEmbedCSS } = await import('html-to-image')
  input.assertActive()
  await withAbort(document.fonts.ready, input.signal)
  input.assertActive()
  const root = element('section', 'conversation-image-document')
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('data-image-export-root', '')
  root.inert = true
  root.style.width = `${IMAGE_WIDTH}px`
  const header = element('header', 'conversation-image-heading')
  header.append(brand(), element('h1', 'conversation-image-title', input.title))
  const viewport = element('div', 'conversation-image-viewport')
  const body = element('div', 'conversation-image-messages')
  for (const message of input.messages) {
    const row = element('article', 'conversation-image-message')
    row.setAttribute('data-export-message', message.id)
    row.append(cloneMessage(message.node, input.interactiveLabel))
    body.append(row)
  }
  viewport.append(body)
  const footer = element('footer', 'conversation-image-footer', 'Aivory')
  root.append(header, viewport, footer)
  document.body.append(root)
  const onAbort = () => root.remove()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await withAbort(Promise.all(Array.from(root.querySelectorAll('img')).map(image => image.decode().catch(() => {}))), input.signal)
    input.assertActive()
    const dimensions = conversationImageDimensions(root.getBoundingClientRect().height)
    const fetchRequestInit: RequestInit = { credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: input.signal }
    const fontEmbedCSS = await withAbort(getFontEmbedCSS(root, { preferredFontFormat: 'woff2', fetchRequestInit }), input.signal)
    input.assertActive()
    const blob = await withAbort(toBlob(root, {
      ...dimensions, skipAutoScale: true,
      fontEmbedCSS, fetchRequestInit,
      style: { position: 'relative', inset: 'auto', zIndex: 'auto' },
    }), input.signal)
    input.assertActive()
    if (!blob || !blob.size) throw new Error('could not encode image')
    const title = Array.from(input.title.replace(/[<>:"/\\|?*]/g, '').trim()).filter(char => char.codePointAt(0)! >= 32).slice(0, 80).join('') || 'Aivory'
    return [{ blob, filename: `${title}.png` }]
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    root.remove()
  }
}

export function saveConversationImage(page: ConversationImagePage): void {
  const url = URL.createObjectURL(page.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = page.filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

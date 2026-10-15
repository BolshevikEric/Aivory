import { authenticatedRequestHeaders } from '@/api/client'
import { apiFetch } from '@/lib/api-fetch'

/** One stable list: html-to-image caches this option after its first capture. */
export const CAPTURE_STYLE_PROPERTIES = (`display position top right bottom left z-index box-sizing width height min-width min-height max-width max-height
margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left
border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style
border-top-color border-right-color border-bottom-color border-left-color border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius
border-collapse border-spacing table-layout caption-side background-color background-image background-size background-position background-repeat background-clip
color font-family font-size font-style font-weight font-variant font-feature-settings font-variation-settings line-height letter-spacing word-spacing
text-align text-indent text-decoration-line text-decoration-color text-decoration-style text-transform text-shadow text-overflow vertical-align
white-space word-break overflow-wrap overflow overflow-x overflow-y opacity visibility object-fit object-position box-shadow
flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content justify-items justify-self gap row-gap column-gap order
grid-template-columns grid-template-rows grid-column grid-row list-style-type list-style-position list-style-image
transform transform-origin float clear direction writing-mode clip clip-path filter content
fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset
paint-order dominant-baseline text-anchor vector-effect d`).split(/\s+/)

export function withCaptureAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Export cancelled', 'AbortError'))
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function boundedResource<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  const controller = new AbortController()
  const abort = () => controller.abort()
  const deadline = window.setTimeout(abort, 8_000)
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try { return await withCaptureAbort(work(controller.signal), controller.signal) }
  finally { window.clearTimeout(deadline); signal?.removeEventListener('abort', abort) }
}

/** Per-export resource cache never survives an account/workspace boundary. */
export async function embedConversationImages(root: HTMLElement, failedLabel: string, signal?: AbortSignal): Promise<void> {
  const cache = new Map<string, Promise<string>>()
  const images = Array.from(root.querySelectorAll('img'))
  async function load(image: HTMLImageElement) {
    try {
      const url = new URL(image.src, window.location.href)
      let resource = cache.get(url.href)
      if (!resource) {
        resource = boundedResource(async currentSignal => {
          if (url.protocol === 'data:') return url.href
          if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('unsupported image URL')
          const path = url.pathname + url.search
          const headers = url.origin === window.location.origin && path.startsWith('/api/') ? await authenticatedRequestHeaders(path) : {}
          const response = await apiFetch(url.href, { headers, signal: currentSignal, credentials: url.origin === window.location.origin ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer' })
          if (!response.ok) throw new Error('image unavailable')
          const blob = await response.blob()
          if (!blob.type.startsWith('image/') || blob.size > 10 * 1024 * 1024) throw new Error('invalid image resource')
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
          })
        }, signal)
        cache.set(url.href, resource)
      }
      image.src = await resource
      image.removeAttribute('srcset'); image.loading = 'eager'
      await boundedResource(() => image.decode(), signal)
    } catch (error) {
      if (signal?.aborted) throw error
      const note = document.createElement('p'); note.className = 'conversation-image-note'; note.textContent = `${failedLabel}${image.alt ? ` (${image.alt})` : ''}`; image.replaceWith(note)
    }
  }
  // Bound network/decode concurrency for mobile memory and large selections.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, async () => { while (next < images.length) await load(images[next++]) }))
}

const fontCSSCache = new Map<string, string>()

/** html-to-image deep-clones SVG without visiting its children. Resolve their
 * presentation styles here so theme variables/currentColor survive serialization. */
export function freezeConversationSVGs(root: HTMLElement): void {
  root.querySelectorAll<SVGElement>('svg,svg *').forEach(node => {
    const computed = getComputedStyle(node)
    for (const name of ['color', 'fill', 'stroke', 'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight']) {
      node.style.setProperty(name, computed.getPropertyValue(name))
    }
  })
}

export async function conversationFontCSS(root: HTMLElement, signal?: AbortSignal): Promise<string> {
  const families = new Set(Array.from(root.querySelectorAll<HTMLElement>('*')).concat(root).map(node => getComputedStyle(node).fontFamily))
  await boundedResource(() => Promise.all([...families].map(family => document.fonts.load(`16px ${family}`, 'Aivory 中文'))), signal).catch(error => { if (signal?.aborted) throw error })
  const key = [...families].sort().join('|') + `:${document.styleSheets.length}`
  const existing = fontCSSCache.get(key)
  if (existing !== undefined) return existing
  const { getFontEmbedCSS } = await import('html-to-image')
  const css = await boundedResource(currentSignal => getFontEmbedCSS(root, { preferredFontFormat: 'woff2', fetchRequestInit: { credentials: 'same-origin', signal: currentSignal } }), signal).catch(error => {
    if (signal?.aborted) throw error
    // A slow/missing custom font must not prevent sharing; use system fallbacks.
    return ''
  })
  if (!css) return ''
  if (fontCSSCache.size >= 12) fontCSSCache.delete(fontCSSCache.keys().next().value!)
  fontCSSCache.set(key, css)
  return css
}

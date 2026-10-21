import { marked, type Token } from 'marked'
import type { ArtifactRef } from '@/types/chat'

type ArtifactLink = Pick<ArtifactRef, 'filename' | 'url'>

const ARTIFACT_OUTPUT_PATH = /attachment:\/\/|sandbox:\/+workspace\/outputs\/|\/workspace\/outputs\//gi
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？]+$/

/** Only file delivery routes may be used as internal component URLs. */
export function isArtifactUrl(value: string): boolean {
  return /^\/api\/(?:artifacts\/(?:[\w.~-]|%[\da-f]{2})+|public\/shared\/(?:[\w.~-]|%[\da-f]{2})+\/artifacts\/(?:[\w.~-]|%[\da-f]{2})+)$/i.test(value)
}

function artifactURL(artifact: ArtifactLink): string | undefined {
  if (isArtifactUrl(artifact.url)) return artifact.url
  try {
    const url = new URL(artifact.url)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href.replace(/['()`[\]{}]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  } catch { /* An invalid delivery URL must not become a working-looking link. */ }
  return undefined
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function extensionOf(value: string): string {
  const match = value.match(/(\.[a-z0-9]{1,12})$/i)
  return match?.[1]?.toLowerCase() ?? ''
}

function resolveArtifact(rawFilename: string, artifacts: readonly ArtifactLink[], recoverTruncation: boolean): ArtifactLink | undefined {
  const raw = rawFilename.normalize('NFC')
  const decoded = decodePathSegment(raw)?.normalize('NFC')
  const exact = artifacts.filter((artifact) => {
    const filename = artifact.filename.normalize('NFC')
    return filename === raw || filename === decoded || encodeURIComponent(filename).toLowerCase() === raw.toLowerCase()
  })
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return undefined

  // Some models truncate a percent-encoded multibyte filename (for example
  // "%E8.docx"). It is impossible to decode, but mapping remains unambiguous
  // when this message contains exactly one artifact with the same extension.
  if (!recoverTruncation || !raw.includes('%') || decoded !== undefined) return undefined
  const extension = extensionOf(decoded ?? raw)
  if (!extension) return undefined
  const byExtension = artifacts.filter((artifact) => extensionOf(artifact.filename) === extension)
  return byExtension.length === 1 ? byExtension[0] : undefined
}

function rewriteTextSegment(segment: string, artifacts: readonly ArtifactLink[]): string {
  let output = '', cursor = 0
  const names = [...new Set(artifacts.flatMap(artifact => [artifact.filename, encodeURI(artifact.filename), encodeURIComponent(artifact.filename)]))].sort((a, b) => b.length - a.length)
  for (const match of segment.matchAll(ARTIFACT_OUTPUT_PATH)) {
    if (match.index < cursor) continue
    if (match.index > 0 && /[\w:/.-]/.test(segment[match.index - 1])) continue
    const start = match.index + match[0].length, tail = segment.slice(start)
    // Match known names first, including spaces, quotes and parentheses. A
    // boundary prevents a shorter filename from matching an unrelated file.
    const known = names.find(name => (tail.startsWith(name) || name.includes('%') && tail.slice(0, name.length).toLowerCase() === name.toLowerCase()) && /^(?:$|[\s)\]}>"'<`]|[.,;:!?，。；：！？]+(?:$|[\s)\]}>"'<`]))/.test(tail.slice(name.length)))
    const captured = known ?? tail.match(/^[^\s)\]}>"'<`]+/)?.[0] ?? ''
    const filename = known ? captured : captured.replace(TRAILING_PUNCTUATION, '')
    if (!filename) continue
    const artifact = resolveArtifact(filename, artifacts, !/^attachment:/i.test(match[0]))
    const url = artifact && artifactURL(artifact)
    if (!url) continue
    output += segment.slice(cursor, match.index) + url
    cursor = start + filename.length
  }
  return output + segment.slice(cursor)
}

function protectedCode(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = Array.from(markdown.matchAll(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi), match => [match.index, match.index + match[0].length])
  const visit = (source: string, tokens: Token[], base: number, depth = 0) => {
    if (depth > 32) { ranges.push([base, base + source.length]); return }
    let cursor = 0
    for (const token of tokens) {
      const start = source.indexOf(token.raw, cursor)
      if (start < 0) continue
      cursor = start + token.raw.length
      if (token.type === 'code') {
        if (token.lang?.trim().toLowerCase() !== 'aivory-ui') ranges.push([base + start, base + cursor])
      } else if (token.type === 'codespan' || token.type === 'escape') ranges.push([base + start, base + cursor])
      else if ('tokens' in token && Array.isArray(token.tokens)) visit(token.raw, token.tokens, base + start, depth + 1)
      else if (token.type === 'list') visit(token.raw, token.items, base + start, depth + 1)
      // Inline lexing retains table pipes and quote/list prefixes, which block
      // child tokens may omit from their raw source ranges.
      if (['table', 'blockquote', 'list'].includes(token.type)) visit(token.raw, marked.Lexer.lexInline(token.raw), base + start, depth + 1)
    }
  }
  visit(markdown, marked.lexer(markdown), 0)
  return ranges.sort((a, b) => a[0] - b[0])
}

/**
 * Resolve attachment and sandbox output links using this message's actual
 * files. Delivery URLs also retain their public share scope. Code examples
 * stay literal; preset UI fences are rendered content and resolve links too.
 */
export function rewriteSandboxArtifactLinks(markdown: string, artifacts?: readonly ArtifactLink[]): string {
  if (!markdown || !artifacts?.length || markdown.search(ARTIFACT_OUTPUT_PATH) < 0) return markdown

  let output = ''
  let cursor = 0
  for (const [start, end] of protectedCode(markdown)) {
    if (start >= cursor) output += rewriteTextSegment(markdown.slice(cursor, start), artifacts)
    if (end > cursor) output += markdown.slice(Math.max(cursor, start), end)
    cursor = Math.max(cursor, end)
  }
  output += rewriteTextSegment(markdown.slice(cursor), artifacts)
  return output
}

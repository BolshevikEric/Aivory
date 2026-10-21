import { describe, expect, it } from 'vitest'
import { isArtifactUrl, rewriteSandboxArtifactLinks } from '@/lib/artifact-links'
import { isSafeMarkdownUrl } from '@/lib/markdown'
import type { ArtifactRef } from '@/types/chat'

function artifact(id: string, filename: string, mimeType = 'application/octet-stream'): ArtifactRef {
  return { id, filename, mimeType, url: `/api/artifacts/${id}` }
}

describe('sandbox artifact links', () => {
  it('maps a URL-encoded Chinese output filename to its authenticated artifact', () => {
    const markdown = '[下载报告](sandbox:/workspace/outputs/%E6%8A%A5%E5%91%8A.docx)'
    expect(rewriteSandboxArtifactLinks(markdown, [artifact('art-report', '报告.docx')]))
      .toBe('[下载报告](/api/artifacts/art-report)')
  })

  it('recovers a truncated percent-encoded filename only when the extension is unique', () => {
    const markdown = '[下载](sandbox:/workspace/outputs/%E8.docx)'
    expect(rewriteSandboxArtifactLinks(markdown, [
      artifact('art-report', '季度报告.docx'),
      artifact('art-sheet', '数据.xlsx'),
    ])).toBe('[下载](/api/artifacts/art-report)')

    expect(rewriteSandboxArtifactLinks(markdown, [
      artifact('art-report-a', '季度报告.docx'),
      artifact('art-report-b', '年度报告.docx'),
    ])).toBe(markdown)
  })

  it('does not rewrite unknown paths, ordinary links, or code examples', () => {
    const unknown = '[下载](sandbox:/workspace/outputs/other.docx)'
    expect(rewriteSandboxArtifactLinks(unknown, [artifact('art-report', '报告.docx')])).toBe(unknown)
    expect(rewriteSandboxArtifactLinks('[网站](https://example.com/a)', [artifact('art-report', '报告.docx')]))
      .toBe('[网站](https://example.com/a)')
    expect(rewriteSandboxArtifactLinks('`sandbox:/workspace/outputs/报告.docx`', [artifact('art-report', '报告.docx')]))
      .toBe('`sandbox:/workspace/outputs/报告.docx`')
  })

  it('rejects unresolved sandbox schemes at the markdown sanitizer boundary', () => {
    expect(isSafeMarkdownUrl('sandbox:/workspace/outputs/report.docx')).toBe(false)
    expect(isSafeMarkdownUrl('/api/artifacts/art-report')).toBe(true)
    expect(isSafeMarkdownUrl('https://example.com/report.docx')).toBe(true)
  })

  it('resolves Chinese attachment downloads, images and reference links from this message', () => {
    const files = [artifact('art-report', '课程总结.docx'), artifact('art-image', '流程图.png', 'image/png')]
    const source = '[下载](attachment://课程总结.docx)\n\n![流程图](attachment://%E6%B5%81%E7%A8%8B%E5%9B%BE.png)\n\n[报告][file]\n\n[file]: attachment://课程总结.docx'
    expect(rewriteSandboxArtifactLinks(source, files)).toBe('[下载](/api/artifacts/art-report)\n\n![流程图](/api/artifacts/art-image)\n\n[报告][file]\n\n[file]: /api/artifacts/art-report')
  })

  it('handles names with spaces, parentheses and punctuation without matching filename prefixes', () => {
    const files = [artifact('report', '课程 总结 (1).docx')]
    expect(rewriteSandboxArtifactLinks('[下载](<attachment://课程 总结 (1).docx>)。', files)).toBe('[下载](</api/artifacts/report>)。')
    expect(rewriteSandboxArtifactLinks('attachment://课程 总结 (1).docx。', files)).toBe('/api/artifacts/report。')
    expect(rewriteSandboxArtifactLinks('[下载](attachment://report.docx.bak)', [artifact('report', 'report.docx')])).toContain('attachment://report.docx.bak')
  })

  it('does not guess missing, duplicate, invalid or other-message attachments', () => {
    const source = '[下载](attachment://unknown.docx)'
    expect(rewriteSandboxArtifactLinks(source, [artifact('report', 'report.docx')])).toBe(source)
    const duplicate = '[下载](attachment://report.docx)'
    expect(rewriteSandboxArtifactLinks(duplicate, [artifact('a', 'report.docx'), artifact('b', 'report.docx')])).toBe(duplicate)
    expect(rewriteSandboxArtifactLinks(duplicate, [{ ...artifact('a', 'report.docx'), url: 'javascript:alert(1)' }])).toBe(duplicate)
    expect(rewriteSandboxArtifactLinks('[下载](attachment://%E8.docx)', [artifact('a', 'report.docx')])).toContain('attachment://')
    expect(rewriteSandboxArtifactLinks(source)).toBe(source)
    expect(isSafeMarkdownUrl('attachment://unknown.docx')).toBe(false)
    expect(isSafeMarkdownUrl('ATTACHMENT://unknown.png')).toBe(false)
  })

  it('retains a share-scoped delivery URL instead of constructing a private URL', () => {
    const shared = { ...artifact('a', 'report.docx'), url: '/api/public/shared/share-token/artifacts/a' }
    expect(rewriteSandboxArtifactLinks('[下载](attachment://report.docx)', [shared])).toBe('[下载](/api/public/shared/share-token/artifacts/a)')
  })

  it('resolves component and SVG attributes including rendered UI fences while keeping code examples literal', () => {
    const files = [artifact('image', 'diagram.png', 'image/png')]
    const markup = '<card><image src="attachment://diagram.png"/><svg><image href="attachment://diagram.png"/></svg></card>'
    expect(rewriteSandboxArtifactLinks(markup, files)).toBe(markup.replaceAll('attachment://diagram.png', '/api/artifacts/image'))
    expect(rewriteSandboxArtifactLinks('```aivory-ui\n' + markup + '\n```', files)).toContain('src="/api/artifacts/image"')
    for (const source of ['`attachment://diagram.png`', '**`attachment://diagram.png`**', '```html\n' + markup + '\n```', '    attachment://diagram.png\n', '<code>attachment://diagram.png</code>', '<pre>attachment://diagram.png</pre>', '[Site](https://example.test/workspace/outputs/diagram.png)']) {
      expect(rewriteSandboxArtifactLinks(source, files)).toBe(source)
    }
  })

  it('only permits encoded artifact delivery paths as internal component URLs', () => {
    expect(isArtifactUrl('/api/artifacts/a%20b')).toBe(true)
    expect(isArtifactUrl('/api/public/shared/token/artifacts/a')).toBe(true)
    for (const url of ['//evil.test/a', '/api/admin/settings', '/api/artifacts/a" onclick="bad', '/api/artifacts/a\\bad', '/api/artifacts/a?redirect=bad']) expect(isArtifactUrl(url)).toBe(false)
  })

  it('keeps code inside lists, blockquotes and Markdown tables literal while resolving their real links', () => {
    const files = [artifact('image', 'diagram.png')]
    const source = '| Code | Link |\n| --- | --- |\n| `attachment://diagram.png` | [View](attachment://diagram.png) |\n\n> ```text\n> attachment://diagram.png\n> ```\n\n- **`attachment://diagram.png`** [View](attachment://diagram.png)'
    const result = rewriteSandboxArtifactLinks(source, files)
    expect(result.match(/attachment:\/\/diagram.png/g)).toHaveLength(3)
    expect(result.match(/\[View\]\(\/api\/artifacts\/image\)/g)).toHaveLength(2)
  })
})

// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/chat/markdown'
import type { ArtifactRef } from '@/types/chat'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/theme', () => ({ useTheme: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'light' }) }))

const artifacts: ArtifactRef[] = [
  { id: 'report', filename: '课程总结.docx', url: '/api/artifacts/report', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'diagram', filename: 'diagram.png', url: '/api/artifacts/diagram', mimeType: 'image/png' },
]

function render(content: string, files = artifacts) {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<Markdown allowGenerativeUI content={content} artifacts={files} />)
  return root
}

describe('message attachment links', () => {
  it('renders real file download routes and image sources', () => {
    const root = render('[下载报告](attachment://课程总结.docx)\n\n![Diagram](attachment://diagram.png)')
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/api/artifacts/report')
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/api/artifacts/diagram')
  })

  it('resolves links and images nested inside table cells, cards and SVG', () => {
    const root = render('<table><tr><td><card><image src="attachment://diagram.png"/><button href="attachment://课程总结.docx">Download</button><link href="attachment://课程总结.docx">Report</link><svg viewBox="0 0 10 10"><image href="attachment://diagram.png" width="10" height="10"/></svg></card></td></tr></table>')
    expect(root.querySelector('td article img')?.getAttribute('src')).toBe('/api/artifacts/diagram')
    expect(Array.from(root.querySelectorAll('td article a')).map(node => node.getAttribute('href'))).toEqual(['/api/artifacts/report', '/api/artifacts/report'])
    expect(root.querySelector('svg image')?.getAttribute('href')).toBe('/api/artifacts/diagram')
  })

  it('keeps unavailable links and images from launching unsupported browser protocols', () => {
    const root = render('[Missing file](attachment://missing.docx)\n\n![Missing image](attachment://missing.png)', [])
    expect(root.textContent).toContain('Missing file')
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(root.querySelector('img')?.hasAttribute('src')).toBe(false)
    expect(root.querySelector('img')?.alt).toBe('Missing image')
  })
})

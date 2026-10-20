// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GenerativeUI } from '@/components/chat/generative-ui'
import { Markdown } from '@/components/chat/markdown'
import { PrivateMarkdown } from '@/components/chat/private-markdown'
import { parseUIMarkup } from '@/lib/generative-markup'
import { nestedComponents, nestedDiagram } from '../../fixtures/generative-nesting'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/theme', () => ({ useTheme: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'light' }) }))

function render(source: string) {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<GenerativeUI code={source} lang="aivory-ui" />)
  return root
}

describe('recursive component composition and SVG', () => {
  it.each(['ordinary', 'private'])('renders interleaved components in %s replies while preserving surrounding prose', (mode) => {
    const source = '## Plans <badge>Ready</badge>\n\nBefore **bold** <badge tone="success">Available</badge> after.\n\n3. Choose <button href="https://example.test">Open</button> now.\n4. Keep context.\n\n> See <badge>Tip</badge> below.\n\n| Plan | Status |\n| --- | --- |\n| Basic | <badge>Available</badge> |'
    const root = document.createElement('div')
    root.innerHTML = renderToStaticMarkup(mode === 'ordinary' ? <Markdown allowGenerativeUI content={source} /> : <PrivateMarkdown allowGenerativeUI text={source} />)
    expect(root.querySelector('h2 .gui-markup-badge')?.textContent).toBe('Ready')
    expect(root.querySelector('p .gui-markup-badge')?.parentElement?.textContent).toBe('Before bold Available after.')
    expect(root.querySelector('p strong')?.textContent).toBe('bold')
    expect(root.querySelector('ol')?.start).toBe(3)
    expect(root.querySelector('ol li a')?.textContent).toBe('Open')
    expect(root.querySelector('blockquote .gui-markup-badge')?.textContent).toBe('Tip')
    expect(root.querySelector('td .gui-markup-badge')?.textContent).toBe('Available')
  })
  it('preserves Markdown emphasis and links spanning inline component boundaries', () => {
    const root = document.createElement('div')
    root.innerHTML = renderToStaticMarkup(<Markdown allowGenerativeUI content={'Use **Basic <badge>Ready</badge> today** and [read <badge>more</badge>](https://example.test).'} />)
    expect(root.querySelector('strong')?.textContent).toBe('Basic Ready today')
    expect(root.querySelector('strong .gui-markup-badge')).not.toBeNull()
    expect(root.querySelector('a')?.textContent).toBe('read more')
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.test/')
    expect(root.textContent).not.toContain('**')
  })
  it('renders rich cells, cards, nested tables, tab panels, accordions, lists and forms recursively', () => {
    const root = render(nestedComponents)
    expect(root.querySelector('td .gui-markup-image img')?.getAttribute('src')).toContain('nested.png')
    expect(root.querySelector('td article table td:last-child')?.textContent).toBe('12')
    expect(root.querySelector('td article .gui-markup-card-footer button')?.textContent).toContain('分析报告')
    expect(root.querySelector('td article li a')?.textContent).toBe('查看明细')
    expect(root.querySelector('[role="tabpanel"] details article a')?.textContent).toBe('团队主页')
    expect(root.querySelector('[role="tabpanel"] details form fieldset input')?.getAttribute('name')).toBe('feedback')
    expect(root.querySelectorAll('td svg.gui-markup-svg').length).toBe(4)
    expect(root.querySelector('button svg path')?.namespaceURI).toBe('http://www.w3.org/2000/svg')
  })
  it('preserves SVG namespaces, case-sensitive names, drawing attributes and plain text', () => {
    const svg = render(nestedDiagram).querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 240 120')
    expect(svg.querySelector('linearGradient')?.namespaceURI).toBe(svg.namespaceURI)
    expect(svg.querySelector('clipPath')).not.toBeNull()
    expect(svg.querySelector('path[stroke]')?.getAttribute('stroke-width')).toBe('5')
    expect(svg.querySelector('text span, text div')).toBeNull()
    expect(svg.querySelector('text')?.textContent).toBe('Q1Q4')
  })
  it('preserves interactive header content beside the sorting action', () => {
    const root = render(nestedComponents)
    expect(root.querySelector('th .gui-markup-table-heading > .gui-markup-button')?.textContent).toBe('项目')
    expect(root.querySelectorAll('th .gui-markup-table-sort')).toHaveLength(2)
    expect(root.querySelector('.gui-markup-table-sort button, .gui-markup-table-sort a')).toBeNull()
  })
  it('isolates IDs and all local references across repeated diagrams', () => {
    const root = render(`<row>${nestedDiagram}${nestedDiagram}</row>`)
    const ids = Array.from(root.querySelectorAll('[id]'), node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const svg of root.querySelectorAll('svg')) {
      for (const node of svg.querySelectorAll('[stroke],[clip-path],[marker-end],[href]')) {
        const value = node.getAttribute('stroke') ?? node.getAttribute('clip-path') ?? node.getAttribute('marker-end') ?? node.getAttribute('href')!
        const id = value.match(/^url\(#(.+)\)$/)?.[1] ?? (value.startsWith('#') ? value.slice(1) : undefined)
        if (id) expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull()
      }
    }
  })
  it('binds native SVG attributes and text to the surrounding component state', () => {
    const svg = render('<state name="amount" value={25}/><card><svg viewBox="0 0 100 40"><rect width={amount * 2} height="10"/><text x="0" y="30">{amount}% **plain**</text></svg></card>').querySelector('svg')!
    expect(svg.querySelector('rect')?.getAttribute('width')).toBe('50')
    expect(svg.querySelector('text')?.textContent).toBe('25% **plain**')
    expect(svg.querySelector('strong')).toBeNull()
  })
  it('supports filters, local text paths, legacy xlink attributes and accessible icon labels', () => {
    const root = render('<svg viewBox="0 0 100 50" aria-hidden={true}><defs><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter><path id="arc" d="M0 20h100"/></defs><text filter="url(#blur)"><textPath xlink:href="#arc">Hello</textPath></text></svg>')
    expect(root.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(root.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('2')
    expect(root.querySelector('textPath')?.getAttribute('href')).toMatch(/^#gui-svg-/)
  })
  it('drops executable attributes, arbitrary styles and remote SVG references', () => {
    const root = render('<svg viewBox="0 0 100 50" style="background:red"><use href="https://evil.test/shape.svg#x"/><rect width="20" height="20" fill="url(https://evil.test/paint)" style="filter:url(https://evil.test)"/><image href="javascript:alert(1)"/><image href="https://images.example.test/safe.png" width="20" height="20"/></svg>')
    expect(root.querySelector('svg')?.hasAttribute('style')).toBe(false)
    expect(root.querySelector('use')?.hasAttribute('href')).toBe(false)
    expect(root.querySelector('rect')?.hasAttribute('fill')).toBe(false)
    expect(root.querySelector('image')?.hasAttribute('href')).toBe(false)
    expect(root.querySelectorAll('image')[1].getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(root.innerHTML).not.toContain('evil.test')
  })
  it('rejects active SVG, drawing tags outside SVG, and preset content inside SVG', () => {
    for (const source of ['<svg onload="alert(1)"/>', '<svg><script>alert(1)</script></svg>', '<svg><foreignObject><box/></foreignObject></svg>', '<svg><button>Go</button></svg>', '<path d="M0 0h20"/>', '<div><card/></div>']) expect(parseUIMarkup(source), source).toBeNull()
    expect(parseUIMarkup('<svg><!-- <script>comment</script> --><path d="M0 0h20"/></svg>')).not.toBeNull()
    expect(parseUIMarkup('<svg><!-- unfinished', true)).not.toBeNull()
  })
  it.each([
    ['box', '<box>', '</box>'], ['row', '<row>', '</row>'], ['grid', '<grid>', '</grid>'],
    ['column', '<column>', '</column>'], ['stack', '<stack>', '</stack>'], ['section', '<section>', '</section>'],
    ['card', '<card><card-content>', '</card-content></card>'],
    ['card slots', '<card><card-header>', '</card-header></card>'],
    ['card footer', '<card><card-footer>', '</card-footer></card>'],
    ['table cell', '<table><tbody><tr><td>', '</td></tr></tbody></table>'],
    ['tabs', '<tabs><tab title="Panel">', '</tab></tabs>'],
    ['accordion', '<accordion><item title="Panel" open>', '</item></accordion>'],
    ['details', '<details><summary>Panel</summary>', '</details>'],
    ['steps', '<steps><step title="Step">', '</step></steps>'],
    ['timeline', '<timeline><item title="Today">', '</item></timeline>'],
    ['list', '<list><li>', '</li></list>'],
    ['alert', '<alert>', '</alert>'], ['callout', '<callout>', '</callout>'],
    ['empty', '<empty>', '</empty>'], ['form', '<form><fieldset>', '</fieldset></form>'],
  ])('recursively renders mixed component content inside %s', (_name, start, end) => {
    const root = render(`${start}<box><image src="https://images.example.test/a.png"/><button href="https://example.test">Open</button>${nestedDiagram}<table><tbody><tr><td>Nested cell</td></tr></tbody></table></box>${end}`)
    expect(root.querySelector('img')).not.toBeNull()
    expect(root.querySelector('a')?.textContent).toBe('Open')
    expect(root.querySelector('svg path[stroke]')).not.toBeNull()
    expect(root.textContent).toContain('Nested cell')
  })
})

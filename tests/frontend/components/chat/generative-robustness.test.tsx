// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GenerativeUI } from '@/components/chat/generative-ui'
import { Markdown } from '@/components/chat/markdown'
import { PrivateMarkdown } from '@/components/chat/private-markdown'
import { TooltipProvider } from '@/components/ui/tooltip'
import { evolvingState, recoveredComponents } from '../../fixtures/generative-robustness'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/theme', () => ({ useTheme: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'light' }) }))

function render(source: string, mode: 'ordinary' | 'private' | 'fenced' = 'ordinary', live = false) {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<TooltipProvider>{mode === 'fenced' ? <GenerativeUI code={source} lang="aivory-ui" live={live}/> : mode === 'private' ? <PrivateMarkdown allowGenerativeUI text={source} live={live}/> : <Markdown allowGenerativeUI content={source} live={live}/>}</TooltipProvider>)
  return root
}

describe('unexpected generative output', () => {
  it.each(['ordinary', 'private'] as const)('keeps normal Markdown usable when no component tags are emitted in %s replies', mode => {
    const root = render('## Normal answer\n\nA **readable** answer.\n\n| Plan | Cost |\n| --- | --- |\n| Basic | 12 |', mode)
    expect(root.textContent).toContain('Normal answer')
    expect(root.querySelector('strong')?.textContent).toBe('readable')
    expect(root.querySelector('td')?.textContent).toBe('Basic')
    expect(root.querySelector('[data-generative-ui]')).toBeNull()
  })
  it.each(['ordinary', 'private', 'fenced'] as const)('recovers unknown wrappers and valid siblings without mounting arbitrary HTML in %s replies', mode => {
    const source = mode === 'fenced' ? recoveredComponents.slice(0, recoveredComponents.indexOf('\n\nResult:')) : recoveredComponents
    const root = render(source, mode)
    expect(root.querySelector('h2')?.textContent).toBe('Recovered answer')
    expect(root.querySelector('.gui-markup-badge')?.textContent).toBe('Available')
    expect(root.textContent).toContain('Preserved details')
    expect(root.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(root.querySelector('button.gui-markup-button')?.textContent).toBe('Review')
    expect(root.querySelector('svg rect')).not.toBeNull()
    expect(root.querySelector('script,style,iframe,object,embed,foreignObject,[onclick],[onload],.invented-layout')).toBeNull()
    expect(root.textContent).not.toMatch(/Unsafe action|Hidden action|SVG action|__UNSAFE_GUI__|body\{display/)
    if (mode !== 'fenced') expect(root.textContent).toContain('Result: Pending')
  })
  it.each(['ordinary', 'private'] as const)('keeps literal expressions intact and shares newly introduced state in %s replies', mode => {
    const root = render(evolvingState, mode)
    expect(root.textContent).toContain('Result: Pending')
    expect(root.querySelector('code')?.textContent).toBe('{done}')
    expect(root.querySelector('[data-latex]')?.getAttribute('data-latex')).toBe('x_{done}')
    expect(root.textContent).toContain('{done} literal.')
    expect(root.textContent).toContain('Notes: Draft')
    expect(root.querySelectorAll('[data-generative-ui]')).toHaveLength(1)
  })
  it('preserves explicit code and pre content rather than interpolating expressions', () => {
    const root = render('<checkbox name="done"/><code>{done}</code><pre>{done}</pre><text>{done}</text>', 'fenced')
    expect(root.querySelector('code')?.textContent).toBe('{done}')
    expect(root.querySelector('pre')?.textContent).toBe('{done}')
    expect(root.querySelector('.gui-markup-text')?.textContent).toBe('false')
    const literal = render('<box><pre>  <script>literal</script>\n{done}  </pre><code><button>Source</button></code></box>', 'fenced')
    expect(literal.querySelector('pre')?.textContent).toBe('  <script>literal</script>\n{done}  ')
    expect(literal.querySelector('code')?.textContent).toBe('<button>Source</button>')
    expect(literal.querySelector('script,button')).toBeNull()
  })
  it('renders expressions containing Markdown or tag strings as text without creating elements', () => {
    const root = render('<checkbox name="done"/>\n\nResult: {done ? "**Complete**" : "<script>"}')
    expect(root.textContent).toContain('Result: <script>')
    expect(root.querySelector('script')).toBeNull()
  })
  it.each(['ordinary', 'private', 'fenced'] as const)('keeps stray closing tags and unknown leaf tags from hiding valid siblings in %s replies', mode => {
    const root = render('<box><badge>One</badge></unexpected><unknown-widget/><button prompt="Review">Review</button></box>', mode)
    expect(root.querySelector('.gui-markup-badge')?.textContent).toBe('One')
    expect(root.querySelector('button')?.textContent).toBe('Review')
  })
  it('preserves content when required tab or radio child tags are absent', () => {
    const root = render('<tabs><card title="Missing tabs"><text>Visible details</text><button prompt="Review">Review</button></card></tabs><radio-group label="Preferences"><text>Missing radio options</text></radio-group>', 'fenced')
    expect(root.querySelector('article')?.textContent).toContain('Visible details')
    expect(root.querySelector('button')?.textContent).toBe('Review')
    expect(root.textContent).toContain('Missing radio options')
    expect(root.querySelector('[role="tablist"]')).toBeNull()
  })
  it('retains malformed table contents as readable components without inventing cells', () => {
    for (const source of ['<table><text>Missing rows</text><button prompt="Review">Review</button></table>', '<table><tbody><tr><card title="Missing cells"><text>Visible content</text><button prompt="Review">Review</button></card></tr></tbody></table>']) {
      const root = render(source, 'fenced')
      expect(root.querySelector('button')?.textContent).toBe('Review')
      expect(root.textContent).toContain('Missing')
      expect(root.querySelector('table,tr,td')).toBeNull()
    }
  })
  it('preserves valid empty rows covered by cells spanning several rows', () => {
    const root = render('<table><tbody><tr><td rowspan={2}>Spanning cell</td></tr><tr></tr></tbody></table>', 'fenced')
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(root.querySelector('td')?.rowSpan).toBe(2)
  })
  it.each(['ordinary', 'private', 'fenced'] as const)('recovers missing closing tags after streaming completes in %s replies', mode => {
    const root = render('<card title="Incomplete"><text>Kept content</text><button prompt="Continue">Continue</button>', mode)
    expect(root.querySelector('article')?.textContent).toContain('Kept content')
    expect(root.querySelector('button')?.textContent).toBe('Continue')
  })
  it.each(['ordinary', 'private', 'fenced'] as const)('retains unreadable markup as escaped source when recovery fails in %s replies', mode => {
    const source = '<box gap={broken(><text>Recoverable source</text></box>'
    const root = render(source, mode)
    expect(root.textContent).toContain('Recoverable source')
    expect(root.querySelector('box,text,script,iframe')).toBeNull()
    expect(root.querySelector('pre code')?.textContent).toContain('<box')
  })
  it('does not reinterpret requested HTML source examples as live components', () => {
    const root = render('```html\n<div><button prompt="Do not send">Source</button></div>\n```')
    expect(root.querySelector('[data-generative-ui]')).toBeNull()
    expect(root.querySelector('code')?.textContent).toContain('<button')
  })
  it('drops raw unsafe-only blocks without introducing an empty UI or consuming the following code example', () => {
    const root = render('<script>window.__UNSAFE_GUI__=true</script>\n\n```html\n<script>literal()</script>\n```')
    expect(root.querySelector('[data-generative-ui]')).toBeNull()
    expect(root.querySelector('code')?.textContent).toBe('<script>literal()</script>')
  })
  it('ignores multiline stray and void closing tags without splitting their surrounding component', () => {
    const root = render('<card>\n<image src="https://images.example.test/example.png"></image>\n</unexpected>\n<button prompt="Review">Kept action</button>\n</card>\n\n## Next section')
    expect(root.querySelector('article button')?.textContent).toBe('Kept action')
    expect(root.textContent).not.toContain('</card>')
    expect(root.textContent).toContain('Next section')
  })
  it('never turns an unsupported callback into an active action', () => {
    const root = render('<div><button onclick={() => fetch("https://unsafe.example.test")}>Unavailable</button></div>', 'fenced')
    expect(root.querySelector('button')?.disabled).toBe(true)
  })
})

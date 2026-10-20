// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GenerativeUI } from '@/components/chat/generative-ui'
import { sampleMap, samplePlaces, nestedMap } from '../../fixtures/generative-map'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function render(source: string) {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<GenerativeUI code={source} lang="aivory-ui" />)
  return root
}

describe('composable map content', () => {
  it('renders synthetic places as escaped names and external search links before hydration', () => {
    const root = render(sampleMap)
    expect(root.querySelectorAll('.gui-map-points > li')).toHaveLength(8)
    expect(root.querySelectorAll('.gui-map-external')).toHaveLength(8)
    for (const place of samplePlaces) expect(root.textContent).toContain(place.name)
    expect(root.querySelector('iframe,script')).toBeNull()
  })
  it('recursively renders maps inside tables and tabs, and components inside place details', () => {
    const root = render(nestedMap)
    expect(root.querySelector('[role="tabpanel"] td .gui-map')).not.toBeNull()
    expect(root.querySelector('.gui-map-detail article img')).not.toBeNull()
    expect(root.querySelector('.gui-map-detail article svg path')).not.toBeNull()
    expect(root.querySelector('.gui-map-detail article button')?.textContent).toBe('Ask about this place')
  })
  it('keeps map labels inert and bounds the canvas dimensions', () => {
    const root = render('<map title="&lt;img src=x onerror=alert(1)&gt;" height={90000}><map-point name="&lt;script&gt;" address="javascript:alert(1)"/></map>')
    expect(root.querySelector('img,script')).toBeNull()
    expect(root.querySelector<HTMLElement>('.gui-map-placeholder')?.style.height).toBe('640px')
    const link = root.querySelector('a')!
    expect(link.protocol).toBe('https:')
    expect(new URL(link.href).searchParams.get('query')).toContain('javascript:alert(1)')
  })
})

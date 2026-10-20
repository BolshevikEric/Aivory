import { createElement, useId, type ReactNode } from 'react'
import { markupAttribute, type MarkupElement, type MarkupNode, type MarkupValue } from '@/lib/generative-markup'
import { markupSVGAttribute, markupSVGTags } from '@/lib/generative-svg'

export function GenerativeSVG({ node, state, text }: { node: MarkupElement; state: Record<string, MarkupValue>; text: (value: string) => string }) {
  const prefix = `gui-svg-${useId().replace(/[^\w-]/g, '')}-`
  function render(element: MarkupElement, key: string, root = false): ReactNode {
    const tag = markupSVGTags.get(element.tag)
    if (!tag) return null
    const props: Record<string, unknown> = { key }
    for (const name of Object.keys(element.attrs)) {
      const attr = markupSVGAttribute(name, markupAttribute(element, name, state), prefix, element.tag)
      if (attr) props[attr[0]] = attr[1]
    }
    if (root) {
      props.xmlns = 'http://www.w3.org/2000/svg'
      props.className = 'gui-markup-svg'
      props.width ??= '100%'
      props.fill ??= 'currentColor'
      if (!props.viewBox) props.height ??= 180
      props.role ??= props['aria-hidden'] === 'true' ? undefined : 'img'
    }
    if (element.tag === 'image') props.referrerPolicy = 'no-referrer'
    const isText = ['text', 'tspan', 'textpath', 'title', 'desc'].includes(element.tag)
    const children = element.children.map((child: MarkupNode, i) => typeof child === 'string'
      ? isText ? text(child) : null
      : render(child, `${key}-${i}`))
    return createElement(tag, props, children)
  }
  return render(node, 'svg', true)
}

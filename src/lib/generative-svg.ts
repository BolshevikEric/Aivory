/** Native SVG names are separate from the surrounding preset component names. */
export const markupSVGTags = new Map((
  'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc ' +
  'linearGradient radialGradient stop clipPath mask marker pattern image ' +
  'filter feGaussianBlur feOffset feBlend feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA ' +
  'feComposite feFlood feMerge feMergeNode feMorphology feDropShadow'
).split(/\s+/).map(name => [name.toLowerCase(), name]))

const svgAttributes = new Map((
  'id viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry width height d points pathLength transform ' +
  'fill fillOpacity fillRule stroke strokeWidth strokeOpacity strokeLinecap strokeLinejoin strokeMiterlimit ' +
  'strokeDasharray strokeDashoffset opacity color vectorEffect paintOrder ' +
  'fontSize fontFamily fontWeight fontStyle textAnchor dominantBaseline alignmentBaseline baselineShift ' +
  'dx dy rotate textLength lengthAdjust letterSpacing wordSpacing startOffset method spacing ' +
  'gradientUnits gradientTransform spreadMethod offset stopColor stopOpacity fx fy fr ' +
  'clipPath clipRule clipPathUnits mask maskUnits maskContentUnits ' +
  'markerStart markerMid markerEnd markerWidth markerHeight markerUnits refX refY orient ' +
  'patternUnits patternContentUnits patternTransform ' +
  'filter filterUnits primitiveUnits in in2 result stdDeviation type values mode operator ' +
  'k1 k2 k3 k4 floodColor floodOpacity radius tableValues slope intercept amplitude exponent ' +
  'href role aria-label aria-hidden aria-labelledby aria-describedby'
).split(/\s+/).flatMap(name => [[name.toLowerCase(), name], [name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), name]]))
svgAttributes.set('xlink:href', 'href')

const localID = /^[A-Za-z_][\w:.-]{0,79}$/

/** Permit local references only, so one answer cannot target another answer's SVG or fetch a resource. */
export function markupSVGAttribute(name: string, value: unknown, prefix: string, tag: string): [string, string | number] | undefined {
  const canonical = svgAttributes.get(name)
  if (canonical?.startsWith('aria-') && typeof value === 'boolean') return [canonical, String(value)]
  if (!canonical || !['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return undefined
  const text = String(value).trim()
  if (canonical === 'id') return localID.test(text) ? [canonical, prefix + text] : undefined
  if (canonical === 'aria-labelledby' || canonical === 'aria-describedby') {
    const ids = text.split(/\s+/)
    return ids.length && ids.every(id => localID.test(id)) ? [canonical, ids.map(id => prefix + id).join(' ')] : undefined
  }
  if (canonical === 'href') {
    if (text.startsWith('#') && localID.test(text.slice(1))) return [canonical, '#' + prefix + text.slice(1)]
    if (tag === 'image') {
      try {
        const url = new URL(text)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return [canonical, url.href]
      } catch { /* An SVG image must have an absolute HTTP(S) URL. */ }
    }
    return undefined
  }
  if (canonical.startsWith('aria-')) return [canonical, text]
  const reference = text.match(/^url\(\s*["']?#([A-Za-z_][\w:.-]{0,79})["']?\s*\)$/i)
  if (reference) return [canonical, `url(#${prefix}${reference[1]})`]
  if (/url\s*\(|(?:https?|data|javascript|vbscript|file):|[\\<>]/i.test(text)) return undefined
  return [canonical, value as string | number]
}

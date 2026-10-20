import { describe, expect, it } from 'vitest'
import { markupElements, parseUIMarkup, prepareGenerativeMarkup } from '@/lib/generative-markup'
import { mapCoordinates, mapSearchURL, markupMapPoints, projectMapLocation, MAX_MAP_POINTS } from '@/lib/generative-map'

const points = (source: string) => markupMapPoints(markupElements(parseUIMarkup(source)!.children)[0])

describe('preset maps', () => {
  it('accepts a structured MapWidget without executing expressions', () => {
    const source = '<MapWidget points={[{"name":"Sample venue","address":"12 Example Avenue, Sampleville"},{"name":"Sample station","address":"34 Example Road, Sampleville"}]}/>'
    expect(points(source).map(point => point.name)).toEqual(['Sample venue', 'Sample station'])
    expect(prepareGenerativeMarkup(source)).toContain('```aivory-ui')
    expect(points('<MapWidget points={fetch("/api/secrets")}/>')).toEqual([])
    expect(points('<MapWidget points={[{"name":"Invalid","lat":91,"lng":1}]}/>')).toEqual([])
  })
  it('accepts nested rich point content, coordinates, aliases and zero coordinates', () => {
    const result = points('<map><map-point name="Origin" lat={0} lng={0}><card><button href="https://example.test">Open</button><svg viewBox="0 0 20 20"><circle r="5"/></svg></card></map-point><map-point name="Station" address="Station Sampleville"/></map>')
    expect(result[0]).toMatchObject({ name: 'Origin', lat: 0, lng: 0 })
    expect(markupElements(result[0].children)[0].tag).toBe('card')
    expect(result[1].lat).toBeUndefined()
    expect(points('<map-widget points={[{"name":"Aliases","latitude":48,"longitude":2}]}/>')[0]).toMatchObject({ lat: 48, lng: 2 })
  })
  it('rejects empty and out-of-range coordinates without treating missing coordinates as zero', () => {
    for (const [lat, lng] of [[null, null], [true, false], ['', ''], [undefined, undefined], [NaN, 1], [Infinity, 1], [91, 0], [1, -181]]) expect(mapCoordinates(lat, lng)).toBeUndefined()
    expect(mapCoordinates('-12.5', '42.2')).toEqual({ lat: -12.5, lng: 42.2 })
    expect(points('<map><map-point name="No location"/><map-point address="Valid" lat={false} lng={null}/></map>')).toMatchObject([{ name: 'Valid', address: 'Valid' }])
  })
  it('limits untrusted point lists and builds safe map links', () => {
    const result = points(`<map>${'<map-point address="Sampleville"/>'.repeat(70)}</map>`)
    expect(result).toHaveLength(MAX_MAP_POINTS)
    const coordinate = points('<map><map-point name="Ambiguous" lat={48} lng={2}/></map>')[0]
    expect(new URL(mapSearchURL(coordinate)).searchParams.get('query')).toBe('48,2')
    const search = points('<map><map-point name="&lt;script&gt;" address="a&amp;b=1"/></map>')[0]
    expect(new URL(mapSearchURL(search)).searchParams.get('query')).toBe('<script> a&b=1')
  })
  it('converts coordinate systems at the provider boundary without double shifting AMap matches', () => {
    const original = { lat: 30, lng: 100 }
    const amap = projectMapLocation(original, 'amap')
    expect(amap.coordinate_system).toBe('gcj02')
    expect(Math.abs(amap.lng - original.lng)).toBeGreaterThan(.0001)
    expect(projectMapLocation(amap, 'amap')).toEqual(amap)
    const restored = projectMapLocation(amap, 'osm')
    expect(restored.lat).toBeCloseTo(original.lat, 6)
    expect(restored.lng).toBeCloseTo(original.lng, 6)
    expect(projectMapLocation({ lat: 48, lng: 2 }, 'amap')).toMatchObject({ lat: 48, lng: 2 })
  })
  it('opens AMap searches and resolved markers using native coordinates', () => {
    const point = points('<map><map-point name="Example" address="Example Plaza"/></map>')[0]
    expect(new URL(mapSearchURL(point, 'amap')).hostname).toBe('uri.amap.com')
    expect(new URL(mapSearchURL(point, 'amap')).searchParams.get('keyword')).toBe('Example Plaza')
    const native = { lat: 30, lng: 100, coordinate_system: 'gcj02' as const }
    expect(new URL(mapSearchURL(point, 'amap', native)).searchParams.get('position')).toBe('100,30')
    const parsed = points('<map><map-point name="Native" lat={30} lng={100} coordinate-system="gcj02"/></map>')[0]
    expect(parsed.coordinate_system).toBe('gcj02')
    expect(new URL(mapSearchURL(parsed, 'amap')).searchParams.get('position')).toBe('100,30')
  })
})

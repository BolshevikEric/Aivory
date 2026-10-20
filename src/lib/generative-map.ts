import { markupAttribute, markupElements, type MarkupElement, type MarkupNode, type MarkupValue } from './generative-markup'
import gcoord from 'gcoord'

export const MAX_MAP_POINTS = 50
export interface MapPoint {
  id: number
  name: string
  address: string
  lat?: number
  lng?: number
  coordinate_system?: 'wgs84' | 'gcj02'
  children: MarkupNode[]
}
export interface MapLocation { lat: number; lng: number; label?: string; coordinate_system?: 'wgs84' | 'gcj02' }
export interface MapProviderConfig { provider: 'osm' | 'amap'; configured: boolean; js_api_key?: string }

export function projectMapLocation(location: MapLocation, provider: MapProviderConfig['provider']): MapLocation {
  const source = location.coordinate_system === 'gcj02' ? gcoord.GCJ02 : gcoord.WGS84
  const target = provider === 'amap' ? gcoord.GCJ02 : gcoord.WGS84
  const [lng, lat] = gcoord.transform([location.lng, location.lat], source, target)
  return { ...location, lat, lng, coordinate_system: provider === 'amap' ? 'gcj02' : 'wgs84' }
}

export function mapCoordinates(lat: unknown, lng: unknown): MapLocation | undefined {
  const number = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  const latitude = number(lat), longitude = number(lng)
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { lat: latitude, lng: longitude } : undefined
}

export function markupMapPoints(node: MarkupElement, state: Record<string, MarkupValue> = {}): MapPoint[] {
  const points: MapPoint[] = []
  const add = (value: unknown, children: MarkupNode[] = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || points.length >= MAX_MAP_POINTS) return
    const data = value as Record<string, unknown>
    const text = (key: string, max: number) => typeof data[key] === 'string' ? data[key].trim().slice(0, max) : ''
    const name = text('name', 200), address = text('address', 500)
    const coordinates = mapCoordinates(data.lat ?? data.latitude, data.lng ?? data.lon ?? data.longitude)
    if (!address && !coordinates) return
    const coordinate_system = data['coordinate-system'] === 'gcj02' ? 'gcj02' : 'wgs84'
    points.push({ id: points.length, name: name || address || `${coordinates!.lat}, ${coordinates!.lng}`, address, ...coordinates, coordinate_system, children })
  }
  // Structured point attributes are data only, independent of the expression interpreter.
  const attribute = node.attrs.points
  if (attribute) {
    try {
      const raw = 'expression' in attribute ? attribute.expression : attribute.literal
      const values: unknown = typeof raw === 'string' && raw.length <= 32000 ? JSON.parse(raw) : undefined
      if (Array.isArray(values)) values.slice(0, MAX_MAP_POINTS).forEach(value => add(value))
    } catch { /* Keep valid nested points when a structured attribute is incomplete. */ }
  }
  for (const point of markupElements(node.children, 'map-point')) {
    const data = Object.fromEntries(['name', 'address', 'lat', 'latitude', 'lng', 'lon', 'longitude', 'coordinate-system'].map(key => [key, markupAttribute(point, key, state)]))
    add(data, point.children)
  }
  return points
}

export function mapSearchURL(point: MapPoint, provider: MapProviderConfig['provider'] = 'osm', location?: MapLocation): string {
  if (provider === 'amap') {
    const coordinates = location ?? mapCoordinates(point.lat, point.lng)
    if (coordinates) {
      const projected = projectMapLocation({ ...coordinates, coordinate_system: location?.coordinate_system ?? point.coordinate_system }, 'amap')
      return `https://uri.amap.com/marker?position=${projected.lng},${projected.lat}&name=${encodeURIComponent(point.name)}&coordinate=gaode&callnative=0`
    }
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(point.address || point.name)}&city=${encodeURIComponent('全国')}&view=map&src=Aivory&coordinate=gaode&callnative=0`
  }
  const coordinates = mapCoordinates(point.lat, point.lng)
  const projected = coordinates && projectMapLocation({ ...coordinates, coordinate_system: point.coordinate_system }, 'osm')
  const query = projected ? `${projected.lat},${projected.lng}` : [point.name, point.address].filter(Boolean).join(' ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

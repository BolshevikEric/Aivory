import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type * as Leaflet from 'leaflet'
import { ExternalLink, LocateFixed, Loader2, MapPin, Minus, Plus, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '@/api/client'
import { apiFetch } from '@/lib/api-fetch'
import { mapCoordinates, mapSearchURL, markupMapPoints, projectMapLocation, type MapLocation, type MapPoint, type MapProviderConfig } from '@/lib/generative-map'
import { AMapCanvas } from './generative-amap'
import { markupAttribute, type MarkupElement, type MarkupNode, type MarkupValue } from '@/lib/generative-markup'
import 'leaflet/dist/leaflet.css'

interface LocatedPoint extends MapPoint { lat: number; lng: number }
interface MapRuntime {
  library: typeof Leaflet
  map: Leaflet.Map
  markers: Leaflet.LayerGroup
}
type LookupResult = { location?: MapLocation; status: 'found' | 'missing' | 'error' }
const tileURL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined) || 'https://tile.openstreetmap.de/{z}/{x}/{y}.png'
const tileAttribution = import.meta.env.VITE_MAP_TILE_ATTRIBUTION as string | undefined

function MapCanvas({ points, selected, select, height, title }: {
  points: LocatedPoint[]; selected?: number; select: (id: number) => void; height: number; title: string
}) {
  const { t } = useTranslation('chat')
  const container = useRef<HTMLDivElement>(null)
  const [runtime, setRuntime] = useState<MapRuntime>()
  const [failed, setFailed] = useState(false), [tilesFailed, setTilesFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false, map: Leaflet.Map | undefined, resize: ResizeObserver | undefined
    const timeout = setTimeout(() => { if (!disposed) setTilesFailed(true) }, 15000)
    void import('leaflet').then(library => {
      if (disposed || !container.current) return
      map = library.map(container.current, { zoomControl: false, attributionControl: false, scrollWheelZoom: false })
      const tiles = library.tileLayer(tileURL, {
        maxZoom: 19, crossOrigin: true, referrerPolicy: 'strict-origin-when-cross-origin',
      }).addTo(map)
      tiles.on('tileerror', () => { if (!disposed) setTilesFailed(true) })
      tiles.on('tileload', () => { clearTimeout(timeout); if (!disposed) setTilesFailed(false) })
      resize = new ResizeObserver(() => map?.invalidateSize({ animate: false }))
      resize.observe(container.current)
      setRuntime({ library, map, markers: library.layerGroup().addTo(map) })
    }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; clearTimeout(timeout); resize?.disconnect(); map?.remove() }
  }, [attempt])
  const fit = useCallback(() => {
    if (!runtime || !points.length) return
    runtime.map.invalidateSize({ animate: false })
    runtime.map.fitBounds(runtime.library.latLngBounds(points.map(point => [point.lat, point.lng])), { padding: [36, 36], maxZoom: points.length === 1 ? 15 : 14, animate: false })
  }, [runtime, points])
  useEffect(() => {
    if (!runtime) return
    runtime.markers.clearLayers()
    fit()
    for (const point of points) {
      const marker = runtime.library.marker([point.lat, point.lng], {
        icon: runtime.library.divIcon({ className: 'gui-map-marker', html: String(point.id + 1), iconSize: [28, 28], iconAnchor: [14, 14] }),
        title: point.name, keyboard: true,
      }).on('click', () => select(point.id)).addTo(runtime.markers)
      const element = marker.getElement()
      if (element) { element.dataset.pointId = String(point.id); element.setAttribute('aria-label', `${point.id + 1}. ${point.name}`) }
    }
  }, [runtime, points, select, fit])
  useEffect(() => {
    if (!runtime) return
    runtime.markers.eachLayer(layer => {
      const marker = layer as Leaflet.Marker
      marker.getElement()?.classList.toggle('is-selected', marker.getElement()?.dataset.pointId === String(selected))
    })
    const point = points.find(point => point.id === selected)
    if (point) runtime.map.setView([point.lat, point.lng], Math.max(runtime.map.getZoom(), 14), { animate: false })
  }, [runtime, selected, points])
  const control = (label: string, icon: ReactNode, action: () => void) => <button type="button" title={label} aria-label={label} onClick={action} disabled={!runtime}>{icon}</button>
  return <div className="gui-map-canvas" data-generative-map-canvas style={{ height }}>
    <div className="gui-map-surface" ref={container} role="region" aria-label={title} />
    {!runtime && <div className="gui-map-notice" role="status">{failed ? <><MapPin size={18} aria-hidden />{t('generative.mapFailed')}<button type="button" title={t('generative.mapRetry')} aria-label={t('generative.mapRetry')} onClick={() => { setFailed(false); setAttempt(value => value + 1) }}><RotateCw size={16} /></button></> : <><Loader2 size={18} className="animate-spin" aria-hidden />{t('generative.mapLoading')}</>}</div>}
    <div className="gui-map-controls">
      {control(t('generative.mapZoomIn'), <Plus size={17} />, () => runtime?.map.zoomIn(1, { animate: false }))}
      {control(t('generative.mapZoomOut'), <Minus size={17} />, () => runtime?.map.zoomOut(1, { animate: false }))}
      {control(t('generative.mapFit'), <LocateFixed size={17} />, fit)}
    </div>
    {tilesFailed && <p className="gui-map-tile-error" role="status">{t('generative.mapTilesFailed')}</p>}
    <div className="gui-map-attribution">{tileAttribution || <>{'© '}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>{' · '}<a href="https://www.openstreetmap.de/" target="_blank" rel="noopener noreferrer">FOSSGIS</a></>}</div>
  </div>
}

export function GenerativeMap({ node, state, render, live = false }: {
  node: MarkupElement; state: Record<string, MarkupValue>; render: (nodes: MarkupNode[], path: string) => ReactNode; live?: boolean
}) {
  const points = markupMapPoints(node, state)
  const [config, setConfig] = useState<MapProviderConfig>()
  const [configFailed, setConfigFailed] = useState(false)
  const [configAttempt, setConfigAttempt] = useState(0)
  const reloadConfig = useCallback(() => setConfigAttempt(value => value + 1), [])
  useEffect(() => {
    if (live) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await apiFetch(apiUrl('/public/maps/config'), { signal: controller.signal, credentials: 'omit' })
        if (!response.ok) throw new Error('map config unavailable')
        const body: MapProviderConfig = await response.json()
        if (!['osm', 'amap'].includes(body.provider) || typeof body.configured !== 'boolean') throw new Error('invalid map provider')
        if (!controller.signal.aborted) { setConfig(current => JSON.stringify(current) === JSON.stringify(body) ? current : body); setConfigFailed(!body.configured || (body.provider === 'amap' && !body.js_api_key)) }
      } catch { if (!controller.signal.aborted) { setConfig(undefined); setConfigFailed(true) } }
    }
    void load()
    window.addEventListener('focus', load)
    return () => { controller.abort(); window.removeEventListener('focus', load) }
  }, [live, configAttempt])
  // Local control updates must not restart address lookups or reset the viewport.
  const signature = JSON.stringify(points.map(({ id, name, address, lat, lng, coordinate_system }) => ({ id, name, address, lat, lng, coordinate_system })))
  const stablePoints = useMemo(() => JSON.parse(signature) as MapPoint[], [signature])
  const height = Number(String(markupAttribute(node, 'height', state) ?? 340).replace(/px$/, ''))
  const title = markupAttribute(node, 'title', state) ?? markupAttribute(node, 'label', state)
  return <MapContent key={signature + JSON.stringify(config)} points={points} stablePoints={stablePoints} height={Number.isFinite(height) ? Math.min(640, Math.max(220, height)) : 340} title={typeof title === 'string' ? title : undefined} render={render} live={live} config={config} configFailed={configFailed} reloadConfig={reloadConfig} />
}

function MapContent({ points, stablePoints, height, title, render, live, config, configFailed, reloadConfig }: {
  points: MapPoint[]; stablePoints: MapPoint[]; height: number; title?: string; render: (nodes: MarkupNode[], path: string) => ReactNode; live: boolean
  config?: MapProviderConfig; configFailed: boolean; reloadConfig: () => void
}) {
  const { t } = useTranslation('chat')
  const [lookups, setLookups] = useState<Record<number, LookupResult>>({})
  const [selected, setSelected] = useState<number>()
  const [requestIds, setRequestIds] = useState(() => stablePoints.filter(point => point.lat === undefined).map(point => point.id))
  const select = useCallback((id: number) => setSelected(id), [])
  useEffect(() => {
    if (live || !config?.configured || configFailed) return
    const controller = new AbortController()
    // Two workers keep long lists responsive while the backend serializes misses.
    const pending = stablePoints.filter(point => requestIds.includes(point.id))
    const worker = async () => {
      while (pending.length && !controller.signal.aborted) {
        const point = pending.shift()!
        let result: LookupResult
        try {
          const response = await apiFetch(apiUrl(`/public/maps/geocode?provider=${config.provider}&q=${encodeURIComponent(point.address)}`), { signal: controller.signal, credentials: 'omit' })
          if (response.status === 409) reloadConfig()
          if (!response.ok) throw new Error('geocoding unavailable')
          const body: { location?: MapLocation | null } = await response.json()
          const location = mapCoordinates(body.location?.lat, body.location?.lng)
          result = location ? { status: 'found', location: { ...location, coordinate_system: body.location?.coordinate_system === 'gcj02' ? 'gcj02' : 'wgs84', label: typeof body.location?.label === 'string' ? body.location.label : undefined } } : { status: 'missing' }
        } catch { result = { status: 'error' } }
        if (!controller.signal.aborted) setLookups(current => ({ ...current, [point.id]: result }))
      }
    }
    void worker(); void worker()
    return () => controller.abort()
  }, [stablePoints, live, requestIds, config, configFailed, reloadConfig])
  const located = useMemo(() => stablePoints.flatMap(point => {
    const direct = mapCoordinates(point.lat, point.lng)
    const location = direct ? { ...direct, coordinate_system: point.coordinate_system } : lookups[point.id]?.location
    return location ? [{ ...point, ...projectMapLocation(location, config?.provider ?? 'osm') }] : []
  }), [stablePoints, lookups, config?.provider])
  const pending = points.filter(point => point.lat === undefined && !lookups[point.id]).length
  const active = points.find(point => point.id === selected) ?? points[0]
  const errors = Object.values(lookups).some(result => result.status === 'error')
  return <section className="gui-map" data-generative-map aria-label={title || t('generative.map')}>
    {title && <h3 className="gui-map-title">{title}</h3>}
    {!live && config?.configured && !configFailed && located.length > 0 ? config.provider === 'amap'
      ? <AMapCanvas points={located} selected={selected} select={select} height={height} title={title || t('generative.map')} apiKey={config.js_api_key!} />
      : <MapCanvas points={located} selected={selected} select={select} height={height} title={title || t('generative.map')} /> : <div className="gui-map-placeholder" data-generative-map-canvas style={{ height }} role="status">
      {live || (!configFailed && (!config || pending)) ? <Loader2 size={22} className="animate-spin" aria-hidden /> : <MapPin size={22} aria-hidden />}
      <span>{live ? t('generative.generating') : configFailed ? t('generative.mapServiceUnavailable') : !config ? t('generative.mapLoading') : pending ? t('generative.mapLocating') : points.length ? t('generative.mapNoLocations') : t('generative.mapEmpty')}</span>
      {configFailed && <button type="button" title={t('generative.mapRetry')} aria-label={t('generative.mapRetry')} onClick={reloadConfig}><RotateCw size={16} /></button>}
    </div>}
    {points.length > 0 && <>
      <div className="gui-map-status" role="status">
        <span>{pending && !live && !configFailed ? t('generative.mapLocatingCount', { found: located.length, total: points.length }) : t('generative.mapCount', { found: located.length, total: points.length })}</span>
        {errors && !pending && <button type="button" title={t('generative.mapRetry')} aria-label={t('generative.mapRetry')} onClick={() => { setRequestIds(Object.entries(lookups).filter(([, value]) => value.status === 'error').map(([id]) => Number(id))); setLookups(current => Object.fromEntries(Object.entries(current).filter(([, value]) => value.status !== 'error'))) }}><RotateCw size={15} /></button>}
      </div>
      <ol className="gui-map-points" aria-label={t('generative.mapPlaces')}>
        {points.map(point => <li key={point.id}><button type="button" className="gui-map-point" aria-pressed={active.id === point.id} onClick={() => select(point.id)}>
          <span className="gui-map-number" aria-hidden>{point.id + 1}</span>
          <span className="gui-map-point-text"><strong>{point.name}</strong>{point.address && point.address !== point.name && <small>{point.address}</small>}{point.lat === undefined && lookups[point.id]?.status === 'missing' && <small>{t('generative.mapUnresolved')}</small>}{lookups[point.id]?.status === 'error' && <small>{t('generative.mapLookupFailed')}</small>}</span>
        </button><a className="gui-map-external" href={mapSearchURL(point, config?.provider, lookups[point.id]?.location)} target="_blank" rel="noopener noreferrer" title={t('generative.mapOpen', { name: point.name })} aria-label={t('generative.mapOpen', { name: point.name })}><ExternalLink size={15} aria-hidden /></a></li>)}
      </ol>
      {active.children.length > 0 && <div className="gui-map-detail">{render(active.children, `point-${active.id}`)}</div>}
      {lookups[active.id]?.location?.label && <p className="gui-map-match">{t('generative.mapMatched', { address: lookups[active.id].location!.label })}</p>}
      {config && points.some(point => point.lat === undefined) && <p className="gui-map-source">{config.provider === 'amap' ? <a href="https://www.amap.com/" target="_blank" rel="noopener noreferrer">{t('generative.mapAMap')}</a> : <><a href="https://photon.komoot.io/" target="_blank" rel="noopener noreferrer">Photon</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a></>}</p>}
    </>}
  </section>
}

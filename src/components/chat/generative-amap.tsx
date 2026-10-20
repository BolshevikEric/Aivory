import { useCallback, useEffect, useRef, useState } from 'react'
import type {} from '@amap/amap-jsapi-types'
import { LocateFixed, Loader2, MapPin, Minus, Plus, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '@/api/client'
import type { MapLocation, MapPoint } from '@/lib/generative-map'

type LocatedPoint = MapPoint & MapLocation
interface Runtime { library: typeof AMap; map: AMap.Map }

let loadedKey = ''
let loading: Promise<typeof AMap> | undefined
class AMapKeyChangedError extends Error {}

async function loadAMap(key: string): Promise<typeof AMap> {
  if (loading && loadedKey === key) return loading
  // The vendor SDK uses one browser-global key. A key change needs a fresh page.
  if (loadedKey && loadedKey !== key) throw new AMapKeyChangedError('AMap key changed')
  loadedKey = key
  const proxy = new URL(apiUrl('/public/maps/_AMapService'), window.location.href).href
  Object.assign(window, { _AMapSecurityConfig: { serviceHost: proxy } })
  loading = import('@amap/amap-jsapi-loader').then(({ default: loader }) => {
    return new Promise<typeof AMap>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AMap load timed out')), 20000)
      loader.load({ key, version: '2.0' }).then(library => { clearTimeout(timer); resolve(library as typeof AMap) }, error => { clearTimeout(timer); reject(error) })
    })
      .catch(error => {
        const resettable = loader as typeof loader & { reset: () => void }
        resettable.reset()
        document.querySelectorAll('script[src^="https://webapi.amap.com/maps?"]').forEach(script => script.remove())
        loading = undefined
        throw error
      })
  }).catch(error => { loading = undefined; throw error })
  return loading
}

export function AMapCanvas({ points, selected, select, height, title, apiKey }: {
  points: LocatedPoint[]; selected?: number; select: (id: number) => void; height: number; title: string; apiKey: string
}) {
  const { t } = useTranslation('chat')
  const container = useRef<HTMLDivElement>(null)
  const markers = useRef<{ marker: AMap.Marker; element: HTMLButtonElement; id: number }[]>([])
  const [runtime, setRuntime] = useState<Runtime>()
  const [failed, setFailed] = useState(false), [tilesFailed, setTilesFailed] = useState(false)
  const [keyChanged, setKeyChanged] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false, map: AMap.Map | undefined
    const timeout = setTimeout(() => { if (!disposed) setTilesFailed(true) }, 20000)
    void loadAMap(apiKey).then(library => {
      if (disposed || !container.current) return
      map = new library.Map(container.current, { viewMode: '2D', center: [0, 0], zoom: 12, scrollWheel: false, animateEnable: false })
      map.on('complete', () => { clearTimeout(timeout); if (!disposed) setTilesFailed(false) })
      setRuntime({ library, map })
    }).catch(error => { if (!disposed) { clearTimeout(timeout); setFailed(true); setKeyChanged(error instanceof AMapKeyChangedError) } })
    return () => { disposed = true; clearTimeout(timeout); map?.destroy() }
  }, [apiKey, attempt])
  const fit = useCallback(() => {
    runtime?.map.setFitView(markers.current.map(item => item.marker), true, [36, 36, 36, 36], points.length === 1 ? 15 : 14)
  }, [runtime, points.length])
  useEffect(() => {
    if (!runtime) return
    const current = points.map(point => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'gui-map-marker gui-amap-marker'
      element.textContent = String(point.id + 1)
      element.dataset.pointId = String(point.id)
      element.setAttribute('aria-label', `${point.id + 1}. ${point.name}`)
      element.title = point.name
      element.onclick = () => select(point.id)
      const marker = new runtime.library.Marker({ position: [point.lng, point.lat], content: element, offset: new runtime.library.Pixel(-14, -14), title: point.name })
      marker.setMap(runtime.map)
      return { marker, element, id: point.id }
    })
    markers.current = current
    fit()
    return () => { for (const { marker, element } of current) { element.onclick = null; marker.setMap(null) }; markers.current = [] }
  }, [runtime, points, select, fit])
  useEffect(() => {
    for (const { element, id } of markers.current) element.classList.toggle('is-selected', id === selected)
    const point = points.find(point => point.id === selected)
    if (point && runtime) runtime.map.setZoomAndCenter(Math.max(runtime.map.getZoom(), 14), [point.lng, point.lat], true)
  }, [runtime, selected, points])
  const retry = () => { setRuntime(undefined); setFailed(false); setTilesFailed(false); setAttempt(value => value + 1) }
  const retryLabel = keyChanged ? t('common:startup.reload') : t('generative.mapRetry')
  return <div className="gui-map-canvas" data-generative-map-canvas data-map-provider="amap" style={{ height }}>
    <div className="gui-map-surface" ref={container} role="region" aria-label={title} />
    {!runtime && <div className="gui-map-notice" role="status">{failed ? <><MapPin size={18} aria-hidden />{t(keyChanged ? 'generative.mapKeyChanged' : 'generative.mapFailed')}<button type="button" title={retryLabel} aria-label={retryLabel} onClick={keyChanged ? () => window.location.reload() : retry}><RotateCw size={16} /></button></> : <><Loader2 size={18} className="animate-spin" aria-hidden />{t('generative.mapLoading')}</>}</div>}
    <div className="gui-map-controls">
      <button type="button" title={t('generative.mapZoomIn')} aria-label={t('generative.mapZoomIn')} disabled={!runtime} onClick={() => runtime?.map.zoomIn()}><Plus size={17} /></button>
      <button type="button" title={t('generative.mapZoomOut')} aria-label={t('generative.mapZoomOut')} disabled={!runtime} onClick={() => runtime?.map.zoomOut()}><Minus size={17} /></button>
      <button type="button" title={t('generative.mapFit')} aria-label={t('generative.mapFit')} disabled={!runtime} onClick={fit}><LocateFixed size={17} /></button>
    </div>
    {tilesFailed && runtime && <p className="gui-map-tile-error" role="status">{t('generative.mapTilesFailed')}</p>}
  </div>
}

import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, Plus, RotateCcw, Trash2, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { compileFunctionExpression, evaluateFunction } from '@/lib/function-expression'
import { functionBounds, functionPath, sampleFunction } from '@/lib/function-plot'
import type { UIBlock } from '@/lib/generative-ui'
import { NumericControl } from './generative-interactions'
import { formatValue, usePlotWidth, visualizationPalette as palette, visualButton, visualFocus, visualInput } from './generative-shared'

type FunctionBlock = Extract<UIBlock, { type: 'function' }>
interface EditableFunction { id: number; expression: string; label?: string; visible: boolean }
const MAX_FUNCTIONS = 8

export function FunctionPlot({ block }: { block: FunctionBlock }) {
  const { t, i18n } = useTranslation('chat')
  const id = useId()
  const nextID = useRef(block.functions.length)
  const [functions, setFunctions] = useState<EditableFunction[]>(() => block.functions.map((fn, index) => ({ ...fn, id: index, visible: true })))
  const [domain, setDomain] = useState<{ min: string | number; max: string | number }>({ min: block.min, max: block.max })
  const [parameters, setParameters] = useState<Record<string, string | number>>(() => Object.fromEntries(block.controls.map(control => [control.id, control.value])))
  const [cursor, setCursor] = useState((block.min + block.max) / 2)
  const { ref, width } = usePlotWidth()
  const plot = { left: width < 320 ? 44 : 54, right: width - 14, top: 18, bottom: 234 }
  const min = Number(domain.min), max = Number(domain.max)
  const validDomain = domain.min !== '' && domain.max !== '' && Number.isFinite(min) && Number.isFinite(max) && Math.abs(min) <= 1e6 && Math.abs(max) <= 1e6 && max - min >= 1e-9
  const validParameters = block.controls.every(control => parameters[control.id] !== '' && Number.isFinite(Number(parameters[control.id])) && Number(parameters[control.id]) >= control.min && Number(parameters[control.id]) <= control.max)
  const deferredFunctions = useDeferredValue(functions)
  const numericParameters = useMemo(() => Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, Number(value)])), [parameters])
  const compiled = useMemo(() => deferredFunctions.map(fn => ({ ...fn, compiled: compileFunctionExpression(fn.expression, block.variable, block.controls.map(control => control.id)) })), [block.controls, block.variable, deferredFunctions])
  const sampled = useMemo(() => compiled.map(fn => ({ ...fn, points: fn.visible && fn.compiled && validDomain && validParameters ? sampleFunction(fn.compiled, block.variable, min, max, block.samples, numericParameters) : [] })), [block.samples, block.variable, compiled, min, max, numericParameters, validDomain, validParameters])
  const bounds = useMemo(() => functionBounds(sampled.map(fn => fn.points)), [sampled])
  const xScale = (x: number) => plot.left + (x - min) / (max - min) * (plot.right - plot.left)
  const yScale = (y: number) => plot.bottom - (y - bounds.min) / (bounds.max - bounds.min) * (plot.bottom - plot.top)
  const cursorX = validDomain ? Math.max(min, Math.min(max, cursor)) : 0
  const hasPoints = sampled.some(fn => fn.points.some(point => point.y !== null))
  const format = (value: number) => formatValue(value, i18n.language)
  const label = (fn: EditableFunction, index: number) => fn.label || `f${index + 1}`

  const reset = () => {
    setFunctions(block.functions.map((fn, index) => ({ ...fn, id: index, visible: true })))
    nextID.current = block.functions.length
    setDomain({ min: block.min, max: block.max })
    setParameters(Object.fromEntries(block.controls.map(control => [control.id, control.value])))
    setCursor((block.min + block.max) / 2)
  }
  const zoom = (factor: number) => {
    if (!validDomain) return
    const center = (min + max) / 2, half = (max - min) * factor / 2
    if (half < 1e-9 || center - half < -1e6 || center + half > 1e6) return
    setDomain({ min: Number((center - half).toPrecision(10)), max: Number((center + half).toPrecision(10)) })
  }

  return <figure data-generative-function className="m-0 min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">{block.title && <figcaption className="text-sm font-medium">{block.title}</figcaption>}<button type="button" className={`ml-auto ${visualButton}`} onClick={reset}><RotateCcw aria-hidden size={14} />{t('generative.reset')}</button></div>
    <div className="space-y-2">
      {functions.map((fn, index) => {
        const valid = compileFunctionExpression(fn.expression, block.variable, block.controls.map(control => control.id)) !== null
        return <div key={fn.id} data-function-row className="space-y-1">
          <div className="gui-function-row">
            <button type="button" className={visualButton} onClick={() => setFunctions(current => current.map(item => item.id === fn.id ? { ...item, visible: !item.visible } : item))} aria-label={t(fn.visible ? 'generative.hideFunction' : 'generative.showFunction', { name: label(fn, index) })} aria-pressed={fn.visible} style={{ color: palette[index % palette.length] }}>{fn.visible ? <Eye aria-hidden size={16} /> : <EyeOff aria-hidden size={16} />}</button>
            <label htmlFor={`${id}-fn-${fn.id}`} className="shrink-0 text-xs text-[var(--color-fg-muted)]">{label(fn, index)}({block.variable}) =</label>
            <input id={`${id}-fn-${fn.id}`} aria-label={t('generative.functionExpression', { name: label(fn, index) })} aria-invalid={!valid} aria-describedby={`${id}-help${valid ? '' : ` ${id}-error-${fn.id}`}`} value={fn.expression} maxLength={240} spellCheck={false} onChange={event => setFunctions(current => current.map(item => item.id === fn.id ? { ...item, expression: event.target.value } : item))} className={`${visualInput} min-w-0 flex-1 font-mono`} />
            <button type="button" className={visualButton} disabled={functions.length === 1} aria-label={t('generative.deleteFunction', { name: label(fn, index) })} onClick={() => setFunctions(current => current.filter(item => item.id !== fn.id))}><Trash2 aria-hidden size={14} /></button>
          </div>
          {!valid && <p role="status" id={`${id}-error-${fn.id}`} className="m-0 pl-2 text-xs text-[var(--color-danger)]">{t('generative.functionInvalid')}</p>}
        </div>
      })}
      <button type="button" disabled={functions.length >= MAX_FUNCTIONS} className={visualButton} onClick={() => {
        const fnID = nextID.current++
        setFunctions(current => [...current, { id: fnID, expression: `${block.variable}^2`, visible: true }])
        requestAnimationFrame(() => document.getElementById(`${id}-fn-${fnID}`)?.focus())
      }}><Plus aria-hidden size={14} />{t('generative.addFunction')}</button>
    </div>
    <div className="gui-fields">
      <label className="gui-field text-xs text-[var(--color-fg-muted)]"><span>{t('generative.rangeMin', { variable: block.variable })}</span><input type="number" step="any" min={-1e6} max={1e6} value={domain.min} onChange={event => setDomain(current => ({ ...current, min: event.target.value }))} className={`${visualInput} w-full`} /></label>
      <label className="gui-field text-xs text-[var(--color-fg-muted)]"><span>{t('generative.rangeMax', { variable: block.variable })}</span><input type="number" step="any" min={-1e6} max={1e6} value={domain.max} onChange={event => setDomain(current => ({ ...current, max: event.target.value }))} className={`${visualInput} w-full`} /></label>
      {block.controls.map(control => <NumericControl key={control.id} control={control} value={parameters[control.id]} onChange={value => setParameters(current => ({ ...current, [control.id]: value }))} />)}
    </div>
    {(!validDomain || !validParameters) && <p role="status" className="m-0 text-xs text-[var(--color-danger)]">{t('generative.rangeInvalid')}</p>}
    <div ref={ref} className="gui-function-plot">
      <div role="group" aria-label={block.title || t('generative.functionPlot')} aria-describedby={`${id}-help ${id}-values`} tabIndex={0} className={`rounded-lg ${visualFocus}`} onKeyDown={event => {
        if (!validDomain || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        setCursor(event.key === 'Home' ? min : event.key === 'End' ? max : Math.max(min, Math.min(max, cursorX + (max - min) / 100 * (event.key === 'ArrowRight' ? 1 : -1))))
      }}>
        <svg viewBox={`0 0 ${width} 266`} className="block w-full" style={{ height: 266 }} aria-hidden onPointerMove={event => {
          if (!validDomain || event.pointerType === 'touch') return
          const rect = event.currentTarget.getBoundingClientRect()
          const pointX = (event.clientX - rect.left) * width / rect.width
          setCursor(min + Math.max(0, Math.min(1, (pointX - plot.left) / (plot.right - plot.left))) * (max - min))
        }}>
          <defs><clipPath id={`${id}-clip`}><rect x={plot.left} y={plot.top} width={plot.right - plot.left} height={plot.bottom - plot.top} /></clipPath></defs>
          {[0, .25, .5, .75, 1].map(step => <g key={step}>
            <line x1={plot.left} x2={plot.right} y1={plot.top + step * (plot.bottom - plot.top)} y2={plot.top + step * (plot.bottom - plot.top)} stroke="var(--color-divider)" strokeDasharray="3 6" />
            {[0, .5, 1].includes(step) && <text x={plot.left - 6} y={plot.top + 4 + step * (plot.bottom - plot.top)} textAnchor="end" fill="var(--color-fg-muted)" fontSize="11">{new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 2 }).format(bounds.max - step * (bounds.max - bounds.min))}</text>}
          </g>)}
          {validDomain && <>
            {min <= 0 && max >= 0 && <line x1={xScale(0)} x2={xScale(0)} y1={plot.top} y2={plot.bottom} stroke="var(--color-fg-muted)" opacity=".5" />}
            {bounds.min <= 0 && bounds.max >= 0 && <line x1={plot.left} x2={plot.right} y1={yScale(0)} y2={yScale(0)} stroke="var(--color-fg-muted)" opacity=".5" />}
            <g clipPath={`url(#${id}-clip)`}>
              {sampled.map((fn, index) => <path key={fn.id} data-function-path d={functionPath(fn.points, bounds, xScale, yScale)} fill="none" stroke={palette[index % palette.length]} strokeWidth="2.5" strokeLinejoin="round" strokeDasharray={index ? `${6 + index * 2} 3` : undefined} />)}
              {hasPoints && <line x1={xScale(cursorX)} x2={xScale(cursorX)} y1={plot.top} y2={plot.bottom} stroke="var(--color-fg-subtle)" strokeDasharray="2 5" />}
            </g>
            {[0, .5, 1].map(step => <text key={step} x={plot.left + step * (plot.right - plot.left)} y="254" textAnchor={step === 0 ? 'start' : step === 1 ? 'end' : 'middle'} fill="var(--color-fg-muted)" fontSize="11">{format(min + step * (max - min))}</text>)}
          </>}
          {!hasPoints && <text x={width / 2} y="130" textAnchor="middle" fill="var(--color-fg-muted)" fontSize="12">{t('generative.noFunctionValues')}</text>}
        </svg>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1"><button type="button" disabled={!validDomain} aria-label={t('generative.zoomIn')} className={visualButton} onClick={() => zoom(.5)}><ZoomIn aria-hidden size={15} /></button><button type="button" disabled={!validDomain} aria-label={t('generative.zoomOut')} className={visualButton} onClick={() => zoom(2)}><ZoomOut aria-hidden size={15} /></button></div>
      {validDomain && <label className="flex min-w-0 flex-1 items-center gap-3 text-xs text-[var(--color-fg-muted)]"><span className="shrink-0">{block.variable} = {format(cursorX)}</span><input type="range" aria-label={t('generative.inspectFunction', { variable: block.variable })} min={min} max={max} step={(max - min) / 500} value={cursorX} onChange={event => setCursor(Number(event.target.value))} className="gui-range min-w-0 flex-1" /></label>}
    </div>
    <div id={`${id}-values`} className="gui-inspection" aria-live="polite" aria-atomic="true">{sampled.filter(fn => fn.visible).map(fn => {
      const index = sampled.indexOf(fn)
      const value = fn.compiled && validDomain && validParameters ? evaluateFunction(fn.compiled, { ...numericParameters, [block.variable]: cursorX }) : null
      return <span key={fn.id}><span style={{ color: palette[index % palette.length] }}>{label(fn, index)}</span>({format(cursorX)}) = <strong className="font-medium tabular-nums text-[var(--color-fg)]">{value === null ? t('generative.undefinedValue') : format(value)}</strong></span>
    })}</div>
    <p id={`${id}-help`} className="m-0 text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('generative.functionHelp', { variable: block.variable })}</p>
  </figure>
}

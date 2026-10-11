import { useId, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { UIBlock } from '@/lib/generative-ui'
import { formatValue, usePlotWidth, visualizationPalette as palette, visualButton, visualFocus } from './generative-shared'

type ChartBlock = Extract<UIBlock, { type: 'chart' }>
type TableBlock = Extract<UIBlock, { type: 'table' }>
const shortLabel = (value: string, max = 14) => value.length > max ? `${value.slice(0, max - 1)}…` : value

export function PresetChart({ block, renderTable }: { block: ChartBlock; renderTable: (block: TableBlock) => ReactNode }) {
  const { t, i18n } = useTranslation('chat')
  const id = useId()
  const { ref, width } = usePlotWidth()
  const [showData, setShowData] = useState(false)
  const [hidden, setHidden] = useState<number[]>([])
  const [selected, setSelected] = useState({ index: 0, series: 0 })
  const series = block.series.map((series, index) => ({ ...series, index }))
  const filteredSeries = series.filter(item => !hidden.includes(item.index))
  const visible = filteredSeries.length ? filteredSeries : [series[0]]
  const circular = block.kind === 'pie' || block.kind === 'donut'
  const horizontal = block.kind === 'horizontal-bar'
  const scatter = block.kind === 'scatter'
  const stacked = block.kind === 'stacked-bar'
  const allValues = visible.flatMap(series => series.values)
  const positive = stacked ? block.labels.map((_, index) => visible.reduce((sum, series) => sum + Math.max(0, series.values[index]), 0)) : allValues
  const negative = stacked ? block.labels.map((_, index) => visible.reduce((sum, series) => sum + Math.min(0, series.values[index]), 0)) : allValues
  const min = Math.min(0, ...negative), max = Math.max(0, ...positive) || (min === 0 ? 1 : 0)
  const span = max - min || 1
  const plot = { left: 52, right: Math.max(72, width - 16), top: 16, bottom: 204 }
  const y = (value: number) => plot.bottom - (value - min) / span * (plot.bottom - plot.top)
  const x = (index: number) => plot.left + (index + .5) * (plot.right - plot.left) / block.labels.length
  const scatterX = visible.flatMap(series => series.xValues ?? [])
  const minX = scatter ? Math.min(...scatterX) : 0, maxX = scatter ? Math.max(...scatterX) : 1
  const realX = (value: number) => plot.left + (maxX === minX ? .5 : (value - minX) / (maxX - minX)) * (plot.right - plot.left)
  const barWidth = Math.min(34, (plot.right - plot.left) * .75 / block.labels.length / (stacked ? 1 : visible.length))
  const every = Math.max(1, Math.ceil(block.labels.length / Math.max(2, Math.floor((plot.right - plot.left) / 70))))
  const activeSeries = visible.find(series => series.index === selected.series) ?? visible[0]
  const activeIndex = Math.min(selected.index, block.labels.length - 1)
  const format = (value: number) => formatValue(value, i18n.language)
  const inspect = (index: number, series: number) => setSelected({ index, series })
  const totals = circular ? block.series[0].values.reduce((sum, value) => sum + value, 0) : 0
  const table = useMemo<TableBlock>(() => ({
    type: 'table', columns: [t('generative.label'), ...block.series.flatMap(series => scatter ? [`${series.name} · ${block.xLabel || 'x'}`, `${series.name} · ${block.yLabel || 'y'}`] : [series.name])],
    rows: block.labels.map((label, index) => [label, ...block.series.flatMap(series => scatter ? [series.xValues![index], series.values[index]] : [series.values[index]])]),
  }), [block, scatter, t])

  function arc(start: number, end: number) {
    const radius = 78, inner = block.kind === 'donut' ? 46 : 0
    const point = (angle: number, r: number) => `${110 + Math.cos(angle) * r},${110 + Math.sin(angle) * r}`
    const large = end - start > Math.PI ? 1 : 0
    if (!inner) return `M110,110 L${point(start, radius)} A${radius},${radius} 0 ${large} 1 ${point(end, radius)} Z`
    return `M${point(start, inner)} L${point(start, radius)} A${radius},${radius} 0 ${large} 1 ${point(end, radius)} L${point(end, inner)} A${inner},${inner} 0 ${large} 0 ${point(start, inner)} Z`
  }

  return <figure data-generative-chart={block.kind} className="m-0 min-w-0 space-y-3">
    {block.title && <figcaption className="text-sm font-medium">{block.title}</figcaption>}
    <div ref={ref} role="group" tabIndex={0} aria-label={block.title || t('generative.chart')} aria-describedby={`${id}-value ${id}-help`} className={`gui-plot rounded-lg ${visualFocus}`} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const current = visible.findIndex(series => series.index === activeSeries.index)
        inspect(activeIndex, visible[(current + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length].index)
      } else inspect(event.key === 'Home' ? 0 : event.key === 'End' ? block.labels.length - 1 : Math.max(0, Math.min(block.labels.length - 1, activeIndex + (event.key === 'ArrowRight' ? 1 : -1))), activeSeries.index)
    }}>
      {circular ? <div className="flex flex-wrap items-center gap-4">
        <svg viewBox="0 0 220 220" aria-hidden className="h-52 w-52 max-w-full shrink-0">
          {!totals && <circle cx="110" cy="110" r="78" fill={block.kind === 'pie' ? 'var(--color-bg-muted)' : 'none'} stroke="var(--color-bg-muted)" strokeWidth={block.kind === 'donut' ? 32 : 0} />}
          {block.series[0].values.map((value, index, values) => {
            if (!value || !totals) return null
            const start = -Math.PI / 2 + values.slice(0, index).reduce((sum, item) => sum + item, 0) / totals * Math.PI * 2
            const end = start + value / totals * Math.PI * 2
            const props = { fill: palette[index % palette.length], onPointerEnter: () => inspect(index, 0), onClick: () => inspect(index, 0) }
            return value === totals
              ? <circle key={index} cx="110" cy="110" r={block.kind === 'donut' ? 62 : 78} {...props} fill={block.kind === 'donut' ? 'none' : props.fill} stroke={props.fill} strokeWidth={block.kind === 'donut' ? 32 : 0} />
              : <path key={index} d={arc(start, end)} {...props} opacity={activeIndex === index ? 1 : .8} />
          })}
          {block.kind === 'donut' && <text x="110" y="114" textAnchor="middle" fill="var(--color-fg)" fontSize="20" fontWeight="600">{format(totals)}</text>}
        </svg>
        <div className="min-w-0 flex-1 basis-40 space-y-1">
          {block.labels.map((label, index) => <button key={index} type="button" onClick={() => inspect(index, 0)} aria-pressed={activeIndex === index} className={`gui-legend-row ${visualFocus}`}>
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: palette[index % palette.length] }} /><span className="min-w-0 flex-1">{label}</span>
            <span className="shrink-0 tabular-nums">{totals ? format(block.series[0].values[index] / totals * 100) : '0'}%</span>
          </button>)}
        </div>
      </div> : horizontal ? <div className="max-h-80 overflow-y-auto overscroll-contain">
        <svg viewBox={`0 0 ${width} ${Math.max(130, block.labels.length * 34 + 34)}`} style={{ height: Math.max(130, block.labels.length * 34 + 34) }} className="block w-full" aria-hidden>
          {block.labels.map((label, index) => {
            const left = Math.min(110, width * .3), right = width - 10
            const hx = (value: number) => left + (value - min) / span * (right - left)
            const rowY = 20 + index * 34
            return <g key={index}>
              <text x={left - 8} y={rowY + 8} textAnchor="end" fill="var(--color-fg-muted)" fontSize="11">{shortLabel(label, Math.max(6, Math.floor(left / 8)))}</text>
              {visible.map((series, si) => <rect key={series.index} x={Math.min(hx(0), hx(series.values[index]))} y={rowY + si * 14 / visible.length} width={Math.abs(hx(series.values[index]) - hx(0))} height={Math.max(2, 14 / visible.length - 1)} rx="2" fill={palette[series.index % palette.length]} onPointerEnter={() => inspect(index, series.index)} onClick={() => inspect(index, series.index)}><title>{`${label} · ${series.name}: ${format(series.values[index])}`}</title></rect>)}
            </g>
          })}
        </svg>
      </div> : <svg viewBox={`0 0 ${width} 244`} className="block w-full" style={{ height: 244 }} aria-hidden>
        {[0, .5, 1].map(step => <g key={step}>
          <line x1={plot.left} x2={plot.right} y1={plot.top + 188 * step} y2={plot.top + 188 * step} stroke="var(--color-divider)" strokeDasharray="3 6" />
          <text x={plot.left - 7} y={plot.top + 4 + 188 * step} textAnchor="end" fill="var(--color-fg-muted)" fontSize="11">{new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(max - span * step)}</text>
        </g>)}
        {visible.map((series, si) => {
          const points = series.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')
          return <g key={series.index} style={{ color: palette[series.index % palette.length] }}>
            {block.kind === 'area' && <polygon points={`${x(0)},${y(0)} ${points} ${x(block.labels.length - 1)},${y(0)}`} fill="currentColor" opacity=".14" />}
            {(block.kind === 'line' || block.kind === 'area') && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeDasharray={series.index ? `${6 + series.index * 2} 3` : undefined} />}
            {series.values.map((value, index) => {
              const pointProps = { onPointerEnter: () => inspect(index, series.index), onClick: () => inspect(index, series.index) }
              if (block.kind === 'bar' || stacked) {
                const base = stacked ? visible.slice(0, si).reduce((sum, prior) => sum + (value >= 0 ? Math.max(0, prior.values[index]) : Math.min(0, prior.values[index])), 0) : 0
                return <rect key={index} x={x(index) + (stacked ? -.5 : si - visible.length / 2) * barWidth} y={Math.min(y(base), y(base + value))} width={Math.max(1, barWidth - (stacked ? 0 : 2))} height={Math.abs(y(base + value) - y(base))} rx={stacked ? 0 : 2} fill="currentColor" {...pointProps}><title>{`${block.labels[index]} · ${series.name}: ${format(value)}`}</title></rect>
              }
              return <circle key={index} cx={scatter ? realX(series.xValues![index]) : x(index)} cy={y(value)} r={activeIndex === index && activeSeries.index === series.index ? 5 : scatter ? 3.5 : 2.5} fill="currentColor" {...pointProps}><title>{`${block.labels[index]} · ${series.name}: ${format(value)}`}</title></circle>
            })}
          </g>
        })}
        {scatter ? [0, .5, 1].map(step => <text key={step} x={plot.left + step * (plot.right - plot.left)} y="228" textAnchor={step === 0 ? 'start' : step === 1 ? 'end' : 'middle'} fill="var(--color-fg-muted)" fontSize="11">{format(minX + step * (maxX - minX))}</text>)
          : block.labels.map((label, index) => (index % every === 0 || index === block.labels.length - 1) && <text key={index} x={x(index)} y="228" textAnchor="middle" fill="var(--color-fg-muted)" fontSize="11">{shortLabel(label)}</text>)}
      </svg>}
    </div>
    <div className="gui-inspection" id={`${id}-value`} aria-live="polite" aria-atomic="true">
      <span className="font-medium text-[var(--color-fg)]">{block.labels[activeIndex]}</span>
      <span>{activeSeries.name}: <strong className="font-medium tabular-nums text-[var(--color-fg)]">{format(activeSeries.values[activeIndex])}</strong></span>
      {scatter && <span>{block.xLabel || 'x'}: {format(activeSeries.xValues![activeIndex])}</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {!circular && block.series.map((series, index) => <button key={index} type="button" aria-pressed={visible.some(item => item.index === index)} disabled={visible.length === 1 && visible[0].index === index} onClick={() => setHidden(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index])} className={`gui-legend ${visualFocus}`}>
        <span aria-hidden className="size-2 rounded-full" style={{ background: palette[index % palette.length] }} />{series.name}
      </button>)}
      <button type="button" className={`ml-auto ${visualButton}`} aria-expanded={showData} onClick={() => setShowData(current => !current)}>{t(showData ? 'generative.hideData' : 'generative.showData')}</button>
    </div>
    <p id={`${id}-help`} className="sr-only">{t('generative.chartKeyboard')}</p>
    {(block.xLabel || block.yLabel) && <p className="m-0 text-xs text-[var(--color-fg-muted)]">{[block.xLabel, block.yLabel].filter(Boolean).join(' · ')}</p>}
    {showData && renderTable(table)}
  </figure>
}

export function Heatmap({ block }: { block: Extract<UIBlock, { type: 'heatmap' }> }) {
  const { t, i18n } = useTranslation('chat')
  const min = Math.min(...block.values.flat()), max = Math.max(...block.values.flat())
  const [selected, setSelected] = useState({ row: 0, column: 0 })
  const activeRow = Math.min(selected.row, block.yLabels.length - 1)
  const activeColumn = Math.min(selected.column, block.xLabels.length - 1)
  const table = useId()
  return <figure data-generative-heatmap className="m-0 min-w-0 space-y-3">
    {block.title && <figcaption className="text-sm font-medium">{block.title}</figcaption>}
    <div className="max-h-96 overflow-auto overscroll-contain">
      <table className="gui-heatmap w-full" role="grid" aria-label={block.title || t('generative.heatmap')}>
        <thead><tr><th /><>{block.xLabels.map((label, index) => <th key={index} scope="col">{label}</th>)}</></tr></thead>
        <tbody>{block.yLabels.map((label, row) => <tr key={row}>
          <th scope="row">{label}</th>
          {block.values[row].map((value, column) => <td key={column}>
            <button id={`${table}-${row}-${column}`} type="button" tabIndex={activeRow === row && activeColumn === column ? 0 : -1} onFocus={() => setSelected({ row, column })} onClick={() => setSelected({ row, column })} onPointerEnter={() => setSelected({ row, column })} aria-label={`${label}, ${block.xLabels[column]}: ${formatValue(value, i18n.language)}`} className={`gui-heatmap-cell ${visualFocus}`} style={{ background: `color-mix(in oklch, var(--color-accent) ${max === min ? 16 : Math.round(8 + (value - min) / (max - min) * 28)}%, var(--color-surface))` }} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
              event.preventDefault()
              const nextRow = Math.max(0, Math.min(block.yLabels.length - 1, row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)))
              const nextColumn = Math.max(0, Math.min(block.xLabels.length - 1, column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)))
              document.getElementById(`${table}-${nextRow}-${nextColumn}`)?.focus()
            }}>{formatValue(value, i18n.language)}</button>
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="gui-inspection" aria-live="polite">{block.yLabels[activeRow]} · {block.xLabels[activeColumn]}: {formatValue(block.values[activeRow][activeColumn], i18n.language)}</div>
    <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]"><span>{formatValue(min, i18n.language)}</span><span aria-hidden className="h-2 w-20 rounded" style={{ background: 'linear-gradient(to right, color-mix(in oklch, var(--color-accent) 8%, var(--color-surface)), color-mix(in oklch, var(--color-accent) 36%, var(--color-surface)))' }} /><span>{formatValue(max, i18n.language)}</span></div>
  </figure>
}

export function Gauge({ block }: { block: Extract<UIBlock, { type: 'gauge' }> }) {
  const { i18n } = useTranslation('chat')
  const ratio = (block.value - block.min) / (block.max - block.min)
  return <figure data-generative-gauge className="m-0 min-w-0 space-y-3">
    {block.title && <figcaption className="text-sm font-medium">{block.title}</figcaption>}
    <div className="flex items-baseline justify-between gap-3"><span className="text-sm">{block.label}</span><span className="text-xl font-semibold tabular-nums">{formatValue(block.value, i18n.language)}{block.unit ? ` ${block.unit}` : ''}</span></div>
    <div role="meter" aria-label={block.label} aria-valuemin={block.min} aria-valuemax={block.max} aria-valuenow={block.value} aria-valuetext={`${formatValue(block.value, i18n.language)} ${block.unit || ''}`} className="h-2.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]"><div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${ratio * 100}%` }} /></div>
    <div className="flex justify-between text-xs tabular-nums text-[var(--color-fg-muted)]"><span>{formatValue(block.min, i18n.language)}</span><span>{formatValue(block.max, i18n.language)}</span></div>
  </figure>
}

import { evaluateFunction, type CompiledFunction } from './function-expression'

export interface FunctionSample { x: number; y: number | null; midpoint: number | null }

export function sampleFunction(fn: CompiledFunction, variable: string, min: number, max: number, samples: number, parameters: Record<string, number>): FunctionSample[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isInteger(samples) || samples < 24 || samples > 600) return []
  const step = (max - min) / (samples - 1)
  return Array.from({ length: samples }, (_, index) => {
    const x = min + index * step
    return { x, y: evaluateFunction(fn, { ...parameters, [variable]: x }), midpoint: index === 0 ? null : evaluateFunction(fn, { ...parameters, [variable]: x - step / 2 }) }
  })
}

export function functionBounds(series: FunctionSample[][]): { min: number; max: number } {
  const values = series.flatMap(samples => samples.flatMap(sample => sample.y === null ? [] : [sample.y])).sort((a, b) => a - b)
  if (!values.length) return { min: -1, max: 1 }
  // Avoid letting the few samples next to a pole flatten the meaningful curve.
  const trim = values.length >= 50 ? Math.floor(values.length * .02) : 0
  const min = values[trim], max = values[values.length - trim - 1]
  const padding = (max - min || Math.max(1, Math.abs(min) * .2)) * .1
  return { min: min - padding, max: max + padding }
}

export function functionNeedsSeparateScales(series: FunctionSample[][]): boolean {
  const spans = series.filter(points => points.some(point => point.y !== null)).map(points => {
    const bounds = functionBounds([points])
    return bounds.max - bounds.min
  })
  return spans.length > 1 && Math.max(...spans) / Math.min(...spans) > 100
}

export function functionPath(samples: FunctionSample[], bounds: { min: number; max: number }, xScale: (x: number) => number, yScale: (y: number) => number): string {
  let connected = false
  let previous: FunctionSample | null = null
  const range = bounds.max - bounds.min
  const path: string[] = []
  for (const sample of samples) {
    if (sample.y === null || sample.y < bounds.min - range || sample.y > bounds.max + range) {
      connected = false
      previous = sample
      continue
    }
    const discontinuity = previous && (sample.midpoint === null || (previous.y !== null && (
      Math.abs(sample.y - previous.y) > range || Math.abs(sample.midpoint - (sample.y + previous.y) / 2) > range * .5
    )))
    if (discontinuity) connected = false
    path.push(`${connected ? 'L' : 'M'}${xScale(sample.x).toFixed(2)},${yScale(sample.y).toFixed(2)}`)
    connected = true
    previous = sample
  }
  return path.join(' ')
}

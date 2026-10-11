import { describe, expect, it } from 'vitest'
import { compileFunctionExpression } from '@/lib/function-expression'
import { functionBounds, functionPath, sampleFunction } from '@/lib/function-plot'

const sample = (expression: string, min: number, max: number, samples = 240) => sampleFunction(compileFunctionExpression(expression)!, 'x', min, max, samples, {})
const pathFor = (expression: string, min: number, max: number, samples?: number) => {
  const points = sample(expression, min, max, samples)
  return functionPath(points, functionBounds([points]), x => x, y => y)
}

describe('function plot sampling', () => {
  it('plots a constant and a domain-limited function without invalid coordinates', () => {
    const constant = sample('3', -5, 5)
    const bounds = functionBounds([constant])
    expect(bounds.min).toBeLessThan(3)
    expect(bounds.max).toBeGreaterThan(3)
    expect(pathFor('3', -5, 5).match(/M/g)).toHaveLength(1)
    const root = sample('sqrt(x)', -2, 2)
    expect(root.filter(point => point.x < 0).every(point => point.y === null)).toBe(true)
    expect(root.filter(point => point.x > 0).every(point => point.y !== null)).toBe(true)
    expect(pathFor('sqrt(x)', -2, 2)).not.toMatch(/NaN|Infinity/)
  })
  it('breaks curves at a pole even when no sample lands exactly on it', () => {
    // Even sampling straddles x=0; odd sampling lands exactly on it.
    for (const samples of [240, 241]) {
      const path = pathFor('1/x', -2, 2, samples)
      expect(path.match(/M/g)).toHaveLength(2)
      expect(path).not.toMatch(/NaN|Infinity/)
      for (const segment of path.split('M').filter(Boolean)) {
        const xs = [...segment.matchAll(/(?:^|L)(-?[\d.]+),/g)].map(match => Number(match[1]))
        expect(xs.every(x => x < 0) || xs.every(x => x > 0)).toBe(true)
      }
    }
  })
  it('keeps separate branches across multiple tangent asymptotes', () => {
    const path = pathFor('tan(x)', -Math.PI, Math.PI)
    expect(path.match(/M/g)?.length).toBeGreaterThanOrEqual(3)
    expect(path).not.toMatch(/NaN|Infinity/)
  })
  it('applies numeric parameters and bounds the amount of sampling work', () => {
    const expression = compileFunctionExpression('a*x', 'x', ['a'])!
    const points = sampleFunction(expression, 'x', 0, 2, 24, { a: 3 })
    expect(points).toHaveLength(24)
    expect(points.at(-1)?.y).toBe(6)
    for (const samples of [0, 10, 601, 1e9]) expect(sampleFunction(expression, 'x', 0, 2, samples, { a: 3 })).toEqual([])
    expect(sampleFunction(expression, 'x', 2, 0, 24, { a: 3 })).toEqual([])
    expect(functionBounds([sample('sqrt(-1)', -2, 2)])).toEqual({ min: -1, max: 1 })
  })
})

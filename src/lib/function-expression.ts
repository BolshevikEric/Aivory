/**
 * Small, deterministic expression evaluator for generated function plots.
 * It intentionally supports arithmetic and common math functions only; user
 * supplied expressions never reach JavaScript's eval or Function constructor.
 */

type Token = { kind: 'number' | 'name' | 'operator' | 'paren' | 'comma'; value: string }
type Node =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'unary'; op: '+' | '-'; value: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }

const MAX_EXPRESSION_LENGTH = 240
const MAX_TOKENS = 96
const constants: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }
const functions: Record<string, { min: number; max: number; run: (...args: number[]) => number }> = {
  abs: { min: 1, max: 1, run: Math.abs },
  acos: { min: 1, max: 1, run: Math.acos },
  asin: { min: 1, max: 1, run: Math.asin },
  atan: { min: 1, max: 1, run: Math.atan },
  atan2: { min: 2, max: 2, run: Math.atan2 },
  cbrt: { min: 1, max: 1, run: Math.cbrt },
  ceil: { min: 1, max: 1, run: Math.ceil },
  cos: { min: 1, max: 1, run: Math.cos },
  cosh: { min: 1, max: 1, run: Math.cosh },
  exp: { min: 1, max: 1, run: Math.exp },
  floor: { min: 1, max: 1, run: Math.floor },
  log: { min: 1, max: 1, run: Math.log },
  ln: { min: 1, max: 1, run: Math.log },
  log2: { min: 1, max: 1, run: Math.log2 },
  log10: { min: 1, max: 1, run: Math.log10 },
  max: { min: 1, max: 8, run: (...args) => Math.max(...args) },
  min: { min: 1, max: 8, run: (...args) => Math.min(...args) },
  pow: { min: 2, max: 2, run: Math.pow },
  round: { min: 1, max: 1, run: Math.round },
  sign: { min: 1, max: 1, run: Math.sign },
  sin: { min: 1, max: 1, run: Math.sin },
  sinh: { min: 1, max: 1, run: Math.sinh },
  sqrt: { min: 1, max: 1, run: Math.sqrt },
  tan: { min: 1, max: 1, run: Math.tan },
  tanh: { min: 1, max: 1, run: Math.tanh },
}

const hasOwn = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name)

export function validExpressionVariable(value: string) {
  return /^[a-z_][a-z0-9_]{0,31}$/.test(value) && !hasOwn(constants, value) && !hasOwn(functions, value) && !['__proto__', 'prototype', 'constructor'].includes(value)
}

function tokenize(source: string): Token[] {
  if (!source || source.length > MAX_EXPRESSION_LENGTH) throw new Error('expression')
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (/\s/.test(char)) { i++; continue }
    if (/[0-9.]/.test(char)) {
      const match = source.slice(i).match(/^(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/)
      if (!match) throw new Error('number')
      const value = Number(match[0])
      if (!Number.isFinite(value)) throw new Error('number')
      tokens.push({ kind: 'number', value: match[0] })
      i += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)
      if (!match) throw new Error('name')
      tokens.push({ kind: 'name', value: match[0].toLowerCase() })
      i += match[0].length
      continue
    }
    if ('+-*/^'.includes(char)) tokens.push({ kind: 'operator', value: char })
    else if (char === '(' || char === ')') tokens.push({ kind: 'paren', value: char })
    else if (char === ',') tokens.push({ kind: 'comma', value: char })
    else throw new Error('character')
    i++
  }
  if (!tokens.length || tokens.length > MAX_TOKENS) throw new Error('tokens')
  return tokens
}

class Parser {
  private index = 0
  constructor(private readonly tokens: Token[]) {}
  private peek() { return this.tokens[this.index] }
  private take() { return this.tokens[this.index++] }
  private expect(kind: Token['kind'], value?: string) {
    const token = this.take()
    if (!token || token.kind !== kind || (value !== undefined && token.value !== value)) throw new Error('syntax')
    return token
  }
  parse(): Node {
    const node = this.additive()
    if (this.index !== this.tokens.length) throw new Error('syntax')
    return node
  }
  private additive(): Node {
    let node = this.multiplicative()
    while (this.peek()?.kind === 'operator' && ['+', '-'].includes(this.peek().value)) {
      const op = this.take().value as '+' | '-'
      node = { kind: 'binary', op, left: node, right: this.multiplicative() }
    }
    return node
  }
  private multiplicative(): Node {
    let node = this.unary()
    while (this.peek()?.kind === 'operator' && ['*', '/'].includes(this.peek().value)) {
      const op = this.take().value as '*' | '/'
      node = { kind: 'binary', op, left: node, right: this.unary() }
    }
    return node
  }
  private power(): Node {
    const left = this.primary()
    if (this.peek()?.kind === 'operator' && this.peek().value === '^') {
      this.take()
      return { kind: 'binary', op: '^', left, right: this.unary() }
    }
    return left
  }
  private unary(): Node {
    if (this.peek()?.kind === 'operator' && ['+', '-'].includes(this.peek().value)) {
      const op = this.take().value as '+' | '-'
      return { kind: 'unary', op, value: this.unary() }
    }
    return this.power()
  }
  private primary(): Node {
    const token = this.peek()
    if (!token) throw new Error('syntax')
    if (token.kind === 'number') {
      this.take()
      return { kind: 'number', value: Number(token.value) }
    }
    if (token.kind === 'name') {
      this.take()
      if (this.peek()?.kind !== 'paren' || this.peek().value !== '(') return { kind: 'name', value: token.value }
      this.take()
      const args: Node[] = []
      if (this.peek()?.value !== ')') {
        args.push(this.additive())
        while (this.peek()?.kind === 'comma') { this.take(); args.push(this.additive()) }
      }
      this.expect('paren', ')')
      return { kind: 'call', name: token.value, args }
    }
    if (token.kind === 'paren' && token.value === '(') {
      this.take()
      const node = this.additive()
      this.expect('paren', ')')
      return node
    }
    throw new Error('syntax')
  }
}

function validate(node: Node, variables: Set<string>, depth = 0): void {
  if (depth > 32) throw new Error('depth')
  switch (node.kind) {
    case 'number': return
    case 'name': if (!variables.has(node.value) && !hasOwn(constants, node.value)) throw new Error('variable'); return
    case 'unary': validate(node.value, variables, depth + 1); return
    case 'binary': validate(node.left, variables, depth + 1); validate(node.right, variables, depth + 1); return
    case 'call': {
      if (!hasOwn(functions, node.name)) throw new Error('function')
      const fn = functions[node.name]
      if (node.args.length < fn.min || node.args.length > fn.max) throw new Error('arity')
      for (const argument of node.args) validate(argument, variables, depth + 1)
    }
  }
}

function evaluate(node: Node, variables: Record<string, number>): number {
  switch (node.kind) {
    case 'number': return node.value
    case 'name': {
      if (hasOwn(variables, node.value)) return variables[node.value]
      if (hasOwn(constants, node.value)) return constants[node.value]
      throw new Error('variable')
    }
    case 'unary': return node.op === '-' ? -evaluate(node.value, variables) : evaluate(node.value, variables)
    case 'binary': {
      const left = evaluate(node.left, variables)
      const right = evaluate(node.right, variables)
      if (node.op === '/' && right === 0) return Number.NaN
      if (node.op === '+') return left + right
      if (node.op === '-') return left - right
      if (node.op === '*') return left * right
      if (node.op === '/') return left / right
      return Math.pow(left, right)
    }
    case 'call': {
      const fn = functions[node.name]
      if (!fn || node.args.length < fn.min || node.args.length > fn.max) throw new Error('function')
      return fn.run(...node.args.map(arg => evaluate(arg, variables)))
    }
  }
}

export interface CompiledFunction {
  expression: string
  variables: string[]
  evaluate: (variables: Record<string, number>) => number
}

export function compileExpression(expression: string, variables: string[] = []): CompiledFunction | null {
  try {
    if (variables.some(value => !validExpressionVariable(value)) || new Set(variables).size !== variables.length) return null
    const ast = new Parser(tokenize(expression)).parse()
    validate(ast, new Set(variables))
    return { expression, variables, evaluate: values => evaluate(ast, values) }
  } catch { return null }
}

export function compileFunctionExpression(expression: string, variable = 'x', additionalVariables: string[] = []): CompiledFunction | null {
  return compileExpression(expression, [variable, ...additionalVariables])
}

export function evaluateFunction(compiled: CompiledFunction, values: Record<string, number>): number | null {
  try {
    const value = compiled.evaluate(values)
    return Number.isFinite(value) && Math.abs(value) <= 1e15 ? value : null
  } catch { return null }
}

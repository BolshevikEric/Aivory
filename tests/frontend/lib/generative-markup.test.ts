import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateMarkupExpression, mapMarkupExpressions, markupAttribute, markupBinding, markupComponents, markupElements, markupReply, parseUIAnswer, parseUIMarkup, prepareGenerativeMarkup, MAX_MARKUP_SOURCE, type MarkupNode } from '@/lib/generative-markup'
import { markupPreset } from '@/lib/generative-markup-presets'
import { tokenizeMarkdown } from '@/lib/markdown'
import { weeklyProgress } from '../fixtures/generative-inline'
import { evolvingState } from '../fixtures/generative-robustness'

describe('composable generative markup', () => {
  it('keeps every shipped example compatible with the markup renderer and visualization engines', () => {
    const prompt = readFileSync('server/internal/store/skills/generative-ui.md', 'utf8')
    const aliases = new Set('mapwidget map-widget asyncimage img column stack section button-group stats span small b i separator list tag callout meter h1 h2 h3 h4 h5 h6 a range label'.split(' '))
    expect(prompt).toContain('one canonical name per component')
    for (const [, name] of prompt.matchAll(/`([A-Za-z][\w-]*)(?=[\s`])/g)) {
      // "label" also names an attribute, so check it as a tag in examples below.
      if (name !== 'label') expect(aliases.has(name.toLowerCase()), `Documented component alias: ${name}`).toBe(false)
    }
    const examples = [...prompt.matchAll(/```aivory-ui\s*\n([\s\S]*?)\n```/g)]
    expect(examples.length).toBeGreaterThanOrEqual(5)
    for (const [, source] of examples) {
      const doc = parseUIMarkup(source)
      expect(doc, source).not.toBeNull()
      const check = (nodes: MarkupNode[]) => {
        for (const node of markupElements(nodes)) {
          expect(aliases.has(node.tag), `Example component alias: ${node.tag}`).toBe(false)
          if (['chart', 'heatmap', 'gauge', 'function', 'calculator'].includes(node.tag)) expect(markupPreset(node, doc!.initial), source).not.toBeNull()
          check(node.children)
        }
      }
      check(doc!.children)
    }
  })
  it('parses freely nested components, Markdown, HTML attributes and JSX values', () => {
    const doc = parseUIMarkup('<grid columns={2} gap={3}><box border radius="xl">**Hello** &amp; welcome<badge tone=success>Ready</badge></box><table><tbody><tr><td><button href="https://example.test?a=1&amp;b=2">Open</button></td></tr></tbody></table></grid>')!
    expect(markupComponents.size).toBeGreaterThan(90)
    const root = markupElements(doc.children)[0]
    expect(markupAttribute(root, 'columns')).toBe(2)
    expect(markupAttribute(markupElements(root.children)[0], 'border')).toBe(true)
    expect(markupElements(root.children)[0].children[0]).toBe('**Hello** & welcome')
  })
  it('interprets the supplied DIL state and GenUI callback as data', () => {
    const doc = parseUIMarkup(`{@body const [kind,setKind] = DIL.useState("生活 vlog")}
      <box><radio-group value={kind} onChange={setKind}><radio value="美食旅游">美食、夜市</radio></radio-group>
      <button onClick={() => GenUI.issueNewTurn("内容："+kind+"；优先台湾创作者。")}>寻找</button></box>`)!
    expect(doc.initial).toEqual({ kind: '生活 vlog' })
    const [radio, button] = markupElements(markupElements(doc.children)[0].children)
    expect(markupBinding(radio, doc.setters)).toBe('kind')
    expect(markupReply(button, { kind: '美食旅游' })).toBe('内容：美食旅游；优先台湾创作者。')
  })
  it('initializes named controls and interpolates declarative prompts', () => {
    const doc = parseUIMarkup('<state name="kind" value="生活"/><form prompt="Find {{kind}} in {{city}}"><input name="city" value="台北"/><switch name="tax"/><button type="submit">Send</button></form>')!
    expect(doc.initial).toEqual({ kind: '生活', city: '台北', tax: false })
    expect(markupReply(markupElements(doc.children)[1], doc.initial)).toBe('Find 生活 in 台北')
    const toggles = parseUIMarkup('<checkbox name="done" value={true}/><switch name="optional" checked={false}/><input name="empty" value={null}/>')!
    expect(toggles.initial).toEqual({ done: true, optional: false, empty: '' })
    expect(markupReply(markupElements(parseUIMarkup('<button prompt="Review {{missing}}">Review</button>')!.children)[0], {})).toBeUndefined()
  })
  it('handles quoted braces, arrows, unicode and escaped expression strings', () => {
    expect(evaluateMarkupExpression('"a} > {b" + "\\n\\u53f0"')).toBe('a} > {b\n台')
    expect(parseUIMarkup('<button onClick={() => GenUI.issueNewTurn("{} < > \\"hi\\"")}>Go</button>')).not.toBeNull()
    expect(evaluateMarkupExpression('quantity * 12 + 3', { quantity: 4 })).toBe(51)
    expect(evaluateMarkupExpression('tax ? price * 1.1 : price', { tax: true, price: 10 })).toBe(11)
    expect(evaluateMarkupExpression('[1, "two", false]')).toEqual([1, 'two', false])
  })
  it('never evaluates JavaScript, functions, prototype paths, or arbitrary handlers', () => {
    for (const expression of ['window.location', 'globalThis.alert(1)', 'constructor.constructor("return 1")()', 'foo["constructor"]', 'fetch("/api")', 'a=1', '(()=>1)()', '1/0', '1e999']) expect(evaluateMarkupExpression(expression, { a: 1 }), expression).toBeUndefined()
    for (const source of ['<script>alert(1)</script>', '<iframe src="https://evil.test"/>', '<svg onload="alert(1)"/>', '{@body const [x,setX] = DIL.useState(fetch("/api"))}<box/>', '<state name="__proto__" value="x"/>', '<state name="x" value="a"/><state name="x" value="b"/>']) expect(parseUIMarkup(source), source).toBeNull()
    const doc = parseUIMarkup('<button onClick={() => fetch("/api")}>Click</button>')!
    expect(markupReply(markupElements(doc.children)[0], {})).toBeUndefined()
  })
  it('caps source size, depth, attributes and component count', () => {
    expect(parseUIMarkup('a'.repeat(MAX_MARKUP_SOURCE + 1))).toBeNull()
    expect(parseUIMarkup('<box>'.repeat(25) + '</box>'.repeat(25))).toBeNull()
    expect(parseUIMarkup('<br/>'.repeat(3001))).toBeNull()
    expect(parseUIMarkup('<box ' + Array.from({ length: 41 }, (_, i) => `a${i}="x"`).join(' ') + '/>')).toBeNull()
  })
  it('progressively renders complete nodes without accepting mismatched completed trees', () => {
    expect(parseUIMarkup('<box><text>Hello</text><row gap={', true)).not.toBeNull()
    expect(parseUIMarkup('<box><text>Hello</text>')).toBeNull()
    expect(parseUIMarkup('<box></row>', true)).toBeNull()
    expect(parseUIMarkup('<box>`<script>not executable</script>`</box>')).not.toBeNull()
    expect(parseUIMarkup('<box><text>Kept</text><row title="a > b" gap={', true)).not.toBeNull()
    expect(parseUIMarkup('<box><text>Kept</text><row title="a > b', true)).not.toBeNull()
  })
  it('treats tags inside expressions, formulas, escapes and code as literal text', () => {
    const source = '<box><checkbox name="done"/><text>{done ? "<button>" : "<script>"} $x<y$ \\<badge>literal\\</badge> `<image src="https://unsafe.example.test"/>`</text></box>'
    const doc = parseUIMarkup(source)!
    const text = markupElements(markupElements(doc.children)[0].children, 'text')[0]
    expect(text.children).toHaveLength(1)
    expect(typeof text.children[0]).toBe('string')
    const mixed = tokenizeMarkdown('<checkbox name="done"/>\n\nResult: {done ? "**Complete**" : "<script>"}', false, true)[0]
    expect(parseUIMarkup(mixed.content)).not.toBeNull()
    expect(mixed.content).toContain('done ? &quot;**Complete**&quot; : &quot;&lt;script&gt;&quot;')
    const blocks = tokenizeMarkdown('<box><text>{true ? "<script>" : "<button>"}</text>\n\n$$x<text>y$$\n</box>\n\n## Outside\n\nKept outside.', false, true)
    expect(blocks.filter(block => block.lang === 'aivory-ui')).toHaveLength(1)
    expect(blocks.find(block => block.type === 'heading')?.content).toBe('Outside')
  })
  it('keeps recovery bounded and the strict protocol parser unchanged', () => {
    expect(parseUIMarkup('<div><card>Kept</card></div>')).toBeNull()
    expect(parseUIAnswer('<div><card>Kept</card></div>')?.children.some(node => typeof node !== 'string' && node.tag === 'card')).toBe(true)
    expect(parseUIAnswer('<box>'.repeat(25) + '</box>'.repeat(25))).toBeNull()
    expect(parseUIAnswer('a'.repeat(MAX_MARKUP_SOURCE + 1))).toBeNull()
    expect(parseUIAnswer('<br/>'.repeat(3001))).toBeNull()
    for (const name of ['true', 'false', 'null']) expect(parseUIMarkup(`<state name="${name}" value={1}/>`)).toBeNull()
  })
  it('never maps prose expressions inside nested code, escaped braces or math', () => {
    const source = 'Active {done}; **`{done}`**; $x_{done}$; \\{done};\n\n```text\n{done}\n```\n\n    {done}'
    const mapped = mapMarkupExpressions(source, () => 'changed')
    expect(mapped).toBe(source.replace('Active {done}', 'Active changed'))
  })
  it('keeps raw component trees together across blank lines and state declarations', () => {
    const source = '# Answer\n\nBefore.\n\n{@body const [kind,setKind] = DIL.useState("vlog")}\n<box>\n**Choose**\n\n<radio-group value={kind} onChange={setKind}><radio value="vlog">Vlog</radio></radio-group>\n</box>\n\n<button prompt="Find {{kind}}">Find</button>\n\nAfter.'
    const blocks = tokenizeMarkdown(source, false, true)
    const ui = blocks.filter(block => block.type === 'code' && block.lang === 'aivory-ui')
    expect(ui).toHaveLength(1)
    expect(parseUIMarkup(ui[0].content)?.initial.kind).toBe('vlog')
    expect(blocks.at(-1)?.content).toBe('After.')
    expect(tokenizeMarkdown(source).some(block => block.lang === 'aivory-ui')).toBe(false)
  })
  it('preserves source examples and ordinary fenced code', () => {
    const source = '```html\n<box><button>Source</button></box>\n```\n\n`<box>inline</box>`'
    expect(prepareGenerativeMarkup(source)).toBe(source)
    expect(prepareGenerativeMarkup('    <box>indented source</box>')).toBe('    <box>indented source</box>')
    const fenced = '```aivory-ui\n<box>\n\nContent\n</box>\n```'
    expect(prepareGenerativeMarkup(fenced)).toBe(fenced)
    expect(tokenizeMarkdown('<box>$$x^2$$</box>', false, true)).toMatchObject([{ type: 'code', lang: 'aivory-ui', content: '<box>$$x^2$$</box>' }])
  })
  it('shares tab control state with the immediately following Markdown progress summary', () => {
    const prepared = prepareGenerativeMarkup(weeklyProgress)
    const blocks = tokenizeMarkdown(weeklyProgress, false, true)
    const ui = blocks.filter(block => block.lang === 'aivory-ui')
    expect(ui).toHaveLength(1)
    expect(ui[0].content).toContain('<p>Progress: Week 1 {w1c ?')
    expect(parseUIMarkup(ui[0].content)?.initial).toEqual({ w1c: false, w2c: false, w3c: false, w4c: false })
    expect(ui[0].content).not.toContain('Research card')
    expect(blocks.at(-1)?.content).toBe('Record the weekly findings here.')
    expect(prepareGenerativeMarkup(prepared)).toBe(prepared)
  })
  it('preserves dependent Markdown headings, lists, quotes, tables and inline component groups', () => {
    const source = 'Choose <checkbox name="done" label="Done"/> now.\n\n## Result {done ? "Done" : "Pending"}\n\n- Selected: {{done}}\n\n> State: {done}\n\n| State |\n| --- |\n| {done} |\n\nContinue <button prompt="Review {{done}}">Review</button>.'
    const ui = tokenizeMarkdown(source, false, true).filter(block => block.lang === 'aivory-ui')
    expect(ui).toHaveLength(1)
    for (const tag of ['h2', 'ul', 'blockquote', 'table', 'button']) expect(ui[0].content).toContain(`<${tag}`)
    expect(parseUIMarkup(ui[0].content)?.initial.done).toBe(false)
  })
  it('extends automatic groups with state introduced by a dependent paragraph', () => {
    const ui = tokenizeMarkdown(evolvingState, false, true).filter(block => block.lang === 'aivory-ui')
    expect(ui).toHaveLength(1)
    expect(ui[0].content).toContain('Notes: {notes}')
    expect(parseUIMarkup(ui[0].content)?.initial).toEqual({ done: false, notes: 'Draft' })
  })
  it('does not merge an independently redeclared state into the previous group', () => {
    const source = '<checkbox name="done"/>\n\n<text>{done}</text>\n\nNew {@body const [done,setDone] = DIL.useState(true)} <checkbox value={done} onChange={setDone}/> group.'
    const ui = tokenizeMarkdown(source, false, true).filter(block => block.lang === 'aivory-ui')
    expect(ui).toHaveLength(2)
    expect(parseUIMarkup(ui[0].content)?.initial.done).toBe(false)
    expect(parseUIMarkup(ui[1].content)?.initial.done).toBe(true)
    const nested = tokenizeMarkdown('<checkbox name="done"/>\n\nNew <card><state name="done" value={true}/><text>{done}</text></card> group.', false, true).filter(block => block.lang === 'aivory-ui')
    expect(nested).toHaveLength(2)
    expect(parseUIMarkup(nested[0].content)?.initial.done).toBe(false)
  })
  it('keeps state boundaries at explicit fences, unrelated prose and source examples', () => {
    const control = '<checkbox name="done" label="Done"/>'
    const summary = 'Result: {done ? "Done" : "Pending"}'
    for (const boundary of ['Unrelated paragraph.', '## Next section', '```text\n{done}\n```', '    {done}', '`{done}`', '- `{done}`', '$x + {done}$', '$${done}$$', '\\{done}', 'Unknown {missing}', '[reference]: https://example.test', '```aivory-ui\n<checkbox name="other"/>\n```']) {
      const ui = tokenizeMarkdown(`${control}\n\n${boundary}\n\n${summary}`, false, true).filter(block => block.lang === 'aivory-ui')
      expect(ui[0].content, boundary).not.toContain('Result:')
    }
    const fenced = tokenizeMarkdown(`\`\`\`aivory-ui\n${control}\n\`\`\`\n\n${summary}`, false, true)
    expect(fenced[0].content).toBe(control)
    expect(fenced.at(-1)?.content).toBe(summary)
    const independent = tokenizeMarkdown(`${control}\n\n${summary}\n\nUnrelated.\n\n<checkbox name="done" value={true}/>\n\n${summary}`, false, true).filter(block => block.lang === 'aivory-ui')
    expect(independent).toHaveLength(2)
    expect(parseUIMarkup(independent[0].content)?.initial.done).toBe(false)
    expect(parseUIMarkup(independent[1].content), independent[1].content).not.toBeNull()
    expect(parseUIMarkup(independent[1].content)?.initial.done).toBe(true)
  })
  it('interleaves inline components with prose, headings, lists, quotes and Markdown tables', () => {
    const source = '## Status <badge>Ready</badge>\n\nBefore **bold** <badge tone="success">Available</badge> after.\n\n3. Compare <button prompt="Compare plans">Compare</button> first.\n4. Keep <text color="muted">context</text>.\n\n> A note <badge>Tip</badge> for you.\n\n| Plan | Status |\n| --- | --- |\n| Basic | <badge>Available</badge> |\n\nEnd.'
    const blocks = tokenizeMarkdown(source, false, true)
    const sources = blocks.filter(block => block.lang === 'aivory-ui').map(block => block.content)
    expect(sources).toHaveLength(5)
    for (const value of sources) expect(parseUIMarkup(value), value).not.toBeNull()
    expect(sources[0]).toContain('<h2>')
    expect(sources[1]).toContain('<p>Before <strong>bold</strong> <badge')
    expect(sources[2]).toContain('<ol start={3}>')
    expect(sources[3]).toContain('<blockquote>')
    expect(sources[4]).toContain('<table>')
    expect(blocks.at(-1)?.content).toBe('End.')
    expect(prepareGenerativeMarkup(prepareGenerativeMarkup(source))).toBe(prepareGenerativeMarkup(source))
  })
  it('splits block components out of sentences without invalid paragraph nesting', () => {
    const [block] = tokenizeMarkdown('Before <card title="Details"><button href="https://example.test">Open</button></card> after.', false, true)
    expect(block.content).toBe('<p>Before </p><card title="Details"><button href="https://example.test">Open</button></card><p> after.</p>')
    const doc = parseUIMarkup(block.content)!
    expect(markupElements(doc.children).map(node => node.tag)).toEqual(['p', 'card', 'p'])
  })
  it('keeps prose-local state and DIL callbacks connected when components are interleaved', () => {
    const source = 'Choose {@body const [kind,setKind] = DIL.useState("Basic")} <select value={kind} onChange={setKind}><option value="Basic">Basic</option></select> then <button onClick={() => GenUI.issueNewTurn("Compare " + kind)}>Compare</button>.'
    const [block] = tokenizeMarkdown(source, false, true)
    const doc = parseUIMarkup(block.content)!
    expect(doc.initial.kind).toBe('Basic')
    expect(doc.setters.setKind).toBe('kind')
    const button = markupElements(markupElements(doc.children).at(-1)!.children, 'button')[0]
    expect(markupReply(button, { kind: 'Pro' })).toBe('Compare Pro')
  })
  it('does not promote tags in code, escaped source, or math, and retains reference definitions', () => {
    for (const source of ['Use `<badge>Source</badge>` literally.', 'Use \\<badge>escaped\\</badge>.', 'The formula $x <text> y$ is literal.', '```html\nBefore <badge>Source</badge> after\n```']) {
      expect(tokenizeMarkdown(source, false, true).some(block => block.lang === 'aivory-ui'), source).toBe(false)
    }
    const source = 'Available <badge>Ready</badge> with $x<y$ and `a<b` preserved.\n\n[reference]: https://example.test'
    const prepared = prepareGenerativeMarkup(source)
    expect(prepared).toContain('[reference]: https://example.test')
    expect(parseUIMarkup(tokenizeMarkdown(source, false, true)[0].content)).not.toBeNull()
    const escaped = tokenizeMarkdown('Use \\<button>source\\</button> beside <badge>Ready</badge>.', false, true)[0]
    expect(escaped.content).not.toContain('<button>')
    expect(escaped.content).toContain('&lt;button&gt;')
  })
  it('keeps indented component trees inside their Markdown list item', () => {
    const source = '- First item\n\n  <card title="Nested"><button href="https://example.test">Open</button></card>\n\n- Second item with <badge>Ready</badge>.'
    const [block] = tokenizeMarkdown(source, false, true)
    const doc = parseUIMarkup(block.content)!
    const list = markupElements(doc.children)[0]
    expect(list.tag).toBe('ul')
    const items = markupElements(list.children, 'li')
    expect(items).toHaveLength(2)
    expect(markupElements(items[0].children).some(node => node.tag === 'card')).toBe(true)
  })
  it('adapts declarative visualizations to the existing validated data engines', () => {
    const samples = [
      '<chart kind="bar"><series name="Requests"><point label="Jan" value={120}/><point label="Feb" value={180}/></series></chart>',
      '<chart kind="scatter"><series name="People"><point label="A" x={160} value={55}/></series></chart>',
      '<heatmap><heat-row label="Morning"><cell label="Mon" value={12}/></heat-row></heatmap>',
      '<gauge label="Completion" value={72}/>',
      '<function min={-5} max={5}><curve expression="a*sin(x)"/><parameter id="a" label="Amplitude" min={0.1} max={3} step={0.1} value={1}/></function>',
      '<calculator><parameter id="quantity" label="Quantity" min={1} max={100} step={1} value={10}/><output label="Total" expression="quantity * 12"/></calculator>',
    ]
    for (const source of samples) expect(markupPreset(markupElements(parseUIMarkup(source)!.children)[0], {}), source).not.toBeNull()
    expect(markupPreset(markupElements(parseUIMarkup('<function expression="window.location"/>')!.children)[0], {})).toBeNull()
  })
})

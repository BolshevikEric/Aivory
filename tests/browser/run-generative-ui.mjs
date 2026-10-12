import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'
const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p))
if (!executablePath) throw new Error('Set CHROME_PATH')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let probes = 0
server.middlewares.use((req, res, next) => {
  if (req.url?.startsWith('/__gui_probe')) { probes++; res.end('probe'); return }
  if (!req.url?.startsWith('/api/')) { next(); return }
  res.setHeader('content-type', 'application/json')
  if (req.url.startsWith('/api/me/skill-commands')) res.end(JSON.stringify([{ id: 'catalog:sk_visual', name: 'generative-ui', description: 'Visual answers', source_skill_id: 'sk_visual', instructions: '', can_manage: false, created_at: 0, updated_at: 0 }]))
  else if (req.url.startsWith('/api/me/skills') || req.url.startsWith('/api/me/prompts') || req.url.startsWith('/api/tools')) res.end('[]')
  else if (req.url.startsWith('/api/notifications')) res.end('{"notifications":[],"total":0}')
  else res.end('{}')
})
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] })
  const page = await browser.newPage()
  const image = await readFile(new URL('../../public/icon-512.png', import.meta.url))
  const imageRequests = []
  const privateRequests = []
  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = new URL(req.url())
    if (url.hostname === 'images.example.test') {
      imageRequests.push({ url: req.url(), headers: req.headers() })
      req.respond(url.pathname === '/missing.png'
        ? { status: 404, contentType: 'text/plain', body: 'Missing image' }
        : { status: 200, contentType: 'image/png', body: image })
      return
    }
    if (url.pathname === '/api/private-chat' && req.method() === 'POST') {
      privateRequests.push(JSON.parse(req.postData()))
      const question = { version: 1, blocks: [{ type: 'question', questions: [{ id: 'platform', question: 'Which platform?', options: ['Windows', 'macOS'] }] }] }
      const form = { version: 1, blocks: [{ type: 'form', title: 'Trip details', fields: [{ id: 'destination', type: 'text', label: 'Destination', required: true }] }] }
      const text = privateRequests.length === 1 ? '```aivory-ui\n' + JSON.stringify(question) + '\n```' : privateRequests.length === 2 ? 'Continuing with macOS.' : privateRequests.length === 3 ? '```aivory-ui\n' + JSON.stringify(form) + '\n```' : 'Planning your trip to Kyoto.'
      req.respond({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'text_delta', text })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n` })
      return
    }
    if (!url.pathname.startsWith('/api/')) { req.continue(); return }
    const body = url.pathname.startsWith('/api/me/skill-commands') ? JSON.stringify([{ id: 'catalog:sk_visual', name: 'generative-ui', description: 'Visual answers', source_skill_id: 'sk_visual', instructions: '', can_manage: false, created_at: 0, updated_at: 0 }]) : url.pathname.startsWith('/api/notifications') ? '{"notifications":[],"total":0}' : '[]'
    req.respond({ status: 200, contentType: 'application/json', body })
  })
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.setViewport({ width: 1024, height: 900 })
  await page.goto(`${origin}/tests/browser/generative-ui-harness.html`)
  await page.waitForSelector('[data-case="presets"] [role="tab"]')
  await page.waitForSelector('[data-case="quoted-news"] [role="tab"]')
  assert.match(await page.$eval('[data-case="quoted-news"]', e => e.textContent), /新增"学校食品安全""网络食品经营"专节/)
  await page.$$eval('[data-case="quoted-news"] [role="tab"]', nodes => nodes[1].click())
  assert.match(await page.$eval('[data-case="quoted-news"]', e => e.textContent), /美国表示"强烈谴责"/)
  await page.$eval('[data-case="rich-table"]', e => e.scrollIntoView({ block: 'start' }))
  await page.waitForFunction(() => [...document.querySelectorAll('[data-case="rich-table"] img')].length === 2 && [...document.querySelectorAll('[data-case="rich-table"] img')].every(e => e.complete && e.naturalWidth > 0) && document.querySelector('[data-case="rich-table"] [role="status"]')?.textContent === 'Image unavailable')
  assert.equal(await page.$$eval('[data-case="rich-table"] th', e => e.length), 5)
  assert.match(await page.$eval('[data-case="rich-table"]', e => e.textContent), /Bundled frontend|Native window controls/)
  assert.equal(await page.$eval('[data-case="rich-table"] tbody td:nth-child(4)', e => getComputedStyle(e).textAlign), 'right')
  assert.equal(await page.$eval('[data-case="rich-table"] tbody td:nth-child(5) a', e => e.target), '_blank')
  assert.equal(await page.$$eval('[data-case="markdown-table"] [data-generative-ui]', e => e.length), 0)
  assert.equal(await page.$$eval('[data-case="markdown-table"] table', e => e.length), 1)
  assert.equal(await page.$$eval('[data-case="advanced"] [data-generative-function]', e => e.length), 1)
  for (const name of ['function-fragment', 'private-function-fragment']) {
    const selector = `[data-case="${name}"]`
    assert.equal(await page.$$eval(`${selector} [data-generative-function]`, nodes => nodes.length), 1)
    assert.equal(await page.$$eval(`${selector} [data-function-path]`, nodes => nodes.filter(node => node.getAttribute('d')?.length > 20).length), 2)
  }
  assert.equal(await page.$$eval('[data-case="unfenced-function"] [data-generative-ui], [data-case="user-function"] [data-generative-ui]', nodes => nodes.length), 0)
  assert.equal(await page.$$eval('[data-case="advanced"] [data-generative-heatmap] td', e => e.length), 6)
  await page.$eval('[data-case="cards"]', e => e.scrollIntoView({ block: 'start' }))
  await page.waitForFunction(() => document.querySelectorAll('[data-case="cards"] img').length === 2 && [...document.querySelectorAll('[data-case="cards"] img')].every(e => e.complete && e.naturalWidth > 0) && document.querySelector('[data-case="cards"] [role="status"]')?.textContent === 'Image unavailable')
  assert.equal(await page.$$eval('[data-case="cards"] [data-generative-card]', e => e.length), 4)
  assert.equal(await page.$eval('[data-case="cards"] .gui-card-link', e => e.textContent.trim()), 'View details')
  assert.equal(await page.$eval('[data-case="cards"] .gui-card-link', e => e.target), '_blank')
  assert.match(await page.$eval('[data-case="cards"] .gui-card-link', e => e.rel), /noopener/)
  assert.equal(await page.$eval('[data-case="cards"] [data-generative-card]', e => getComputedStyle(e).borderTopWidth), '0px')
  await page.click('[data-case="rich-table"] thead th:nth-child(1) button')
  await page.waitForFunction(() => document.querySelector('[data-case="rich-table"] thead th:first-child')?.getAttribute('aria-sort') === 'ascending')
  assert.match(await page.$eval('[data-case="rich-table"] tbody tr:first-child', e => e.textContent), /Browser client/)
  const tableFilter = await page.$('[data-case="rich-table"] [data-generative-table-controls] input')
  await tableFilter.click()
  await page.keyboard.type('Desktop client')
  assert.equal(await page.$$eval('[data-case="rich-table"] tbody tr', e => e.length), 1)
  await tableFilter.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.press('Backspace')
  await page.waitForFunction(() => document.querySelectorAll('[data-case="rich-table"] tbody tr').length === 3)
  await page.keyboard.type('no-such-application')
  await page.waitForFunction(() => document.querySelector('[data-case="rich-table"] tbody [role="status"]')?.textContent === 'No matching rows')
  await tableFilter.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.press('Backspace')
  const editableFunction = await page.$('[data-case="advanced"] [data-generative-function] input')
  const initialCurve = await page.$eval('[data-case="advanced"] [data-function-path]', e => e.getAttribute('d'))
  await editableFunction.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.type('a * cos(x)')
  await page.waitForFunction(initialCurve => {
    const plot = document.querySelector('[data-case="advanced"] [data-function-path]')
    return plot && plot.getAttribute('d')?.length > 100 && plot.getAttribute('d') !== initialCurve
  }, {}, initialCurve)
  await page.click('[data-case="advanced"] [data-generative-function] button:has(svg.lucide-plus)')
  assert.equal(await page.$$eval('[data-case="advanced"] [data-function-row]', rows => rows.length), 3)
  const functionRows = await page.$$('[data-case="advanced"] [data-function-row]')
  await (await functionRows.at(-1).$('button:last-child')).click()
  assert.equal(await page.$$eval('[data-case="advanced"] [data-function-row]', rows => rows.length), 2)
  await editableFunction.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.type('window.location')
  await page.waitForFunction(() => document.querySelector('[data-case="advanced"] [data-function-row] input')?.getAttribute('aria-invalid') === 'true')
  await page.waitForFunction(() => document.querySelector('[data-case="advanced"] [data-function-path]')?.getAttribute('d') === '')
  await page.click('[data-case="advanced"] [data-generative-function] button:has(svg.lucide-rotate-ccw)')
  const functionRegion = '[data-case="advanced"] [data-generative-function] [role="group"]'
  await page.focus(functionRegion)
  await page.keyboard.press('End')
  assert.match(await page.$eval('[data-case="advanced"] [data-generative-function] .gui-inspection', e => e.textContent), /6\.28/)
  const heatmap = '[data-case="advanced"] [data-generative-heatmap]'
  await page.focus(`${heatmap} td button`)
  await page.keyboard.press('ArrowRight')
  assert.match(await page.$eval(`${heatmap} .gui-inspection`, e => e.textContent), /Tue: 16/)
  const scatter = '[data-case="advanced"] [data-generative-chart="scatter"]'
  await page.click(`${scatter} button[aria-expanded]`)
  assert.equal(await page.$$eval(`${scatter} thead th`, e => e.length), 5)
  assert.deepEqual(await page.$$eval(`${scatter} tbody tr:first-child td`, cells => cells.map(cell => cell.textContent)), ['A', '158', '51', '148', '42'])
  await page.click(`${scatter} button[aria-expanded]`)
  const stacked = '[data-case="advanced"] [data-generative-chart="stacked-bar"]'
  await page.click(`${stacked} .gui-legend:first-child`)
  assert.equal(await page.$$eval(`${stacked} svg rect`, e => e.length), 2)
  assert.equal(await page.$eval(`${stacked} .gui-legend:nth-child(2)`, e => e.disabled), true)
  await page.click(`${stacked} .gui-legend:first-child`)
  await page.focus(`${stacked} [role="group"]`)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  assert.match(await page.$eval(`${stacked} .gui-inspection`, e => e.textContent), /July.*App:.*48/)
  const calculator = '[data-case="advanced"] [data-generative-calculator]'
  assert.match(await page.$eval(calculator, e => e.textContent), /optional 10% tax/)
  assert.match(await page.$eval(`${calculator} dd`, e => e.textContent), /120/)
  await page.click(`${calculator} input[type="checkbox"]`)
  assert.match(await page.$eval(`${calculator} dd`, e => e.textContent), /132/)
  await page.select(`${calculator} select`, '24')
  assert.match(await page.$eval(`${calculator} dd`, e => e.textContent), /264/)
  const quantityInput = await page.$(`${calculator} input[type="number"]`)
  await quantityInput.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.press('Backspace')
  assert.equal(await page.$eval(`${calculator} input[type="number"]`, e => e.getAttribute('aria-invalid')), 'true')
  assert.equal(await page.$eval(`${calculator} dd`, e => e.textContent), '—')
  await page.keyboard.type('2')
  assert.match(await page.$eval(`${calculator} dd`, e => e.textContent), /52\.8/)
  await quantityInput.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.type('101')
  assert.equal(await page.$eval(`${calculator} dd`, e => e.textContent), '—', 'out-of-range values must not produce misleading results')
  await page.click(`${calculator} button`)
  assert.match(await page.$eval(`${calculator} dd`, e => e.textContent), /120/)
  assert.equal(await page.$eval(`${calculator} input[type="checkbox"]`, e => e.checked), false)
  assert.equal(await page.$eval(`${calculator} select`, e => e.value), '12')
  await page.click('[data-case="advanced"] [data-generative-checklist] input[type="checkbox"]')
  assert.match(await page.$eval('[data-case="advanced"] [data-generative-checklist]', e => e.textContent), /1 \/ 2/)
  await page.click('[data-case="advanced"] [data-generative-quiz] input[value="0"]')
  await page.click('[data-case="advanced"] [data-generative-quiz] button')
  assert.match(await page.$eval('[data-case="advanced"] [data-generative-quiz] [role="status"]', e => e.textContent), /highlighted answer/)
  await page.click('[data-case="advanced"] [data-generative-quiz] button')
  await page.click('[data-case="advanced"] [data-generative-quiz] input[value="1"]')
  await page.click('[data-case="advanced"] [data-generative-quiz] button')
  assert.match(await page.$eval('[data-case="advanced"] [data-generative-quiz] [role="status"]', e => e.textContent), /Correct/)
  const questionSelector = '[data-case="questions"] [data-generative-question]'
  assert.equal(await page.$eval(`${questionSelector} .gui-question-submit`, e => e.disabled), true)
  assert.equal(await page.$$eval(`${questionSelector} input:checked`, e => e.length), 0)
  await page.click(`${questionSelector} fieldset:nth-of-type(1) input[value="1"]`)
  await page.click(`${questionSelector} fieldset:nth-of-type(1) input[value="other"]`)
  await page.type(`${questionSelector} fieldset:nth-of-type(1) textarea`, 'FreeBSD')
  assert.equal(await page.$eval(`${questionSelector} .gui-question-submit`, e => e.disabled), true, 'all questions must be answered')
  await page.click(`${questionSelector} fieldset:nth-of-type(2) input[value="0"]`)
  await page.click(`${questionSelector} fieldset:nth-of-type(2) input[value="1"]`)
  await page.$eval(`${questionSelector} .gui-question-submit`, e => { e.click(); e.click() })
  await page.waitForFunction(() => document.querySelector('[data-case="questions"] .gui-question-feedback')?.textContent === 'Answers sent')
  const submittedAnswer = await page.evaluate(() => window.__QUESTION_REPLY__)
  assert.equal(submittedAnswer.messageId, 'question-message')
  assert.match(submittedAnswer.text, /Which platform are you using\?\n- FreeBSD/)
  assert.match(submittedAnswer.text, /Which features do you need\?\n- Charts\n- Tables/)
  assert.doesNotMatch(submittedAnswer.text, /macOS/)
  assert.equal(await page.$$eval(`${questionSelector} input:disabled`, e => e.length), 8)
  const retryQuestion = '[data-case="question-retry"] [data-generative-question]'
  await page.click(`${retryQuestion} input[value="0"]`)
  await page.click(`${retryQuestion} .gui-question-submit`)
  await page.waitForFunction(() => document.querySelector('[data-case="question-retry"] .gui-question-feedback')?.textContent.includes('Could not send'))
  assert.equal(await page.$eval(`${retryQuestion} input[value="0"]`, e => e.checked), true, 'keep answers for retry')
  await page.click(`${retryQuestion} .gui-question-submit`)
  await page.waitForFunction(() => document.querySelector('[data-case="question-retry"] .gui-question-feedback')?.textContent === 'Answers sent')
  assert.equal(await page.evaluate(() => window.__QUESTION_ATTEMPTS__), 2)
  for (const kind of ['question-streaming', 'question-readonly']) assert(await page.$$eval(`[data-case="${kind}"] input`, inputs => inputs.every(input => input.matches(':disabled'))))
  assert.equal(await page.$$eval('[data-case="question-readonly"] .gui-question-submit', e => e.length), 0)
  const formSelector = '[data-case="form"] [data-generative-form]'
  const submitForm = () => page.$eval(formSelector, form => form.requestSubmit())
  const fillFormField = async (name, value) => {
    const input = await page.$(`${formSelector} [name="${name}"]`)
    await input.evaluate(e => { e.focus(); e.select() })
    await page.keyboard.type(value)
  }
  assert.equal(await page.$eval(`${formSelector} button[type="submit"]`, e => e.textContent.trim()), 'Plan my trip')
  await submitForm()
  assert.equal(await page.evaluate(() => window.__FORM_ATTEMPTS__), undefined, 'invalid forms must not be sent')
  assert.equal(await page.$eval(`${formSelector} [name="destination"]`, e => document.activeElement === e), true)
  assert(await page.$$eval(`${formSelector} [role="alert"]`, e => e.length > 0))
  await fillFormField('destination', '  ')
  await submitForm()
  assert.equal(await page.evaluate(() => window.__FORM_ATTEMPTS__), undefined, 'required fields cannot be whitespace only')
  await fillFormField('destination', 'Kyoto')
  await fillFormField('email', 'not-an-email')
  await fillFormField('budget', '5100')
  await page.select(`${formSelector} select`, 'relaxed')
  await page.click(`${formSelector} input[name="transport"][value="Train"]`)
  await page.type(`${formSelector} textarea`, 'Vegetarian food\nPrefer quiet places')
  await submitForm()
  assert.equal(await page.evaluate(() => window.__FORM_ATTEMPTS__), undefined, 'invalid email, bounds and checkbox groups must be rejected')
  assert.equal(await page.$eval(`${formSelector} [name="budget"]`, e => e.getAttribute('aria-invalid')), 'true')
  assert.match(await page.$eval(`${formSelector} [data-form-field="budget"] [role="alert"]`, e => e.textContent), /no greater than 5000/)
  assert.equal(await page.$eval(`${formSelector} [name="email"]`, e => e.getAttribute('aria-invalid')), 'true')
  assert.match(await page.$eval(`${formSelector} [data-form-field="email"] [role="alert"]`, e => e.textContent), /valid email address/)
  assert.equal(await page.$eval(`${formSelector} [name="interests"]`, e => e.getAttribute('aria-invalid')), 'true')
  await fillFormField('email', 'traveler@example.test')
  await fillFormField('budget', '1250')
  await page.click(`${formSelector} input[name="interests"][value="Food"]`)
  await page.click(`${formSelector} input[name="interests"][value="Museums"]`)
  await submitForm()
  assert.equal(await page.evaluate(() => window.__FORM_ATTEMPTS__), undefined, 'number step must be validated')
  await fillFormField('budget', '1200')
  await page.$eval(formSelector, form => { form.requestSubmit(); form.requestSubmit() })
  await page.waitForFunction(() => document.querySelector('[data-case="form"] .gui-form-feedback')?.textContent.includes('Could not send'))
  assert.equal(await page.evaluate(() => window.__FORM_ATTEMPTS__), 1, 'double clicks must not send twice')
  assert.equal(await page.$eval(`${formSelector} [name="destination"]`, e => e.value), 'Kyoto', 'keep form entries on failure')
  await submitForm()
  await page.waitForFunction(() => document.querySelector('[data-case="form"] .gui-form-feedback')?.textContent === 'Form sent')
  const submittedForm = await page.evaluate(() => window.__FORM_REPLY__)
  assert.equal(await page.evaluate(() => window.__FORM_ATTEMPTS__), 2)
  assert.equal(submittedForm.messageId, 'form-message')
  assert.match(submittedForm.text, /Plan a trip/)
  assert.match(submittedForm.text, /Destination\nKyoto/)
  assert.match(submittedForm.text, /Budget per person\n1200/)
  assert.match(submittedForm.text, /Pace\nRelaxed/)
  assert.match(submittedForm.text, /Interests\n- Food\n- Museums/)
  assert.match(submittedForm.text, /Include alternative destinations\nNo/)
  assert.match(submittedForm.text, /Departure date\nNot provided/)
  assert.match(submittedForm.text, /Other requirements\nVegetarian food\nPrefer quiet places/)
  assert(await page.$$eval(`${formSelector} input, ${formSelector} select, ${formSelector} textarea`, e => e.every(input => input.matches(':disabled'))))
  for (const kind of ['form-streaming', 'form-answered', 'form-readonly']) {
    assert(await page.$$eval(`[data-case="${kind}"] input`, inputs => inputs.every(input => input.matches(':disabled'))))
    await page.$eval(`[data-case="${kind}"] form`, form => form.requestSubmit())
  }
  assert.equal(await page.$$eval('[data-case="form-readonly"] button[type="submit"], [data-case="form-answered"] button[type="submit"]', e => e.length), 0)
  const nativeForm = '[data-case="form-native"] form'
  await page.type(`${nativeForm} input[type="url"]`, 'not-a-url')
  await page.$eval(nativeForm, form => form.requestSubmit())
  assert.equal(await page.evaluate(() => window.__NATIVE_FORM_SUBMITTED__), undefined)
  assert.equal(await page.$eval(`${nativeForm} input[type="time"]`, e => e.value), '09:30')
  assert.equal(await page.$eval(`${nativeForm} input[type="datetime-local"]`, e => e.value), '2026-10-11T09:30')
  const urlInput = await page.$(`${nativeForm} input[type="url"]`)
  await urlInput.evaluate(input => { input.focus(); input.select() })
  await page.keyboard.type('https://example.test')
  await page.$eval(nativeForm, form => form.requestSubmit())
  assert.equal(await page.evaluate(() => window.__NATIVE_FORM_SUBMITTED__), undefined, 'required checkbox must be checked')
  await page.click(`${nativeForm} input[type="checkbox"]`)
  await page.$eval(nativeForm, form => form.requestSubmit())
  await page.waitForFunction(() => window.__NATIVE_FORM_SUBMITTED__ === true)
  // Private mode submits selected answers only through its in-memory history and private API.
  const privateChat = '[data-case="private-question-chat"]'
  await page.type(`${privateChat} textarea`, 'Ask me what platform I use.')
  await page.$eval(`${privateChat} form`, form => form.requestSubmit())
  await page.waitForSelector(`${privateChat} [data-generative-question] input:not(:disabled)`)
  await page.click(`${privateChat} [data-generative-question] input[value="1"]`)
  await page.click(`${privateChat} .gui-question-submit`)
  await page.waitForFunction(() => document.querySelector('[data-case="private-question-chat"]')?.textContent.includes('Continuing with macOS.'))
  assert.equal(privateRequests.length, 2)
  assert.equal(privateRequests[1].messages.length, 3)
  assert.equal(privateRequests[1].messages.at(-1).role, 'user')
  assert.match(privateRequests[1].messages.at(-1).text, /Which platform\?\n- macOS/)
  const privateComposer = `${privateChat} textarea:not([data-field-id])`
  await page.type(privateComposer, 'Ask me for a trip brief.')
  await page.$eval(privateComposer, textarea => textarea.closest('form').requestSubmit())
  await page.waitForSelector(`${privateChat} [data-generative-form] input:not(:disabled)`)
  await page.type(privateComposer, 'Keep this unfinished composer draft')
  await page.type(`${privateChat} [data-generative-form] input`, 'Kyoto')
  await page.$eval(`${privateChat} [data-generative-form]`, form => form.requestSubmit())
  await page.waitForFunction(() => document.querySelector('[data-case="private-question-chat"]')?.textContent.includes('Planning your trip to Kyoto.'))
  assert.equal(privateRequests.length, 4)
  assert.equal(privateRequests[3].messages.length, 7)
  assert.equal(privateRequests[3].messages.at(-1).role, 'user')
  assert.match(privateRequests[3].messages.at(-1).text, /Trip details\n\n1\. Destination\nKyoto/)
  assert.equal(await page.$eval(privateComposer, textarea => textarea.value), 'Keep this unfinished composer draft')
  assert.equal(await page.$$eval('[data-case="user"] [data-generative-ui], [data-case="ordinary"] [data-generative-ui]', e => e.length), 0)
  assert.match(await page.$eval('[data-case="incomplete"]', e => e.textContent), /Preparing visualization/)
  await page.click('[data-case="presets"] [role="tab"]:nth-child(2)')
  assert.match(await page.$eval('[data-case="presets"] [role="tabpanel"]:not([hidden])', e => e.textContent), /June/)
  await page.focus('[data-case="presets"] [role="tab"]:nth-child(2)')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.$eval('[data-case="presets"] [role="tab"]', e => e.getAttribute('aria-selected')), 'true')
  await page.click('[data-case="presets"] summary')
  assert.match(await page.$eval('[data-case="presets"] details[open]', e => e.textContent), /Check inputs/)
  const inner = async selector => {
    await page.waitForFunction(sel => Array.from(document.querySelectorAll('iframe')).length > 0 && Boolean(window.__GUI__), {}, selector)
    for (let i = 0; i < 100; i++) {
      for (const f of page.frames()) { try { if (await f.$(selector)) return f } catch { /* document replacing */ } }
      await new Promise(r => setTimeout(r, 50))
    }
    console.log('Missing frame diagnostics', await Promise.all(page.frames().map(async f => ({ url: f.url(), body: await f.evaluate(() => document.body.innerHTML.slice(0, 600)).catch(String) }))))
    throw new Error(`Frame missing: ${selector}`)
  }
  let content = await inner('#action')
  await content.click('#action')
  assert.equal(await content.$eval('#action', e => e.textContent), 'Updated')
  await page.evaluate(() => { window.__GUI__.setLive(true); window.__GUI__.setHTML('<p id="stream">Live content</p>') })
  await inner('#stream')
  await page.evaluate(() => { window.__GUI__.setHTML('<p id="finished">Complete content</p>'); window.__GUI__.setLive(false) })
  await inner('#finished')
  await page.waitForSelector('[data-case="inline"] iframe:not([aria-hidden="true"])')
  assert.doesNotMatch(await page.$eval('[data-case="inline"]', e => e.textContent), /View source|查看源码/)
  // An unfinished streamed script must not destroy the last useful document.
  await page.evaluate(() => { window.__GUI__.setLive(true); window.__GUI__.setHTML('<p id="finished">Complete content</p><script>const value =') })
  await new Promise(r => setTimeout(r, 1100))
  content = await inner('#finished')
  assert.equal(await content.$eval('#finished', e => e.textContent), 'Complete content')
  await page.evaluate(() => { window.__GUI__.setHTML('<div id="delayed"></div><script>setTimeout(()=>document.getElementById("delayed").textContent="Async content",300)</script>'); window.__GUI__.setLive(false) })
  await inner('#delayed')
  await page.waitForSelector('[data-case="inline"] iframe:not([aria-hidden="true"])')
  content = await inner('#delayed')
  assert.equal(await content.$eval('#delayed', e => e.textContent), 'Async content')
  // Script failures and completely empty answers expose a compact recovery action.
  await page.evaluate(() => window.__GUI__.setHTML('<script>throw new Error("render failure")</script>'))
  await page.waitForFunction(() => document.querySelector('[data-case="inline"]')?.textContent.includes('could not be displayed'))
  assert.equal(await page.$eval('[data-case="inline"] button', e => e.textContent), 'Reload')
  await page.click('[data-case="inline"] button')
  await page.waitForFunction(() => document.querySelector('[data-case="inline"]')?.textContent.includes('could not be displayed'))
  assert.deepEqual(errors.splice(0), ['Error: render failure', 'Error: render failure'], 'expected sandboxed rendering errors')
  await page.evaluate(() => window.__GUI__.setHTML('<div></div>'))
  await page.waitForFunction(() => document.querySelector('[data-case="inline"]')?.textContent.includes('could not be displayed'), { timeout: 12000 })
  await page.evaluate(() => window.__GUI__.setHTML('<p id="recovered">Recovered</p>'))
  await inner('#recovered')
  await page.waitForSelector('[data-case="inline"] iframe:not([aria-hidden="true"])')
  // Successful child rendering never grants parent DOM, storage, or native API.
  await page.evaluate(origin => window.__GUI__.setHTML(`<pre id="security"></pre><script>
    const results={};for(const [name,fn] of Object.entries({parent:()=>parent.document.body,storage:()=>localStorage.length,cookie:()=>document.cookie,native:()=>top.aivoryDesktop})){try{fn();results[name]='allowed'}catch{results[name]='blocked'}}
    document.getElementById('security').textContent=JSON.stringify(results);
    fetch('${origin}/__gui_probe?fetch').catch(()=>{});new WebSocket('ws://'+new URL('${origin}').host+'/__gui_probe?socket');
    </script><img src="${origin}/__gui_probe?image"><link rel="stylesheet" href="${origin}/__gui_probe?css">`), origin)
  content = await inner('#security')
  const result = JSON.parse(await content.$eval('#security', e => e.textContent))
  for (const name of ['parent', 'storage', 'cookie', 'native']) assert.equal(result[name], 'blocked', name)
  await page.evaluate(origin => window.__GUI__.setHTML(`<p id="navigation">Navigation blocked</p><script>setTimeout(()=>location.href='${origin}/__gui_probe?navigation',100)</script>`), origin)
  await inner('#navigation')
  await new Promise(r => setTimeout(r, 400))
  await page.evaluate(origin => window.__GUI__.setHTML(`<p id="form">No forms or popups</p><form action="${origin}/__gui_probe?form" method="get"><input name="q" value="private"></form><script>document.querySelector('form').submit();window.open('${origin}/__gui_probe?popup');</script>`), origin)
  await inner('#form')
  await new Promise(r => setTimeout(r, 400))
  for (const navigation of ['blob', 'data']) {
    await page.evaluate(({ origin, navigation }) => {
      const payload = `<script>fetch('${origin}/__gui_probe?${navigation}-escape').catch(()=>{})</script>`
      const encoded = JSON.stringify(payload).replace(/</g, '\\u003c')
      const target = navigation === 'blob' ? `URL.createObjectURL(new Blob([payload],{type:'text/html'}))` : `'data:text/html;base64,'+btoa(payload)`
      window.__GUI__.setHTML(`<p id="escape">${navigation}</p><script>const payload=${encoded};setTimeout(()=>location.href=${target},100)</script>`)
    }, { origin, navigation })
    await inner('#escape')
    await new Promise(r => setTimeout(r, 500))
  }
  assert.equal(probes, 0, 'generated HTML sent a network request')
  // Direct administrator command appears without any personal skill row.
  await page.click('[data-case="composer"] .tiptap')
  await page.keyboard.type('/generative-ui')
  await new Promise(r => setTimeout(r, 800))
  await page.waitForFunction(() => [...document.querySelectorAll('[cmdk-item], [role="option"], button')].some(e => e.textContent.includes('generative-ui')), { timeout: 15000 })
  const button = await page.evaluateHandle(() => [...document.querySelectorAll('[role="option"]')].find(e => e.textContent.includes('generative-ui')))
  await button.asElement().click()
  await page.keyboard.type('Visualize usage')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__SUBMITTED_SKILLS__)
  assert.deepEqual(await page.evaluate(() => window.__SUBMITTED_SKILLS__), ['catalog:sk_visual'])
  await page.evaluate(() => window.__GUI__.setHTML('<style>input{width:100%;background:var(--color-bg-muted);color:var(--color-fg)}</style><label for="n">Quantity</label><input id="n" value="10">'))
  await inner('#n')
  await mkdir('/tmp/aivory-generative-ui', { recursive: true })
  for (const width of [360, 768, 1280]) {
    await page.setViewport({ width, height: 900 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') }, theme)
      await inner('#n')
      for (const locale of ['en', 'zh', 'zh-Hant', 'ja', 'fr']) {
        await page.evaluate(locale => window.__GUI__.setLanguage(locale), locale)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${theme}/${locale} overflows`)
      }
      assert.equal(await page.$eval('[data-case="advanced"] [data-generative-checklist] ul', e => getComputedStyle(e).listStyleType), 'none')
      assert.equal(await page.$eval('[data-case="advanced"] [data-generative-calculator] h3', e => getComputedStyle(e).fontSize), '14px')
      assert.equal(await page.$eval('[data-case="advanced"] .gui-blocks', e => getComputedStyle(e).rowGap), '24px')
      assert.equal(await page.$eval('[data-case="form-preview"] input[type="date"]', e => getComputedStyle(e).colorScheme), theme, 'native date/radio/checkbox controls must follow the app theme')
      await page.$eval('[data-case="rich-table"]', e => e.scrollIntoView({ block: 'start' }))
      const table = await page.$eval('[data-case="rich-table"] [data-generative-table]', e => ({ width: e.clientWidth, scrollWidth: e.scrollWidth }))
      assert(table.scrollWidth > table.width, 'Wide rich table must scroll internally')
      for (const selector of ['[data-case="rich-table"]', '[data-case="private-table"]']) {
        await page.$eval(selector, e => e.scrollIntoView({ block: 'start' }))
        await page.waitForFunction(sel => [...document.querySelectorAll(`${sel} img`)].every(e => e.complete && e.naturalWidth > 0), {}, selector)
        const sizes = await page.$$eval(`${selector} img`, images => images.map(e => {
          const image = e.getBoundingClientRect(), cell = e.closest('td').getBoundingClientRect()
          return { width: image.width, height: image.height, cellWidth: cell.width, fit: getComputedStyle(e).objectFit, referrer: e.referrerPolicy, lazy: e.loading }
        }))
        for (const size of sizes) {
          assert(size.width > 0 && size.width <= 120 && size.height <= 90 && size.width <= size.cellWidth, JSON.stringify(size))
          assert.equal(size.fit, 'contain')
          assert.equal(size.referrer, 'no-referrer')
          assert.equal(size.lazy, 'lazy')
        }
      }
      await page.$eval('[data-case="rich-table"]', e => e.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: `/tmp/aivory-generative-ui/table-${width}-${theme}.png` })
      for (const selector of ['[data-case="cards"]', '[data-case="private-cards"]']) {
        await page.$eval(selector, e => e.scrollIntoView({ block: 'start' }))
        await page.waitForFunction(sel => document.querySelectorAll(`${sel} img`).length === 2 && [...document.querySelectorAll(`${sel} img`)].every(e => e.complete && e.naturalWidth > 0), {}, selector)
        assert(await page.$$eval(`${selector} [data-generative-card]`, cards => cards.every(e => {
          const card = e.getBoundingClientRect(), container = e.closest('[data-generative-ui]').getBoundingClientRect()
          return card.width > 0 && card.left >= container.left && card.right <= container.right
        })), 'cards must fit both normal and private responses')
        assert(await page.$$eval(`${selector} .gui-card-link`, links => links.every(e => {
          const link = e.getBoundingClientRect(), card = e.closest('[data-generative-card]').getBoundingClientRect()
          return link.left >= card.left && link.right <= card.right && e.scrollWidth <= e.clientWidth + 1
        })), 'long link labels must wrap within the card')
        assert(await page.$$eval(`${selector} img`, images => images.every(e => {
          const image = e.getBoundingClientRect(), card = e.closest('[data-generative-card]').getBoundingClientRect()
          return image.width <= card.width && image.height <= 128 && getComputedStyle(e).objectFit === 'contain' && e.referrerPolicy === 'no-referrer' && e.loading === 'lazy'
        })), 'card images must fit without cropping or exposing the conversation referrer')
      }
      await page.$eval('[data-case="cards"]', e => e.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: `/tmp/aivory-generative-ui/cards-${width}-${theme}.png` })
      for (const [name, selector] of [['function', '[data-generative-function]'], ['calculator', '[data-generative-calculator]'], ['charts', '[data-generative-chart="donut"]']]) {
        await page.$eval(`[data-case="advanced"] ${selector}`, e => e.scrollIntoView({ block: 'start' }))
        await new Promise(resolve => setTimeout(resolve, 100))
        await page.screenshot({ path: `/tmp/aivory-generative-ui/${name}-${width}-${theme}.png` })
      }
      await page.$eval('[data-case="function-fragment"]', node => node.scrollIntoView({ block: 'start' }))
      assert(await page.$$eval('[data-case="function-fragment"] [data-function-path]', nodes => nodes.every(node => node.getAttribute('d')?.length > 20)), 'standalone functions must render at every screen size')
      await page.screenshot({ path: `/tmp/aivory-generative-ui/function-fragment-${width}-${theme}.png` })
      await page.$eval('[data-case="questions"]', e => e.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: `/tmp/aivory-generative-ui/questions-${width}-${theme}.png` })
      await page.$eval('[data-case="form-preview"]', e => e.scrollIntoView({ block: 'start' }))
      assert(await page.$$eval('[data-case="form-preview"] input, [data-case="form-preview"] select, [data-case="form-preview"] textarea', controls => controls.every(e => {
        const box = e.getBoundingClientRect(), container = e.closest('[data-generative-form]').getBoundingClientRect()
        return box.width > 0 && box.left >= container.left - 1 && box.right <= container.right + 1
      })), 'form controls must fit the response')
      await page.screenshot({ path: `/tmp/aivory-generative-ui/form-${width}-${theme}.png` })
      await new Promise(r => setTimeout(r, 400))
      const themedFrame = await inner('#n')
      assert(await themedFrame.$eval('#n', e => e.getBoundingClientRect().width > 0))
      await page.$eval('[data-case="inline"]', e => e.scrollIntoView({ block: 'center' }))
      await new Promise(r => setTimeout(r, 100))
      await page.screenshot({ path: `/tmp/aivory-generative-ui/${width}-${theme}.png`, fullPage: true })
    }
  }
  assert(imageRequests.some(req => req.url.endsWith('/app.png')), 'External table image was never requested')
  assert(imageRequests.every(req => !req.headers.referer), 'External table images must not receive the conversation referrer')
  assert.deepEqual(errors, [])
  console.log('PASS: cards/images/safe links/normal and private replies, calculator validation/recalculation/reset, native forms/validation/label serialization/retry/double-submit guards, clarification single/multi/custom answers, streaming/read-only/history states, private-chat question and form continuation, charts/scatter, table filtering/sorting, editable functions, checklist/quiz, keyboard interaction, HTML recovery/isolation, slash command, 30 responsive/theme/language combinations')
} finally {
  await browser?.close()
  server.httpServer?.closeAllConnections()
  await server.close()
}

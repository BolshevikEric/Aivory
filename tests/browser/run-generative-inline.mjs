import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
if (!executablePath) throw new Error('Set CHROME_PATH')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
const directory = '/tmp/aivory-generative-inline'
let browser
try {
  await mkdir(directory, { recursive: true })
  await server.listen()
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) { void request.respond({ status: 200, contentType: 'application/json', body: '[]' }); return }
    void request.continue()
  })
  await page.setViewport({ width: 1280, height: 1000 })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/generative-ui-harness.html?interleaved`)
  const normal = '[data-case="interleaved"]'
  for (const scope of [normal, '[data-case="interleaved-private"]']) {
    await page.waitForSelector(`${scope} h2 .gui-markup-badge`)
    assert.equal(await page.$eval(`${scope} h2 .gui-markup-badge`, node => node.textContent), 'Available')
    assert.equal(await page.$eval(`${scope} ol`, node => node.start), 3)
    assert.equal(await page.$$eval(`${scope} ol li`, nodes => nodes.length), 2)
    assert.equal(await page.$eval(`${scope} blockquote .gui-markup-badge`, node => node.textContent), 'Example')
    assert.equal(await page.$$eval(`${scope} tbody tr`, nodes => nodes.length), 2)
    assert.equal(await page.$eval(`${scope} p code`, node => node.textContent), '<button>Example</button>')
    assert.equal(await page.$$eval(`${scope} .katex`, nodes => nodes.length), 1)
    assert.equal(await page.$$eval(`${scope} p article`, nodes => nodes.length), 0, 'Block components are outside paragraph containers')
    assert.equal(await page.$eval(`${scope} article a`, node => node.textContent), 'View details')
  }
  await page.select(`${normal} select`, 'Pro')
  await page.click(`${normal} button.gui-markup-button`)
  await page.waitForFunction(() => window.__INTERLEAVED_REPLY__ === 'Compare the Pro plan for my usage')
  await page.$eval(`${normal} input[type="range"]`, node => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '5')
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.ok((await page.$eval(normal, node => node.textContent)).includes('Total: 60 USD'), 'The complete UI fence retains independent local state')
  for (const width of [360, 768, 1280]) {
    await page.setViewport({ width, height: 1000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark') }, theme)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      for (const scope of [normal, '[data-case="interleaved-private"]']) {
        const invalid = await page.$$eval(`${scope} .gui-markup-badge, ${scope} .gui-markup-button`, nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length)
        assert.equal(invalid, 0, 'Inline labels and commands fit their containers')
      }
      await (await page.$(normal)).screenshot({ path: `${directory}/inline-${width}-${theme}.png` })
    }
  }
  await page.evaluate(() => { window.__GUI__.setLive(true); window.__GUI__.setMarkup('A streamed response <badge>Ready</badge> with <button prompt="Continue">Continue</button>.') })
  await page.waitForFunction(() => {
    const scope = document.querySelector('[data-case="interleaved"]')
    return scope.textContent.includes('A streamed response') && scope.querySelector('button')?.disabled
  })
  await page.evaluate(() => window.__GUI__.setLive(false))
  await page.waitForFunction(() => !document.querySelector('[data-case="interleaved"] button').disabled)

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/generative-ui-harness.html?weekly`)
  const privateScope = '[data-case="interleaved-private"]'
  const progress = scope => page.$eval(scope, node => Array.from(node.querySelectorAll('p')).find(element => element.textContent.startsWith('Progress:'))?.textContent)
  const expectedProgress = (first = false, fourth = false) => `Progress: Week 1 ${first ? '\u2705' : '\u25cb'} / Week 2 \u25cb / Week 3 \u25cb / Week 4 ${fourth ? '\u2705' : '\u25cb'}`
  await page.waitForSelector(`${normal} input[name$="-w1c"]`)
  for (const scope of [normal, privateScope]) assert.equal(await progress(scope), expectedProgress())
  await page.click(`${normal} input[name$="-w1c"]`)
  assert.equal(await progress(normal), expectedProgress(true))
  await page.click(`${normal} [role="tab"]:nth-child(4)`)
  await page.click(`${normal} input[name$="-w4c"]`)
  assert.equal(await progress(normal), expectedProgress(true, true))
  await page.click(`${normal} [role="tab"]:nth-child(1)`)
  assert.equal(await page.$eval(`${normal} input[name$="-w1c"]`, node => node.checked), true, 'Switching tabs preserves checkbox state')
  assert.equal(await progress(privateScope), expectedProgress(), 'Private and ordinary replies have independent state')
  await page.click(`${privateScope} input[name$="-w1c"]`)
  assert.equal(await progress(privateScope), expectedProgress(true))
  assert.equal(await progress(normal), expectedProgress(true, true))

  await page.evaluate(async () => {
    const fixture = await import('/tests/frontend/fixtures/generative-inline.ts')
    window.__GUI__.setMarkup(fixture.weeklyProgressControls)
  })
  await page.waitForFunction(() => !document.querySelector('[data-case="interleaved"]').textContent.includes('Progress:'))
  assert.equal(await page.$eval(`${normal} input[name$="-w1c"]`, node => node.checked), true)
  await page.evaluate(async () => {
    const fixture = await import('/tests/frontend/fixtures/generative-inline.ts')
    window.__GUI__.setLive(true)
    window.__GUI__.setMarkup(fixture.weeklyProgress)
  })
  await page.waitForFunction(() => document.querySelector('[data-case="interleaved"]').textContent.includes('Research card'))
  assert.equal(await progress(normal), expectedProgress(true, true), 'Appending a dependent summary preserves the existing control state')
  assert.equal(await page.$eval(`${normal} input[name$="-w1c"]`, node => node.disabled), true)
  await page.evaluate(() => window.__GUI__.setLive(false))
  await page.waitForFunction(() => !document.querySelector('[data-case="interleaved"] input[name$="-w1c"]').disabled)
  await page.click(`${normal} input[name$="-w1c"]`)
  assert.equal(await progress(normal), expectedProgress(false, true))
  for (const width of [360, 1280]) {
    await page.setViewport({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await (await page.$(normal)).screenshot({ path: `${directory}/weekly-progress-${width}.png` })
  }

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/generative-ui-harness.html?robustness`)
  await page.waitForSelector(`${normal} .gui-markup-badge`)
  for (const scope of [normal, privateScope]) {
    assert.equal(await page.$eval(`${scope} .gui-markup-badge`, node => node.textContent), 'Available')
    assert.ok((await page.$eval(scope, node => node.textContent)).includes('Result: Pending'))
    assert.equal(await page.$$eval(`${scope} script,${scope} style,${scope} iframe,${scope} foreignObject,${scope} [onclick],${scope} [onload],${scope} .invented-layout`, nodes => nodes.length), 0)
    assert.equal(await page.$$eval(`${scope} svg rect`, nodes => nodes.length), 1)
  }
  assert.equal(await page.evaluate(() => window.__UNSAFE_GUI__), undefined)
  await page.click(`${normal} input[type="checkbox"]`)
  await page.waitForFunction(() => document.querySelector('[data-case="interleaved"]').textContent.includes('Result: Complete'))
  await page.click(`${normal} .gui-markup-button`)
  await page.waitForFunction(() => window.__INTERLEAVED_REPLY__ === 'Review true')
  assert.equal(await page.$eval(`${privateScope} input[type="checkbox"]`, node => node.checked), false)

  await page.reload()
  await page.waitForSelector(`${normal} input[type="checkbox"]`)
  await page.evaluate(async () => {
    const fixture = await import('/tests/frontend/fixtures/generative-robustness.ts')
    window.__GUI__.setMarkup(fixture.evolvingState)
  })
  await page.waitForFunction(() => document.querySelector('[data-case="interleaved"]').textContent.includes('Notes: Draft'))
  await page.click(`${normal} input[type="checkbox"]`)
  await page.$eval(`${normal} input[name="notes"]`, node => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, 'Revised')
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(() => document.querySelector('[data-case="interleaved"]').textContent.includes('Notes: Revised'))
  assert.equal(await page.$eval(`${normal} code`, node => node.textContent), '{done}')
  assert.equal(await page.$eval(`${normal} [data-latex]`, node => node.getAttribute('data-latex')), 'x_{done}')
  assert.ok((await page.$eval(normal, node => node.textContent)).includes('{done} literal.'))
  for (const width of [360, 1280]) {
    await page.setViewport({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await (await page.$(normal)).screenshot({ path: `${directory}/recovered-state-${width}.png` })
  }
  await page.evaluate(() => {
    window.__GUI__.setLive(true)
    window.__GUI__.setMarkup('<card><text>Streaming prefix</text><button prompt="Continue">Continue</button><row title="a > b" gap={')
  })
  await page.waitForFunction(() => document.querySelector('[data-case="interleaved"] article')?.textContent.includes('Streaming prefix'))
  assert.equal(await page.$eval(`${normal} .gui-markup-button`, node => node.disabled), true)
  await page.evaluate(() => { window.__GUI__.setLive(false); window.__GUI__.setMarkup('<card><text>Streaming prefix</text><button prompt="Continue">Continue</button><row title="a > b" gap={2}></row></card>') })
  await page.waitForFunction(() => !document.querySelector('[data-case="interleaved"] .gui-markup-button').disabled)
  await page.evaluate(() => window.__GUI__.setMarkup('<box gap={broken(><text>Preserved source</text></box>'))
  await page.waitForSelector(`${normal} pre code`)
  assert.ok((await page.$eval(`${normal} pre code`, node => node.textContent)).includes('Preserved source'))
  assert.equal(await page.$$eval(`${normal} box,${normal} text`, nodes => nodes.length), 0)
  await page.evaluate(() => window.__GUI__.setMarkup('<tabs><tab title="First">First</tab><tab title="Second">Second</tab></tabs>'))
  await page.waitForSelector(`${normal} [role="tab"]:nth-child(2)`)
  await page.click(`${normal} [role="tab"]:nth-child(2)`)
  await page.evaluate(() => window.__GUI__.setMarkup('<tabs><tab title="Only">Only remaining panel</tab></tabs>'))
  await page.waitForFunction(() => document.querySelector('[data-case="interleaved"] [role="tabpanel"]:not([hidden])')?.textContent.trim() === 'Only remaining panel')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ screenshots: directory, viewports: 10, interactions: 'mixed prose, weekly progress, tabs, independent groups, unknown tag recovery, literal code/math, evolving state, follow-ups, malformed source and streaming passed' }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

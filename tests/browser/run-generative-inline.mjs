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
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ screenshots: directory, viewports: 6, interactions: 'mixed prose, headings, lists, quotes, tables, code, math, shared state, independent fences, follow-ups and streaming passed' }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

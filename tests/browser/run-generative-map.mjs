import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
if (!executablePath) throw new Error('Set CHROME_PATH')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
const directory = '/tmp/aivory-generative-map'
let browser
try {
  await mkdir(directory, { recursive: true })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(30_000)
  const image = await readFile(new URL('../../public/icon-512.png', import.meta.url))
  const lookups = [], errors = [], tiles = []
  let retryAttempts = 0
  await page.setRequestInterception(true)
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => { if (response.url().includes('tile.openstreetmap.de') && response.ok()) tiles.push(response.url()) })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'images.example.test') { void request.respond({ status: 200, contentType: 'image/png', body: image }); return }
    if (url.pathname === '/api/public/maps/config') { void request.respond({ status: 200, contentType: 'application/json', body: '{"provider":"osm","configured":true}' }); return }
    if (url.pathname === '/api/public/maps/geocode') {
      const query = url.searchParams.get('q')
      lookups.push(query)
      if (query === 'Retry' && ++retryAttempts === 1) { void request.respond({ status: 502, contentType: 'application/json', body: '{"error":"unavailable"}' }); return }
      const location = query === 'Missing' ? null : { lat: 48 + lookups.indexOf(query) * .003, lng: 2 + lookups.indexOf(query) * .005, label: query }
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ location }) }); return
    }
    if (url.pathname.startsWith('/api/')) { void request.respond({ status: 200, contentType: 'application/json', body: '[]' }); return }
    void request.continue()
  })
  await page.setViewport({ width: 1280, height: 1100 })
  await page.goto(`${origin}/tests/browser/generative-ui-harness.html?maps`)
  const scope = '[data-case="map"]'
  await page.waitForFunction(() => document.querySelectorAll('[data-case="map"] .gui-map-marker').length === 8)
  assert.equal(lookups.length, 8, 'The complete synthetic address list was resolved')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-case="map"] img.leaflet-tile')].some(image => image.complete && image.naturalWidth > 0), { timeout: 25_000 })
  assert.ok(tiles.length > 0, 'Real basemap tiles loaded')
  await page.click(`${scope} .gui-map-points li:nth-child(3) button`)
  assert.equal(await page.$eval(`${scope} .gui-map-points li:nth-child(3) button`, node => node.getAttribute('aria-pressed')), 'true')
  assert.equal(await page.$$eval(`${scope} .gui-map-marker.is-selected`, nodes => nodes.length), 1)
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-case="map"] .gui-map-canvas').getBoundingClientRect()
    const marker = document.querySelector('[data-case="map"] .gui-map-marker.is-selected').getBoundingClientRect()
    return Math.abs(marker.left + marker.width / 2 - canvas.left - canvas.width / 2) < 2 && Math.abs(marker.top + marker.height / 2 - canvas.top - canvas.height / 2) < 2
  })
  const zoom = await page.$$eval(`${scope} img.leaflet-tile`, nodes => Math.max(...nodes.map(node => Number(new URL(node.src).pathname.split('/').at(-3)))))
  await page.click(`${scope} .gui-map-controls button:first-child`)
  await page.waitForFunction(previous => [...document.querySelectorAll('[data-case="map"] img.leaflet-tile')].some(node => Number(new URL(node.src).pathname.split('/').at(-3)) > previous), {}, zoom)
  await page.click(`${scope} .gui-map-controls button:last-child`)
  for (const width of [360, 768, 1280]) {
    await page.setViewport({ width, height: 1100 })
    await page.click(`${scope} .gui-map-controls button:last-child`)
    await page.waitForFunction(() => {
      const surface = document.querySelector('[data-case="map"] .gui-map-canvas').getBoundingClientRect()
      const images = [...document.querySelectorAll('[data-case="map"] img.leaflet-tile')].filter(image => {
        const box = image.getBoundingClientRect()
        return box.left < surface.right && box.right > surface.left && box.top < surface.bottom && box.bottom > surface.top
      })
      return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)
    }, { timeout: 25_000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark') }, theme)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      const box = await page.$eval(`${scope} .gui-map-canvas`, node => ({ width: node.clientWidth, height: node.clientHeight }))
      assert.ok(box.width >= 280 && box.height === 340)
      await (await page.$(scope)).screenshot({ path: `${directory}/map-${width}-${theme}.png` })
    }
  }
  await page.evaluate(() => window.__GUI__.setMarkup('<state name="count" value={1}/><slider name="count" label="Count" value={1}/><map><map-point address="Missing"/><map-point address="Retry"/><map-point name="Direct" lat={48} lng={2}><card title="Nested detail"><svg viewBox="0 0 32 24"><path d="M2 20L16 4L30 20"/></svg><button prompt="Explain this place">Ask</button></card></map-point></map>'))
  await page.waitForSelector(`${scope} .gui-map-status button`)
  assert.ok((await page.$eval(`${scope} .gui-map`, node => node.textContent)).includes('Address not matched'))
  await page.click(`${scope} .gui-map-status button`)
  await page.waitForFunction(() => document.querySelectorAll('[data-case="map"] .gui-map-marker').length === 2)
  assert.equal(lookups.filter(query => query === 'Missing').length, 1, 'Retry only repeats failed requests')
  const beforeLocalChange = lookups.length
  await page.$eval(`${scope} input[type="range"]`, node => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(node, '8'); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })) })
  await page.click(`${scope} .gui-map-points li:nth-child(3) button`)
  await page.waitForSelector(`${scope} .gui-map-detail article svg path`)
  await page.click(`${scope} .gui-map-detail button`)
  await page.waitForFunction(() => window.__MAP_REPLY__ === 'Explain this place')
  assert.equal(lookups.length, beforeLocalChange)
  assert.equal(await page.$$eval('[data-case="map-private"] .gui-map-marker', nodes => nodes.length), 2)
  await page.click('[data-case="map-private"] .gui-map-points li:nth-child(2) button')
  assert.equal(await page.$eval('[data-case="map-private"] .gui-map-detail a', node => node.textContent), 'Open station')
  await page.evaluate(() => { window.__GUI__.setLive(true); window.__GUI__.setMarkup('<map><map-point address="Streaming address"/></map>') })
  await page.waitForSelector(`${scope} .gui-map-placeholder`)
  assert.equal(lookups.includes('Streaming address'), false, 'Streaming markup makes no geocoding requests')
  await page.evaluate(() => window.__GUI__.setLive(false))
  await page.waitForFunction(() => document.querySelectorAll('[data-case="map"] .gui-map-marker').length === 1)
  assert.equal(lookups.filter(query => query === 'Streaming address').length, 1)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ screenshots: directory, lookups: lookups.length, basemapTiles: tiles.length, viewports: 6, interactions: 'markers, zoom, fit, nested details, private replies, local state, retry and streaming passed' }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}

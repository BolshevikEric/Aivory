import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!chrome) throw new Error('Chrome is required')
const output = '/tmp/aivory-amap'
// Exercise our SDK boundary without vendor credentials or real user locations.
const sdk = `
window.__AMAP_TEST__ = { actions: [], positions: [], destroyed: 0 };
class TestMap {
  constructor(element) {
    this.element = element; this.zoom = 12; this.markers = [];
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 340;
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e4eadf'; ctx.fillRect(0, 0, 800, 340);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 12;
    for (let x = 40; x < 800; x += 90) { ctx.beginPath();ctx.moveTo(x, 0);ctx.lineTo(x + 45, 340);ctx.stroke() }
    ctx.beginPath();ctx.moveTo(0, 170);ctx.lineTo(800, 140);ctx.stroke();element.append(canvas);
  }
  on(event, action) { if(event === 'complete') setTimeout(action, 20) }
  getZoom() { return this.zoom }
  zoomIn() { this.zoom++;window.__AMAP_TEST__.actions.push('zoomIn') }
  zoomOut() { this.zoom--;window.__AMAP_TEST__.actions.push('zoomOut') }
  setFitView() { window.__AMAP_TEST__.actions.push('fit') }
  setZoomAndCenter(zoom, center) { this.zoom = zoom;window.__AMAP_TEST__.actions.push(['select', center]) }
  destroy() { this.element.replaceChildren();window.__AMAP_TEST__.destroyed++ }
}
class TestMarker {
  constructor(options) { this.options = options;window.__AMAP_TEST__.positions.push(options.position) }
  setMap(map) {
    if (this.map) this.options.content.remove();this.map = map;
    if (map) { const n = map.markers.length;map.markers.push(this);this.options.content.style.cssText = 'position:absolute;left:'+(30+n*12)+'%;top:'+(40+n%2*12)+'%';map.element.append(this.options.content) }
  }
}
window.AMap = { Map: TestMap, Marker: TestMarker, Pixel: class Pixel {} };
window.___onAPILoaded();
`
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
let settings = { map_provider: 'osm', sandbox_configured: true, image_model_configured: true }
let mapConfig = { provider: 'amap', configured: true, js_api_key: 'js-test-key' }
let configUnavailable = false, sdkUnavailable = false
const requests = [], patches = [], errors = []
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(25000)
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'webapi.amap.com') {
      requests.push(url.href)
      void request.respond({ status: sdkUnavailable ? 503 : 200, contentType: 'application/javascript', body: sdkUnavailable ? '' : sdk }); return
    }
    if (url.pathname === '/api/public/maps/config') { void request.respond({ status: configUnavailable ? 503 : 200, contentType: 'application/json', body: JSON.stringify(mapConfig) }); return }
    if (url.pathname === '/api/public/maps/geocode') {
      requests.push(url.href)
      assert.ok(['amap', 'osm'].includes(url.searchParams.get('provider')))
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ location: { lat: 30, lng: 100, coordinate_system: url.searchParams.get('provider') === 'amap' ? 'gcj02' : 'wgs84', label: 'Example Plaza' } }) }); return
    }
    if (url.pathname === '/api/admin/settings') {
      if (request.method() === 'PATCH') {
        patches.push(JSON.parse(request.postData()))
        settings = { ...settings, ...patches.at(-1) }
        for (const key of ['map_amap_web_api_key', 'map_amap_js_api_key', 'map_amap_security_secret']) if (settings[key]) settings[key] = '••••••'
      }
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }); return
    }
    if (url.pathname.startsWith('/api/')) { void request.respond({ status: 200, contentType: 'application/json', body: '[]' }); return }
    void request.continue()
  })
  for (const width of [390, 1280]) {
    for (const theme of ['light', 'dark']) {
      settings = { map_provider: 'osm', sandbox_configured: true, image_model_configured: true }
      await page.setViewport({ width, height: 1000 })
      await page.goto(`${origin}/tests/browser/admin-tables-harness.html?view=tools&theme=${theme}&lang=zh`)
      await page.waitForSelector('#map-provider')
      assert.equal(await page.$('#map-amap-web-key'), null)
      await page.click('#map-provider')
      await page.waitForSelector('[role="option"][data-state="unchecked"]')
      await page.$$eval('[role="option"]', nodes => nodes.find(node => node.textContent === '高德地图').click())
      await page.waitForSelector('#map-amap-web-key')
      await page.waitForFunction(() => !document.querySelector('[role="listbox"]'))
      await page.type('#map-amap-web-key', 'web-test-key')
      await page.type('#map-amap-js-key', 'js-test-key')
      await page.type('#map-amap-security-code', 'security-test-code')
      assert.deepEqual(await page.$$eval('#map-amap-web-key,#map-amap-js-key,#map-amap-security-code', nodes => nodes.map(node => node.value)), ['web-test-key', 'js-test-key', 'security-test-code'])
      await page.$$eval('button', nodes => nodes.find(node => node.textContent.trim() === '保存').click())
      await page.waitForFunction(() => document.querySelector('#map-amap-web-key')?.value === '••••••')
      assert.equal(patches.at(-1).map_provider, 'amap')
      assert.equal(patches.at(-1).map_amap_web_api_key, 'web-test-key')
      assert.equal(patches.at(-1).map_amap_js_api_key, 'js-test-key')
      assert.equal(patches.at(-1).map_amap_security_secret, 'security-test-code')
      await page.$eval('#map-provider', node => node.scrollIntoView({ block: 'center' }))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      await page.screenshot({ path: `${output}/admin-${width}-${theme}.png` })
    }
  }
  const scope = '[data-case="map"]'
  await page.goto(`${origin}/tests/browser/generative-ui-harness.html?maps`)
  await page.waitForFunction(() => Boolean(window.__GUI__))
  await page.evaluate(() => window.__GUI__.setMarkup('<map title="Example places"><map-point name="Address" address="Example Plaza"><button prompt="Explain the plaza">Ask</button></map-point><map-point name="GPS grid point" lat={30} lng={100}/><map-point name="Native grid point" lat={30} lng={100} coordinate-system="gcj02"/></map>'))
  await page.waitForFunction(() => document.querySelectorAll('[data-case="map"] .gui-amap-marker').length === 3)
  assert.equal(await page.$eval(`${scope} .gui-map-external`, node => new URL(node.href).hostname), 'uri.amap.com')
  assert.equal(await page.$eval(`${scope} .gui-map-source`, node => node.textContent), 'AMap')
  const positions = await page.evaluate(() => window.__AMAP_TEST__.positions)
  assert.ok(positions.some(([lng, lat]) => lng === 100 && lat === 30), 'Native AMap coordinates keep their position')
  assert.ok(positions.some(([lng, lat]) => lng !== 100 && lat !== 30 && Math.abs(lng - 100) < .01), 'GPS coordinates are converted')
  await page.click(`${scope} .gui-map-points li:nth-child(2) button`)
  assert.equal(await page.$$eval(`${scope} .gui-amap-marker.is-selected`, nodes => nodes.length), 1)
  await page.click(`${scope} .gui-map-marker:first-of-type`)
  for (const index of [1, 2, 3]) await page.click(`${scope} .gui-map-controls button:nth-child(${index})`)
  assert.ok((await page.evaluate(() => window.__AMAP_TEST__.actions)).includes('zoomIn'))
  assert.ok((await page.evaluate(() => window.__AMAP_TEST__.actions)).includes('zoomOut'))
  assert.deepEqual(await page.evaluate(() => window._AMapSecurityConfig), { serviceHost: `${origin}/api/public/maps/_AMapService` })
  for (const width of [390, 1280]) {
    await page.setViewport({ width, height: 1000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme)
      const metrics = await page.$eval(`${scope} canvas`, canvas => ({ pixels: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data], width: canvas.clientWidth }))
      assert.equal(metrics.pixels[3], 255)
      assert.ok(metrics.width > 280)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      await (await page.$(scope)).screenshot({ path: `${output}/mock-sdk-${width}-${theme}.png` })
    }
  }
  mapConfig = { provider: 'amap', configured: false }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector(`${scope} .gui-map-placeholder button`)
  const beforeMisconfigured = requests.length
  await page.click(`${scope} .gui-map-placeholder button`)
  await page.waitForFunction(() => !document.querySelector('[data-case="map"] .gui-amap-marker'))
  assert.equal(requests.length, beforeMisconfigured, 'Missing credentials make no geocoding or SDK requests')
  mapConfig = { provider: 'amap', configured: true, js_api_key: 'js-test-key' }
  await page.click(`${scope} .gui-map-placeholder button`)
  await page.waitForFunction(() => document.querySelectorAll('[data-case="map"] .gui-amap-marker').length === 3)
  configUnavailable = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector(`${scope} .gui-map-placeholder button`)
  configUnavailable = false
  await page.click(`${scope} .gui-map-placeholder button`)
  await page.waitForFunction(() => document.querySelectorAll('[data-case="map"] .gui-amap-marker').length === 3)
  // A failed SDK load must be retryable without reloading the page.
  sdkUnavailable = true
  await page.reload()
  await page.waitForSelector(`${scope} .gui-map-notice button`)
  sdkUnavailable = false
  await page.click(`${scope} .gui-map-notice button`)
  await page.waitForSelector(`${scope} .gui-amap-marker`)
  mapConfig = { provider: 'osm', configured: true }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector(`${scope} .leaflet-container`)
  assert.equal(await page.$eval(`${scope} .gui-map-external`, node => new URL(node.href).hostname), 'www.google.com')
  mapConfig = { provider: 'amap', configured: true, js_api_key: 'js-test-key' }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector(`${scope} .gui-amap-marker`)
  mapConfig = { provider: 'amap', configured: true, js_api_key: 'replacement-js-test-key' }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector(`${scope} .gui-map-notice button[aria-label="Reload"]`)
  await page.click(`${scope} .gui-map-notice button`)
  await page.waitForSelector(`${scope} .gui-amap-marker`)
  assert.ok(requests.every(url => !/photon|openstreetmap|google/.test(url)))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ screenshots: output, adminSaves: patches.length, sdk: 'mocked; live credentials required for vendor validation', assertions: 'provider selection, masked save, markers, coordinate conversion, zoom/fit, proxy config, retries, responsive layout' }, null, 2))
} catch (error) {
  await (await browser?.pages())?.at(-1)?.screenshot({ path: `${output}/failure.png` })
  throw error
} finally {
  await browser?.close()
  await server.close()
}

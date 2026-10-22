import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!chrome) throw new Error('Chrome is required')
const output = '/tmp/aivory-web-providers'
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
const errors = [], patches = []
let settings, browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/admin/settings') {
      if (request.method() === 'PATCH') {
        const patch = JSON.parse(request.postData())
        patches.push(patch)
        settings = { ...settings, ...patch }
        for (const key of ['search_api_key', 'fetch_api_key']) if (settings[key]) settings[key] = '••••••'
      }
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      void request.respond({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }
    void request.continue()
  })
  const select = async (id, label) => {
    await page.$eval(id, node => node.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await page.click(id)
    await page.waitForSelector('[role="option"]')
    const found = await page.$$eval('[role="option"]', (nodes, text) => {
      const option = nodes.find(node => node.textContent.trim() === text)
      option?.click()
      return Boolean(option)
    }, label)
    assert.ok(found, `Missing option ${label}`)
    await page.waitForFunction(() => !document.querySelector('[role="listbox"]'))
  }
  const save = async label => {
    const count = patches.length
    await page.$$eval('button', (nodes, text) => nodes.find(node => node.textContent.trim() === text).click(), label)
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(node => node.getAttribute('aria-busy') === 'true'))
    assert.equal(patches.length, count + 1)
  }
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'fr']) {
    const text = JSON.parse(readFileSync(`src/i18n/locales/${locale}/admin.json`, 'utf8'))
    const common = JSON.parse(readFileSync(`src/i18n/locales/${locale}/common.json`, 'utf8'))
    for (const width of [390, 1280]) {
      settings = { search_provider: 'duckduckgo', fetch_provider: 'builtin', fetch_jina_default_base_url: 'https://deployment-reader.example.test', sandbox_configured: true, image_model_configured: true }
      await page.setViewport({ width, height: 1000 })
      const url = `${origin}/tests/browser/admin-tables-harness.html?view=tools&lang=${locale}&theme=${width === 390 ? 'dark' : 'light'}`
      await page.goto(url)
      await page.waitForSelector('#fetch-jina-url')
      assert.equal(await page.$eval('#fetch-jina-url', node => node.placeholder), 'https://deployment-reader.example.test')
      await select('#search-provider', 'DeepSeek')
      await page.type('#search-key', 'search-test-key')
      await select('#fetch-provider', 'AnySearch')
      assert.equal(await page.$('#fetch-jina-url'), null)
      await page.type('#fetch-api-key', 'reader-test-key')
      await save(common.actions.save)
      assert.equal(patches.at(-1).search_provider, 'deepseek')
      assert.equal(patches.at(-1).fetch_provider, 'anysearch')
      assert.equal(patches.at(-1).search_api_key, 'search-test-key')
      assert.equal(patches.at(-1).fetch_api_key, 'reader-test-key')
      await page.reload()
      await page.waitForSelector('#fetch-api-key')
      assert.equal(await page.$eval('#fetch-api-key', node => node.value), '••••••')
      await select('#fetch-provider', 'DeepSeek')
      await save(common.actions.save)
      assert.equal(patches.at(-1).fetch_provider, 'deepseek')
      assert.equal(patches.at(-1).fetch_api_key, '••••••')
      await select('#fetch-provider', text.tools.fetchBuiltin)
      assert.equal(await page.$('#fetch-api-key'), null)
      await page.type('#fetch-jina-url', 'https://custom-reader.example.test')
      await select('#fetch-jina-mode', text.tools.fetchJinaModeRaw)
      await save(common.actions.save)
      assert.equal(patches.at(-1).fetch_jina_base_url, 'https://custom-reader.example.test')
      assert.equal(patches.at(-1).fetch_jina_url_mode, 'raw')
      assert.equal(patches.at(-1).search_provider, 'deepseek')
      assert.equal(Object.hasOwn(patches.at(-1), 'fetch_jina_default_base_url'), false)
      await page.reload()
      await page.waitForSelector('#fetch-jina-url')
      assert.equal(await page.$eval('#fetch-jina-url', node => node.value), 'https://custom-reader.example.test')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale}/${width}: horizontal overflow`)
      await page.$eval('#fetch-provider', node => node.closest('section').scrollIntoView({ block: 'center', behavior: 'instant' }))
      await page.screenshot({ path: `${output}/${locale}-${width}.png` })
    }
    console.log(`Search/reader independence, custom selects, save/reload and layout passed: ${locale}`)
  }
  assert.deepEqual(errors, [])
  console.log(`Web provider browser checks passed; screenshots: ${output}`)
} finally {
  await browser?.close()
  await server.close()
}

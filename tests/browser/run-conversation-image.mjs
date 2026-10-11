import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
if (!executablePath) throw new Error('Set CHROME_PATH')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
try {
  await server.listen()
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') console.log('Browser error:', message.text()) })
  page.setDefaultTimeout(60_000)
  await page.setRequestInterception(true)
  const shareRequests = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return request.continue()
    if (url.pathname.endsWith('/share')) {
      shareRequests.push(request.method())
      return request.respond({ status: 200, contentType: 'application/json', body: '{"share":null}' })
    }
    const body = url.pathname.startsWith('/api/notifications') ? '{"notifications":[],"total":0}' : '[]'
    request.respond({ status: 200, contentType: 'application/json', body })
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(`${origin}/tests/browser/conversation-image-harness.html`)
  await page.waitForSelector('[data-message-id="first-assistant"]')
  const item = async (label, selector = '[role="menuitem"]') => {
    await page.waitForFunction((text, sel) => Array.from(document.querySelectorAll(sel)).some(node => node.textContent.trim() === text), {}, label, selector)
    const handle = await page.evaluateHandle((text, sel) => Array.from(document.querySelectorAll(sel)).find(node => node.textContent.trim() === text), label, selector)
    if (!handle.asElement()) console.log('Available actions', await page.$$eval(selector, nodes => nodes.map(node => node.textContent)))
    assert(handle.asElement(), `Missing action ${label}`)
    return handle.asElement()
  }
  const openDesktopShare = async label => {
    await page.click('header button[aria-label="Conversation actions"]')
    await (await item('Share')).hover()
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="menuitem"]')).some(e => e.textContent.trim() === 'Share as image'))
    await (await item(label)).click()
  }
  await openDesktopShare('Share as link')
  await page.waitForSelector('[role="dialog"]')
  assert(shareRequests.includes('GET'), 'link sharing must keep the existing API')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  const composer = '[data-vt-composer] [contenteditable="true"]'
  await page.type(composer, 'Keep this composer draft')
  await openDesktopShare('Share as image')
  await page.waitForSelector('[data-image-share-toolbar]')
  assert.equal(await page.$$eval('[data-image-share-row] > input[type="checkbox"]', nodes => nodes.length), 5)
  assert.equal(await page.$$eval('[data-image-share-row] > input:checked', nodes => nodes.length), 0)
  await page.click('[data-image-share-row="first-user"] > input')
  await page.click('[data-image-share-row="first-assistant"] > input')
  await page.evaluate(() => window.__IMAGE_SHARE__.failNextCapture())
  const generate = await item('Generate image', '[data-image-share-toolbar] button')
  await generate.click()
  await page.waitForFunction(() => document.body.textContent.includes('Could not generate the image.'))
  assert.equal(await page.$$eval('[data-image-share-row] > input:checked', nodes => nodes.length), 2, 'retain selection after failed encoding')
  assert.equal(await page.$$eval('[data-image-share-preview]', nodes => nodes.length), 0)
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  await page.waitForFunction(() => document.querySelector('[data-image-share-preview] img')?.naturalWidth > 0)
  const text = await page.evaluate(() => window.__IMAGE_EXPORT_TEXT__)
  assert.match(text, /帮我比较/)
  assert.match(text, /Selected answer/)
  assert.doesNotMatch(text, /EXCLUDED PRIVATE/)
  assert(text.indexOf('帮我比较') < text.indexOf('Selected answer'), 'selection must retain conversation order')
  const pixels = await page.$eval('[data-image-share-preview] img', image => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const bg = data.slice(0, 3)
    let content = 0, logo = 0
    for (let y = 64; y < canvas.height - 64; y += 3) for (let x = 64; x < canvas.width - 64; x += 3) {
      const i = (y * canvas.width + x) * 4
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 45) { content++; if (y < 128 && x < 330) logo++ }
    }
    return { width: canvas.width, height: canvas.height, content, logo }
  })
  assert.equal(pixels.width, 1520)
  assert(pixels.height > 600 && pixels.height < 11000)
  assert(pixels.content > 1000, JSON.stringify(pixels))
  assert(pixels.logo > 50, 'Logo and wordmark must appear in the actual PNG')
  await mkdir('/tmp/aivory-conversation-image', { recursive: true })
  await page.screenshot({ path: '/tmp/aivory-conversation-image/preview-light.png' })
  const downloadDir = `/tmp/aivory-conversation-image/download-${Date.now()}`
  await mkdir(downloadDir, { recursive: true })
  const session = await page.createCDPSession()
  await session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  await (await item('Save image', '[data-image-share-preview] button')).click()
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(downloadDir)).some(name => name.endsWith('.png'))) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const png = (await readdir(downloadDir)).find(name => name.endsWith('.png'))
  assert(png, 'Save must download a PNG file')
  const bytes = await readFile(`${downloadDir}/${png}`)
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10])
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-image-share-toolbar]'))
  assert.equal(await page.$eval(composer, node => node.textContent), 'Keep this composer draft')
  // Mobile uses a second level inside its action sheet, not a desktop hover menu.
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForSelector('header button[aria-label="More"]')
  await page.click('header button[aria-label="More"]')
  await page.waitForSelector('[role="dialog"]')
  await page.$eval('[role="dialog"]', async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await (await item('Share', '[role="dialog"] button')).click()
  await (await item('Share as image', '[role="dialog"] button')).click()
  await page.waitForSelector('[data-image-share-toolbar]')
  for (const theme of ['light', 'dark']) for (const language of ['en', 'zh', 'zh-Hant', 'ja', 'fr']) {
    await page.evaluate((theme, language) => { window.__IMAGE_SHARE__.setTheme(theme); return window.__IMAGE_SHARE__.setLanguage(language) }, theme, language)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${language} horizontal overflow`)
    assert(await page.$eval('[data-image-share-toolbar]', node => node.getBoundingClientRect().bottom <= innerHeight + 1), 'Toolbar must stay in viewport')
  }
  await page.evaluate(() => window.__IMAGE_SHARE__.setLanguage('en'))
  await page.screenshot({ path: '/tmp/aivory-conversation-image/select-mobile-dark.png' })
  await page.click('[data-image-share-row="visual-assistant"] > input')
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  await page.waitForFunction(() => document.querySelector('[data-image-share-preview] img')?.naturalWidth === 1520)
  await page.$eval('[data-image-share-preview]', async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await page.screenshot({ path: '/tmp/aivory-conversation-image/preview-dark.png' })
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  assert.equal(await page.$eval('[data-image-share-row="visual-assistant"] > input', node => node.checked), true)
  await page.evaluate(() => window.__IMAGE_SHARE__.addLongMessage())
  await (await item('Clear', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-row="long-answer"] > input')
  await page.click('[data-image-share-row="long-answer"] > input')
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  await page.waitForFunction(() => /1 \/ [2-9]/.test(document.querySelector('[data-image-share-preview]')?.textContent || ''))
  await page.click('[data-image-share-preview] button[aria-label="Next image"]')
  await page.waitForFunction(() => /2 \/ [2-9]/.test(document.querySelector('[data-image-share-preview]')?.textContent || ''))
  assert(await page.$eval('[data-image-share-preview] img', image => image.naturalWidth === 1520 && image.naturalHeight <= 11000), 'long reply pages must stay within canvas limits')
  await page.evaluate(() => window.__IMAGE_SHARE__.changeAccount())
  await page.waitForFunction(() => !document.querySelector('[data-image-share-preview]') && !document.querySelector('[data-image-share-toolbar]'))
  assert.deepEqual(errors, [])
  console.log('PASS: nested link/image menus, message selection/order/exclusion, failed encoding/retry, real PNG/logo/download, composer draft retention, charts/forms, multi-page long replies, mobile and 10 theme/language combinations, account isolation')
} finally {
  await browser?.close()
  server.httpServer?.closeAllConnections()
  await server.close()
}

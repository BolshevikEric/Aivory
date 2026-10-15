import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
if (!executablePath) throw new Error('Set CHROME_PATH')
const outputDirectory = process.env.AIVORY_SHARE_TEST_OUTPUT_DIR || 'node_modules/.cache/aivory-conversation-share'
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
  let printedHTML = ''
  let pdfRequests = 0
  const exportMetrics = []
  await page.exposeFunction('recordExportMetric', value => exportMetrics.push(value))
  await page.evaluateOnNewDocument(() => window.addEventListener('aivory:conversation-export', event => window.recordExportMetric(event.detail)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return request.continue()
    if (url.pathname.endsWith('/export/pdf')) {
      void (async () => {
        pdfRequests++
        printedHTML = JSON.parse(request.postData()).html
        const printPage = await browser.newPage()
        try {
          await printPage.setJavaScriptEnabled(false)
          await printPage.setRequestInterception(true)
          printPage.on('request', resource => resource.url().startsWith('data:') || resource.url() === 'about:blank' ? resource.continue() : resource.abort())
          await printPage.setContent(printedHTML, { waitUntil: 'load' })
          const bytes = await printPage.pdf({ format: 'A4', printBackground: true })
          await request.respond({ status: 200, contentType: 'application/pdf', body: Buffer.from(bytes) })
        } catch (error) { await request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: String(error) }) }) }
        finally { await printPage.close() }
      })()
      return
    }
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
    for (const format of ['PDF', 'JSON', 'TXT']) assert(await item(`Share as ${format}`))
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
  await page.waitForFunction(() => document.body.textContent.includes('Could not generate the image.'), { timeout: 15000 }).catch(async error => { console.log('Export failure state:', await page.evaluate(() => document.body.innerText)); throw error })
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
  assert.equal(pixels.width, 1140, 'standard quality is the faster default')
  assert(pixels.height > 600 && pixels.height < 11000)
  assert(pixels.content > 1000, JSON.stringify(pixels))
  assert(pixels.logo > 50, 'Logo and wordmark must appear in the actual PNG')
  await mkdir(outputDirectory, { recursive: true })
  await page.screenshot({ path: `${outputDirectory}/preview-light.png` })
  const downloadDir = `${outputDirectory}/download-${Date.now()}`
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
  for (const format of ['PDF', 'JSON', 'TXT']) assert(await item(`Share as ${format}`, '[role="dialog"] button'))
  await (await item('Share as image', '[role="dialog"] button')).click()
  await page.waitForSelector('[data-image-share-toolbar]')
  for (const theme of ['light', 'dark']) for (const language of ['en', 'zh', 'zh-Hant', 'ja', 'fr']) {
    await page.evaluate((theme, language) => { window.__IMAGE_SHARE__.setTheme(theme); return window.__IMAGE_SHARE__.setLanguage(language) }, theme, language)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${language} horizontal overflow`)
    assert(await page.$eval('[data-image-share-toolbar]', node => node.getBoundingClientRect().bottom <= innerHeight + 1), 'Toolbar must stay in viewport')
  }
  await page.evaluate(() => window.__IMAGE_SHARE__.setLanguage('en'))
  await page.screenshot({ path: `${outputDirectory}/select-mobile-dark.png` })
  await page.click('[data-image-share-row="visual-assistant"] > input')
  await page.select('[data-image-share-toolbar] select[aria-label="Image quality"]', 'high')
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  await page.waitForFunction(() => document.querySelector('[data-image-share-preview] img')?.naturalWidth === 1520)
  const chartColorPixels = await page.$eval('[data-image-share-preview] img', image => {
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let accent = 0
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 100 && pixels[index + 2] > pixels[index] + 20 && pixels[index + 2] > pixels[index + 1] + 30) accent++
    return accent
  })
  assert(chartColorPixels > 3000, 'dark-theme SVG chart bars must retain the accent color')
  await page.$eval('[data-image-share-preview]', async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await page.screenshot({ path: `${outputDirectory}/preview-dark.png` })
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  assert.equal(await page.$eval('[data-image-share-row="visual-assistant"] > input', node => node.checked), true)
  await page.evaluate(() => window.__IMAGE_SHARE__.addLongMessage())
  await (await item('Clear', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-row="long-answer"] > input')
  await page.click('[data-image-share-row="long-answer"] > input')
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  await page.waitForFunction(() => document.querySelector('[data-image-share-preview] img')?.naturalHeight > 11000)
  assert.equal(await page.$$eval('[data-image-share-preview] img', nodes => nodes.length), 1, 'long replies must produce only one image')
  assert.equal(await page.$$eval('[data-image-share-preview] button[aria-label="Next image"]', nodes => nodes.length), 0)
  assert(await page.$eval('[data-image-share-preview] img', image => image.naturalWidth >= 760 && image.naturalHeight <= 16384), 'long image must stay readable within canvas limits')
  assert.match(await page.evaluate(() => window.__IMAGE_EXPORT_TEXT__), /FINAL PARAGRAPH/, 'the final paragraph must be included')
  const bottomContent = await page.$eval('[data-image-share-preview] img', image => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = 500
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, image.naturalHeight - 500, image.naturalWidth, 500, 0, 0, canvas.width, 500)
    const pixels = context.getImageData(0, 0, canvas.width, 500).data
    let content = 0
    for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - pixels[0]) + Math.abs(pixels[i + 1] - pixels[1]) + Math.abs(pixels[i + 2] - pixels[2]) > 45) content++
    return content
  })
  assert(bottomContent > 1000, 'the bottom of the long PNG must contain rendered content')
  await page.screenshot({ path: `${outputDirectory}/preview-long.png` })
  // All formats reuse the same selection and never request a full message tree.
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  await (await item('Clear', '[data-image-share-toolbar] button')).click()
  await page.click('[data-image-share-row="first-user"] > input')
  await page.click('[data-image-share-row="first-assistant"] > input')
  await page.select('[data-image-share-toolbar] select[aria-label="File format"]', 'json')
  await (await item('Generate file', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-share-format="json"] [data-share-text-preview]')
  await page.waitForFunction(() => document.querySelector('[data-share-text-preview]')?.textContent.includes('aivory-conversation-share'))
  const sharedJSON = await page.$eval('[data-share-text-preview]', node => JSON.parse(node.textContent))
  assert.deepEqual(sharedJSON.messages.map(message => message.id), ['first-user', 'first-assistant'])
  assert.doesNotMatch(JSON.stringify(sharedJSON), /EXCLUDED PRIVATE|long-answer|reasoning|cost/)
  await (await item('Save file', '[data-image-share-preview] button')).click()
  const waitForDownload = async extension => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const filename = (await readdir(downloadDir)).find(name => name.endsWith(extension))
      if (filename) return filename
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.fail(`Missing ${extension} download`)
  }
  assert.deepEqual(JSON.parse(await readFile(`${downloadDir}/${await waitForDownload('.json')}`, 'utf8')).messages.map(message => message.id), ['first-user', 'first-assistant'])
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  await page.select('[data-image-share-toolbar] select[aria-label="File format"]', 'txt')
  await (await item('Generate file', '[data-image-share-toolbar] button')).click()
  await page.waitForFunction(() => document.querySelector('[data-share-text-preview]')?.textContent.includes('Selected answer'))
  const plainText = await page.$eval('[data-share-text-preview]', node => node.textContent)
  assert.match(plainText, /帮我比较/)
  assert.match(plainText, /const example/)
  assert.doesNotMatch(plainText, /EXCLUDED PRIVATE|```|\*\*bold/)
  await (await item('Save file', '[data-image-share-preview] button')).click()
  assert.match(await readFile(`${downloadDir}/${await waitForDownload('.txt')}`, 'utf8'), /帮我比较/)
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  await page.select('[data-image-share-toolbar] select[aria-label="File format"]', 'pdf')
  await (await item('Generate file', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-share-format="pdf"] canvas')
  assert.equal(pdfRequests, 1)
  assert.match(printedHTML, /帮我比较/)
  assert.match(printedHTML, /Selected answer/)
  assert.doesNotMatch(printedHTML, /EXCLUDED PRIVATE|FINAL PARAGRAPH/)
  await (await item('Save file', '[data-image-share-preview] button')).click()
  const pdfFile = await waitForDownload('.pdf')
  assert.equal((await readFile(`${downloadDir}/${pdfFile}`)).subarray(0, 5).toString(), '%PDF-')
  // PDF.js extracts actual saved PDF bytes, including Chinese and code text.
  const savedPDF = Array.from(await readFile(`${downloadDir}/${pdfFile}`))
  const extracted = await page.evaluate(async bytes => {
    const pdfjs = await import('/node_modules/.vite/deps/pdfjs-dist.js')
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
    const pages = []
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
      pages.push({ text: (await page.getTextContent()).items.map(item => item.str || '').join(' '), image: canvas.toDataURL('image/png') })
    }
    await pdf.destroy()
    return pages
  }, savedPDF)
  for (const [index, rendered] of extracted.entries()) await writeFile(`${outputDirectory}/pdf-page-${index + 1}.png`, Buffer.from(rendered.image.split(',')[1], 'base64'))
  const pdfText = extracted.map(page => page.text).join('\n')
  // PDF text items may split ligatures and CJK radicals across font subsets.
  const searchableText = pdfText.normalize('NFKC').replace(/\s+/g, '')
  assert.match(searchableText, /帮我比较/)
  assert.match(searchableText, /Selectedanswer/)
  assert.match(searchableText, /constexample/)
  assert.doesNotMatch(pdfText, /EXCLUDED PRIVATE/)
  await page.screenshot({ path: `${outputDirectory}/preview-pdf-mobile.png` })
  assert(exportMetrics.some(metric => metric.format === 'image' && metric.timings.total > 0))
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  await page.select('[data-image-share-toolbar] select[aria-label="File format"]', 'image')
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  const capturesBefore = exportMetrics.filter(metric => metric.format === 'image').length
  await (await item('Change selection', '[data-image-share-preview] button')).click()
  await (await item('Generate image', '[data-image-share-toolbar] button')).click()
  await page.waitForSelector('[data-image-share-preview] img')
  assert.equal(exportMetrics.filter(metric => metric.format === 'image').length, capturesBefore, 'identical selection must reuse the generated PNG')
  console.log('Export metrics:', JSON.stringify(exportMetrics))
  await page.evaluate(() => window.__IMAGE_SHARE__.changeAccount())
  await page.waitForFunction(() => !document.querySelector('[data-image-share-preview]') && !document.querySelector('[data-image-share-toolbar]'))
  assert.deepEqual(errors, [])
  console.log('PASS: nested link/image menus, message selection/order/exclusion, failed encoding/retry, real PNG/logo/download, composer draft retention, charts/forms, complete single long image, JSON/TXT/PDF files and downloads, searchable Chinese PDF text, cached PNG, mobile and 10 theme/language combinations, account isolation')
} finally {
  await browser?.close()
  server.httpServer?.closeAllConnections()
  await server.close()
}

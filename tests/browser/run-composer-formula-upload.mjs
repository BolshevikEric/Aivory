import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
if (!executablePath) throw new Error('Set CHROME_PATH')
const outputDirectory = '/tmp/aivory-composer-formula-upload'
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
try {
  await server.listen()
  await mkdir(outputDirectory, { recursive: true })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  for (const { width, finishBeforeConfirm } of [
    { width: 1024, finishBeforeConfirm: false }, { width: 390, finishBeforeConfirm: false },
    { width: 1024, finishBeforeConfirm: true }, { width: 390, finishBeforeConfirm: true },
  ]) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    let uploadRequest
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return request.continue()
      if (url.pathname === '/api/files/uploaded-formula-image') return request.respond({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJv0AAAAASUVORK5CYII=', 'base64') })
      if (url.pathname === '/api/files' && request.method() === 'POST') {
        uploadRequest = request
        return
      }
      const body = url.pathname === '/api/me/upload-policy' ? { max_image_bytes: 5242880, max_file_bytes: 52428800 } : []
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.setViewport({ width, height: 844 })
    await page.goto(`${origin}/tests/browser/composer-harness.html`)
    const shell = '.chat-composer-shell'
    await page.waitForSelector(`${shell}[data-height-ready="true"]`)
    await page.evaluate(() => window.__COMPOSER__.fillText('Explain this image: '))
    await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent === 'Explain this image: ')
    // Exercise the real image picker, keeping its upload pending until after
    // the user confirms the formula.
    await page.$eval('input[type="file"][accept^="image/"]', input => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJv0AAAAASUVORK5CYII='), char => char.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'formula-image.png', { type: 'image/png' }))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    for (let attempt = 0; !uploadRequest && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert(uploadRequest, 'Image upload must start')
    assert(await page.$eval(`${shell} button[data-composer-action="send"]`, button => button.disabled), 'Sending stays blocked during upload')
    if (width < 640) {
      await page.click(`${shell} button[aria-label="More"]`)
      const action = await page.evaluateHandle(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper] button')].find(button => button.textContent.trim() === 'Add formula'))
      assert(action.asElement(), 'Mobile menu must offer formula insertion')
      await action.asElement().click()
    } else await page.click(`${shell} button[aria-label="Add formula"]`)
    await page.waitForSelector('.formula-editor-dialog math-field')
    await page.waitForFunction(() => !document.querySelector('.formula-mathfield-host')?.getAttribute('aria-busy'))
    assert.equal(await page.$eval('math-field', field => document.activeElement === field), true, 'Ready means the formula input owns keyboard focus')
    await page.keyboard.type('x^2+1', { delay: 30 })
    assert.match(await page.$eval('math-field', field => field.getValue('latex')), /x\^2/)
    const completeUpload = async () => {
      await uploadRequest.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'uploaded-formula-image', name: 'formula-image.png', size: 68, kind: 'image', url: '/api/files/uploaded-formula-image' }) })
      await page.waitForFunction(() => !document.querySelector('.chat-composer-shell button[data-composer-action="send"]')?.disabled)
    }
    if (finishBeforeConfirm) {
      await completeUpload()
      assert.equal(await page.$eval('math-field', field => field.getValue('latex')), 'x^2+1', 'Completing the upload must preserve the open formula draft')
    }
    await page.screenshot({ path: `${outputDirectory}/editing-${width}-${finishBeforeConfirm}.png` })
    const insert = await page.evaluateHandle(() => [...document.querySelectorAll('.formula-editor-dialog button')].find(button => button.textContent.trim() === 'Insert formula'))
    await insert.asElement().click()
    await page.waitForFunction(() => !document.querySelector('.formula-editor-dialog'))
    await page.waitForSelector(`${shell} .tiptap-mathematics-render--editable`)
    assert.match(await page.$eval(`${shell} .tiptap`, editor => editor.textContent), /Explain this image:/)
    assert.equal(await page.$eval(`${shell} button[data-composer-action="send"]`, button => button.disabled), !finishBeforeConfirm)
    await page.waitForFunction(() => document.activeElement === document.querySelector('.chat-composer-shell .tiptap'))
    await page.keyboard.type(' Continue')
    if (!finishBeforeConfirm) await completeUpload()
    await page.waitForFunction(() => !document.querySelector('.chat-composer-shell button[data-composer-action="send"]')?.disabled)
    await page.screenshot({ path: `${outputDirectory}/inserted-${width}-${finishBeforeConfirm}.png` })
    await page.click(`${shell} button[data-composer-action="send"]`)
    await page.waitForFunction(() => window.__COMPOSER_MESSAGE__)
    const submitted = await page.evaluate(() => window.__COMPOSER_MESSAGE__)
    assert.match(submitted.text, /Explain this image:/)
    assert.match(submitted.text, / Continue$/)
    assert(submitted.text.includes(String.raw`\(x^2+1\)`), 'Submitted text retains the inserted formula')
    assert.deepEqual(submitted.attachments.map(attachment => attachment.id), ['uploaded-formula-image'])
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log(`Composer formula/upload checks passed. Screenshots: ${outputDirectory}`)
} finally {
  await browser?.close()
  await server.close()
}

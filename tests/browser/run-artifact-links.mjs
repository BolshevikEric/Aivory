import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(value => value && existsSync(value))
if (!executablePath) throw new Error('Set CHROME_PATH')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
const directory = await mkdtemp(path.join(tmpdir(), 'aivory-artifact-download-'))
const screenshots = '/tmp/aivory-artifact-links'
const image = await readFile(new URL('../../public/icon-512.png', import.meta.url))
const download = Buffer.from('Generated document download fixture')
let browser
try {
  await mkdir(screenshots, { recursive: true })
  await server.listen()
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] })
  const page = await browser.newPage()
  const errors = [], unsupported = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (request.url().startsWith('attachment:')) unsupported.push(request.url())
    const pathname = new URL(request.url()).pathname
    if (pathname === '/api/artifacts/diagram') { void request.respond({ status: 200, contentType: 'image/png', body: image }); return }
    if (pathname === '/api/artifacts/report') { void request.respond({ status: 200, contentType: 'application/octet-stream', headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E8%AF%BE%E7%A8%8B%E6%80%BB%E7%BB%93.docx" }, body: download }); return }
    if (pathname.startsWith('/api/')) { void request.respond({ status: 200, contentType: 'application/json', body: '[]' }); return }
    void request.continue()
  })
  const session = await page.createCDPSession()
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory, eventsEnabled: true })
  const completed = new Promise(resolve => session.on('Browser.downloadProgress', event => { if (event.state === 'completed') resolve() }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/generative-ui-harness.html?artifacts`)
  await page.waitForFunction(() => window.__GUI__)
  await page.evaluate(() => {
    window.__GUI__.setMarkup('## Generated files\n\n[Download report](attachment://课程总结.docx)\n\n![Diagram](attachment://diagram.png)\n\n<table><tr><td><card title="Preview"><image src="attachment://diagram.png" width="160px"/><button href="attachment://课程总结.docx">Download</button><svg viewBox="0 0 100 100" width="100px"><image href="attachment://diagram.png" width="100" height="100"/></svg></card></td></tr></table>')
  })
  await page.waitForFunction(() => document.querySelector('.prose-aivory a')?.textContent === 'Download report')
  assert.equal(await page.$eval('.prose-aivory a', node => node.hasAttribute('href')), false)
  // The server can deliver artifact metadata after the text has already arrived.
  await page.evaluate(() => window.__GUI__.setArtifacts([
    { id: 'report', filename: '课程总结.docx', url: '/api/artifacts/report', mimeType: 'application/octet-stream' },
    { id: 'diagram', filename: 'diagram.png', url: '/api/artifacts/diagram', mimeType: 'image/png' },
  ]))
  await page.waitForFunction(() => document.querySelectorAll('.prose-aivory a[href="/api/artifacts/report"]').length === 2)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.prose-aivory img')).length === 2 && Array.from(document.querySelectorAll('.prose-aivory img')).every(node => node.complete && node.naturalWidth > 0))
  assert.equal(await page.$eval('.prose-aivory svg image', node => node.getAttribute('href')), '/api/artifacts/diagram')
  for (const width of [360, 1280]) {
    await page.setViewport({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.screenshot({ path: `${screenshots}/attachments-${width}.png`, fullPage: true })
  }
  await page.click('.prose-aivory a[href="/api/artifacts/report"]')
  let timeout
  try { await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Download did not complete')), 15000) })]) }
  finally { clearTimeout(timeout) }
  assert.deepEqual(await readFile(path.join(directory, '课程总结.docx')), download)
  assert.deepEqual(unsupported, [])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', checks: 'Chinese filename download bytes, Markdown images, nested component and SVG URLs, late artifact metadata, mobile/desktop layout', screenshots }, null, 2))
} finally {
  await browser?.close()
  await server.close()
  await rm(directory, { recursive: true, force: true })
}

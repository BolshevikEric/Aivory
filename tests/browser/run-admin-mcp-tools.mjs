import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!chrome) throw new Error('Set CHROME_PATH')
const output = '/tmp/aivory-admin-mcp-tools'
await mkdir(output, { recursive: true })
const tools = Array.from({ length: 8 }, (_, index) => ({
  name: index === 0 ? 'search' : `lookup_${index}`,
  title: index === 0 ? 'Web search' : `Lookup ${index}`,
  description: 'Find matching information from the connected service. Results include source links and a short description.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search keywords' } }, required: ['query'] },
}))
let service = { id: 'search-mcp', name: 'Search MCP', icon: 'Search', description: 'Search and information lookup', url: 'https://example.test/mcp', headers: {}, enabled: true, discovered_tools: tools, disabled_tools: [], last_synced_at: 1791770000 }
let rejectNext = false
const errors = []
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) { request.continue(); return }
    let body = []
    if (path === '/api/admin/mcp') body = [service]
    if (path === '/api/admin/mcp/search-mcp' && request.method() === 'PATCH') {
      if (rejectNext) {
        rejectNext = false
        request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary update failure' }) })
        return
      }
      service = { ...service, ...JSON.parse(request.postData()) }
      body = service
    }
    if (path.endsWith('/sync')) body = service
    request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  page.setDefaultTimeout(30_000)
  const waitForDrawer = () => page.waitForFunction(() => {
    const rect = document.querySelector('[role="dialog"]')?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.right <= innerWidth + 1 && rect.left >= -1
  })
  const toolsButton = '[data-column="actions"] button[aria-label="Manage tools for Search MCP"]'
  for (const width of [1280, 390]) {
    for (const theme of ['dark', 'light']) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 })
      await page.goto(`${origin}/tests/browser/admin-tables-harness.html?view=mcp&theme=${theme}&lang=en`)
      await page.waitForSelector(toolsButton)
      await page.click(toolsButton)
      await page.waitForSelector('[role="dialog"] input[aria-label="Search tools"]')
      await waitForDrawer()
      assert.equal(await page.$$eval('[role="dialog"] [role="switch"]', nodes => nodes.length), 8)
      await page.click('[role="switch"][aria-label="Enable tool search"]')
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Enable tool search"]')?.getAttribute('aria-checked') === 'false')
      assert.deepEqual(service.disabled_tools, ['search'])
      assert.equal(await page.$eval('[role="switch"][aria-label="Enable tool lookup_1"]', node => node.getAttribute('aria-checked')), 'true')
      await page.reload()
      await page.waitForSelector(toolsButton)
      await page.click(toolsButton)
      await page.waitForSelector('[role="switch"][aria-label="Enable tool search"]')
      await waitForDrawer()
      assert.equal(await page.$eval('[role="switch"][aria-label="Enable tool search"]', node => node.getAttribute('aria-checked')), 'false')
      rejectNext = true
      await page.click('[role="switch"][aria-label="Enable tool search"]')
      await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="Enable tool search"]')?.disabled)
      assert.equal(await page.$eval('[role="switch"][aria-label="Enable tool search"]', node => node.getAttribute('aria-checked')), 'false')
      await page.type('input[aria-label="Search tools"]', 'web search')
      assert.equal(await page.$$eval('[role="dialog"] [role="switch"]', nodes => nodes.length), 1)
      await page.$eval('[role="dialog"] details', node => { node.open = true })
      const bounds = await page.$eval('[role="dialog"]', node => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, scroll: node.scrollWidth, client: node.clientWidth }
      })
      assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && bounds.top >= -1 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds))
      assert.ok(bounds.scroll <= bounds.client + 1, JSON.stringify(bounds))
      await page.screenshot({ path: `${output}/${theme}-${width}.png` })
      await page.click('[role="switch"][aria-label="Enable tool search"]')
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Enable tool search"]')?.getAttribute('aria-checked') === 'true')
      assert.deepEqual(service.disabled_tools, [])
    }
  }
  assert.deepEqual(errors, [])
  console.log(`MCP tool drawer passed toggle, persistence, failure, search and layout checks at desktop/mobile sizes. Screenshots: ${output}`)
} catch (error) {
  const page = (await browser?.pages())?.at(-1)
  await page?.screenshot({ path: `${output}/failure.png` })
  throw error
} finally {
  await browser?.close()
  await server.close()
}

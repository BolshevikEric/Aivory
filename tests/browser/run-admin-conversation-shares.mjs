import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
if (!chrome) throw new Error('Set CHROME_PATH to Chrome or Chromium')
const output = '/tmp/aivory-admin-conversation-shares'
await mkdir(output, { recursive: true })
const now = Math.floor(Date.now() / 1000)
const users = Array.from({ length: 45 }, (_, index) => ({
  id: `u${index + 1}`, name: `Member ${index + 1}`, email: `member${index + 1}@example.test`, role: 'user', status: 'active',
  group_id: index % 2 ? 'group-beta' : 'group-alpha', created_at: now, settings: {},
}))
const shares = Array.from({ length: 55 }, (_, index) => ({
  id: `sh_fixture_${index + 1}`, conversation_id: `conv-${index + 1}`, title: `Research conversation ${index + 1}`,
  user_id: index === 54 ? 'u2' : 'u1', user_name: index === 54 ? 'Second Author' : 'Example Author',
  user_email: index === 54 ? 'second@example.test' : 'author@example.test', created_at: now - index,
}))
const groups = [{ id: 'group-alpha', name: 'Alpha' }, { id: 'group-beta', name: 'Beta' }]
const requests = []
const errors = []
const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' })
let browser

try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return request.continue()
    const path = url.pathname.slice(4)
    requests.push({ path, query: Object.fromEntries(url.searchParams) })
    let body
    const offset = Number(url.searchParams.get('offset') || 0)
    const limit = Number(url.searchParams.get('limit') || 50)
    if (path === '/admin/conversation-shares') {
      const search = (url.searchParams.get('search') || '').toLowerCase()
      const user = (url.searchParams.get('user') || '').toLowerCase()
      const filtered = shares.filter((item) => `${item.title} ${item.id} ${item.conversation_id}`.toLowerCase().includes(search)
        && `${item.user_name} ${item.user_email} ${item.user_id}`.toLowerCase().includes(user))
      body = { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset }
    } else if (path === '/admin/users') {
      const search = (url.searchParams.get('search') || '').toLowerCase()
      const group = url.searchParams.get('group_id')
      const filtered = users.filter((user) => (!group || user.group_id === group) && `${user.name} ${user.email}`.toLowerCase().includes(search))
      body = { users: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset }
    } else if (path === '/admin/user-groups') body = groups
    else {
      errors.push(`Missing fixture: ${path}`)
      body = []
    }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'fr']) {
    const admin = JSON.parse(readFileSync(`src/i18n/locales/${locale}/admin.json`, 'utf8'))
    const common = JSON.parse(readFileSync(`src/i18n/locales/${locale}/common.json`, 'utf8'))
    for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
      await page.setViewport({ width, height: 960, isMobile: width === 390, hasTouch: width === 390 })
      await page.goto(`${base}tests/browser/admin-tables-harness.html?view=shares&theme=${theme}&lang=${locale}`, { waitUntil: 'networkidle0' })
      await page.waitForSelector('tbody tr', { visible: true })
      assert.equal(await page.$$eval('tbody tr', (rows) => rows.length), 50)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
      if (width === 390) {
        const visibleText = await page.$eval('tbody tr:first-child', (element) => element.innerText)
        assert.ok(visibleText.includes('Example Author'))
        assert.ok(visibleText.includes('/share/sh_fixture_1'))
      }
      const link = await page.$eval('a[aria-label="' + admin.conversationShares.open + '"]', (element) => element.href)
      assert.ok(link.endsWith('/share/sh_fixture_1'))
      await page.screenshot({ path: `${output}/shares-${locale}-${width}.png`, fullPage: true })
      await page.click(`button[aria-label="${common.pagination.next}"]`)
      await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Research conversation 51'))
      assert.equal(await page.$$eval('tbody tr', (rows) => rows.length), 5)
      await page.type(`input[aria-label="${admin.usage.filters.user}"]`, 'second@example.test')
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody')?.textContent.includes('Second Author'))
      assert.equal(requests.at(-1).query.offset || '0', '0')
      await page.type(`input[aria-label="${admin.conversationShares.searchPlaceholder}"]`, 'no-match')
      await page.waitForFunction((text) => document.body.innerText.includes(text), {}, admin.conversationShares.emptyFiltered)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
    }
  }

  const admin = JSON.parse(readFileSync('src/i18n/locales/zh/admin.json', 'utf8'))
  const common = JSON.parse(readFileSync('src/i18n/locales/zh/common.json', 'utf8'))
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 960, isMobile: width === 390, hasTouch: width === 390 })
    await page.goto(`${base}tests/browser/admin-tables-harness.html?view=users&theme=light&lang=zh`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('tbody tr', { visible: true })
    await page.click(`button[aria-label="${common.pagination.next}"]`)
    await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Member 21'))
    await page.click(`button[aria-label="${admin.users.filterGroup}"]`)
    await page.waitForSelector('[role="option"]', { visible: true })
    const beta = await page.evaluateHandle(() => [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === 'Beta'))
    assert.ok(beta.asElement())
    await beta.asElement().click()
    await beta.dispose()
    await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('member2@example.test'))
    assert.equal(requests.at(-1).query.group_id, 'group-beta')
    assert.equal(requests.at(-1).query.offset, '0')
    await page.type(`input[aria-label="${admin.users.searchPlaceholder}"]`, 'member2@')
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody')?.textContent.includes('member2@example.test'))
    assert.equal(requests.at(-1).query.group_id, 'group-beta')
    assert.equal(requests.at(-1).query.search, 'member2@')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
    await page.screenshot({ path: `${output}/users-filter-${width}.png`, fullPage: true })
  }
  assert.deepEqual(errors, [])
  console.log(`Admin share pagination, filters, links, empty states and user groups passed. Screenshots: ${output}`)
} finally {
  await browser?.close()
  await server.close()
}

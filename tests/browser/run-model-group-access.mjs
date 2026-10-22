import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome executable')
const output = '/tmp/aivory-model-group-access'
await mkdir(output, { recursive: true })
const channel = { id: 'c1', name: 'Provider', type: 'openai', api_format: 'chat', enabled: true }
const model = {
  id: 'm1', channel_id: 'c1', kind: 'chat', label: 'Access test', request_id: 'access-test',
  description: '', icon: '', enabled: true, tool_mode: 'native', stream: true, vision: true,
  param_controls: [], extra_params: {}, official_tools: [], tags: [], skills: [], denied_group_ids: ['g2'],
}
const groups = [{ id: 'g1', name: 'Team' }, { id: 'g2', name: 'Guests' }]
let bindingState = { regular: [{ id: 'b1', model_id: 'm1', channel_id: 'c1', priority: 1, weight: 100, role: 'regular', channel_enabled: true, disabled_until: 0 }], fallback: [] }
const fixtures = {
  '/admin/channels': [channel], '/admin/models': [model], '/admin/model-tags': [], '/admin/skills': [],
  '/admin/tools/builtins': [], '/admin/mcp': [], '/admin/settings': {}, '/admin/user-groups': groups,
  '/admin/models/m1/quotas': [], '/admin/models/m1/skills': [], '/admin/channels/capabilities': [channel],
}
const mutations = []
const errors = []
let failGroups = false
const server = await createServer({ server: { port: 5203, strictPort: false }, logLevel: 'error' })
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
    if (path === '/admin/user-groups' && failGroups) return request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' })
    let body = fixtures[path]
    if (request.method() !== 'GET') mutations.push({ path, method: request.method(), body: JSON.parse(request.postData() || '{}') })
    if (path === '/admin/models/m1' && request.method() === 'PATCH') {
      Object.assign(model, JSON.parse(request.postData()))
      body = model
    }
    if (path === '/admin/models/m1/channels') {
      if (request.method() === 'PUT') bindingState = JSON.parse(request.postData())
      body = bindingState
    }
    if (body === undefined) { errors.push(`Missing fixture: ${path}`); body = [] }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  const selectTab = async (label) => {
    const handle = await page.evaluateHandle((text) => [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === text), label)
    assert.ok(handle.asElement(), `Missing tab: ${label}`)
    await handle.asElement().evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
    await handle.asElement().click()
    await handle.dispose()
    await page.waitForFunction((text) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === text, {}, label)
  }
  const open = async (locale, width, theme = 'light') => {
    await page.setViewport({ width, height: 960 })
    await page.goto(`${base}tests/browser/admin-tables-harness.html?view=model-edit&model=m1&theme=${theme}&lang=${locale}`, { waitUntil: 'networkidle0' })
    await page.click('details > summary')
    const text = JSON.parse(readFileSync(`src/i18n/locales/${locale}/admin.json`, 'utf8'))
    await selectTab(text.models.advancedTabs.permissions)
    return text
  }
  const label = (text, group) => text.models.groupAccess.switchLabel.replace('{{group}}', group)
  const selector = (text, group) => `button[role="switch"][aria-label=${JSON.stringify(label(text, group))}]`
  const checked = (s) => page.$eval(s, (element) => element.getAttribute('aria-checked') === 'true')
  let text = await open('zh', 1440)
  const team = selector(text, 'Team')
  const guest = selector(text, 'Guests')
  await page.waitForSelector(team)
  assert.equal(await checked(team), true)
  assert.equal(await checked(guest), false)
  await page.click(team)
  await page.click(guest)
  assert.equal(mutations.length, 0, 'Access toggles saved before the model Save action')
  assert.equal(await checked('button[role="switch"][aria-label="Team"]'), false, 'Access change altered free quota')
  await selectTab('生成设置')
  await selectTab('权限与配额')
  assert.equal(await checked(team), false, 'Switching tabs discarded the draft')
  assert.equal(await checked(guest), true)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存').click())
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((button) => button.getAttribute('aria-busy') === 'true'))
  assert.deepEqual(mutations.find((item) => item.method === 'PATCH')?.body.denied_group_ids, ['g1'])
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'fr']) {
    for (const width of [1440, 390]) {
      text = await open(locale, width, width === 390 ? 'dark' : 'light')
      const access = selector(text, 'Team')
      await page.waitForSelector(access)
      assert.equal(await checked(access), false, 'Saved permissions were lost on reload')
      assert.equal(await checked(selector(text, 'Guests')), true)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale}/${width}: viewport overflow`)
      await page.$eval(access, (element) => element.closest('section').scrollIntoView({ block: 'center' }))
      const section = await page.$(`${access}`)
      const sectionHandle = await section.evaluateHandle((element) => element.closest('section'))
      await sectionHandle.asElement().screenshot({ path: `${output}/${locale}-${width}.png` })
      await sectionHandle.dispose()
    }
    console.log(`Model access browser checks passed: ${locale}, desktop/mobile`)
  }
  failGroups = true
  text = await open('zh', 390)
  await page.waitForFunction((message) => document.body.innerText.includes(message), {}, text.models.groupAccess.loadFailed)
  assert.equal(await page.$(team), null)
  failGroups = false
  await page.evaluate((label) => [...document.querySelectorAll('[role="alert"] button')].find((button) => button.textContent.trim() === label).click(), text.models.groupAccess.retry)
  await page.waitForSelector(team)
  assert.equal(await checked(team), false, 'Retry discarded the saved policy')
  assert.deepEqual(errors, [])
  console.log(`Model access save/reload/quota independence/retry checks passed; screenshots: ${output}`)
} finally {
  await browser?.close()
  await server.close()
}

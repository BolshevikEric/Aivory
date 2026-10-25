import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
assert.ok(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable')
const output = process.env.AIVORY_UI_STATE_SCREENSHOTS || path.join(tmpdir(), 'aivory-ui-states')
await mkdir(output, { recursive: true })
const cacheDir = await mkdtemp(path.join(tmpdir(), 'aivory-ui-states-cache-'))
const server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 5204, strictPort: true }, logLevel: 'error' })
const baseUrl = 'http://127.0.0.1:5204'
const policy = { password_login_enabled: true, passkey_login_enabled: true, entry_mode: 'login_page', default_provider: null, oauth_initial_password_policy: 'required', providers: [] }
const user = { id: 'u1', name: 'UI review', email: 'review@example.test', role: 'admin', status: 'active', has_password: true, created_at: 1, settings: { onboarded: true, admin_onboarding_v1: 'completed', language: 'zh', theme: 'light' } }
const project = { id: 'p1', name: 'Existing project', description: '', instructions: '', pinned: false, created_at: 1, updated_at: 1 }
const emptyFixtures = {
  '/auth/session': { authenticated: true, user, access_token: 'ui-review-token', request_signing_key: 'ui-review-key', auth_policy: policy },
  '/public/auth-policy': policy, '/public/needs-setup': { needs_setup: false },
  '/public/signup-open': { open: true, captcha_required: false },
  '/public/site-status': { closed: false, message: '' },
  '/me': user, '/me/settings': user.settings,
  '/me/credits': { permanent: 100, available: 100, timed: { balance: 0, grants: [] } },
  '/me/storage': { used_bytes: 0, quota_bytes: 100000 },
  '/me/files': { files: [], total: 0 }, '/me/domain-data': {},
  '/me/credit-adjustment-notifications': { notifications: [] },
  '/notifications': { notifications: [], total: 0 }, '/announcement': { enabled: false, bar_enabled: false },
  '/workspaces': { workspaces: [] }, '/models': { models: [], default_id: '' },
  '/image-models': { models: [], default_id: '' }, '/model-tags': [],
  '/conversations': { conversations: [], has_more: false }, '/projects': [], '/kbs': [],
  '/skills': [], '/me/skills': [], '/me/prompts': [], '/me/mcps': [], '/me/skill-commands': [],
  '/library/catalog': { skills: [], prompts: [], mcp: [] },
  '/sandbox/availability': { available: false },
  '/admin/users': { users: [], total: 0 }, '/admin/users/u1': user,
  '/admin/user-groups': [], '/admin/skills': [], '/admin/prompts': [], '/admin/channels': [],
  '/admin/channels/health': { channels: {} }, '/admin/models': [], '/admin/model-tags': [],
  '/admin/oauth-providers': [], '/admin/settings': {}, '/admin/redeem-codes': [],
  '/admin/workspaces': { workspaces: [] },
  '/admin/usage': { records: [], total: 0, total_cost: 0, page: 1, page_size: 50 },
  '/admin/onboarding': { status: 'completed', steps: [] },
}
const failureRoutes = new Set([
  '/admin/skills', '/admin/prompts', '/admin/channels', '/admin/models', '/admin/model-tags',
  '/admin/oauth-providers', '/admin/user-groups', '/admin/users', '/admin/workspaces',
  '/admin/redeem-codes', '/admin/usage', '/me/files', '/projects', '/kbs', '/library/catalog',
])
let mode = 'empty'
let browser
const errors = []
let checks = 0

try {
  await server.listen()
  browser = await puppeteer.launch({ executablePath, headless: true })
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(60_000)
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.evaluateOnNewDocument(() => {
    // This also runs in document-preview sandbox frames, which cannot use storage.
    try {
      localStorage.setItem('aivory.lang', 'zh')
      localStorage.setItem('aivory.theme', 'light')
    } catch { /* opaque sandbox origin */ }
  })
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return request.continue()
    const route = url.pathname.slice(4)
    if (mode === 'error' && failureRoutes.has(route)) {
      return request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'UI state regression fixture' }) })
    }
    let body = emptyFixtures[route] ?? {}
    if (mode === 'project' && route === '/projects') body = [project]
    if (route === '/events') return request.respond({ status: 200, contentType: 'text/event-stream', body: '' })
    return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  async function goto(route) {
    await page.goto(baseUrl + route, { waitUntil: 'networkidle0' })
  }
  async function screenshot(name) {
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
  }
  const adminRoute = (view, theme = 'light', lang = 'zh') => `/tests/browser/admin-tables-harness.html?view=${view}&theme=${theme}&lang=${lang}`

  for (const theme of ['light', 'dark']) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    for (const view of ['users', 'groups']) {
      mode = 'empty'
      await goto(adminRoute(view, theme))
      await page.waitForSelector('.admin-table-empty h3')
      for (const end of [false, true]) {
        const visible = await page.$eval('.admin-table-scroll', (frame, end) => {
          frame.scrollLeft = end ? frame.scrollWidth : 0
          const text = frame.querySelector('.admin-table-empty h3').getBoundingClientRect()
          const viewport = frame.getBoundingClientRect()
          return text.left >= viewport.left - 1 && text.right <= viewport.right + 1 && text.width > 0
        }, end)
        assert.ok(visible, `${view}/${theme}: empty message must be visible at both horizontal scroll positions`)
      }
      assert.equal(await page.$eval('.admin-table-empty h3', (heading) => heading.textContent), '暂无记录')
      await screenshot(`${view}-${theme}-mobile`)
      checks++
    }
  }

  await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false })
  for (const view of ['skills', 'prompts', 'channels', 'models', 'oauth', 'groups', 'users', 'tags', 'workspaces', 'redeem', 'usage']) {
    mode = 'error'
    await goto(adminRoute(view))
    await page.waitForSelector('[role="alert"] button')
    const failure = await page.$eval('[role="alert"]', (element) => element.textContent)
    assert.ok(failure.includes('页面加载失败') && failure.includes('再试一次'), `${view}: show a persistent, localized error and retry`)
    await screenshot(`${view}-error`)
    mode = 'empty'
    await page.click('[role="alert"] button')
    await page.waitForFunction(() => !document.querySelector('[role="alert"]') && document.querySelector('h3[role], [role="status"] h3'))
    assert.equal(await page.$('[aria-busy="true"]'), null, `${view}: retry finishes loading`)
    checks++
  }

  for (const [language, retry] of [['en', 'Try again'], ['zh-Hant', '再試一次'], ['ja', 'もう一度試す'], ['fr', 'Réessayer']]) {
    mode = 'error'
    await goto(adminRoute('skills', 'light', language))
    await page.waitForSelector('[role="alert"] button')
    const label = await page.$eval('[role="alert"] button', (button) => button.textContent.trim())
    assert.equal(label, retry, `${language}: the retry action is translated`)
    checks++
  }

  mode = 'project'
  await goto('/projects')
  await page.waitForSelector('input')
  await page.type('input', 'NoMatch_9821')
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('没有匹配的项目'))
  assert.ok(!await page.$eval('[role="status"]', (element) => element.textContent.includes('暂无项目。')))
  await screenshot('projects-no-results')
  await page.click('[role="status"] button')
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('Existing project'))
  const pinned = await page.$$('main button')
  for (const button of pinned) {
    if ((await button.evaluate((element) => element.textContent)).includes('已置顶')) { await button.click(); break }
  }
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('暂无置顶项目'))
  await page.click('[role="status"] button')
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('Existing project'))
  checks += 2

  mode = 'empty'
  await goto('/files')
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('还没有文件'))
  assert.equal(await page.$$eval('main h3', (headings) => headings.filter((heading) => heading.textContent === '还没有文件').length), 1, 'Files must only show one empty collection message')
  await screenshot('files-empty')
  mode = 'error'
  await goto('/files')
  await page.waitForSelector('main [role="alert"]')
  assert.ok(!await page.$eval('main', (main) => main.textContent.includes('还没有文件')), 'A failed file request must not assert that the collection is empty')
  await screenshot('files-error')
  checks += 2

  assert.deepEqual(errors, [], 'No rendering errors during state transitions')
  console.log(`PASS: ${checks} UI state scenarios; screenshots: ${output}`)
} finally {
  await browser?.close()
  await server.close()
  // The dependency optimizer may finish a write just after the server closes.
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

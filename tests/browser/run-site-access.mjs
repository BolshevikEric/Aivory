import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
assert.ok(executablePath, 'Chrome is required')
const baseUrl = process.env.AIVORY_LAYOUT_TEST_URL || 'http://127.0.0.1:5173'
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => { errors.push(String(error)); console.error(error) })
page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()) })
await page.setViewport({ width: 1366, height: 900 })
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
let authenticated = true
let role = 'admin'
let site = { closed: false, message: '' }
let settings = { site_access: site }
const patches = []
let sharedReads = 0
const policy = { password_login_enabled: true, passkey_login_enabled: true, entry_mode: 'login_page', default_provider: null, providers: [], oauth_initial_password_policy: 'required' }
const user = () => ({ id: `site-${role}`, email: 'fixture@example.test', name: 'Fixture', role, status: 'active', has_password: true,
  settings: { onboarded: true, language: 'zh', theme: 'light' } })

await page.setRequestInterception(true)
page.on('request', (request) => {
  const path = new URL(request.url()).pathname
  if (!path.startsWith('/api/')) { void request.continue(); return }
  if (path === '/api/auth/logout') authenticated = false
  if (path.startsWith('/api/public/shared/')) sharedReads++
  if (path === '/api/admin/settings' && request.method() === 'PATCH') {
    const patch = JSON.parse(request.postData())
    patches.push(patch)
    settings = { ...settings, ...patch }
    if (patch.site_access) site = patch.site_access
  }
  const fixtures = {
    '/api/auth/session': { authenticated, user: authenticated ? user() : null, access_token: 'fixture-token', request_signing_key: 'fixture-key', auth_policy: policy },
    '/api/me': user(), '/api/me/settings': user().settings,
    '/api/public/site-status': site,
    '/api/public/auth-policy': policy, '/api/public/needs-setup': { needs_setup: false }, '/api/public/signup-open': { open: true },
    '/api/admin/settings': settings, '/api/admin/notifications': { notifications: [], total: 0 },
    '/api/admin/onboarding': { status: 'completed', deployment_profile: 'full', required: [], optional: [], full_optional: [] },
    '/api/announcement': { enabled: false, bar_enabled: false }, '/api/workspaces': { workspaces: [] },
    '/api/models': { models: [], default_id: '' }, '/api/image-models': { models: [], default_id: '' },
    '/api/conversations': { conversations: [], has_more: false }, '/api/library/catalog': { skills: [], prompts: [], mcp: [] },
    '/api/me/credits': { permanent: 100, available: 100, timed: { balance: 0, grants: [] } },
    '/api/me/credit-adjustment-notifications': { notifications: [] }, '/api/notifications': { notifications: [], total: 0 },
  }
  const arrayPaths = ['/api/projects', '/api/skills', '/api/me/skills', '/api/me/prompts', '/api/me/mcps', '/api/model-tags', '/api/kbs', '/api/public/oauth-providers']
  void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[path] ?? (arrayPaths.includes(path) ? [] : {})) })
})

try {
  await page.goto(`${baseUrl}/admin/announcement`)
  await page.waitForSelector('#site-closed')
  await page.waitForSelector('#ann-enabled')
  await page.waitForFunction(() => [...document.querySelectorAll('h1')].some((node) => node.textContent === '网站与通知'))
  assert.equal(await page.$$eval('main h1', (headings) => headings.length), 1)
  assert.equal(await page.$$eval('section[aria-label]', (sections) => sections.filter((section) => ['网站访问', '弹窗消息', '通知'].includes(section.getAttribute('aria-label'))).length), 3)
  assert.equal(await page.$$eval('a[href="/admin/notifications"]', (links) => links.length), 0, 'one combined navigation destination')
  const text = '正在迁移服务器\n请稍后再试。<img src=x onerror=alert(1)>'
  await page.type('#site-closed-message', text)
  await page.click('#site-closed')
  await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="网站访问"]')
    const save = [...section.querySelectorAll('button')].find((button) => button.textContent.includes('保存'))
    save.click()
  })
  await page.waitForFunction(() => document.querySelector('#site-closed')?.getAttribute('aria-checked') === 'true')
  await page.waitForNetworkIdle({ idleTime: 200 })
  assert.deepEqual(patches[0], { site_access: { closed: true, message: text } })
  assert.equal(await page.$('.site-closed-page'), null, 'admin stays in the console after closing')
  await page.screenshot({ path: '/tmp/aivory-site-settings-desktop.png', fullPage: true })

  role = 'user'
  await page.goto(`${baseUrl}/chat`)
  await page.waitForSelector('.site-closed-message')
  assert.equal(await page.$eval('.site-closed-message', (node) => node.textContent), text)
  assert.equal(await page.$('.site-closed-message img'), null, 'custom content is plain text')
  await page.setViewport({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile has no horizontal overflow')
  await page.screenshot({ path: '/tmp/aivory-site-closed-mobile.png', fullPage: true })
  site = { closed: false, message: '' }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector('[contenteditable="true"]')
  // Already-open tabs close on a status refresh, then recover when reopened.
  site = { closed: true, message: text }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector('.site-closed-page')
  authenticated = false
  await page.goto(`${baseUrl}/share/example`)
  await page.waitForSelector('.site-closed-page')
  assert.equal(sharedReads, 0, 'closed shares do not load their contents')
  assert.equal(await page.$eval('.site-closed-page', (node) => node.textContent.includes('管理员登录')), false, 'closure page does not display an administrator login entry')
  assert.equal(await page.$('.site-closed-page a[href="/login"]'), null, 'closure page has no login link')
  await page.goto(`${baseUrl}/login`)
  await page.waitForSelector('input[type="password"]')
  assert.equal(await page.$('.site-closed-page'), null, 'administrator login remains available')
  assert.deepEqual(errors, [])
  console.log('Site access browser checks passed: combined page, admin bypass, closure, reopening, shared-page block, safe text, mobile and login.')
} catch (error) {
  await page.screenshot({ path: '/tmp/aivory-site-access-failure.png', fullPage: true })
  console.error(await page.evaluate(() => ({ url: location.href, headings: [...document.querySelectorAll('h1,h2')].map((node) => node.textContent) })), errors)
  throw error
} finally {
  await browser.close()
}

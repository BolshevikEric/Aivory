import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.AIVORY_AUTH_LAYOUT_TEST_URL || 'http://127.0.0.1:5174'
const executablePath = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
assert.ok(executablePath, 'Chrome is required')
const outputDir = path.join(tmpdir(), 'aivory-auth-email')
mkdirSync(outputDir, { recursive: true })
const messages = Object.fromEntries(['en', 'zh', 'zh-Hant', 'ja', 'fr'].map((locale) => [locale, JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${locale}/auth.json`, import.meta.url), 'utf8'))]))
const token = 'a'.repeat(43)
let entryMode = 'login_page'
let failSend = false
let invalidToken = false
let authenticated = false
const requests = []
const errors = []
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 20000, args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
page.on('pageerror', (error) => errors.push(String(error)))
await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('aivory.lang')) localStorage.setItem('aivory.lang', 'en'); localStorage.setItem('aivory.theme', 'light') })
await page.setRequestInterception(true)
page.on('request', (request) => {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/')) return void request.continue()
  const policy = { password_login_enabled: true, passkey_login_enabled: false, entry_mode: entryMode, default_provider: entryMode === 'auto_redirect' ? 'github' : null, providers: [], oauth_initial_password_policy: 'required' }
  const user = { id: 'email-test-user', email: 'account@example.test', name: 'Test', role: 'user', status: 'active', has_password: true, settings: { language: 'en' } }
  const fixtures = {
    '/api/auth/session': { authenticated, user: authenticated ? user : null, access_token: authenticated ? 'test-token' : '', auth_policy: policy },
    '/api/me': user,
    '/api/public/auth-policy': policy,
    '/api/public/needs-setup': { needs_setup: false },
    '/api/public/signup-open': { open: true, captcha_required: false, login_captcha_required: false },
    '/api/public/oauth-providers': [],
    '/api/announcement': { enabled: false, bar_enabled: false },
  }
  if (['/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/register', '/api/auth/send-code'].includes(url.pathname)) {
    requests.push({ path: url.pathname, body: JSON.parse(request.postData()) })
    if (url.pathname.endsWith('/forgot-password') && failSend) return void request.respond({ status: 503, contentType: 'application/json', body: '{}' })
    if (url.pathname.endsWith('/reset-password') && invalidToken) return void request.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_or_expired_reset_link' }) })
    const body = url.pathname.endsWith('/register') ? { verification_required: true, email: 'account@example.test', retry_after: 0 } : { ok: true, retry_after: 0 }
    return void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  }
  void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname] ?? {}) })
})
async function visit(route) {
  await page.goto(baseUrl + route, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.login-content')
}
async function title(text) { await page.waitForFunction((expected) => document.querySelector('#login-title')?.textContent === expected, {}, text) }
async function fits(label) {
  await page.evaluate(() => document.fonts.ready)
  const layout = await page.evaluate(() => {
    const content = document.querySelector('.login-content').getBoundingClientRect()
    const panel = document.querySelector('.login-panel').getBoundingClientRect()
    return { top: content.top, bottom: content.bottom, panelTop: panel.top, panelBottom: panel.bottom,
      width: document.scrollingElement.scrollWidth, viewportWidth: innerWidth }
  })
  if (label.startsWith('reset-zh-') || label === 'sent-zh-320') await page.screenshot({ path: path.join(outputDir, `${label}.png`), captureBeyondViewport: false })
  assert.ok(layout.top >= layout.panelTop - 1 && layout.bottom <= layout.panelBottom + 1 && layout.width <= layout.viewportWidth + 1, `${label}: clipped layout ${JSON.stringify(layout)}`)
}
async function completeReset() {
  await page.type('#new-pw', 'new-password123')
  if (await page.$eval('#confirm-pw', (el) => el.getBoundingClientRect().height === 0)) {
    await page.click('button[type="submit"]')
    await page.waitForFunction(() => document.querySelector('#confirm-pw').getBoundingClientRect().height > 0)
  }
  await page.type('#confirm-pw', 'different-password')
  const before = requests.length
  await page.click('button[type="submit"]')
  await page.waitForSelector('[role="alert"]')
  assert.equal(requests.length, before, 'A mismatched confirmation must not call reset')
  await page.$eval('#confirm-pw', (el) => { el.focus(); el.select() })
  await page.type('#confirm-pw', 'new-password123')
  await page.click('button[type="submit"]')
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 360 }]) {
    await page.setViewport(viewport)
    for (const locale of Object.keys(messages)) {
      await visit(`/reset-password?lang=${locale}#token=${token}`)
      await title(messages[locale].forgot.resetTitle)
      assert.equal(await page.evaluate(() => document.documentElement.lang), locale)
      await fits(`reset-${locale}-${viewport.width}`)
      await completeReset()
      await title(messages[locale].forgot.resetSuccess)
      assert.equal(new URL(page.url()).hash, '', 'Consumed reset token must leave the URL')
      assert.deepEqual(requests.at(-1).body, { token, new_password: 'new-password123' })
      await fits(`done-${locale}-${viewport.width}`)
      await visit('/forgot-password')
      await page.type('#forgot-email', 'account@example.test')
      await page.click('button[type="submit"]')
      await title(messages[locale].forgot.sentTitle)
      assert.equal(requests.at(-1).body.locale, locale)
      assert.equal(await page.$('#reset-code'), null, 'Recovery must not ask for a verification code')
      await fits(`sent-${locale}-${viewport.width}`)
      console.log(`PASS: ${locale} at ${viewport.width}x${viewport.height}`)
    }
  }
  await page.setViewport({ width: 1280, height: 800 })
  await visit('/register')
  await page.type('#register-name', 'Email Test')
  await page.type('#register-email', 'account@example.test')
  if (await page.$eval('#register-pw', (el) => el.getBoundingClientRect().height === 0)) await page.click('button[type="submit"]')
  await page.type('#register-pw', 'new-password123')
  await page.click('.login-agreement input')
  await page.click('button[type="submit"]')
  await page.waitForSelector('#register-code')
  assert.equal(requests.at(-1).body.locale, 'fr', 'Registration email must use current site language')
  await page.click('.login-resend')
  await page.waitForFunction(() => !document.querySelector('.login-resend')?.disabled)
  assert.equal(requests.at(-1).path, '/api/auth/send-code')
  assert.equal(requests.at(-1).body.locale, 'fr', 'Verification resend must use current site language')

  failSend = true
  await visit('/forgot-password')
  await page.type('#forgot-email', 'account@example.test')
  await page.click('button[type="submit"]')
  await page.waitForSelector('[role="alert"]')
  assert.ok(await page.$('#forgot-email'), 'Network failure must stay on the request form')
  failSend = false
  invalidToken = true
  await visit(`/reset-password?lang=zh#token=${token}`)
  await completeReset()
  await title(messages.zh.forgot.invalidTitle)
  invalidToken = false
  await visit('/reset-password?lang=ja')
  await title(messages.ja.forgot.invalidTitle)

  entryMode = 'auto_redirect'
  await visit(`/reset-password?lang=zh-Hant#token=${token}`)
  await title(messages['zh-Hant'].forgot.resetTitle)
  assert.equal(new URL(page.url()).pathname, '/reset-password')
  await visit('/forgot-password')
  assert.equal(new URL(page.url()).pathname, '/forgot-password', 'OAuth auto redirect must not hijack recovery')
  authenticated = true
  await visit(`/reset-password?lang=zh#token=${token}`)
  await title(messages.zh.forgot.resetTitle)
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh', 'Email link language must survive session hydration')
  assert.deepEqual(errors, [])
  console.log(`PASS: registration/resend language, reset link flow, five languages, desktop/mobile layouts, mismatch/failure/expired states, OAuth entry and authenticated language. Screenshots: ${outputDir}`)
} finally { await browser.close() }

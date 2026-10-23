import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.AIVORY_AUTH_LAYOUT_TEST_URL || 'http://127.0.0.1:5176'
const executablePath = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
assert.ok(executablePath, 'Chrome is required')
const outputDir = path.join(tmpdir(), 'aivory-account-status')
mkdirSync(outputDir, { recursive: true })
const locales = Object.fromEntries(['en', 'zh', 'zh-Hant', 'ja', 'fr'].map((locale) => [locale, JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${locale}/auth.json`, import.meta.url), 'utf8'))]))
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 20000, args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
let mode = 'login_page'
let contact = 'support@example.test'
let locale = 'zh'
let theme = 'light'
let failLogin = false
const errors = []
const oauthRequests = []
let sessionProbes = 0
page.on('pageerror', (error) => errors.push(String(error)))
await page.setRequestInterception(true)
page.on('request', (request) => {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/')) return void request.continue()
  if (url.pathname === '/api/auth/session') sessionProbes++
  if (url.pathname.includes('/oauth/') && url.pathname.endsWith('/start')) {
    oauthRequests.push(url.pathname)
    return void request.respond({ status: 200, contentType: 'text/html', body: 'OAuth provider' })
  }
  if (url.pathname === '/api/auth/login' && failLogin) return void request.respond({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'account_suspended' }) })
  const provider = { id: 'test-provider', kind: 'oauth2', name: 'Identity provider' }
  const policy = { password_login_enabled: true, passkey_login_enabled: false, entry_mode: mode, default_provider: provider, providers: [provider], oauth_initial_password_policy: 'required' }
  const fixtures = {
    '/api/auth/session': { authenticated: false, auth_policy: policy },
    '/api/auth/logout': { ok: true },
    '/api/public/auth-policy': policy,
    '/api/public/needs-setup': { needs_setup: false },
    '/api/public/signup-open': { open: true, captcha_required: false, login_captcha_required: false },
    '/api/public/legal-config': { contact_email: contact, terms_text: '', privacy_text: '' },
    '/api/announcement': { enabled: false, bar_enabled: false },
  }
  return void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname] ?? {}) })
})

let initScript
async function visit(route, reset = true) {
  if (initScript) await page.removeScriptToEvaluateOnNewDocument(initScript.identifier)
  initScript = await page.evaluateOnNewDocument((lang, pref, clear) => {
    localStorage.setItem('aivory.lang', lang)
    localStorage.setItem('aivory.theme', pref)
    if (clear) sessionStorage.clear()
  }, locale, theme, reset)
  await page.goto(baseUrl + route, { waitUntil: 'networkidle0' })
}
async function suspended() {
  await page.waitForSelector('.account-suspended-page')
  await page.waitForFunction((expected) => document.querySelector('#suspension-title')?.textContent === expected, {}, locales[locale].suspended.title)
  assert.equal(new URL(page.url()).pathname, '/account-suspended')
  assert.equal(await page.$('.login-panel'), null, 'Suspension must have its own page')
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 360 }]) {
    await page.setViewport(viewport)
    for (locale of Object.keys(locales)) {
      await visit('/account-suspended')
      await suspended()
      await page.waitForSelector('.account-suspended-contact')
      assert.equal(await page.$eval('.account-suspended-contact', (el) => el.textContent), contact)
      assert.ok(await page.$eval('.account-suspended-footer', (el) => !el.textContent.includes('legal.')))
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${locale} overflow at ${viewport.width}`)
      if (locale === 'zh' && viewport.width >= 390) await page.screenshot({ path: path.join(outputDir, `suspended-${viewport.width}.png`), captureBeyondViewport: false })
      console.log(`PASS: suspended ${locale} at ${viewport.width}x${viewport.height}`)
    }
  }
  assert.equal(sessionProbes, 0, 'The suspended page must not restore a previous session')
  locale = 'zh'
  theme = 'dark'
  contact = 'admin@aivory.local'
  await page.setViewport({ width: 1440, height: 900 })
  await visit('/account-suspended')
  await suspended()
  assert.equal(await page.$('.account-suspended-contact'), null, 'Placeholder contact must not be presented as support')
  await page.screenshot({ path: path.join(outputDir, 'suspended-dark.png'), captureBeyondViewport: false })

  theme = 'light'
  failLogin = true
  await visit('/login')
  await page.waitForSelector('#email')
  await page.type('#email', 'banned@example.test')
  await page.type('#pw', 'password123')
  await page.click('button[type="submit"]')
  await suspended()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('aivory.account-suspended')), '1')
  // A full page load retains the account status and cannot restart auto SSO.
  await visit('/login', false)
  await suspended()
  await page.click('.account-suspended-switch')
  await page.waitForSelector('#email')
  assert.equal(new URL(page.url()).pathname, '/login')
  assert.equal(await page.evaluate(() => sessionStorage.getItem('aivory.account-suspended')), null)

  await visit('/login?oauth_error=account_disabled')
  await suspended()
  mode = 'auto_redirect'
  await visit('/account-suspended')
  await suspended()
  assert.equal(oauthRequests.length, 0, 'Suspension must not loop through an automatic provider redirect')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(`PASS: login, OAuth, refresh persistence, account switch, automatic SSO, placeholder contact and dark theme. Screenshots: ${outputDir}`)
} finally {
  await browser.close()
}

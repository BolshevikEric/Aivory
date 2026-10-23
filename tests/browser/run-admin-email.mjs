import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const base = process.env.AIVORY_AUTH_LAYOUT_TEST_URL || 'http://127.0.0.1:5176'
const executablePath = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
assert.ok(executablePath, 'Chrome required')
const output = path.join(tmpdir(), 'aivory-admin-email')
mkdirSync(output, { recursive: true })
const purposes = ['verify', 'reset', 'welcome', 'membership']
const locales = Object.fromEntries(['zh', 'en', 'zh-Hant', 'ja', 'fr'].map((locale) => [locale, JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${locale}/admin.json`, import.meta.url), 'utf8'))]))
let language = 'zh'
let settings = { smtp_host: 'smtp.example.test', smtp_port: '587', smtp_user: 'security@example.test', smtp_password: '••••••', smtp_from: 'Aivory <security@example.test>', smtp_tls: false }
let failSave = false
let failLoad = false
const mutations = []
const previewRequests = []
const errors = []
const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 20000, args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => { if (message.type() === 'error') console.error('Browser console:', message.text()) })
await page.setRequestInterception(true)
page.on('request', (request) => {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/')) return void request.continue()
  const policy = { password_login_enabled: true, passkey_login_enabled: false, entry_mode: 'login_page', default_provider: null, providers: [], oauth_initial_password_policy: 'required' }
  const user = { id: 'email-admin', email: 'admin@example.test', name: 'Administrator', role: 'admin', status: 'active', has_password: true, settings: { language, theme: 'light', onboarded: true, admin_onboarding_v1: 'completed' } }
  const fixtures = {
    '/api/auth/session': { authenticated: true, user, access_token: 'test-access', request_signing_key: 'test-signing', auth_policy: policy },
    '/api/me': user,
    '/api/public/auth-policy': policy,
    '/api/admin/onboarding': { status: 'completed', deployment_profile: 'full', required: [], optional: [], full_optional: [] },
    '/api/announcement': { enabled: false, bar_enabled: false },
    '/api/notifications': { notifications: [], total: 0 },
    '/api/me/credit-adjustment-notifications': { notifications: [] },
  }
  let body = fixtures[url.pathname] ?? {}
  let status = 200
  if (url.pathname === '/api/admin/settings') {
    if (request.method() === 'PATCH') {
      const patch = JSON.parse(request.postData())
      mutations.push(patch)
      if (failSave) { status = 400; body = { error: 'invalid input' } }
      else {
        settings = { ...settings, ...structuredClone(patch) }
        for (const account of settings.email_delivery.accounts) if (account.password) account.password = '••••••'
        body = settings
      }
    } else if (failLoad) { status = 503; body = { error: 'unavailable' } }
    else body = settings
  }
  if (url.pathname === '/api/admin/email/preview') {
    previewRequests.push(Object.fromEntries(url.searchParams))
    body = { subject: locales[language].emailDelivery.types[url.searchParams.get('purpose')].title, html: `<html lang="${language}"><body><h1>Preview</h1><p>Example email</p></body></html>` }
  }
  void request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
})
let initScript
async function visit() {
  if (initScript) await page.removeScriptToEvaluateOnNewDocument(initScript.identifier)
  initScript = await page.evaluateOnNewDocument((lang) => { if (window.top !== window) return; localStorage.setItem('aivory.lang', lang); localStorage.setItem('aivory.theme', 'light'); sessionStorage.clear() }, language)
  await page.goto(base + '/admin/settings/email', { waitUntil: 'networkidle0' })
}
async function waitFor(selector, hidden = false) {
  await page.waitForFunction((query, missing) => Boolean(document.querySelector(query)) !== missing, { polling: 100, timeout: 15000 }, selector, hidden)
}
async function clickText(text, selector = 'button') {
  const handle = await page.evaluateHandle((label, query) => [...document.querySelectorAll(query)].find((el) => el.textContent.trim() === label), text, selector)
  assert.ok(handle.asElement(), `Missing control ${text}`)
  await handle.asElement().evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await handle.asElement().focus()
  await page.keyboard.press('Space')
  await handle.dispose()
}
async function fill(selector, value) {
  await page.$eval(selector, (el) => { el.scrollIntoView({ block: 'center' }); el.focus(); el.select() })
  await page.type(selector, value)
}
async function choose(purpose, name) {
  await page.$eval(`#sender-${purpose}`, (el) => el.scrollIntoView({ block: 'center' }))
  await page.focus(`#sender-${purpose}`)
  await page.keyboard.press('Space')
  await waitFor('[role="option"]')
  await page.keyboard.press('End')
  await page.waitForFunction((expected) => document.activeElement?.textContent === expected, { polling: 100, timeout: 5000 }, name)
  await page.keyboard.press('Enter')
  await waitFor('[role="option"]', true)
  assert.ok((await page.$eval(`#sender-${purpose}`, (el) => el.textContent)).includes(name))
}
async function fits(label) {
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }))
  assert.ok(widths.page <= widths.viewport + 1, `${label} horizontal overflow: ${JSON.stringify(widths)}`)
}

try {
  await page.setViewport({ width: 1440, height: 1000 })
  await visit()
  await waitFor('#host-legacy')
  assert.equal(await page.$eval('#password-legacy', (el) => el.value), '••••••')
  assert.equal(await page.$$eval('[data-email-purpose]', (els) => els.length), 4)
  assert.equal(await page.$$eval('#enabled-verify, #enabled-reset', (els) => els.length), 0, 'Security emails must not offer an off switch')
  for (const purpose of ['welcome', 'membership']) assert.ok(await page.$(`#enabled-${purpose}`))
  await page.screenshot({ path: path.join(output, 'accounts-desktop.png'), captureBeyondViewport: false })
  await clickText(locales.zh.emailDelivery.addAccount)
  const id = await page.$$eval('[data-email-account]', (els) => els.at(-1).dataset.emailAccount)
  await fill(`#name-${id}`, 'Membership service')
  await fill(`#host-${id}`, 'members.smtp.example.test')
  await fill(`#user-${id}`, 'members@example.test')
  await fill(`#password-${id}`, 'new-mail-password')
  await fill(`#from-${id}`, 'Aivory <members@example.test>')
  await choose('membership', 'Membership service')
  await choose('welcome', 'Membership service')
  await page.$eval('#enabled-membership', (el) => el.scrollIntoView({ block: 'center' }))
  await page.click('#enabled-membership')
  assert.equal(await page.$eval('#enabled-membership', (el) => el.getAttribute('aria-checked')), 'false')
  const firstSave = page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PATCH')
  await clickText('保存')
  assert.equal((await firstSave).status(), 200)
  assert.equal(await page.$eval('#enabled-membership', (el) => el.getAttribute('aria-checked')), 'false')
  assert.equal(mutations.at(-1).email_delivery.rules.membership.enabled, false)
  assert.equal(mutations.at(-1).email_delivery.rules.membership.account_id, id)
  assert.equal(mutations.at(-1).email_delivery.accounts[0].password, '••••••')
  assert.equal(mutations.at(-1).email_delivery.accounts[1].password, 'new-mail-password')
  await visit()
  await waitFor('#sender-membership')
  assert.equal(await page.$eval('#enabled-membership', (el) => el.getAttribute('aria-checked')), 'false')
  assert.ok((await page.$eval('#sender-membership', (el) => el.textContent)).includes('Membership service'))
  await page.$eval('#email-types-title', (el) => el.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: path.join(output, 'types-desktop.png'), captureBeyondViewport: false })
  await choose('reset', 'Membership service')
  const secondSave = page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PATCH')
  await clickText('保存')
  assert.equal((await secondSave).status(), 200)
  assert.equal(mutations.at(-1).email_delivery.rules.reset.enabled, true)
  assert.equal(mutations.at(-1).email_delivery.rules.reset.account_id, id)
  for (const purpose of purposes) {
    await page.$eval(`[data-email-purpose="${purpose}"] button`, (el) => el.scrollIntoView({ block: 'center' }))
    await page.click(`[data-email-purpose="${purpose}"] button`)
    await waitFor('[role="dialog"] iframe')
    assert.deepEqual(previewRequests.at(-1), { purpose, locale: 'zh' })
    assert.equal(await page.$eval('[role="dialog"] iframe', (el) => el.getAttribute('sandbox')), '')
    await page.keyboard.press('Escape')
    await waitFor('[role="dialog"]', true)
  }
  failSave = true
  const failedSave = page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PATCH')
  await clickText('保存')
  assert.equal((await failedSave).status(), 400)
  await waitFor('[role="alert"]')
  assert.ok(await page.$eval('[role="alert"]', (el) => el.textContent.includes('SMTP')))
  failSave = false
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewport(viewport)
    for (language of Object.keys(locales)) {
      await visit()
      await waitFor('#sender-verify')
      await fits(`${language}-${viewport.width}`)
      assert.equal(await page.$eval('#email-types-title', (el) => el.textContent), locales[language].emailDelivery.typesTitle)
      await page.$eval('#email-types-title', (el) => el.scrollIntoView({ block: 'start' }))
      if (language === 'zh' && viewport.width === 390) await page.screenshot({ path: path.join(output, 'types-mobile.png'), captureBeyondViewport: false })
      console.log(`PASS: email settings ${language} at ${viewport.width}`)
    }
  }
  language = 'zh'
  failLoad = true
  await visit()
  await waitFor('[role="alert"]')
  assert.equal(await page.$('#sender-verify'), null)
  failLoad = false
  await clickText('再试一次')
  await waitFor('#sender-verify')
  settings.email_delivery.accounts[1].name = 'M'.repeat(100)
  await page.setViewport({ width: 320, height: 568 })
  await visit()
  await waitFor('#sender-reset')
  await page.$eval('#sender-reset', (el) => el.scrollIntoView({ block: 'center' }))
  const bounds = await page.$eval('#sender-reset', (el) => ({ right: el.getBoundingClientRect().right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  assert.ok(bounds.right <= 320 && bounds.scrollWidth <= bounds.clientWidth + 1, `Long account name overflow: ${JSON.stringify(bounds)}`)
  await page.focus('#sender-reset')
  await page.keyboard.press('Space')
  await waitFor('[role="option"]')
  assert.ok(await page.$eval('[role="listbox"]', (el) => el.getBoundingClientRect().right <= innerWidth))
  await page.keyboard.press('Escape')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(`PASS: account creation, legacy password retention, routing, optional switches, required emails, save/reload, four previews and error recovery. Screenshots: ${output}`)
} catch (error) {
  console.error('Page errors:', errors)
  console.error('Page text:', await page.evaluate(() => document.body.innerText))
  await page.screenshot({ path: path.join(output, 'failure.png'), captureBeyondViewport: false })
  throw error
} finally { await browser.close() }

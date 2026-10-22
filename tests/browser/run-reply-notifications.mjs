import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
const baseUrl = process.env.AIVORY_LAYOUT_TEST_URL || 'http://127.0.0.1:5188'
const output = '/tmp/aivory-reply-notifications'
await mkdir(output, { recursive: true })
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
await page.evaluateOnNewDocument(() => {
  const state = { permission: 'default', requests: 0, notices: [], route: null }
  class NotificationMock {
    static get permission() { return state.permission }
    static async requestPermission() { state.requests++; return (state.permission = 'granted') }
    constructor(title, options) { this.title = title; this.options = options; state.notices.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }
  window.Notification = NotificationMock
  window.__REPLY_NOTIFICATIONS__ = state
})
try {
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(`${baseUrl}/tests/browser/mobile-layout-harness.html?mode=settings&tab=notifications`)
  const toggle = '[data-settings-dialog] [role="switch"]'
  await page.waitForSelector(toggle)
  assert.equal(await page.$eval(toggle, (element) => element.getAttribute('aria-checked')), 'false')
  assert.equal(await page.evaluate(() => window.__REPLY_NOTIFICATIONS__.requests), 0)
  await page.click(toggle)
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'true', {}, toggle)
  assert.equal(await page.evaluate(() => window.__REPLY_NOTIFICATIONS__.requests), 1)
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === '/src/lib/reply-notifications.ts')?.name
    const notifications = await import(url)
    window.__REPLY_MODULE__ = notifications
    window.__STOP_REPLY_NOTIFICATIONS__ = notifications.startReplyNotifications((route) => { window.__REPLY_NOTIFICATIONS__.route = route })
    const conversation = { id: 'notification-fixture', title: 'Private title', modelId: 'm', messages: [], createdAt: 1, updatedAt: 1 }
    const message = { id: 'reply-fixture', role: 'assistant', content: 'Private body', streaming: false, createdAt: 1 }
    window.__REPLY_FIXTURE__ = { conversation, message }
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    notifications.publishReplyCompleted(conversation, message)
    notifications.publishReplyCompleted(conversation, message)
  })
  await page.waitForFunction(() => window.__REPLY_NOTIFICATIONS__.notices.length === 1)
  assert.equal(await page.evaluate(() => JSON.stringify(window.__REPLY_NOTIFICATIONS__.notices[0].options).includes('Private')), false)
  await page.evaluate(() => window.__REPLY_NOTIFICATIONS__.notices[0].onclick())
  await page.waitForFunction(() => window.__REPLY_NOTIFICATIONS__.route === '/chat/notification-fixture')
  await page.click(toggle)
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'false', {}, toggle)
  console.log('PASS: explicit permission request, persisted toggle, background completion, duplicate suppression and notification click')

  for (const language of ['zh', 'en', 'zh-Hant', 'ja', 'fr']) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
      await page.setViewport(viewport)
      await page.evaluate(() => window.__MOBILE_LAYOUT__.resetViewport())
      await page.evaluate((language) => {
        const stores = window.__MOBILE_LAYOUT__.stores
        stores.language.getState().setLang(language)
        stores.theme.getState().setPref(language === 'en' ? 'dark' : 'light')
      }, language)
      await page.waitForFunction(() => document.querySelector('[data-settings-dialog] h1')?.textContent && !document.querySelector('[data-settings-dialog]').textContent.includes('notifications.'))
      const bounds = await page.$eval('[data-settings-dialog]', (dialog) => {
        const rect = dialog.getBoundingClientRect()
        const switchRect = dialog.querySelector('[role="switch"]').getBoundingClientRect()
        return { rect: rect.toJSON(), switchRect: switchRect.toJSON(), scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, fits: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1 &&
          dialog.scrollWidth <= dialog.clientWidth + 1 && switchRect.right <= rect.right && switchRect.left >= rect.left
        }
      })
      await page.screenshot({ path: `${output}/${language}-${viewport.width}.png` })
      assert.equal(bounds.fits, true, `${language} ${viewport.width}: ${JSON.stringify(bounds)}`)
    }
  }
  console.log('PASS: five locales, light/dark themes and three desktop/mobile sizes')
  await page.evaluate(() => {
    window.__REPLY_NOTIFICATIONS__.permission = 'denied'
    window.dispatchEvent(new Event('focus'))
  })
  await page.waitForFunction((selector) => document.querySelector(selector)?.disabled === true, {}, toggle)
  assert.equal(await page.evaluate(() => window.__REPLY_NOTIFICATIONS__.requests), 1)
  assert.ok(await page.$eval('[data-settings-dialog] [role="status"]', (element) => element.textContent.length > 20))
  await page.evaluate(() => {
    window.__REPLY_NOTIFICATIONS__.permission = 'granted'
    window.dispatchEvent(new Event('focus'))
  })
  await page.waitForFunction((selector) => document.querySelector(selector)?.disabled === false, {}, toggle)
  console.log('PASS: blocked permissions disable the switch and recovering site permission restores it')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.AIVORY_SHARE_TEST_URL || 'http://127.0.0.1:5184'
const executablePath = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable')

const policy = {
  password_login_enabled: true, passkey_login_enabled: true, entry_mode: 'auto_redirect',
  default_provider: { id: 'test-provider' }, oauth_initial_password_policy: 'required',
}
const user = {
  id: 'share-viewer', email: 'viewer@example.test', name: 'Viewer', role: 'user', status: 'active',
  has_password: true, created_at: 1, settings: { onboarded: true, language: 'zh', theme: 'light' },
}
const snapshot = {
  title: 'Browser share regression', created_at: 1,
  messages: [{ role: 'assistant', created_at: 1, attachments: [], citations: [],
    blocks: [{ kind: 'text', text: 'Shared content remains visible after the session is restored.' }] }],
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
    for (const scenario of ['anonymous', 'hydrating', 'retry', 'missing']) {
      const page = await browser.newPage()
      // Production registers a passthrough service worker. Keep fixture
      // requests on the page so Puppeteer's API interception can answer them.
      await page.setBypassServiceWorker(true)
      const errors = []
      const requestErrors = []
      let shareRequests = 0
      let shareStarted
      const shareRequested = new Promise((resolve) => { shareStarted = resolve })
      let sessionSent
      const sessionResponded = new Promise((resolve) => { sessionSent = resolve })
      page.on('pageerror', (error) => errors.push(String(error)))
      await page.setViewport(viewport)
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('aivory.lang', 'zh')
        localStorage.setItem('aivory.theme', 'light')
      })
      await page.setRequestInterception(true)
      page.on('request', (request) => {
        void (async () => {
          const route = new URL(request.url()).pathname
          if (!route.startsWith('/api/')) { await request.continue(); return }
          let body = {}
          let status = 200
          if (route === '/api/auth/session') {
            if (scenario === 'hydrating') await shareRequested
            body = { authenticated: scenario === 'hydrating', user: scenario === 'hydrating' ? user : null,
              access_token: 'restored-token', request_signing_key: 'restored-key', auth_policy: policy }
          } else if (route === '/api/public/shared/browser-fixture') {
            shareRequests += 1
            shareStarted()
            if (scenario === 'hydrating') {
              await sessionResponded
              await page.waitForFunction(() => document.body.textContent.includes('克隆到我的对话'))
            }
            const headers = request.headers()
            for (const name of ['authorization', 'cookie', 'x-req-token', 'x-device-id']) {
              assert.equal(headers[name], undefined, `Public share sent ${name}`)
            }
            status = scenario === 'missing' ? 404 : scenario === 'retry' && shareRequests === 1 ? 429 : 200
            body = status === 200 ? snapshot : { error: status === 404 ? 'not found' : 'rate limited' }
          } else {
            body = {
              '/api/public/auth-policy': policy, '/api/public/needs-setup': { needs_setup: false },
              '/api/public/signup-open': { open: true }, '/api/me': user,
              '/api/notifications': { notifications: [], total: 0 },
              '/api/announcement': { enabled: false, bar_enabled: false },
            }[route] || {}
          }
          await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
          if (route === '/api/auth/session') sessionSent()
        })().catch((error) => requestErrors.push(String(error)))
      })

      try {
        await page.goto(`${baseUrl}/share/browser-fixture`, { waitUntil: 'domcontentloaded' })
        if (scenario === 'retry') {
          await page.waitForSelector('[role="alert"] button')
          assert.ok(await page.$eval('[role="alert"]', (node) => node.textContent.includes('暂时无法加载分享')))
          await page.screenshot({ path: path.join(tmpdir(), `aivory-share-retry-error-${viewport.width}.png`) })
          await page.click('[role="alert"] button')
        }
        if (scenario === 'missing') {
          await page.waitForFunction(() => document.body.textContent.includes('该分享不可用'))
          assert.equal(await page.$('[role="alert"]'), null)
        } else {
          await page.waitForSelector('#shared-conversation-title')
          assert.ok(await page.$eval('main', (node) => node.textContent.includes('Shared content remains visible')))
          await page.screenshot({ path: path.join(tmpdir(), `aivory-share-${scenario}-${viewport.width}.png`) })
        }
        assert.equal(shareRequests, scenario === 'retry' ? 2 : 1)
        const fits = await page.evaluate(() => {
          const doc = document.scrollingElement
          return doc.scrollWidth <= innerWidth + 1 && doc.scrollHeight <= innerHeight + 1
        })
        assert.ok(fits, `${scenario} at ${viewport.width}px overflows the viewport`)
        assert.deepEqual(errors, [], 'Browser rendering errors')
        assert.deepEqual(requestErrors, [], 'Request interception errors')
        console.log(`PASS ${scenario} ${viewport.width}x${viewport.height}`)
      } catch (error) {
        await page.screenshot({ path: path.join(tmpdir(), 'aivory-share-failure.png') })
        console.error(JSON.stringify({ scenario, viewport, shareRequests, errors, requestErrors,
          online: await page.evaluate(() => navigator.onLine),
          url: page.url(), text: await page.$eval('body', (body) => body.innerText.slice(0, 2000)) }))
        throw error
      }
      await page.close()
    }
  }
} finally {
  await browser.close()
}

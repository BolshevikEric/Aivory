import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, preview } from 'vite'
import puppeteer from 'puppeteer-core'

const production = process.argv.includes('--production')
const entryPath = production ? readFileSync('dist/index.html', 'utf8').match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)[1] : '/src/main.tsx'
const output = join(tmpdir(), `aivory-startup-${production ? 'production' : 'dev'}`)
const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find((candidate) => candidate && existsSync(candidate))
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chrome executable')
await mkdir(output, { recursive: true })
let server
let browser
let origin
let passed = 0
const policy = { password_login_enabled: true, passkey_login_enabled: false, entry_mode: 'login_page', default_provider: null, oauth_initial_password_policy: 'required', oauth_auto_provision_enabled: true, providers: [] }

async function open(options = {}) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setBypassServiceWorker(true)
  page.setDefaultTimeout(30000)
  await page.setViewport(options.mobile ? { width: 320, height: 640, isMobile: true, deviceScaleFactor: 1 } : { width: 1280, height: 800 })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: options.systemDark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }])
  if (options.noScript) await page.setJavaScriptEnabled(false)
  await page.evaluateOnNewDocument((settings, languages) => {
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value)
    Object.defineProperty(navigator, 'languages', { value: languages })
  }, { 'aivory.lang': options.language || 'zh', 'aivory.theme': options.theme || 'light', 'aivory.accent': options.accent || 'violet', ...(options.storage || {}) }, options.languages || ['zh-CN'])
  let entry
  let session
  let lazy
  let holdingSession = options.holdSession
  let navigations = 0
  const requests = []
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    requests.push(url.pathname)
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++
    if (request.resourceType() === 'script' && url.pathname === entryPath) {
      if (options.entry === 'hold') { entry = request; return }
      if (options.entry === 'fail') { void request.abort('failed'); return }
      if (options.entry === 'throw') { void request.respond({ contentType: 'text/javascript', body: 'throw new Error("Simulated startup exception")' }); return }
      if (options.entry === 'reject') { void request.respond({ contentType: 'text/javascript', body: 'Promise.reject(new Error("Simulated startup rejection"))' }); return }
      if (options.entry === 'syntax') { void request.respond({ contentType: 'text/javascript', body: 'const =' }); return }
      if (options.entry === 'empty') { void request.respond({ contentType: 'text/javascript', body: 'void 0' }); return }
    }
    if (url.pathname === '/src/pages/auth/AuthLayout.tsx' || /^\/assets\/AuthLayout-[^/]+\.js$/.test(url.pathname)) {
      if (options.holdLazy) { lazy = request; return }
      if (options.lazyFail) { void request.abort('failed'); return }
    }
    if (url.pathname === '/broken-startup.css') { void request.abort('failed'); return }
    if (url.pathname.startsWith('/api/')) {
      if (holdingSession && url.pathname === '/api/auth/session') { session = request; return }
      const body = url.pathname === '/api/auth/session' ? { authenticated: false, auth_policy: policy }
        : url.pathname === '/api/public/auth-policy' ? policy
        : url.pathname === '/api/public/needs-setup' ? { needs_setup: false }
        : url.pathname === '/api/public/signup-open' ? { open: true, captcha_required: false, login_captcha_required: false }
        : url.pathname === '/api/public/announcement' ? { enabled: false }
        : {}
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }); return
    }
    void request.continue()
  })
  const navigation = page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // A pending module delays DOMContentLoaded; inspect the already-parsed splash.
  if (options.entry === 'hold') await page.waitForSelector('[data-startup-screen="static"]')
  else await navigation
  return {
    page, context, requests, errors, navigation,
    entry: () => entry, session: () => session, lazy: () => lazy, navigations: () => navigations,
    async releaseSession() {
      holdingSession = false
      await session.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false, auth_policy: policy }) })
    },
    async close() {
      if (entry && !entry.isInterceptResolutionHandled()) await entry.abort().catch(() => {})
      if (session && !session.isInterceptResolutionHandled()) await session.abort().catch(() => {})
      if (lazy && !lazy.isInterceptResolutionHandled()) await lazy.abort().catch(() => {})
      await context.close()
      await navigation.catch(() => {})
    },
  }
}

async function geometry(page) {
  return page.evaluate(() => {
    const splash = document.querySelector('.aivory-startup')
    const box = (selector) => {
      const rect = splash.querySelector(selector).getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const style = getComputedStyle(splash)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    context.fillStyle = style.backgroundColor
    context.fillRect(0, 0, 1, 1)
    const backgroundHex = '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('')
    return {
      brand: box('.aivory-startup-brand'), dots: box('.aivory-startup-dots'), status: box('.aivory-startup-status'),
      background: style.backgroundColor, color: style.color, accent: getComputedStyle(splash.querySelector('circle')).fill,
      themeColor: document.querySelector('meta[name="theme-color"]').content, backgroundHex,
      mask: getComputedStyle(splash.querySelector('.aivory-startup-wordmark')).maskImage,
      scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
    }
  })
}

async function check(name, run) {
  await run()
  passed++
  console.log('PASS', name)
}

try {
  if (production) {
    server = await preview({ preview: { host: '127.0.0.1', port: 4178, strictPort: false } })
  } else {
    server = await createServer({ server: { host: '127.0.0.1', port: 5178, strictPort: false } })
    await server.listen()
  }
  origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await puppeteer.launch({ executablePath, headless: true })

  await check('five-second slow message, stable geometry, manual reload, no automatic refresh', async () => {
    const run = await open({ entry: 'hold', mobile: true })
    try {
      const initial = await geometry(run.page)
      assert.equal(await run.page.$eval('.aivory-startup-message', (element) => element.textContent), '')
      await run.page.waitForFunction(() => document.querySelector('[data-startup-screen]').dataset.state === 'slow')
      assert.equal(await run.page.$eval('.aivory-startup-message', (element) => element.textContent), '加载时间较长')
      assert.deepEqual((await geometry(run.page)).brand, initial.brand)
      assert.ok(initial.mask.startsWith('url("data:image/svg+xml;base64,'))
      assert.equal(initial.scrollWidth, initial.width)
      await run.page.screenshot({ path: join(output, 'slow-mobile.png') })
      await run.entry().abort('failed')
      await run.navigation
      await run.page.waitForSelector('[data-state="failed"] button:not([hidden])')
      assert.equal(await run.page.$eval('.aivory-startup-message', (element) => element.textContent), '页面加载失败')
      assert.deepEqual((await geometry(run.page)).brand, initial.brand)
      assert.equal(run.navigations(), 1)
      await run.page.screenshot({ path: join(output, 'failed-mobile.png') })
      await run.page.click('.aivory-startup-reload')
      await run.page.waitForFunction(() => window.aivoryStartup.getState() === 'loading')
      assert.equal(run.navigations(), 2)
    } finally { await run.close() }
  })

  for (const entry of ['throw', 'reject', 'syntax']) await check(`${entry} before React starts shows failure`, async () => {
    const run = await open({ entry })
    try {
      await run.page.waitForSelector('[data-state="failed"] button:not([hidden])')
      assert.equal(run.navigations(), 1)
    } finally { await run.close() }
  })

  await check('stylesheet failure uses the self-contained startup failure screen', async () => {
    const run = await open({ entry: 'empty' })
    try {
      await run.page.evaluate(() => {
        const stylesheet = document.createElement('link')
        stylesheet.rel = 'stylesheet'
        stylesheet.href = '/broken-startup.css'
        document.head.appendChild(stylesheet)
      })
      await run.page.waitForSelector('[data-state="failed"] button:not([hidden])')
    } finally { await run.close() }
  })

  await check('multiline French status fits the reserved mobile space without shifting the brand', async () => {
    const run = await open({ entry: 'empty', mobile: true, language: 'fr' })
    try {
      const initial = await geometry(run.page)
      await run.page.waitForSelector('[data-state="slow"]')
      assert.deepEqual((await geometry(run.page)).brand, initial.brand)
      assert.equal(await run.page.evaluate(() => {
        const message = document.querySelector('.aivory-startup-message').getBoundingClientRect()
        const dots = document.querySelector('.aivory-startup-dots').getBoundingClientRect()
        return message.top >= dots.bottom + 4
      }), true)
      await run.page.screenshot({ path: join(output, 'slow-french-mobile.png') })
    } finally { await run.close() }
  })

  for (const [language, text] of [['zh', '页面加载失败'], ['zh-Hant', '頁面載入失敗'], ['en', 'Page failed to load'], ['ja', 'ページを読み込めませんでした'], ['fr', 'Le chargement de la page a échoué']]) {
    await check(`preboot localizes ${language} without downloading the entry`, async () => {
      const run = await open({ entry: 'fail', language })
      try {
        await run.page.waitForSelector('[data-state="failed"]')
        assert.equal(await run.page.$eval('html', (element) => element.lang), language)
        assert.equal(await run.page.$eval('.aivory-startup-message', (element) => element.textContent), text)
      } finally { await run.close() }
    })
  }

  for (const theme of ['light', 'dark']) for (const accent of ['violet', 'lagoon', 'ember', 'moss', 'indigo', 'rose', 'mono']) {
    await check(`${theme}/${accent} has identical static and React colors and dimensions`, async () => {
      const run = await open({ entry: 'hold', holdSession: true, theme, accent, systemDark: theme === 'light' })
      try {
        const initial = await geometry(run.page)
        assert.equal(initial.themeColor, initial.backgroundHex)
        await run.page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, {}, theme)
        await run.entry().continue()
        await run.navigation
        await run.page.waitForSelector('[data-startup-screen="react"]')
        const rendered = await geometry(run.page)
        assert.deepEqual(rendered.brand, initial.brand)
        assert.deepEqual(rendered.dots, initial.dots)
        assert.deepEqual(rendered.status, initial.status)
        assert.equal(rendered.background, initial.background)
        assert.equal(rendered.color, initial.color)
        assert.equal(rendered.accent, initial.accent)
        assert.equal(rendered.themeColor, rendered.backgroundHex)
        await run.page.screenshot({ path: join(output, `${theme}-${accent}.png`) })
        await run.page.waitForFunction(() => window.aivoryStartup.getState() === 'ready')
        assert.equal(await run.page.$('[data-startup-screen="static"]'), null)
        await run.page.waitForFunction(() => Boolean(document.querySelector('[data-startup-screen="react"]')))
        // Auth API latency continues the same loading UI without declaring local resource failure.
        assert.notEqual(await run.page.$eval('[data-startup-screen="react"]', (element) => element.dataset.state), 'failed')
        while (!run.session()) await new Promise((resolve) => setTimeout(resolve, 20))
        await run.releaseSession()
        await run.page.waitForSelector('input[type="password"]').catch(async (error) => {
          console.error({ body: await run.page.$eval('body', (element) => element.innerText), errors: run.errors, requests: run.requests.filter((request) => request.startsWith('/api/')) })
          throw error
        })
        assert.equal(await run.page.$('.aivory-startup'), null)
        assert.equal(await run.page.title(), 'Aivory')
        assert.deepEqual(run.errors, [])
        if (theme === 'light' && accent === 'violet') {
          await run.page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { error: new Error('Unrelated error after boot') })))
          await new Promise((resolve) => setTimeout(resolve, 5500))
          assert.equal(await run.page.$('.aivory-startup'), null)
          assert.equal(await run.page.evaluate(() => window.aivoryStartup.getState()), 'ready')
        }
      } finally { await run.close() }
    })
  }

  await check('late lazy-module failure uses the React failure screen without auto-reloading', async () => {
    const run = await open({ lazyFail: true })
    try {
      await run.page.waitForSelector('[data-startup-screen="react"][data-state="failed"] button')
      assert.equal(run.navigations(), 1)
    } finally { await run.close() }
  })

  await check('consecutive auth and route loading screens share the initial five-second budget', async () => {
    const run = await open({ holdSession: true, holdLazy: true })
    try {
      await run.page.waitForSelector('[data-startup-screen="react"]')
      const initial = await geometry(run.page)
      const elapsed = await run.page.evaluate(() => Date.now() - window.aivoryStartup.startedAt)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 3500 - elapsed)))
      assert.ok(run.session())
      await run.releaseSession()
      const deadline = Date.now() + 30000
      while (!run.lazy() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(run.lazy(), 'AuthLayout should be waiting for its module')
      await run.page.waitForSelector('[data-startup-screen="react"][data-state="slow"]', { timeout: 2200 })
      assert.deepEqual((await geometry(run.page)).brand, initial.brand)
      await run.lazy().continue()
      await run.page.waitForSelector('input[type="password"]')
    } finally { await run.close() }
  })

  await check('browser-language fallback, invalid settings, ignored image errors, dynamic theme-color', async () => {
    const run = await open({ entry: 'empty', language: 'unsupported', languages: ['de-DE', 'zh-TW'], storage: { 'aivory.settings': '{invalid' } })
    try {
      assert.equal(await run.page.$eval('html', (element) => element.lang), 'zh-Hant')
      await run.page.evaluate(() => {
        const image = document.createElement('img')
        document.body.appendChild(image)
        image.dispatchEvent(new Event('error'))
        document.documentElement.dataset.theme = 'dark'
        document.documentElement.classList.add('dark')
        document.documentElement.dataset.accent = 'moss'
      })
      assert.equal(await run.page.$eval('[data-startup-screen]', (element) => element.dataset.state), 'loading')
      const current = await geometry(run.page)
      assert.equal(current.themeColor, current.backgroundHex)
      const viewport = await run.page.$eval('meta[name="viewport"]', (element) => element.content)
      assert.ok(!viewport.includes('user-scalable=no') && !viewport.includes('maximum-scale'))
    } finally { await run.close() }
  })

  await check('JavaScript-disabled help is visible above the startup layer', async () => {
    const run = await open({ noScript: true, mobile: true })
    try {
      assert.equal(await run.page.$eval('[data-startup-screen]', (element) => getComputedStyle(element).display), 'none')
      assert.equal(await run.page.$eval('.aivory-noscript', (element) => document.elementFromPoint(innerWidth / 2, innerHeight / 2) === element || element.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2))), true)
      await run.page.screenshot({ path: join(output, 'noscript-mobile.png') })
    } finally { await run.close() }
  })
  console.log(`${passed} startup browser checks passed (${production ? 'production' : 'dev'}). Screenshots: ${output}`)
} finally {
  await browser?.close()
  await server?.close()
}

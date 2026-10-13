import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { preview } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path))
if (!executablePath) throw new Error('Set CHROME_PATH to a local Chrome or Edge executable')
if (!existsSync('dist/version.json')) throw new Error('Run npm run build before the foreground browser regression')
const bootVersion = JSON.parse(readFileSync('dist/version.json', 'utf8')).version
const output = resolve(process.env.FOREGROUND_OUTPUT || join(tmpdir(), 'aivory-foreground-results'))
const temporary = await mkdtemp(join(tmpdir(), 'aivory-foreground-browser-'))
await mkdir(output, { recursive: true })
const results = []
let server
let browser
let counts = {}
let profileLanguage = 'zh'
let deployedVersion = bootVersion

const administrator = {
  id: 'foreground-admin', name: 'Administrator', email: 'admin@example.test', role: 'admin',
  status: 'active', created_at: 1, has_password: true,
  settings: { language: 'zh', theme: 'light', onboarded: true, admin_onboarding_v1: 'completed' },
}
const target = { ...administrator, id: 'foreground-target', name: 'Target user', role: 'user' }
const conversation = {
  id: 'foreground-conv', user_id: target.id, title: 'Foreground regression conversation',
  active_leaf_id: 'branch-a', model_id: 'foreground-model', model_label: 'Regression model', created_at: 1, updated_at: 2,
}
const messages = [
  { id: 'question', conversation_id: conversation.id, role: 'user', created_at: 1,
    blocks: [{ kind: 'text', text: 'Inspect both answers and retain the reading state when returning to this conversation.' }] },
  ...['a', 'b'].map((branch, index) => ({
    id: `branch-${branch}`, parent_id: 'question', conversation_id: conversation.id,
    role: 'assistant', created_at: index + 2, status: 'complete', model_id: 'foreground-model',
    blocks: [
      { kind: 'thinking', text: `Reasoning for branch ${branch.toUpperCase()}.\n\n` + 'A paragraph of persisted reasoning.\n\n'.repeat(30) },
      { kind: 'text', text: `Answer ${branch.toUpperCase()}.\n\n` + 'A paragraph of the inspected answer.\n\n'.repeat(30) },
    ],
  })),
]

function fixture(path) {
  if (path === '/api/auth/session') return {
    authenticated: true, user: administrator, access_token: 'foreground-fixture', request_signing_key: 'foreground-fixture-key',
    auth_policy: { password_login_enabled: true, entry_mode: 'login_page', oauth_initial_password_policy: 'required', providers: [] },
  }
  if (path === '/api/me') return { ...administrator, settings: { ...administrator.settings, language: profileLanguage } }
  if (path === '/api/me/settings') return administrator.settings
  if (path === '/api/notifications') return { notifications: [], total: 0 }
  if (path === '/api/me/domain-data') return { needs_action: false }
  if (path === '/api/admin/system-update' || path === '/api/admin/desktop-update' || path === '/api/public/desktop-download') return {}
  if (path === '/api/models' || path === '/api/image-models') return {
    models: [{ id: 'foreground-model', label: 'Regression model', kind: 'chat', enabled: true, tags: [] }], default_id: 'foreground-model',
  }
  if (path === `/api/admin/conversations/${conversation.id}`) return conversation
  if (path === `/api/admin/conversations/${conversation.id}/messages`) return messages
  if (path === '/api/admin/users') return { users: [target], total: 1, limit: 200, offset: 0 }
  if (path === `/api/admin/users/${target.id}`) return target
  if (path === `/api/admin/users/${target.id}/conversations`) return [conversation]
  return []
}

try {
  server = await preview({
    preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} }, logLevel: 'warn',
    plugins: [{
      name: 'foreground-api-fixtures',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url, 'http://foreground.invalid').pathname
          if (path === '/version.json') {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ version: deployedVersion }))
          } else if (path.startsWith('/api/')) {
            counts[path] = (counts[path] || 0) + 1
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify(fixture(path)))
          } else next()
        })
      },
    }],
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({
    executablePath, headless: true, userDataDir: join(temporary, 'profile'),
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  })
  for (const viewport of [
    { width: 390, height: 844, isMobile: true, hasTouch: true },
    { width: 1280, height: 900 },
  ]) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    const errors = []
    counts = {}
    let navigations = 0
    profileLanguage = 'zh'
    deployedVersion = bootVersion
    page.setDefaultTimeout(30_000)
    await page.setViewport(viewport)
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    page.on('pageerror', (error) => { errors.push(String(error)); console.error('[browser]', String(error)) })
    page.on('console', (message) => { if (message.type() === 'error') console.error('[console]', message.text()) })
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++ })
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('aivory.lang', 'zh')
      window.__foregroundBoot = crypto.randomUUID()
      window.__foregroundOffset = 0
      window.__foregroundVisibility = 'visible'
      const now = Date.now.bind(Date)
      Date.now = () => now() + window.__foregroundOffset
      Object.defineProperty(document, 'visibilityState', { get: () => window.__foregroundVisibility })
    })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (process.env.FOREGROUND_DEBUG && url.protocol.startsWith('http')) console.log('Request', request.method(), url.pathname)
      if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) {
        await request.abort()
        return
      }
      await request.continue()
    })

    const path = `/admin/users/${target.id}/conversations/${conversation.id}`
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle0' })
    if (process.env.FOREGROUND_DEBUG) {
      console.log('Loaded', { url: page.url(), counts, errors })
      await page.screenshot({ path: join(output, `initial-${viewport.width}.png`) })
    }
    await page.waitForSelector('[data-message-id="branch-a"]')
    const next = '[data-message-id="branch-a"] span[aria-label] > button:has(.lucide-chevron-right)'
    await page.click(next)
    await page.waitForSelector('[data-message-id="branch-b"]')
    await page.click('[data-message-id="branch-b"] button[aria-expanded]')
    const initialScroll = await page.evaluate(() => {
      window.__foregroundNode = document.querySelector('[data-message-id="branch-b"]')
      let scroll = window.__foregroundNode.parentElement
      while (scroll && (!/(auto|scroll)/.test(getComputedStyle(scroll).overflowY) || scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement
      if (!scroll) throw new Error('Missing conversation scroll container')
      window.__foregroundScroll = scroll
      scroll.scrollTop = 220
      return scroll.scrollTop
    })
    assert.ok(initialScroll > 0)
    const initialNavigations = navigations
    const initialBoot = await page.evaluate(() => window.__foregroundBoot)
    const initialDetails = counts[`/api/admin/conversations/${conversation.id}`]
    const initialMessages = counts[`/api/admin/conversations/${conversation.id}/messages`]
    const initialProfiles = counts['/api/me'] || 0
    deployedVersion = 'foreground-next-deploy'
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'aivory.update-ready', newValue: 'foreground-next-deploy',
    })))
    for (const language of ['zh', 'zh', 'en']) {
      profileLanguage = language
      const previousProfiles = counts['/api/me'] || 0
      await page.evaluate(() => {
        window.__foregroundVisibility = 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
        window.__foregroundOffset += 31_001
        window.__foregroundVisibility = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
      })
      await page.waitForFunction(() => document.documentElement.lang === 'zh' || document.documentElement.lang === 'en')
      await page.waitForNetworkIdle({ idleTime: 300 })
      assert.equal(counts['/api/me'], previousProfiles + 1, 'focus and visibility must share one profile refresh')
      assert.equal(navigations, initialNavigations, 'app switching must not reload or navigate')
      const state = await page.evaluate(() => ({
        sameNode: document.querySelector('[data-message-id="branch-b"]') === window.__foregroundNode,
        expanded: window.__foregroundNode?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
        scrollTop: window.__foregroundScroll?.scrollTop,
        language: document.documentElement.lang,
        pathname: location.pathname,
      }))
      assert.equal(state.sameNode, true, 'the real MessageRow must stay mounted')
      assert.equal(state.expanded, 'true')
      assert.equal(state.language, language)
      assert.equal(state.pathname, path)
      if (language === 'zh') assert.ok(Math.abs(state.scrollTop - initialScroll) <= 2, 'reading position must be retained')
    }
    assert.equal(counts[`/api/admin/conversations/${conversation.id}`], initialDetails)
    assert.equal(counts[`/api/admin/conversations/${conversation.id}/messages`], initialMessages)
    assert.equal(counts['/api/me'], initialProfiles + 3)
    await page.screenshot({ path: join(output, `foreground-${viewport.width}.png`) })
    await page.$eval(`a[href="/admin/users/${target.id}/conversations"]`, (link) => link.click())
    if (process.env.FOREGROUND_DEBUG) console.log('Navigation triggered', { url: page.url(), navigations, initialNavigations })
    await page.waitForFunction(() => sessionStorage.getItem('aivory.version-reload'))
    await page.waitForFunction((previous) => window.__foregroundBoot !== previous, {}, initialBoot)
    await page.waitForFunction((expected) => location.pathname === expected, {}, `/admin/users/${target.id}/conversations`)
    await page.waitForSelector('tbody tr')
    assert.equal(new URL(page.url()).pathname, `/admin/users/${target.id}/conversations`)
    assert.ok(navigations > initialNavigations, 'a visible route navigation must apply the pending deployment')
    assert.equal(counts['/api/auth/session'], 2, 'the deployment must perform exactly one document reload')
    const marker = await page.evaluate(() => JSON.parse(sessionStorage.getItem('aivory.version-reload')))
    assert.equal(marker.v, 'foreground-next-deploy')
    assert.deepEqual(errors, [])
    results.push({ viewport, passed: true, initialScroll, initialDetails, initialMessages,
      foregroundProfileRefreshes: 3, appliedVersion: marker.v, errors })
    console.log(`PASS foreground ${viewport.width}x${viewport.height}`)
    await context.close()
  }
  await writeFile(join(output, 'results.json'), JSON.stringify({ browser: await browser.version(), results }, null, 2))
  console.log(`Results: ${output}`)
} finally {
  if (browser) await browser.close()
  if (server) await new Promise((done) => server.httpServer.close(done))
  await rm(temporary, { recursive: true, force: true })
}

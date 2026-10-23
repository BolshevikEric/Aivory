import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.AIVORY_LAYOUT_TEST_URL || 'http://127.0.0.1:5173'
const executablePath = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
assert.ok(executablePath, 'Chrome is required')
const output = path.join(tmpdir(), 'aivory-mobile-navigation')
mkdirSync(output, { recursive: true })
const errors = []
const moves = []
const policy = { password_login_enabled: true, passkey_login_enabled: true, entry_mode: 'login_page', default_provider: null, providers: [], oauth_initial_password_policy: 'required' }
const user = { id: 'navigation-user', email: 'navigation@example.test', name: 'Navigation', role: 'admin', status: 'active', has_password: true,
  settings: { language: 'zh', theme: 'light', onboarded: true, admin_onboarding_v1: 'completed' } }
const workspaces = Array.from({ length: 24 }, (_, i) => ({ id: `workspace-${i}`, name: `Workspace ${i + 1} ${'long name '.repeat(8)}`, owner_id: user.id, role: 'admin', is_owner: true, created_at: 1 }))
const projects = Array.from({ length: 30 }, (_, i) => ({ id: `project-${i}`, name: `Project ${i + 1} ${'long name '.repeat(8)}`, accent: 'violet', created_at: 1, updated_at: 1 }))
const conversations = [{ id: 'navigation-conversation', title: 'Navigation conversation', model_id: 'model', created_at: 1, updated_at: 1 }]
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
page.on('pageerror', (error) => errors.push(error.stack || String(error)))
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
await page.setRequestInterception(true)
page.on('request', (request) => {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/')) return void request.continue()
  if (url.pathname === '/api/conversations/navigation-conversation' && request.method() === 'PATCH') moves.push(JSON.parse(request.postData()))
  const fixtures = {
    '/api/auth/session': { authenticated: true, user, access_token: 'fixture-token', request_signing_key: 'fixture-key', auth_policy: policy },
    '/api/me': user, '/api/me/settings': user.settings,
    '/api/public/auth-policy': policy, '/api/public/site-status': { closed: false, message: '' },
    '/api/admin/onboarding': { status: 'completed', deployment_profile: 'full', required: [], optional: [], full_optional: [] },
    '/api/announcement': { enabled: false, bar_enabled: false }, '/api/notifications': { notifications: [], total: 0 },
    '/api/me/credit-adjustment-notifications': { notifications: [] },
    '/api/me/credits': { permanent: 100, available: 100, timed: { balance: 0, grants: [] } },
    '/api/workspaces': { workspaces }, '/api/projects': projects,
    '/api/conversations': { conversations: url.searchParams.has('project_id') ? [] : conversations, has_more: false },
    '/api/models': { models: [], default_id: '' }, '/api/image-models': { models: [], default_id: '' },
    '/api/library/catalog': { skills: [], prompts: [], mcp: [] },
  }
  const arrays = ['/api/skills', '/api/me/skills', '/api/me/prompts', '/api/me/mcps', '/api/model-tags', '/api/kbs', '/api/me/skill-commands']
  void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname] ?? (arrays.includes(url.pathname) ? [] : {})) })
})
await page.evaluateOnNewDocument(() => {
  if (window.top !== window || !['http:', 'https:'].includes(location.protocol)) return
  localStorage.setItem('aivory.lang', 'zh')
  localStorage.setItem('aivory.theme', 'light')
  localStorage.setItem('aivory.workspace', 'personal')
})

async function activate(selector, text) {
  const handle = await page.evaluateHandle((query, label) => [...document.querySelectorAll(query)].find((el) => label === undefined || el.textContent.trim() === label.trim()), selector, text)
  assert.ok(handle.asElement(), `Missing ${selector}: ${text}`)
  await handle.asElement().evaluate((el) => el.scrollIntoView({ block: 'nearest' }))
  if (page.viewport().hasTouch) await handle.asElement().tap()
  else await handle.asElement().click()
  await handle.dispose()
}
async function fit(selector, label) {
  await page.waitForSelector(selector, { timeout: 5000 })
  await page.waitForFunction((query) => [...document.querySelectorAll(query)].every((el) => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.left > -1000
  }), {}, selector)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const boxes = await page.$$eval(selector, (elements) => elements.map((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }))
  const viewport = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    const left = parseFloat(style.getPropertyValue('--surface-viewport-left')) || 0
    const top = parseFloat(style.getPropertyValue('--surface-viewport-top')) || 0
    return { left, top, right: left + parseFloat(style.getPropertyValue('--surface-viewport-width')), bottom: top + parseFloat(style.getPropertyValue('--surface-viewport-height')) }
  })
  for (const box of boxes) {
    const fits = box.width > 0 && box.height > 0 && box.left >= viewport.left + 7 && box.right <= viewport.right - 7 && box.top >= viewport.top + 7 && box.bottom <= viewport.bottom - 7
    assert.ok(fits, `${label}: ${JSON.stringify(box)} outside ${JSON.stringify(viewport)}`)
  }
}
async function accountSubmenu(label, placement) {
  await activate(placement === 'header' ? 'main button[aria-label="账户"]' : 'aside button[aria-label="账户"]')
  await fit('[role="menu"]', `${placement} account`)
  await activate('[role="menuitem"][aria-haspopup="menu"]', label)
  await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 2)
  await fit('[role="menu"]', `${placement} ${label}`)
  if (await page.evaluate(() => innerWidth < 640)) {
    await activate('[data-menu-back]')
    await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 1)
    assert.equal(await page.$eval('[role="menu"]', (el) => el.contains(document.activeElement)), true, 'Back restores focus to the parent menu')
    await activate('[role="menuitem"][aria-haspopup="menu"]', label)
    await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 2)
  }
  if (label === '工作空间') {
    await page.evaluate(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')].at(-1)
      const last = [...menu.querySelectorAll('[role="menuitem"]')].at(-1)
      last.scrollIntoView({ block: 'nearest' })
    })
    await fit('[role="menu"]', `${placement} workspace scrolled`)
  }
  await page.screenshot({ path: path.join(output, `${placement}-${label}-${await page.evaluate(() => innerWidth)}.png`) })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 0)
}

try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
    await page.setViewport({ ...viewport, isMobile: viewport.width < 1024, hasTouch: viewport.width < 1024 })
    await page.goto(baseUrl + '/', { waitUntil: 'networkidle0' })
    await page.waitForSelector('button[aria-label="账户"]')
    if (viewport.width < 1024) {
      await accountSubmenu('语言', 'header')
      await accountSubmenu('工作空间', 'header')
      await activate('button[aria-label="折叠 / 展开侧边栏"]')
      await page.waitForSelector('aside[data-variant="sheet"]')
    }
    await accountSubmenu('语言', 'sidebar')
    await accountSubmenu('工作空间', 'sidebar')
    await activate('aside button[aria-label="会话操作"]')
    await activate('[role="menuitem"][aria-haspopup="menu"]', '移动到项目')
    await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 2)
    await fit('[role="menu"]', 'move conversation')
    await page.screenshot({ path: path.join(output, `move-${viewport.width}.png`) })
    await Promise.all([
      page.waitForRequest((request) => request.url().endsWith('/api/conversations/navigation-conversation') && request.method() === 'PATCH'),
      activate('[role="menuitem"]', projects.at(-1).name),
    ])
    assert.deepEqual(moves.at(-1), { project_id: projects.at(-1).id })
    await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 0)
    await activate('[class~="group/toast"] button[aria-label="关闭"]')
    await page.waitForSelector('[class~="group/toast"]', { hidden: true })
    if (viewport.width < 1024) {
      await page.evaluate(() => {
        const probe = document.querySelector('[data-app-safe-area]')
        if (!probe) throw new Error('Missing safe area probe')
        probe.style.paddingTop = '47px'
        probe.style.paddingBottom = '34px'
        window.dispatchEvent(new Event('resize'))
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const bounds = await page.$eval('[data-slot="sheet-content"]', (el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
      assert.equal(Math.round(bounds.bottom), viewport.height, 'Navigation background reaches the viewport bottom')
      const footer = await page.$eval('aside button[aria-label="账户"]', (el) => el.getBoundingClientRect().bottom)
      assert.ok(footer <= viewport.height - 34, `Account controls remain clear of the home indicator: ${footer}`)
      const backgrounds = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-slot="sheet-content"]')).backgroundColor, getComputedStyle(document.querySelector('aside')).backgroundColor])
      assert.equal(backgrounds[0], backgrounds[1], 'Inset padding has the sidebar background')
      await page.screenshot({ path: path.join(output, `sidebar-safe-${viewport.width}.png`) })
      await accountSubmenu('语言', 'sidebar')
      await accountSubmenu('工作空间', 'sidebar')
      if (viewport.width === 390) {
        await activate('aside button[aria-label="账户"]')
        await activate('[role="menuitem"][aria-haspopup="menu"]', '语言')
        // Model Safari changing the visual viewport while layout size stays fixed.
        await page.evaluate(() => {
          Object.defineProperty(visualViewport, 'height', { configurable: true, value: 320 })
          Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 100 })
          visualViewport.dispatchEvent(new Event('resize'))
          visualViewport.dispatchEvent(new Event('scroll'))
        })
        await fit('[role="menu"]', 'menus follow the visual viewport')
        const visibleSidebar = await page.$eval('[data-slot="sheet-content"]', (el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
        assert.deepEqual(visibleSidebar, { top: 100, bottom: 420 })
        await page.evaluate(() => {
          delete visualViewport.height
          delete visualViewport.offsetTop
          visualViewport.dispatchEvent(new Event('resize'))
          visualViewport.dispatchEvent(new Event('scroll'))
        })
        await fit('[role="menu"]', 'menus recover after viewport expansion')
        await page.keyboard.press('Escape')
      }
    }
    console.log(`PASS: navigation menus and sidebar ${viewport.width}x${viewport.height}`)
  }
  assert.deepEqual(errors, [])
  console.log(`Screenshots: ${output}`)
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') })
  console.error('Page errors:', errors)
  console.error('Interaction state:', await page.evaluate(() => {
    const button = document.querySelector('aside button[aria-label="账户"]')
    const box = button?.getBoundingClientRect()
    const hit = box && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return { bodyPointerEvents: getComputedStyle(document.body).pointerEvents, accountState: button?.getAttribute('data-state'), hit: hit?.outerHTML.slice(0, 300), zoom: visualViewport?.scale }
  }))
  throw error
} finally { await browser.close() }

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p))
if (!executablePath) throw new Error('Set CHROME_PATH')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', async request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) { await request.continue(); return }
    let body = []
    if (url.pathname === '/api/sandbox/availability') body = { available: true }
    if (url.pathname === '/api/me/skill-commands') body = [{ id: 'catalog:sk_visual', name: 'generative-ui', description: 'Visual answers', source_skill_id: 'sk_visual', instructions: '', icon: 'PanelsTopLeft', can_manage: false, created_at: 0, updated_at: 0 }, { id: 'usk_meeting', name: 'meeting-notes', description: 'Extract action items', instructions: '', icon: 'FileText', can_manage: true, created_at: 0, updated_at: 0 }]
    if (url.pathname === '/api/kbs') {
      await new Promise(resolve => setTimeout(resolve, 150))
      body = [{ id: 'kb-reference', user_id: 'composer-user', name: 'Reference library', description: '', created_at: 0 }]
    }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.evaluateOnNewDocument(() => {
    window.showDirectoryPicker = async () => {
      window.__FOLDER_PICKED__ = true
      throw new DOMException('Cancelled', 'AbortError')
    }
  })
  await page.setViewport({ width: 1024, height: 700 })
  await page.goto(`${origin}/tests/browser/composer-harness.html`)
  const shell = '.chat-composer-shell'
  await page.waitForSelector(`${shell}[data-height-ready="true"]`)
  const settled = async () => {
    try {
      await page.waitForFunction(() => {
        const shell = document.querySelector('.chat-composer-shell')
        return Math.abs(shell.offsetHeight - shell.querySelector('.chat-composer-body').offsetHeight) <= 1
      }, { timeout: 5000 })
    } catch (error) {
      const sizes = await page.$eval(shell, e => ({ shell: e.offsetHeight, body: e.querySelector('.chat-composer-body').offsetHeight, style: e.style.height, text: e.textContent }))
      throw new Error(`Composer did not settle: ${JSON.stringify(sizes)}`, { cause: error })
    }
  }
  const openMenu = () => page.click(`${shell} button[aria-label="${page.viewport().width < 640 ? 'More' : 'Features'}"]`)
  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-radix-popper-content-wrapper] [role="dialog"]'))
  }
  await settled()
  await openMenu()
  await page.waitForSelector('[data-radix-popper-content-wrapper]:has([role="dialog"]) button[aria-label="Knowledge bases"]')
  const menu = '[data-radix-popper-content-wrapper]:has([role="dialog"])'
  const menuText = await page.$eval(menu, e => e.textContent)
  assert.match(menuText, /Research/)
  assert.match(menuText, /Verify/)
  assert.doesNotMatch(menuText, /Plan, search the web|A second model|whole folder/)
  assert.equal(await page.$$eval(`${shell} button[aria-label="Knowledge bases"], ${shell} button[aria-label="Upload folder"]`, e => e.length), 0, 'resource actions must only appear inside the menu')
  const folderButton = await page.evaluateHandle(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper]:has([role="dialog"]) button')].find(e => e.textContent.trim() === 'Upload folder'))
  await folderButton.asElement().click()
  await page.waitForFunction(() => window.__FOLDER_PICKED__ === true)
  await page.waitForFunction(() => !document.querySelector('[data-radix-popper-content-wrapper]:has([role="dialog"])'))
  await openMenu()
  await page.click(`${menu} button[aria-label="Knowledge bases"]`)
  await page.waitForSelector('[data-composer-menu="knowledge-bases"]')
  assert.equal(await page.$eval('[data-composer-menu="knowledge-bases"] button[aria-label="Back"]', e => document.activeElement === e), true)
  await page.waitForSelector('[data-composer-menu="knowledge-bases"] button[aria-label="Reference library"]')
  await page.click('[data-composer-menu="knowledge-bases"] button[aria-label="Reference library"]')
  await page.waitForSelector(`${shell} button[aria-label="Remove knowledge base Reference library"]`)
  await settled()
  await page.keyboard.press('ArrowLeft')
  await page.waitForSelector(`${menu} button[aria-label="Knowledge bases"]`)
  assert.equal(await page.$eval(`${menu} button[aria-label="Knowledge bases"]`, e => document.activeElement === e), true)
  await closeMenu()

  await openMenu()
  await page.click(`${menu} button[aria-label="Skills"]`)
  await page.waitForSelector('[data-composer-menu="skills"]')
  assert.equal(await page.$eval('[data-composer-menu="skills"] button[aria-label="Back"]', e => document.activeElement === e), true)
  const defaultToggle = '[data-composer-menu="skills"] button[aria-label="Enable or remove skill generative-ui"]'
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'true')
  assert.doesNotMatch(await page.$eval('[data-composer-menu="skills"]', e => e.textContent), /Model defaults stay active in this chat/)
  await page.click(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'false')
  await page.click('[data-composer-menu="skills"] button[aria-label="Enable or remove skill meeting-notes"]')
  await page.waitForSelector(`${shell} button[aria-label="Remove skill meeting-notes"]`)
  await page.click('[data-composer-menu="skills"] input')
  await page.keyboard.type('no-match')
  await page.waitForFunction(() => document.querySelector('[data-composer-menu="skills"]').textContent.includes('No matching skills.'))
  await page.keyboard.press('ArrowLeft')
  assert(await page.$('[data-composer-menu="skills"]'), 'editing search must not navigate back')
  await page.click('[data-composer-menu="skills"] button[aria-label="Back"]')
  assert.equal(await page.$eval(`${menu} button[aria-label="Skills"]`, e => document.activeElement === e), true)
  await closeMenu()
  await page.click(`${shell} button[aria-label="Remove skill meeting-notes"]`)
  await page.waitForFunction(() => !document.querySelector('.chat-composer-shell button[aria-label="Remove skill meeting-notes"]'))
  await settled()

  // Record real rendered heights, rather than only checking a CSS declaration.
  const record = async action => page.evaluate(action => new Promise(resolve => {
    const shell = document.querySelector('.chat-composer-shell')
    const heights = [shell.getBoundingClientRect().height]
    const start = performance.now()
    const tick = () => {
      heights.push(shell.getBoundingClientRect().height)
      if (performance.now() - start > 350) resolve(heights)
      else requestAnimationFrame(tick)
    }
    if (action === 'add') window.__COMPOSER__.setKBIds(['kb-reference'])
    else if (action === 'remove') window.__COMPOSER__.setKBIds([])
    else window.__COMPOSER__.fillText(Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`).join('\n'))
    requestAnimationFrame(tick)
  }), action)
  const assertSmooth = heights => {
    const from = heights[0], to = heights.at(-1)
    assert(Math.abs(to - from) > 20, `Expected a meaningful height change: ${heights}`)
    assert(heights.some(height => height > Math.min(from, to) + 2 && height < Math.max(from, to) - 2), `Height jumped directly to its destination: ${heights}`)
  }
  assertSmooth(await record('remove'))
  assertSmooth(await record('add'))
  assertSmooth(await record('text'))
  await page.evaluate(() => window.__COMPOSER__.fillText(''))
  await settled()
  await page.click(`${shell} .tiptap`)
  await page.keyboard.type('/generative-ui')
  await page.waitForSelector('[role="option"]')
  const skill = await page.evaluateHandle(() => [...document.querySelectorAll('[role="option"]')].find(e => e.textContent.includes('generative-ui')))
  await skill.asElement().click()
  await page.waitForSelector(`${shell} button[aria-label="Remove skill generative-ui"]`)
  await settled()
  await openMenu()
  await page.click(`${menu} button[aria-label="Skills"]`)
  await page.waitForSelector(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'true', '/ must override a cancelled default as a manual selection for this turn')
  assert.match(await page.$eval('[data-composer-menu="skills"]', e => e.textContent), /Manual · this turn only/)
  assert.equal(await page.$$eval('[data-composer-menu="skills"] button[aria-label="Enable or remove skill generative-ui"]', e => e.length), 1, 'same skill must not render twice')
  await page.click(defaultToggle)
  await page.waitForFunction(() => !document.querySelector('.chat-composer-shell button[aria-label="Remove skill generative-ui"]'))
  await closeMenu()
  await page.click(`${shell} .tiptap`)
  await page.keyboard.type('/generative-ui')
  await page.waitForSelector('[role="option"]')
  await page.keyboard.press('Enter')
  await page.waitForSelector(`${shell} button[aria-label="Remove skill generative-ui"]`)
  await page.type(`${shell} .tiptap`, 'Use the reference library')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__COMPOSER_SUBMIT__)
  assert.deepEqual(await page.evaluate(() => window.__COMPOSER_SUBMIT__.selectedUserSkillIds), ['catalog:sk_visual'])
  assert.deepEqual(await page.evaluate(() => window.__COMPOSER_SUBMIT__.disabledModelSkillIds), ['sk_visual'])
  assert.equal(await page.$(`${shell} button[aria-label="Remove skill generative-ui"]`), null)
  await settled()

  await openMenu()
  await page.click(`${menu} button[aria-label="Skills"]`)
  await page.waitForSelector(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'false', 'manual override must leave the default disabled after sending')
  await closeMenu()
  await page.evaluate(() => { window.__COMPOSER_SUBMIT__ = undefined })
  await page.type(`${shell} .tiptap`, 'Plain reply')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__COMPOSER_SUBMIT__)
  assert.deepEqual(await page.evaluate(() => window.__COMPOSER_SUBMIT__.disabledModelSkillIds), ['sk_visual'])
  await openMenu()
  await page.click(`${menu} button[aria-label="Skills"]`)
  await page.waitForSelector(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'false', 'default exclusion must survive sending')
  await page.click(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'true', 're-selecting the default must restore it')
  assert.doesNotMatch(await page.$eval('[data-composer-menu="skills"]', e => e.textContent), /Manual · this turn only[\s\S]*generative-ui/)
  assert.equal(await page.$(`${shell} button[aria-label="Remove skill generative-ui"]`), null, 'restoring a default must not create a manual override')
  await page.click(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'false')
  await page.click(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'true', 'repeated cancel/restore must leave the last selection active')
  await closeMenu()
  await page.evaluate(() => { window.__COMPOSER_SUBMIT__ = undefined })
  await page.type(`${shell} .tiptap`, 'Reply with restored defaults')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__COMPOSER_SUBMIT__)
  assert.deepEqual(await page.evaluate(() => window.__COMPOSER_SUBMIT__.disabledModelSkillIds), [], 'restored default must be removed from request exclusions')
  assert.equal(await page.evaluate(() => window.__COMPOSER_SUBMIT__.selectedUserSkillIds), undefined, 'restored default must retain system authority')
  await openMenu()
  await page.click(`${menu} button[aria-label="Skills"]`)
  await page.waitForSelector(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'true', 'restored default must stay enabled after sending')
  await closeMenu()

  await page.click(`${shell} .tiptap`)
  await page.keyboard.type('/generative-ui')
  await page.waitForSelector('[role="option"]')
  await page.keyboard.press('Enter')
  await page.waitForSelector(`${shell} button[aria-label="Remove skill generative-ui"]`)
  await page.click(`${shell} button[aria-label="Remove skill generative-ui"]`)
  await page.waitForFunction(() => !document.querySelector('.chat-composer-shell button[aria-label="Remove skill generative-ui"]'))
  await openMenu()
  await page.click(`${menu} button[aria-label="Skills"]`)
  await page.waitForSelector(defaultToggle)
  assert.equal(await page.$eval(defaultToggle, e => e.getAttribute('aria-checked')), 'false', 'removing a manual chip must also cancel the same model default')
  await page.click(defaultToggle)
  await closeMenu()

  await mkdir('/tmp/aivory-composer', { recursive: true })
  for (const width of [360, 768, 1280]) {
    await page.setViewport({ width, height: 700 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') }, theme)
      await settled()
      await openMenu()
      await page.waitForSelector(`${menu} button[aria-label="Knowledge bases"]`)
      for (const locale of ['en', 'zh', 'zh-Hant', 'ja', 'fr']) {
        await page.evaluate(locale => window.__COMPOSER__.setLanguage(locale), locale)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${theme}/${locale} overflows`)
      }
      const rect = await page.$eval(menu, e => e.getBoundingClientRect().toJSON())
      assert(rect.left >= 0 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= 700)
      await page.waitForFunction(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper] [role="dialog"]')].every(e => e.getAnimations().every(animation => animation.playState !== 'running')))
      await page.screenshot({ path: `/tmp/aivory-composer/menu-${width}-${theme}.png` })
      await page.evaluate(() => window.__COMPOSER__.setLanguage('en'))
      await page.click(`${menu} button[aria-label="Skills"]`)
      await page.waitForSelector('[data-composer-menu="skills"]')
      for (const locale of ['en', 'zh', 'zh-Hant', 'ja', 'fr']) {
        await page.evaluate(locale => window.__COMPOSER__.setLanguage(locale), locale)
        await page.waitForFunction(() => [...document.querySelectorAll('[data-radix-popper-content-wrapper] [role="dialog"]')].every(e => e.getAnimations().every(animation => animation.playState !== 'running')))
        // Radix repositions after the submenu/translation changes its size.
        await page.waitForFunction(() => {
          const rect = document.querySelector('[data-radix-popper-content-wrapper]:has([role="dialog"])').getBoundingClientRect()
          return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight
        }, { timeout: 3000 })
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `skills ${width}/${theme}/${locale} overflows`)
        const skillRect = await page.$eval(menu, e => e.getBoundingClientRect().toJSON())
        assert(skillRect.left >= 0 && skillRect.right <= width + 1 && skillRect.top >= 0 && skillRect.bottom <= 700, `skills ${width}/${theme}/${locale} exceeds viewport: ${JSON.stringify(skillRect)}`)
      }
      await page.screenshot({ path: `/tmp/aivory-composer/skills-${width}-${theme}.png` })
      await closeMenu()
      await page.evaluate(() => window.__COMPOSER__.setLanguage('en'))
      await page.evaluate(() => window.__COMPOSER__.setLayout('home'))
      await page.evaluate(() => window.__COMPOSER__.setKBIds(['kb-reference']))
      await settled()
      await page.screenshot({ path: `/tmp/aivory-composer/input-${width}-${theme}.png` })
      assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'composer must not create page scrolling')
      await page.evaluate(() => window.__COMPOSER__.setLayout('thread'))
    }
  }
  await openMenu()
  await page.click(`${menu} button[aria-label="Tools: Automatic"]`)
  await page.waitForSelector(`${menu} [role="radio"]`)
  await page.evaluate(() => window.__COMPOSER__.setToolsEnabled(false))
  await page.waitForSelector(`${menu} button[aria-label="Knowledge bases"]`)
  assert.equal(await page.$$eval(`${menu} [role="radio"]`, e => e.length), 0, 'changing to a model without tools must leave the unavailable submenu')
  await page.keyboard.press('Escape')
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  assert(await page.$eval(shell, e => getComputedStyle(e).transitionDuration.split(',').every(value => parseFloat(value) <= 0.00001)), 'reduced motion must disable visible height transitions')
  await page.evaluate(() => window.__COMPOSER__.setKBIds([]))
  await settled()
  assert.deepEqual(errors, [])
  console.log('PASS: compact feature menu, folder picker, shared knowledge-base and skill submenus, slash/menu synchronization, default exclusions, keyboard navigation, smooth growth/shrink/text/skill selection, local submit, reduced motion, 30 responsive/theme/locale combinations')
} finally {
  await browser?.close()
  server.httpServer?.closeAllConnections()
  await server.close()
}

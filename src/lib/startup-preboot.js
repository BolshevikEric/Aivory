/* Inlined by Vite with the shared language helper and startup translations. */
/* global aivoryLanguages, startupMessages */
var root = document.documentElement
function stored(key) {
  try { return localStorage.getItem(key) } catch (_) { return null }
}
var preference = stored('aivory.theme')
if (['light', 'dark', 'system'].indexOf(preference) < 0) preference = 'system'
var systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  var theme = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference
  root.dataset.theme = theme
  root.classList.toggle('dark', theme === 'dark')
}
applyTheme()
var accent = stored('aivory.accent')
root.dataset.accent = ['violet', 'lagoon', 'ember', 'moss', 'indigo', 'rose', 'mono'].indexOf(accent) >= 0 ? accent : 'violet'
try {
  var settings = JSON.parse(stored('aivory.settings') || '{}')
  var appearance = settings.appearance || {}
  root.dataset.density = appearance.density === 'cozy' ? 'cozy' : 'comfortable'
  root.dataset.fontsize = ['sm', 'lg'].indexOf(appearance.fontSize) >= 0 ? appearance.fontSize : 'md'
  var font = appearance.font === 'inter' ? 'humanist' : appearance.font === 'system' ? 'rounded' : appearance.font
  root.dataset.font = ['default', 'humanist', 'rounded', 'serif'].indexOf(font) >= 0 ? font : 'default'
} catch (_) { }
var language = aivoryLanguages.normalizeLanguage(stored('aivory.lang'))
var browserLanguages = navigator.languages || [navigator.language]
for (var i = 0; !language && i < browserLanguages.length; i++) {
  language = aivoryLanguages.normalizeLanguage(browserLanguages[i])
}
root.lang = language || 'en'

function messages() {
  return startupMessages[aivoryLanguages.normalizeLanguage(root.lang)] || startupMessages.en
}

// Convert the shared CSS background to sRGB for browsers that require a hex theme-color.
function syncThemeColor() {
  var color = getComputedStyle(root).backgroundColor
  var canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  var context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    var pixel = context.getImageData(0, 0, 1, 1).data
    color = '#' + [pixel[0], pixel[1], pixel[2]].map(function (value) { return value.toString(16).padStart(2, '0') }).join('')
  }
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = color
}
syncThemeColor()
var observer = new MutationObserver(syncThemeColor)
observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] })

var startedAt = Date.now()
var state = 'loading'
var screen = null
var timer
function render() {
  screen = screen || document.querySelector('[data-startup-screen="static"]')
  if (!screen) return
  if (!screen.isConnected && state === 'failed') document.body.appendChild(screen)
  var copy = messages()
  screen.dataset.state = state
  screen.setAttribute('aria-label', state === 'failed' ? copy.failed : state === 'slow' ? copy.slow : copy.loading)
  screen.setAttribute('aria-busy', state === 'failed' ? 'false' : 'true')
  screen.querySelector('.aivory-startup-message').textContent = state === 'failed' ? copy.failed : state === 'slow' ? copy.slow : ''
  screen.querySelector('.aivory-startup-dots').style.visibility = state === 'failed' ? 'hidden' : 'visible'
  var button = screen.querySelector('button')
  button.textContent = copy.reload
  button.hidden = state !== 'failed'
  button.onclick = function () { window.location.reload() }
}
function stopWatchingStartup() {
  clearTimeout(timer)
  window.removeEventListener('error', onError, true)
  window.removeEventListener('unhandledrejection', fail)
  window.removeEventListener('vite:preloadError', fail)
  document.removeEventListener('DOMContentLoaded', render)
  systemTheme.removeEventListener('change', applyTheme)
}
function fail() {
  if (state === 'ready' || state === 'failed') return
  state = 'failed'
  stopWatchingStartup()
  render()
}
function onError(event) {
  var target = event.target
  var resourceFailed = target && (target.tagName === 'SCRIPT' ||
    (target.tagName === 'LINK' && (target.rel === 'stylesheet' || target.rel === 'modulepreload')))
  if (resourceFailed || event instanceof ErrorEvent) fail()
}
window.aivoryStartup = {
  startedAt: startedAt,
  getState: function () { return state },
  mount: render,
  ready: function () {
    if (state === 'failed' || state === 'ready') return
    state = 'ready'
    stopWatchingStartup()
    if (screen) screen.remove()
    screen = null
    syncThemeColor()
  },
  fail: fail,
}
timer = setTimeout(function () {
  if (state !== 'loading') return
  state = 'slow'
  render()
}, 5000)
window.addEventListener('error', onError, true)
window.addEventListener('unhandledrejection', fail)
window.addEventListener('vite:preloadError', fail)
systemTheme.addEventListener('change', applyTheme)
document.addEventListener('DOMContentLoaded', render)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ReplyNotifications } from '../reply-notifications.cjs'

function fixture() {
  const notices = []
  const messages = []
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(options) { super(); this.options = options; notices.push(this) }
    show() { this.shown = true }
    close() { this.closed = true; this.emit('close') }
  }
  let focused = false
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => focused,
    webContents: Object.assign(new EventEmitter(), { send: (...args) => messages.push(args) }),
  })
  const manager = new ReplyNotifications({ Notification, window, activate: () => { focused = true; window.emit('focus') } })
  return { manager, window, notices, messages, focus: () => { focused = true } }
}
const payload = { userId: 'user-a', conversationId: 'chat-a', workspaceId: null, messageId: 'reply-a', title: 'Reply ready', body: 'Select to view.' }

test('native notifications are gated on actual window focus and validate their payload', () => {
  const { manager, notices, focus } = fixture()
  for (const patch of [{ userId: '' }, { conversationId: 'https://evil.test' }, { workspaceId: '../admin' }, { title: 'x'.repeat(121) }]) {
    assert.equal(manager.show({ ...payload, ...patch }), false)
  }
  assert.equal(manager.show(payload), true)
  assert.equal(manager.show(payload), false)
  assert.equal(notices.length, 1)
  focus()
  assert.equal(manager.show({ ...payload, messageId: 'reply-b' }), false)
})

test('clicking restores the window and passes an internal target back to the renderer', () => {
  const { manager, notices, messages } = fixture()
  manager.show(payload)
  notices[0].emit('click')
  assert.equal(notices[0].closed, true)
  assert.deepEqual(messages, [['desktop:reply-notification', { userId: 'user-a', conversationId: 'chat-a', workspaceId: null, privateChat: undefined }]])
  notices[0].emit('click')
  assert.equal(messages.length, 1)
})

test('focus, navigation, explicit cleanup and window close dismiss native notices and invalidate clicks', () => {
  for (const action of ['focus', 'navigation', 'clear', 'closed']) {
    const { manager, window, notices, messages } = fixture()
    manager.show(payload)
    if (action === 'navigation') window.webContents.emit('did-start-navigation')
    else if (action === 'clear') manager.clear()
    else window.emit(action)
    assert.equal(notices[0].closed, true)
    notices[0].emit('click')
    assert.equal(messages.length, 0)
  }
})

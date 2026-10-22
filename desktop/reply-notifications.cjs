const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)

class ReplyNotifications {
  constructor({ Notification, window, activate, icon }) {
    this.Notification = Notification
    this.window = window
    this.activate = activate
    this.icon = icon
    this.active = new Map()
    this.clear = this.clear.bind(this)
    window.on('focus', this.clear)
    window.webContents.on('did-start-navigation', this.clear)
    window.once('closed', this.clear)
  }

  show(payload) {
    const window = this.window
    if (!this.Notification.isSupported() || window.isDestroyed() ||
      (window.isVisible() && window.isFocused() && !window.isMinimized())) return false
    if (!payload || !validId(payload.userId) || !validId(payload.conversationId) || !validId(payload.messageId) ||
      (payload.workspaceId !== null && !validId(payload.workspaceId)) ||
      (payload.privateChat !== undefined && typeof payload.privateChat !== 'boolean') ||
      typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 120 ||
      typeof payload.body !== 'string' || payload.body.length > 300) return false
    const { userId, conversationId, workspaceId, privateChat, messageId, title, body } = payload
    const key = `${userId}:${conversationId}:${messageId}`
    if (this.active.has(key)) return false
    try {
      const notification = new this.Notification({ title, body, icon: this.icon })
      this.active.set(key, notification)
      const remove = () => { if (this.active.get(key) === notification) this.active.delete(key) }
      notification.on('close', remove)
      notification.on('failed', remove)
      notification.on('click', () => {
        if (this.active.get(key) !== notification || window.isDestroyed()) return
        remove()
        notification.close()
        this.activate()
        window.webContents.send('desktop:reply-notification', { userId, conversationId, workspaceId, privateChat })
      })
      if (this.active.size > 32) {
        const [oldestKey, oldest] = this.active.entries().next().value
        this.active.delete(oldestKey)
        oldest.close()
      }
      notification.show()
      return true
    } catch {
      this.active.delete(key)
      return false
    }
  }

  clear() {
    const notifications = [...this.active.values()]
    this.active.clear()
    for (const notification of notifications) notification.close()
  }
}

module.exports = { ReplyNotifications }

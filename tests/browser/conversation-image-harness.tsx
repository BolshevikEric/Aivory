import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import i18n from '@/i18n'
import '@/styles/globals.css'
import 'katex/dist/katex.min.css'
import ChatThread from '@/pages/chat/ChatThread'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import { useAuth } from '@/store/auth'
import { useConversations } from '@/store/conversations'
import { useModels } from '@/store/models'
import type { Conversation, Message } from '@/types/chat'
import { complexTable } from '../frontend/fixtures/generative-table'
import { nestedComponents } from '../frontend/fixtures/generative-nesting'

const now = Date.now()
const message = (id: string, role: Message['role'], content: string): Message => ({ id, role, content, createdAt: now })
const gui = JSON.stringify({ version: 1, blocks: [
  { type: 'chart', kind: 'bar', labels: ['June', 'July'], series: [{ name: 'Requests', values: [120, 180] }] },
  { type: 'form', title: 'Trip details', fields: [{ type: 'text', id: 'destination', label: 'Destination', required: true }] },
] })
const fixture: Conversation = {
  id: 'image-conversation', title: 'Aivory · 分享图片测试', createdAt: now, updatedAt: now, modelId: 'test-model', creatorId: 'test-user',
  messages: [
    message('first-user', 'user', '帮我比较这些方案，并保留数学和代码格式。'),
    message('first-assistant', 'assistant', '## Selected answer\n\nThe answer contains **bold text**, $x^2 + y^2$, and a table.\n\n| Option | Details |\n| --- | --- |\n| Browser | No installation required |\n| Desktop | macOS, Windows and Linux |\n\n```js\nconst example = "This is a deliberately long line that should wrap in the exported image rather than disappear beyond the right edge."\n```\n\n![Aivory icon](/icon-512.png)'),
    message('excluded-user', 'user', 'EXCLUDED PRIVATE MESSAGE'),
    message('excluded-assistant', 'assistant', 'EXCLUDED PRIVATE ANSWER'),
    message('visual-assistant', 'assistant', '```aivory-ui\n' + gui + '\n```\n\n' + complexTable + '\n\n' + nestedComponents),
  ],
}
useAuth.setState({ user: { id: 'test-user', role: 'admin', email: 'test@example.test', displayName: 'Test' } as never, status: 'authenticated' })
useModels.setState({ loaded: true, loading: false, loadedScope: null, loadedPolicyKey: 'personal', models: [{ id: 'test-model', label: 'Test model', kind: 'chat', enabled: true, capabilities: ['text'], tool_mode: 'none', param_controls: [] }] as never })
useConversations.setState({ accountId: 'test-user', conversations: [fixture], loadOne: async () => {}, loadInlineThreads: async () => {} })
Reflect.set(window, '__IMAGE_SHARE__', {
  setLanguage: (language: string) => i18n.changeLanguage(language),
  setTheme: (theme: string) => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') },
  changeAccount: () => { useAuth.setState({ user: { id: 'other-user', role: 'admin' } as never }); useConversations.setState({ accountId: 'other-user', conversations: [] }) },
  addLongMessage: () => useConversations.setState({ conversations: [{ ...fixture, messages: [...fixture.messages, message('long-answer', 'assistant', Array.from({ length: 180 }, (_, index) => `${index + 1}. A long paragraph for checking a complete single-image export without losing the end of the reply.${index === 179 ? ' FINAL PARAGRAPH' : ''}`).join('\n\n'))] }] }),
  failNextCapture: () => {
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) { HTMLCanvasElement.prototype.toBlob = original; callback(null) }
  },
})
window.addEventListener('aivory:conversation-export', () => {
  const root = document.querySelector<HTMLElement>('[data-image-export-root]')
  const svg = root?.querySelector<SVGSVGElement>('.gui-markup-svg[aria-label="季度趋势"]')
  if (root && svg) {
    const parent = root.getBoundingClientRect(), drawing = svg.getBoundingClientRect()
    Reflect.set(window, '__SVG_EXPORT__', { x: drawing.x - parent.x, y: drawing.y - parent.y, width: drawing.width, height: drawing.height, rootWidth: parent.width })
  }
  const table = document.querySelector<HTMLTableElement>('.conversation-image-document .gui-markup-table > table')
  if (!table?.tHead) return
  Reflect.set(window, '__TABLE_EXPORT__', {
    tableWidth: table.getBoundingClientRect().width,
    parentWidth: table.parentElement!.getBoundingClientRect().width,
    nameWidth: table.tHead.rows[0].cells[0].getBoundingClientRect().width,
    scoreWidth: table.tHead.rows[1].cells[0].getBoundingClientRect().width,
    columnSpan: table.tBodies[0].rows[0].cells[0].colSpan,
    rowSpan: table.tBodies[0].rows[1].cells[1].rowSpan,
    total: table.tFoot?.textContent,
    columns: table.querySelectorAll('col').length,
    expanded: Array.from(table.querySelectorAll('col')).every(col => col.span === 1),
  })
})
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node instanceof HTMLElement && node.hasAttribute('data-image-export-root')) Reflect.set(window, '__IMAGE_EXPORT_TEXT__', node.textContent)
  }
}).observe(document.body, { childList: true })
await i18n.changeLanguage('en')
createRoot(document.getElementById('root')!).render(<TooltipProvider><MemoryRouter initialEntries={['/chat/image-conversation']}><div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}><Routes><Route path="/chat/:id" element={<ChatThread />} /></Routes></div><Toaster /></MemoryRouter></TooltipProvider>)

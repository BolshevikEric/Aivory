import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import '@/styles/globals.css'
import { Markdown } from '@/components/chat/markdown'
import { PrivateMarkdown } from '@/components/chat/private-markdown'
import { Composer } from '@/components/chat/composer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuth } from '@/store/auth'
import { useModels } from '@/store/models'
import { GenerativeReplyProvider } from '@/components/chat/generative-reply'
import PrivateChat from '@/pages/chat/PrivateChat'

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``
const quotedNews = `{"version":1,"title":"News","blocks":[{"type":"tabs","items":[{"title":"Domestic","blocks":[{"type":"text","text":"新增"学校食品安全""网络食品经营"专节。"}]},{"title":"International","blocks":[{"type":"text","text":"美国表示"强烈谴责"。"}]}]}]}`
const preview = new URLSearchParams(globalThis.location.search).has('preview')
const tableImageURL = (file: string) => preview
  ? new URL(file === 'missing.png' ? '/missing-table-image.png' : '/icon-512.png', globalThis.location.href).href
  : `https://images.example.test/${file}`
const document = JSON.stringify({ version: 1, title: 'Usage overview', blocks: [
  { type: 'metrics', items: [{ label: 'Tokens', value: 3000, hint: 'Three months' }] },
  { type: 'chart', kind: 'line', labels: ['June', 'July', 'August'], series: [{ name: 'Tokens', values: [800, 1000, 1200] }] },
  { type: 'tabs', items: [{ title: 'Summary', blocks: [{ type: 'text', text: 'Steady growth' }] }, { title: 'Breakdown', blocks: [{ type: 'table', columns: ['Month', 'Tokens'], rows: [['June', 800], ['July', 1000]] }] }] },
  { type: 'accordion', items: [{ title: 'Assumptions', blocks: [{ type: 'steps', items: [{ title: 'Check inputs' }, { title: 'Compare months', description: 'Use the same period' }] }] }] },
] })
const richTable = JSON.stringify({ version: 1, title: 'Deployment comparison', description: 'Compare the same features across three options.', blocks: [{
  type: 'table',
  columns: [{ label: 'Application', width: 'wide' }, { label: 'Preview', width: 'compact', align: 'center' }, { label: 'Capabilities', width: 'wide' }, { label: 'Users', width: 'compact', align: 'right' }, 'Reference'],
  rows: [
    [{ type: 'text', text: 'Desktop client', description: 'Bundled frontend with persistent server settings.' }, { type: 'image', url: tableImageURL('app.png'), alt: 'Desktop application', caption: 'App icon' }, { type: 'list', items: ['macOS, Windows and Linux', 'Native window controls'] }, 120, { type: 'link', url: 'https://example.test/desktop', text: 'Desktop release' }],
    [{ type: 'text', text: 'Browser client', description: 'A long detail that should wrap naturally within its column without expanding the page or hiding other cells.' }, { type: 'image', url: tableImageURL('browser.png'), alt: 'Browser application' }, { type: 'list', items: ['Responsive layout', 'No installation required'] }, 800, { type: 'link', url: 'https://example.test/web', text: 'Open website' }],
    ['Unavailable preview', { type: 'image', url: tableImageURL('missing.png'), alt: 'Unavailable application preview' }, null, false, 'No reference'],
  ],
}] })
const cards = JSON.stringify({ version: 1, blocks: [
  { type: 'cards', title: 'Search highlights', description: 'A compact digest of relevant results.', items: [
    { title: 'A new desktop release', description: 'A local frontend with browser authorization and persistent server settings.', meta: 'Product journal · Today', image: { url: tableImageURL('news.png'), alt: 'Release preview' }, link: { url: 'https://example.test/news' } },
    { title: 'An alternative deployment', description: 'A summary remains readable even when the image cannot be loaded.', meta: 'Deployment guide', image: { url: tableImageURL('missing.png'), alt: 'Deployment preview' }, link: { url: 'https://example.test/deploy', label: 'Read the guide' } },
    { title: 'An-option-with-an-extremely-long-unbroken-name-that-must-wrap-within-the-card-at-every-screen-size', description: 'Compare the trade-offs before choosing.\nText-only results need no image or link.' },
  ] },
  { type: 'card', title: 'Recommended option', description: 'A single card can highlight one useful recommendation without a large layout.', image: { url: tableImageURL('recommendation.png'), alt: 'Recommendation' }, link: { url: 'https://example.test/option', label: 'Explore this option and compare it with the alternatives' } },
] })
const advanced = JSON.stringify({ version: 1, title: 'Explore the data', blocks: [
  { type: 'chart', kind: 'donut', labels: ['Web', 'Desktop', 'API'], series: [{ name: 'Requests', values: [54, 28, 18] }] },
  { type: 'heatmap', title: 'Activity by hour', xLabels: ['Mon', 'Tue', 'Wed'], yLabels: ['Morning', 'Evening'], values: [[12, 16, 9], [22, 18, 28]] },
  { type: 'gauge', label: 'Completion', value: 72, min: 0, max: 100, unit: '%' },
  { type: 'calculator', title: 'Cost explorer', description: 'Compare quantities and plans, with optional 10% tax.', inputs: [{ type: 'range', id: 'quantity', label: 'Quantity', min: 1, max: 100, step: 1, value: 10 }, { type: 'toggle', id: 'tax', label: 'Include tax', value: false }, { type: 'select', id: 'price', label: 'Plan', value: '12', options: [{ label: 'Basic', value: '12' }, { label: 'Pro', value: '24' }] }], outputs: [{ label: 'Total', expression: 'quantity * price * (1 + tax * 0.1)', unit: 'USD' }] },
  { type: 'checklist', title: 'Plan', items: [{ text: 'Compare the options' }, { text: 'Try a scenario' }] },
  { type: 'quiz', question: 'What is 2 + 2?', options: ['3', '4'], answer: 1, explanation: 'Two pairs make four.' },
  { type: 'function', title: 'Editable function', functions: [{ expression: 'a * sin(x)' }, { expression: 'cos(x)' }], variable: 'x', range: { min: -6.28, max: 6.28 }, samples: 120, controls: [{ type: 'range', id: 'a', label: 'Amplitude', min: .1, max: 2, step: .1, value: 1 }] },
  { type: 'chart', kind: 'scatter', title: 'Height and weight', xLabel: 'Height (cm)', yLabel: 'Weight (kg)', labels: ['A', 'B', 'C'], series: [{ name: 'Adults', xValues: [158, 176, 184], values: [51, 72, 82] }, { name: 'Teenagers', xValues: [148, 156, 172], values: [42, 51, 63] }] },
  { type: 'chart', kind: 'stacked-bar', title: 'Requests by platform', labels: ['June', 'July'], series: [{ name: 'Web', values: [60, 75] }, { name: 'App', values: [40, 48] }] },
  { type: 'chart', kind: 'area', title: 'Monthly tokens', labels: ['June', 'July', 'August'], series: [{ name: 'Tokens', values: [800, 1000, 1200] }] },
  { type: 'chart', kind: 'horizontal-bar', title: 'Requests by channel', labels: ['Channel A', 'Channel B'], series: [{ name: 'Requests', values: [120, 220] }] },
  { type: 'chart', kind: 'pie', title: 'A single slice', labels: ['All'], series: [{ name: 'Share', values: [100] }] },
] })
const questions = JSON.stringify({ version: 1, blocks: [{ type: 'question', title: 'A few details', questions: [
  { id: 'platform', question: 'Which platform are you using?', options: [{ label: 'Windows', description: 'Windows 10 or 11' }, 'macOS', 'Linux'] },
  { id: 'needs', question: 'Which features do you need?', options: ['Charts', 'Tables', 'Editable functions'], multiple: true },
] }] })
const singleQuestion = JSON.stringify({ version: 1, blocks: [{ type: 'question', questions: [{ id: 'platform', question: 'Which platform are you using?', options: ['Windows', 'macOS'], allowCustom: false }] }] })
const form = JSON.stringify({ version: 1, blocks: [{ type: 'form', title: 'Plan a trip', description: 'Share a few preferences so I can tailor your itinerary.', submitLabel: 'Plan my trip', fields: [
  { id: 'destination', type: 'text', label: 'Destination', required: true, placeholder: 'City or region' },
  { id: 'budget', type: 'number', label: 'Budget per person', min: 0, max: 5000, step: 100, description: 'Total budget in USD.' },
  { id: 'email', type: 'email', label: 'Email', required: true },
  { id: 'departure', type: 'date', label: 'Departure date' },
  { id: 'pace', type: 'select', label: 'Pace', options: [{ label: 'Relaxed', value: 'relaxed' }, { label: 'Packed', value: 'packed' }], required: true },
  { id: 'transport', type: 'radio', label: 'Transport', options: ['Train', 'Plane'] },
  { id: 'interests', type: 'checkboxes', label: 'Interests', options: ['Nature', 'Food', 'Museums'], required: true },
  { id: 'flexible', type: 'checkbox', label: 'Include alternative destinations' },
  { id: 'notes', type: 'textarea', label: 'Other requirements', placeholder: 'Anything else I should consider?' },
] }] })
const singleFieldForm = JSON.stringify({ version: 1, blocks: [{ type: 'form', fields: [{ id: 'details', type: 'text', label: 'Details', required: true }] }] })
const nativeForm = JSON.stringify({ version: 1, blocks: [{ type: 'form', title: 'Other input types', fields: [
  { id: 'url', type: 'url', label: 'Website' }, { id: 'tel', type: 'tel', label: 'Telephone' },
  { id: 'time', type: 'time', label: 'Time', value: '09:30' }, { id: 'datetime', type: 'datetime-local', label: 'Date and time', value: '2026-10-11T09:30' },
  { id: 'confirmation', type: 'checkbox', label: 'Confirm these preferences', required: true },
] }] })
const functionFragment = JSON.stringify({ type: 'function', title: 'Discontinuity examples', functions: [
  { expression: '2/(1+exp(-50*x))-1', label: 'Smooth step' },
  { expression: 'sin(x)/x', label: 'Removable discontinuity' },
], variable: 'x', range: { min: -6, max: 6 } })
let questionAttempts = 0
let formAttempts = 0
function Harness() {
  const [html, setHTML] = useState('<button id="action" onclick="this.textContent=\'Updated\'">Calculate</button>')
  const [live, setLive] = useState(false)
  useEffect(() => {
    Reflect.set(window, '__GUI__', { setHTML, setLive, setLanguage: (locale: string) => i18n.changeLanguage(locale) })
  }, [])
  if (preview) return <main style={{ width: '100%', maxWidth: 760, padding: 16, margin: 'auto' }}>
    <Markdown allowGenerativeUI content={fence('aivory-ui', richTable)} />
    <Markdown allowGenerativeUI content={'| Name | Value |\n| --- | --- |\n| Plain Markdown | 12 |'} />
  </main>
  return <TooltipProvider><MemoryRouter><main style={{ width: '100%', maxWidth: 760, padding: 16, margin: 'auto' }}>
    <section data-case="rich-table"><Markdown allowGenerativeUI content={fence('aivory-ui', richTable)} /></section>
    <section data-case="cards"><Markdown allowGenerativeUI content={fence('aivory-ui', cards)} /></section>
    <section data-case="advanced"><Markdown allowGenerativeUI content={fence('aivory-ui', advanced)} /></section>
    <section data-case="function-fragment"><Markdown allowGenerativeUI content={fence('aivory-ui', functionFragment)} /></section>
    <section data-case="private-function-fragment"><PrivateMarkdown allowGenerativeUI text={fence('aivory-ui', functionFragment)} /></section>
    <section data-case="unfenced-function"><Markdown allowGenerativeUI content={functionFragment} /></section>
    <section data-case="user-function"><Markdown content={fence('aivory-ui', functionFragment)} /></section>
    <section data-case="questions"><GenerativeReplyProvider messageId="question-message" status="ready" onReply={async (messageId, text) => {
      Reflect.set(window, '__QUESTION_REPLY__', { messageId, text })
      await new Promise(resolve => setTimeout(resolve, 150))
      return true
    }}><Markdown allowGenerativeUI content={fence('aivory-ui', questions)} /></GenerativeReplyProvider></section>
    <section data-case="question-retry"><GenerativeReplyProvider messageId="retry-message" status="ready" onReply={async () => {
      Reflect.set(window, '__QUESTION_ATTEMPTS__', ++questionAttempts)
      return questionAttempts > 1
    }}><Markdown allowGenerativeUI content={fence('aivory-ui', singleQuestion)} /></GenerativeReplyProvider></section>
    <section data-case="question-streaming"><GenerativeReplyProvider messageId="streaming-message" status="ready" onReply={async () => { throw new Error('streaming reply must not submit') }}><Markdown allowGenerativeUI live content={fence('aivory-ui', singleQuestion)} /></GenerativeReplyProvider></section>
    <section data-case="question-readonly"><Markdown allowGenerativeUI content={fence('aivory-ui', singleQuestion)} /></section>
    <section data-case="form"><GenerativeReplyProvider messageId="form-message" status="ready" onReply={async (messageId, text) => {
      Reflect.set(window, '__FORM_REPLY__', { messageId, text })
      Reflect.set(window, '__FORM_ATTEMPTS__', ++formAttempts)
      await new Promise(resolve => setTimeout(resolve, 150))
      return formAttempts > 1
    }}><Markdown allowGenerativeUI content={fence('aivory-ui', form)} /></GenerativeReplyProvider></section>
    <section data-case="form-preview"><GenerativeReplyProvider messageId="form-preview" status="ready" onReply={async () => true}><Markdown allowGenerativeUI content={fence('aivory-ui', form)} /></GenerativeReplyProvider></section>
    <section data-case="form-native"><GenerativeReplyProvider messageId="form-native" status="ready" onReply={async () => { Reflect.set(window, '__NATIVE_FORM_SUBMITTED__', true); return true }}><Markdown allowGenerativeUI content={fence('aivory-ui', nativeForm)} /></GenerativeReplyProvider></section>
    <section data-case="form-streaming"><GenerativeReplyProvider messageId="form-streaming" status="ready" onReply={async () => { throw new Error('streaming form must not submit') }}><Markdown allowGenerativeUI live content={fence('aivory-ui', singleFieldForm)} /></GenerativeReplyProvider></section>
    <section data-case="form-answered"><GenerativeReplyProvider messageId="form-answered" status="answered" onReply={async () => { throw new Error('historical form must not submit') }}><Markdown allowGenerativeUI content={fence('aivory-ui', singleFieldForm)} /></GenerativeReplyProvider></section>
    <section data-case="form-readonly"><Markdown allowGenerativeUI content={fence('aivory-ui', singleFieldForm)} /></section>
    <section data-case="presets"><Markdown allowGenerativeUI content={fence('aivory-ui', document)} /></section>
    <section data-case="quoted-news"><Markdown allowGenerativeUI content={fence('aivory-ui', quotedNews)} /></section>
    <section data-case="inline"><Markdown allowGenerativeUI live={live} content={fence('aivory-html', html)} /></section>
    <section data-case="private"><PrivateMarkdown allowGenerativeUI text={fence('aivory-ui', document)} /></section>
    <section data-case="private-table"><PrivateMarkdown allowGenerativeUI text={fence('aivory-ui', richTable)} /></section>
    <section data-case="private-cards"><PrivateMarkdown allowGenerativeUI text={fence('aivory-ui', cards)} /></section>
    <section data-case="markdown-table"><Markdown allowGenerativeUI content={'| Name | Value |\n| --- | --- |\n| Plain Markdown | 12 |'} /></section>
    <section data-case="user"><Markdown content={fence('aivory-ui', document)} /></section>
    <section data-case="ordinary"><Markdown allowGenerativeUI content={fence('html', '<h1>Ordinary preview</h1>')} /></section>
    <section data-case="incomplete"><Markdown allowGenerativeUI live content={fence('aivory-ui', '{"version":1,')} /></section>
    <section data-case="composer"><Composer modelId="test-model" onModelChange={() => {}} onSubmit={(_text, _attachments, options) => Reflect.set(window, '__SUBMITTED_SKILLS__', options.selectedUserSkillIds)} /></section>
    <section data-case="private-question-chat"><PrivateChat /></section>
  </main></MemoryRouter></TooltipProvider>
}
useAuth.setState({ user: { id: 'test-user', email: 'test@example.test', displayName: 'Test', role: 'admin' } as never, status: 'authenticated' })
useModels.setState({ loaded: true, loading: false, loadedScope: null, loadedPolicyKey: 'personal', models: [{ id: 'test-model', label: 'Test', kind: 'chat', enabled: true, capabilities: ['text'], tool_mode: 'none', param_controls: [] }] as never })
await i18n.changeLanguage('en')
createRoot(globalThis.document.getElementById('root')!).render(<Harness />)

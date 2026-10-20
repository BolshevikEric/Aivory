import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import '@/styles/globals.css'
import 'katex/dist/katex.min.css'
import { Composer } from '@/components/chat/composer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuth } from '@/store/auth'
import { useModels } from '@/store/models'

function Harness() {
  const [kbIds, setKBIds] = useState<string[]>([])
  const [fillRequest, setFillRequest] = useState<{ text: string; id: number }>()
  const [layout, setLayout] = useState<'home' | 'thread'>('thread')
  const fillId = useRef(0)
  useEffect(() => {
    Reflect.set(window, '__COMPOSER__', {
      setKBIds, setLayout,
      fillText: (text: string) => setFillRequest({ text, id: ++fillId.current }),
      setLanguage: (locale: string) => i18n.changeLanguage(locale),
      setToolsEnabled: (enabled: boolean) => useModels.setState(current => ({ models: current.models.map(model => ({ ...model, tool_mode: enabled ? 'native' : 'none' })) })),
    })
  }, [])
  return <MemoryRouter initialEntries={['/chat/composer-test']}><TooltipProvider><main style={{ display: 'flex', height: '100dvh', padding: 24, flexDirection: 'column', justifyContent: layout === 'home' ? 'center' : 'flex-end', alignItems: 'center' }}>
    <div style={{ width: '100%', maxWidth: 720 }}>
      <Composer modelId="composer-model" onModelChange={() => {}} onSubmit={(text, attachments, options) => { Reflect.set(window, '__COMPOSER_MESSAGE__', { text, attachments }); Reflect.set(window, '__COMPOSER_SUBMIT__', options) }} kbIds={kbIds} onKBChange={setKBIds} fillRequest={fillRequest} menuSide={layout === 'home' ? 'bottom' : 'top'} />
    </div>
  </main></TooltipProvider></MemoryRouter>
}

useAuth.setState({ user: { id: 'composer-user', email: 'composer@example.test', displayName: 'Test', role: 'admin' } as never, status: 'authenticated' })
useModels.setState({ loaded: true, loading: false, loadedScope: null, loadedPolicyKey: 'personal', verifyAvailable: true, models: [{ id: 'composer-model', label: 'Test model', kind: 'chat', enabled: true, capabilities: ['text'], tool_mode: 'native', param_controls: [], skills_default_enabled: true, bound_skills: [{ id: 'sk_visual', name: 'generative-ui', display_description: 'Visual answers', icon: 'PanelsTopLeft', enabled: true, sort_order: 0 }] }] as never })
await i18n.changeLanguage('en')
createRoot(document.getElementById('root')!).render(<Harness />)

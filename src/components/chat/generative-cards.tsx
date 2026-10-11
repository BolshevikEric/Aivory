import { useState } from 'react'
import { ArrowUpRight, Image as ImageIcon, ImageOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UIBlock, UICard } from '@/lib/generative-ui'
import { visualFocus } from './generative-shared'

function CardImage({ image }: { image: NonNullable<UICard['image']> }) {
  const { t } = useTranslation('chat')
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading')
  const alt = image.alt || t('generative.image')
  return <a className={`gui-card-image ${visualFocus}`} href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`${t('generative.openImage')}: ${alt}`}>
    {state !== 'error' && <img src={image.url} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setState('loaded')} onError={() => setState('error')} className={state === 'loaded' ? '' : 'invisible'} />}
    {state === 'loading' && <ImageIcon aria-hidden size={20} />}
    {state === 'error' && <span role="status" className="flex flex-col items-center gap-1 px-2 text-center text-xs"><ImageOff aria-hidden size={18} />{t('generative.imageFailed')}</span>}
  </a>
}

function Card({ card, single = false }: { card: UICard; single?: boolean }) {
  const { t } = useTranslation('chat')
  return <article data-generative-card className={`gui-card ${single ? 'gui-card-single' : ''}`}>
    {card.image && <CardImage key={card.image.url} image={card.image} />}
    <div className="gui-card-content">
      {card.meta && <p className="gui-card-meta">{card.meta}</p>}
      <h3>{card.title}</h3>
      {card.description && <p className="gui-card-description">{card.description}</p>}
      {card.link && <a className={`gui-card-link ${visualFocus}`} href={card.link.url} target="_blank" rel="noopener noreferrer"><span className="min-w-0">{card.link.label || t('generative.viewDetails')}</span><ArrowUpRight aria-hidden size={14} /></a>}
    </div>
  </article>
}

export function GenerativeCards({ block }: { block: Extract<UIBlock, { type: 'card' | 'cards' }> }) {
  if (block.type === 'card') return <Card card={block} single />
  return <section data-generative-cards className="min-w-0 space-y-3">
    {(block.title || block.description) && <div className="space-y-1">{block.title && <h3 className="m-0 text-sm font-medium">{block.title}</h3>}{block.description && <p className="m-0 text-sm text-[var(--color-fg-muted)]">{block.description}</p>}</div>}
    <div className="gui-cards">{block.items.map((card, index) => <Card key={index} card={card} single={block.items.length === 1} />)}</div>
  </section>
}

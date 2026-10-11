import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { cn, truncate } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/use-media-query'
import { mediaQuery } from '@/lib/design-tokens'
import { mathContentToPlainText } from '@/lib/math-content'
import type { Conversation } from '@/types/chat'

interface ConversationMinimapProps {
  conversation: Conversation
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

// Only surface the rail for genuinely long threads — a handful of turns navigate
// fine by scrolling. "Rounds" = user questions on the active line (the rail
// tracks the conversation LINE, never the branch tree).
const MIN_ROUNDS = 5
// A user turn becomes "current" once its heading has scrolled to within this many
// px of the thread viewport's top edge.
const ACTIVE_LINE_OFFSET = 96
// Bound pasted prompts in the navigation; CSS fits the preview to the available
// width rather than forcing every question to the same character count.
const LABEL_MAX = 160

/**
 * A slim right-edge rail — one tick per user question — for jumping around a long
 * conversation. The tick of the turn currently in view is filled; hovering (or
 * keyboard-focusing) the rail reveals each question's text. Active path only, so
 * it stays a simple vertical line regardless of branches (§ minimap). Desktop-only
 * and hidden until the thread passes MIN_ROUNDS rounds.
 */
export function ConversationMinimap({ conversation, scrollContainerRef }: ConversationMinimapProps) {
  const { t } = useTranslation('chat')
  const isDesktop = useMediaQuery(mediaQuery.desktop)
  // The global reduced-motion CSS rule only sets the DEFAULT scroll-behavior; an
  // explicit JS `behavior:'smooth'` overrides it (CSSOM), so gate it ourselves.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  const userTurns = useMemo(
    () => conversation.messages.filter((m) => m.role === 'user'),
    [conversation.messages],
  )
  const enabled = isDesktop && userTurns.length > MIN_ROUNDS
  // Key on user-turn ids only, so streaming tokens (which mutate assistant
  // content, not the turn set) don't churn the scroll-spy subscription.
  const turnsKey = useMemo(() => userTurns.map((m) => m.id).join('|'), [userTurns])
  const turnLabels = useMemo(() => userTurns.map((m, i) =>
    truncate(mathContentToPlainText(m.content ?? '').replace(/\s+/g, ' ').trim(), LABEL_MAX) ||
    t('minimap.untitled', { index: i + 1, defaultValue: 'Question {{index}}' }),
  ), [userTurns, t])

  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const activeTickRef = useRef<HTMLButtonElement>(null)
  const activePreviewRef = useRef<HTMLButtonElement>(null)

  // Scroll-spy: the current turn is the LAST user question whose heading sits at
  // or above a line near the viewport top. The thread is reverse-paginated, so
  // only in-DOM anchors count — older windowed-out turns simply aren't "active"
  // until scrolled back into the mounted window. rAF-throttled.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!enabled || !container) return
    const ids = turnsKey ? turnsKey.split('|') : []
    let raf = 0
    const compute = () => {
      raf = 0
      const line = container.getBoundingClientRect().top + ACTIVE_LINE_OFFSET
      let active: string | null = null
      let firstMounted: string | null = null
      for (const id of ids) {
        const el = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        if (!el) continue
        if (firstMounted === null) firstMounted = id
        if (el.getBoundingClientRect().top <= line) active = id
        else break
      }
      const next = active ?? firstMounted
      setActiveId((prev) => (prev === next ? prev : next))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    compute()
    container.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [enabled, scrollContainerRef, turnsKey])

  // The compact ticks and spacious previews scroll independently. Keep the
  // current turn visible in both without moving the conversation itself.
  useEffect(() => {
    const pairs = [
      [railRef.current, activeTickRef.current],
      [previewRef.current, activePreviewRef.current],
    ] as const
    const keepActiveVisible = () => {
      for (const [container, item] of pairs) {
        if (!container || !item || container.scrollHeight <= container.clientHeight) continue
        const cr = container.getBoundingClientRect()
        const ir = item.getBoundingClientRect()
        if (ir.top < cr.top + 4) container.scrollTop -= cr.top + 4 - ir.top
        else if (ir.bottom > cr.bottom - 4) container.scrollTop += ir.bottom - cr.bottom + 4
      }
    }
    keepActiveVisible()
    const observer = new ResizeObserver(keepActiveVisible)
    for (const [container, item] of pairs) {
      if (container) observer.observe(container)
      if (item) observer.observe(item)
    }
    return () => observer.disconnect()
  }, [activeId, enabled])

  if (!enabled) return null

  const scrollToTurn = (id: string) => {
    const container = scrollContainerRef.current
    if (!container) return
    const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth'
    const el = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (el) el.scrollIntoView({ behavior, block: 'start' })
    // Windowed-out (not yet mounted) target: fall back to the top, matching the
    // outline — scrolling up remounts older turns.
    else container.scrollTo({ top: 0, behavior })
  }

  return (
    <nav
      aria-label={t('minimap.label', { defaultValue: 'Conversation map' })}
      className={cn(
        'group/rail pointer-events-none absolute inset-y-4 right-3 z-20',
        'flex w-[min(24rem,calc(100%-1.5rem))] items-center gap-3',
      )}
    >
      {/* Place ticks first in the tab order; focusing one reveals the list. The
          visual order keeps them outside the panel at the right edge. */}
      <div
        ref={railRef}
        data-minimap-rail
        className="pointer-events-auto order-2 flex max-h-[min(38vh,100%)] w-8 shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain scrollbar-none py-1"
      >
        {userTurns.map((m, i) => {
          const active = m.id === activeId
          const hovered = m.id === hoveredId
          return (
            <button
              key={m.id}
              ref={active ? activeTickRef : undefined}
              type="button"
              onClick={() => scrollToTurn(m.id)}
              onPointerEnter={() => setHoveredId(m.id)}
              onPointerLeave={() => setHoveredId(null)}
              aria-current={active ? 'true' : undefined}
              aria-label={`${t('minimap.jumpTo', { defaultValue: 'Jump to this question' })}: ${turnLabels[i]}`}
              className="flex h-4 w-full shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
            >
              <span
                aria-hidden
                className={cn(
                  'block rounded-full transition-[height,background-color] duration-fast ease-out motion-reduce:transition-none',
                  active
                    ? 'h-0.5 w-5 bg-[var(--color-fg)]'
                    : hovered ? 'h-1 w-4 bg-[var(--color-fg-subtle)]' : 'h-0.5 w-4 bg-[var(--color-fg-faint)]/50',
                )}
              />
            </button>
          )
        })}
      </div>
      <div
        className={cn(
          'invisible pointer-events-none relative order-1 flex max-h-[min(62vh,100%)] min-w-0 flex-1 flex-col rounded-xl bg-[var(--color-bg-muted)] p-1.5 opacity-0',
          'transition-opacity duration-fast ease-out motion-reduce:transition-none',
          'group-hover/rail:visible group-hover/rail:pointer-events-auto group-hover/rail:opacity-100',
          'group-focus-within/rail:visible group-focus-within/rail:pointer-events-auto group-focus-within/rail:opacity-100',
          // A transparent bridge keeps the preview open while crossing the gap
          // between the compact rail and the larger, independently spaced list.
          "after:absolute after:inset-y-0 after:-right-3 after:w-3 after:content-['']",
        )}
      >
        <div
          ref={previewRef}
          data-minimap-preview
          className="min-h-0 overflow-y-auto overscroll-contain scrollbar-none"
        >
          <div className="flex flex-col gap-1">
            {userTurns.map((m, i) => {
              const active = m.id === activeId
              const hovered = m.id === hoveredId
              const text = turnLabels[i]
              return (
                <button
                  key={m.id}
                  ref={active ? activePreviewRef : undefined}
                  type="button"
                  onClick={() => scrollToTurn(m.id)}
                  onPointerEnter={() => setHoveredId(m.id)}
                  onPointerLeave={() => setHoveredId(null)}
                  aria-current={active ? 'true' : undefined}
                  aria-label={`${t('minimap.jumpTo', { defaultValue: 'Jump to this question' })}: ${text}`}
                  className={cn(
                    'min-h-10 w-full shrink-0 rounded-lg px-3 py-2 text-left text-sm leading-6 outline-none',
                    'transition-colors duration-fast ease-out motion-reduce:transition-none',
                    'hover:bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] hover:text-[var(--color-fg)]',
                    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]',
                    active
                      ? 'bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] font-medium text-[var(--color-fg)]'
                      : hovered
                        ? 'bg-[color-mix(in_oklch,var(--color-fg)_6%,transparent)] text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-muted)]',
                  )}
                >
                  <span className="block truncate">{text}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </nav>
  )
}

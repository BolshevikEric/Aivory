import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import { ArrowLeft, Check, ChevronRight } from 'lucide-react'
import { createContext, forwardRef, useCallback, useContext, useRef, useState, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useQuietSurface } from '@/contexts/quiet-surface'
import { useSurfaceViewport } from '@/hooks/use-app-viewport'
import { readAppViewport } from '@/lib/app-viewport'

export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger
export const DropdownMenuGroup = DropdownPrimitive.Group
export const DropdownMenuPortal = DropdownPrimitive.Portal
export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup

const SubmenuContext = createContext<{
  trigger: RefObject<HTMLDivElement | null>
  close: () => void
} | null>(null)

export function DropdownMenuSub({ children, open, defaultOpen = false, onOpenChange, ...rest }: ComponentPropsWithoutRef<typeof DropdownPrimitive.Sub>) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const trigger = useRef<HTMLDivElement>(null)
  const setOpen = (next: boolean) => {
    setInternalOpen(next)
    onOpenChange?.(next)
  }
  return (
    <SubmenuContext.Provider value={{ trigger, close: () => { setOpen(false); trigger.current?.focus() } }}>
      <DropdownPrimitive.Sub {...rest} open={open ?? internalOpen} onOpenChange={setOpen}>
        {children}
      </DropdownPrimitive.Sub>
    </SubmenuContext.Provider>
  )
}

function useMenuViewport(padding: NonNullable<ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>['collisionPadding']>) {
  const surface = useSurfaceViewport()
  const viewport = readAppViewport()
  const edges = typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : padding
  return {
    surface,
    collisionPadding: {
      top: (edges.top ?? 0) + Math.max(0, surface.top - viewport.top),
      right: (edges.right ?? 0) + Math.max(0, viewport.right - surface.right),
      bottom: (edges.bottom ?? 0) + Math.max(0, viewport.bottom - surface.bottom),
      left: (edges.left ?? 0) + Math.max(0, surface.left - viewport.left),
    },
  }
}

const menuClass = cn(
  'viewport-menu z-[70] min-w-[200px] overflow-hidden',
  'rounded-popup border border-[var(--color-border)] bg-[var(--color-surface-raised)]',
  'shadow-[var(--shadow-popover)]',
  'p-1.5',
  // Direction-aware enter/exit (globals.css): grows out of the trigger side.
  'popup-motion',
)

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, collisionPadding = 8, ...rest }, ref) {
  const quiet = useQuietSurface()
  const viewport = useMenuViewport(collisionPadding)
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={viewport.collisionPadding}
        sticky="always"
        // Cap to the space Radix measured and scroll the overflow — a tall menu
        // opening upward from a bottom-anchored trigger (e.g. the sidebar avatar
        // menu) would otherwise clip past the viewport top with no way to reach
        // the hidden items. Submenus are portaled, so this scroll never clips them.
        className={cn(menuClass, 'max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto', quiet && 'border-0 shadow-[var(--shadow-popover-quiet)]', className)}
        {...rest}
      />
    </DropdownPrimitive.Portal>
  )
})

const itemClass = cn(
  'group/item relative flex items-center gap-2.5 cursor-pointer select-none',
  'rounded-[8px] px-2.5 py-1.5 text-sm text-[var(--color-fg)] outline-none',
  'data-[highlighted]:bg-[var(--color-bg-muted)] data-[highlighted]:text-[var(--color-fg)]',
  'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
  'transition-colors duration-100',
)

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { destructive?: boolean }
>(function DropdownMenuItem({ className, destructive, ...rest }, ref) {
  return (
    <DropdownPrimitive.Item
      ref={ref}
      className={cn(
        itemClass,
        destructive && 'text-[var(--color-danger)] data-[highlighted]:text-[var(--color-danger)] data-[highlighted]:bg-[var(--color-danger-soft)]',
        className,
      )}
      {...rest}
    />
  )
})

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof DropdownPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.SubTrigger>
>(function DropdownMenuSubTrigger({ className, children, ...rest }, ref) {
  const submenu = useContext(SubmenuContext)
  const trigger = submenu?.trigger
  const composedRef = useCallback((node: HTMLDivElement | null) => {
    if (trigger) trigger.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }, [trigger, ref])
  return (
    <DropdownPrimitive.SubTrigger
      ref={composedRef}
      className={cn(itemClass, 'data-[state=open]:bg-[var(--color-bg-muted)]', className)}
      {...rest}
    >
      {children}
      <ChevronRight size={14} aria-hidden className="ml-auto text-[var(--color-fg-subtle)]" />
    </DropdownPrimitive.SubTrigger>
  )
})

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof DropdownPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, children, collisionPadding = 8, sideOffset = 0, style, ...rest }, ref) {
  const quiet = useQuietSurface()
  const { t } = useTranslation('common')
  const submenu = useContext(SubmenuContext)
  const viewport = useMenuViewport(collisionPadding)
  const narrow = viewport.surface.width > 0 && viewport.surface.width < 640
  const triggerWidth = submenu?.trigger.current?.getBoundingClientRect().width ?? 0
  // A phone cannot fit two menus side by side. Overlap the parent trigger's
  // column while keeping Radix's positioning, focus and dismissal behavior.
  const stacked = narrow && triggerWidth > 0
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.SubContent
        ref={ref}
        data-menu-stacked={stacked || undefined}
        sideOffset={stacked ? -triggerWidth : sideOffset}
        collisionPadding={viewport.collisionPadding}
        sticky="always"
        style={{ ...style, ...(stacked ? { width: triggerWidth, minWidth: 0 } : {}) }}
        className={cn(menuClass, 'max-h-[min(var(--radix-dropdown-menu-content-available-height),22rem)] overflow-y-auto', quiet && 'border-0 shadow-[var(--shadow-popover-quiet)]', className)}
        {...rest}
      >
        {stacked && submenu ? (
          <>
            <DropdownPrimitive.Item data-menu-back className={cn(itemClass, 'min-h-11')} onSelect={(event) => { event.preventDefault(); submenu.close() }}>
              <ArrowLeft size={15} aria-hidden />
              {t('actions.back')}
            </DropdownPrimitive.Item>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {children}
      </DropdownPrimitive.SubContent>
    </DropdownPrimitive.Portal>
  )
})

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, checked, ...rest }, ref) {
  return (
    <DropdownPrimitive.CheckboxItem
      ref={ref}
      checked={checked}
      className={cn(itemClass, 'pl-7', className)}
      {...rest}
    >
      <DropdownPrimitive.ItemIndicator className="absolute left-2 inline-flex">
        <Check size={14} aria-hidden />
      </DropdownPrimitive.ItemIndicator>
      {children}
    </DropdownPrimitive.CheckboxItem>
  )
})

export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...rest }, ref) {
  return (
    <DropdownPrimitive.RadioItem ref={ref} className={cn(itemClass, 'pl-7', className)} {...rest}>
      <DropdownPrimitive.ItemIndicator className="absolute left-2 inline-flex">
        <span className="size-1.5 rounded-full bg-[var(--color-accent)]" />
      </DropdownPrimitive.ItemIndicator>
      {children}
    </DropdownPrimitive.RadioItem>
  )
})

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>
>(function DropdownMenuLabel({ className, ...rest }, ref) {
  return (
    <DropdownPrimitive.Label
      ref={ref}
      className={cn('px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]', className)}
      {...rest}
    />
  )
})

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...rest }, ref) {
  const quiet = useQuietSurface()
  return (
    <DropdownPrimitive.Separator
      ref={ref}
      className={cn('my-1 h-px bg-[var(--color-divider)] -mx-1', quiet && 'h-1 bg-transparent', className)}
      {...rest}
    />
  )
})

export function DropdownMenuShortcut({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto pl-3 text-[11px] tracking-wide text-[var(--color-fg-subtle)] font-mono', className)}
      {...rest}
    />
  )
}

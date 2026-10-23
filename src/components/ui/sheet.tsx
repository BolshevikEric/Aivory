import * as DialogPrimitive from '@radix-ui/react-dialog'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { useQuietSurface } from '@/contexts/quiet-surface'
import { useAppViewport } from '@/hooks/use-app-viewport'

/**
 * Sheet — left/right/bottom slide-over. Built on Radix Dialog primitives.
 * Used for: mobile sidebar, settings sheet, share sheet.
 */
export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

type Side = 'left' | 'right' | 'bottom' | 'top'

interface SheetContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: Side
  /** 'nav' (left/right only) = the mobile slide-over width (min(86vw,22rem)). */
  size?: 'sm' | 'md' | 'lg' | 'nav'
  /** Required for accessibility — Radix will warn otherwise. Pass JSX or a string. */
  label?: string
  scrollMode?: 'body' | 'content'
}

const sideClass: Record<Side, string> = {
  left:
    'left-0 top-0 h-full data-[state=open]:animate-[sheet-in-l_280ms_var(--ease-out)] data-[state=closed]:animate-[sheet-out-l_180ms_var(--ease-in)]',
  right:
    'right-0 top-0 h-full data-[state=open]:animate-[sheet-in-r_280ms_var(--ease-out)] data-[state=closed]:animate-[sheet-out-r_180ms_var(--ease-in)]',
  top:
    'left-0 right-0 top-0 data-[state=open]:animate-[sheet-in-t_280ms_var(--ease-out)] data-[state=closed]:animate-[sheet-out-t_180ms_var(--ease-in)]',
  bottom:
    'left-0 right-0 bottom-0 data-[state=open]:animate-[sheet-in-b_280ms_var(--ease-out)] data-[state=closed]:animate-[sheet-out-b_180ms_var(--ease-in)]',
}

const sizeForSide = (side: Side, size: 'sm' | 'md' | 'lg' | 'nav' = 'md') => {
  if (side === 'left' || side === 'right') {
    return size === 'nav'
      ? 'w-[var(--layout-drawer-w)]'
      : size === 'sm'
        ? 'w-[18rem]'
        : size === 'md'
          ? 'w-[22rem]'
          : 'w-[28rem]'
  }
  // 'nav' is meaningless for top/bottom — fall back to the medium height.
  return size === 'sm' ? 'h-[40vh]' : size === 'lg' ? 'h-[80vh]' : 'h-[60vh]'
}

export const SheetContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  function SheetContent({ side = 'right', size = 'md', label, className, scrollMode, children, ...rest }, ref) {
    const quiet = useQuietSurface()
    useAppViewport()
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-[50] bg-[var(--color-overlay)] backdrop-blur-[2px]',
            'data-[state=open]:animate-[fade-in_200ms_var(--ease-out)]',
            'data-[state=closed]:animate-[fade-out_140ms_var(--ease-in)]',
          )}
        />
        <DialogPrimitive.Content
          ref={ref}
          data-slot="sheet-content"
          data-side={side}
          data-size={size}
          data-scroll-mode={scrollMode}
          aria-describedby={undefined}
          className={cn(
            'viewport-sheet fixed z-[50] min-h-0 min-w-0 bg-[var(--color-surface)] border-[var(--color-border)]',
            sideClass[side],
            sizeForSide(side, size),
            side === 'left' && 'border-r',
            side === 'right' && 'border-l',
            side === 'top' && 'rounded-b-popup border-b',
            side === 'bottom' && 'rounded-t-popup border-t',
            quiet && 'border-0',
            'shadow-[var(--shadow-xl)] focus-visible:outline-none flex flex-col',
            className,
          )}
          {...rest}
        >
          {label ? (
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          ) : null}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    )
  },
)

export function SheetHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('shrink-0 min-w-0 px-5 pt-5 pb-3', className)} {...rest} />
}
export function SheetBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sheet-body" className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-2', className)} {...rest} />
}
export function SheetFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const quiet = useQuietSurface()
  return (
    <div
      className={cn('shrink-0 min-w-0 px-5 py-4 border-t border-[var(--color-divider)] flex flex-wrap items-center justify-end gap-2', quiet && 'border-0', className)}
      {...rest}
    />
  )
}
export const SheetTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-lg font-semibold leading-6 tracking-normal text-[var(--color-fg)]', className)}
      {...rest}
    />
  )
})
export const SheetDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-sm text-[var(--color-fg-muted)] mt-1.5', className)}
      {...rest}
    />
  )
})

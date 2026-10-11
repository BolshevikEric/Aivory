import { useMemo, type ReactNode } from 'react'
import { GenerativeReplyContext, type GenerativeReplyContextValue, type GenerativeReplyHandler, type GenerativeReplyStatus } from './generative-reply-context'

export type { GenerativeReplyHandler, GenerativeReplyStatus } from './generative-reply-context'

/** Only a chat owner supplies a reply handler. Shared/admin renderers stay read-only. */
export function GenerativeReplyProvider({ messageId, status, onReply, children }: {
  messageId: string
  status: GenerativeReplyStatus
  onReply?: GenerativeReplyHandler
  children: ReactNode
}) {
  const value = useMemo<GenerativeReplyContextValue>(() => ({
    status,
    submit: onReply ? text => onReply(messageId, text) : undefined,
  }), [messageId, onReply, status])
  return <GenerativeReplyContext.Provider value={value}>{children}</GenerativeReplyContext.Provider>
}

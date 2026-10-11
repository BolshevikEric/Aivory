import { createContext, useContext } from 'react'

export type GenerativeReplyStatus = 'ready' | 'streaming' | 'answered' | 'readonly'
export type GenerativeReplyHandler = (messageId: string, text: string) => Promise<boolean>
export interface GenerativeReplyContextValue {
  status: GenerativeReplyStatus
  submit?: (text: string) => Promise<boolean>
}

export const GenerativeReplyContext = createContext<GenerativeReplyContextValue>({ status: 'readonly' })
export const useGenerativeReply = () => useContext(GenerativeReplyContext)

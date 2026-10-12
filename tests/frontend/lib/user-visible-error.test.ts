import { describe, expect, it } from 'vitest'
import {
  OPERATION_CANCELED_MESSAGE,
  TOOL_FAILURE_MESSAGE,
  TOOL_TIMEOUT_MESSAGE,
  isToolFailureOutput,
  sanitizeToolErrorOutput,
  sanitizeUserVisibleError,
} from '@/lib/user-visible-error'

describe('user-visible error sanitization', () => {
  it('recognizes canonical tool failures without classifying ordinary tool output as an error', () => {
    for (const message of [TOOL_FAILURE_MESSAGE, TOOL_TIMEOUT_MESSAGE, OPERATION_CANCELED_MESSAGE, 'Error: unknown tool']) {
      expect(isToolFailureOutput(`  ${message}  `)).toBe(true)
    }
    for (const message of [undefined, '', 'Completed', `Documentation quotes: ${TOOL_FAILURE_MESSAGE}`, 'Search results about errors']) {
      expect(isToolFailureOutput(message)).toBe(false)
    }
  })
  it('removes an upstream image endpoint from cancellation errors', () => {
    const raw = 'Error: Post "https://images.internal.example.test/v1/images/edits": context canceled'

    const safe = sanitizeToolErrorOutput(raw)

    expect(safe).toBe(OPERATION_CANCELED_MESSAGE)
    expect(safe).not.toContain('images.internal.example.test')
    expect(safe).not.toContain('/v1/images/edits')
  })

  it('uses safe tool copy for internal network and credential diagnostics', () => {
    expect(sanitizeToolErrorOutput('dial tcp 10.0.0.8:9000: connection refused')).toBe(
      TOOL_FAILURE_MESSAGE,
    )
    expect(sanitizeToolErrorOutput('Authorization: Bearer secret-token')).toBe(
      TOOL_FAILURE_MESSAGE,
    )
  })

  it('classifies timeouts without exposing their diagnostic detail', () => {
    expect(
      sanitizeUserVisibleError('Post "https://images.internal/v1/edit": context deadline exceeded'),
    ).toBe(TOOL_TIMEOUT_MESSAGE)
  })

  it('keeps ordinary safe validation messages', () => {
    expect(sanitizeToolErrorOutput('prompt required')).toBe('prompt required')
  })
})

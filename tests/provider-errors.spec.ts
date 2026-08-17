import { describe, expect, it } from 'vitest'

import {
  createProviderAttemptRecord,
  ProviderError,
  providerHttpError,
} from '../src/provider-runtime/index.js'

describe('Provider errors and attempt records', () => {
  it.each([
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [400, false],
    [401, false],
    [404, false],
  ])('classifies HTTP %i retryability as %s', (status, retryable) => {
    expect(providerHttpError({
      capability: 'main_search',
      provider: 'search-api',
      status,
    }).retryable).toBe(retryable)
  })

  it('never projects a raw cause, response body, header, or secret message', () => {
    const secret = 'Bearer test-only-sensitive-value'
    const error = providerHttpError({
      capability: 'main_search',
      cause: new Error(`Authorization: ${secret}; response body: private`),
      provider: 'search-api',
      retryAfterMs: 2500,
      status: 429,
    })
    const record = createProviderAttemptRecord({
      attempts: 2,
      capability: 'main_search',
      durationMs: 17,
      error,
      outcome: 'failed',
      participatedInFallback: true,
      provider: 'search-api',
    })
    const serialized = JSON.stringify({ error, record })

    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('response body')
    expect(serialized).not.toContain('Authorization')
    expect(error.cause).toBeUndefined()
    expect(record).toEqual({
      attempts: 2,
      capability: 'main_search',
      durationMs: 17,
      errorKind: 'rate_limited',
      httpStatus: 429,
      outcome: 'failed',
      participatedInFallback: true,
      provider: 'search-api',
      retryable: true,
    })
  })

  it('keeps cancellation distinct from ordinary provider failure', () => {
    const abort = new DOMException('cancelled by caller', 'AbortError')
    const record = createProviderAttemptRecord({
      attempts: 1,
      capability: 'docs_search',
      durationMs: 3,
      error: abort,
      outcome: 'failed',
      participatedInFallback: false,
      provider: 'context7',
    })

    expect(record).toEqual({
      attempts: 1,
      capability: 'docs_search',
      durationMs: 3,
      outcome: 'aborted',
      participatedInFallback: false,
      provider: 'context7',
    })
  })

  it('requires an explicit safe reason for skipped work', () => {
    expect(createProviderAttemptRecord({
      attempts: 0,
      capability: 'web_search',
      durationMs: 0,
      outcome: 'skipped',
      participatedInFallback: false,
      provider: 'tavily',
      skipReason: 'budget_zero',
    })).toMatchObject({ outcome: 'skipped', skipReason: 'budget_zero' })

    expect(() => createProviderAttemptRecord({
      attempts: 0,
      capability: 'web_search',
      durationMs: 0,
      outcome: 'skipped',
      participatedInFallback: false,
      provider: 'tavily',
    })).toThrow(/skipReason/)
  })

  it('uses fixed safe vocabulary for non-HTTP errors', () => {
    const cause = new Error('token=do-not-copy')
    const error = new ProviderError({
      capability: 'docs_search',
      cause,
      kind: 'invalid_response',
      provider: 'exa',
    })

    expect(error.message).toBe('exa: response could not be validated')
    expect(JSON.stringify(error)).not.toContain('do-not-copy')
    expect(error.retryable).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import type { RetryConfig } from '../src/config.js'
import {
  exponentialBackoffMs,
  isRetryableProviderError,
  parseRetryAfterMs,
  providerHttpError,
  retryProviderOperation,
} from '../src/provider-runtime/index.js'

const policy = (overrides: Partial<RetryConfig> = {}): RetryConfig => ({
  baseDelayMs: 100,
  jitterRatio: 0,
  maxAttempts: 4,
  maxDelayMs: 1000,
  maxTotalDelayMs: 5000,
  multiplier: 2,
  ...overrides,
})

describe('Retry-After and bounded backoff', () => {
  it('parses delta-seconds and HTTP dates against an injected clock', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:27:59 GMT')
    expect(parseRetryAfterMs('1.25', now)).toBe(1250)
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(1000)
    expect(parseRetryAfterMs('not-a-date', now)).toBeUndefined()
    expect(parseRetryAfterMs(null, now)).toBeUndefined()
  })

  it('applies symmetric jitter without exceeding the per-delay cap', () => {
    expect(exponentialBackoffMs(1, policy({ jitterRatio: 0.5 }), () => 0)).toBe(50)
    expect(exponentialBackoffMs(1, policy({ jitterRatio: 0.5 }), () => 0.5)).toBe(100)
    expect(exponentialBackoffMs(4, policy({ jitterRatio: 1, maxDelayMs: 500 }), () => 1)).toBe(500)
  })

  it('retries only when the Provider explicitly classifies the error as retryable', async () => {
    let calls = 0
    const waits: number[] = []
    const notices: number[] = []
    const result = await retryProviderOperation({
      capability: 'main_search',
      operation: async () => {
        calls += 1
        if (calls < 3) {
          throw providerHttpError({
            capability: 'main_search',
            provider: 'search-api',
            status: 503,
          })
        }
        return 'ok'
      },
      onRetry: (notice) => notices.push(notice.delayMs),
      policy: policy(),
      provider: 'search-api',
      random: () => 0.5,
      shouldRetry: isRetryableProviderError,
      signal: new AbortController().signal,
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(result).toEqual({ attempts: 3, totalDelayMs: 300, value: 'ok' })
    expect(calls).toBe(3)
    expect(waits).toEqual([100, 200])
    expect(notices).toEqual(waits)
  })

  it('does not retry a non-transient status', async () => {
    let calls = 0
    const error = providerHttpError({
      capability: 'main_search',
      provider: 'search-api',
      status: 400,
    })
    const promise = retryProviderOperation({
      capability: 'main_search',
      operation: async () => {
        calls += 1
        throw error
      },
      policy: policy(),
      provider: 'search-api',
      shouldRetry: isRetryableProviderError,
      signal: new AbortController().signal,
      sleep: async () => {
        throw new Error('sleep must not run')
      },
    })

    await expect(promise).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  it('caps Retry-After and cumulative waiting', async () => {
    const waits: number[] = []
    let calls = 0
    const error = providerHttpError({
      capability: 'web_search',
      provider: 'tavily',
      retryAfterMs: 60_000,
      status: 429,
    })
    const promise = retryProviderOperation({
      capability: 'web_search',
      operation: async () => {
        calls += 1
        throw error
      },
      policy: policy({ maxAttempts: 3, maxDelayMs: 80, maxTotalDelayMs: 120 }),
      provider: 'tavily',
      shouldRetry: isRetryableProviderError,
      signal: new AbortController().signal,
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    await expect(promise).rejects.toBe(error)
    expect(calls).toBe(3)
    expect(waits).toEqual([80, 40])
    expect(waits.reduce((sum, value) => sum + value, 0)).toBe(120)
  })

  it('stops an active backoff wait on cancellation and starts no next attempt', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped the tool')
    const transient = providerHttpError({
      capability: 'docs_search',
      provider: 'context7',
      status: 503,
    })
    let calls = 0
    let announceRetry: (() => void) | undefined
    const retryAnnounced = new Promise<void>((resolve) => {
      announceRetry = resolve
    })
    const promise = retryProviderOperation({
      capability: 'docs_search',
      onRetry: () => announceRetry?.(),
      operation: async () => {
        calls += 1
        throw transient
      },
      policy: policy({ baseDelayMs: 60_000, maxDelayMs: 60_000 }),
      provider: 'context7',
      shouldRetry: isRetryableProviderError,
      signal: controller.signal,
    })
    const rejection = expect(promise).rejects.toBe(reason)

    await retryAnnounced
    controller.abort(reason)
    await rejection
    expect(calls).toBe(1)
  })

  it('never retries an AbortError even if a callback asks to retry it', async () => {
    let calls = 0
    const aborted = new DOMException('provider aborted', 'AbortError')
    const promise = retryProviderOperation({
      capability: 'docs_search',
      operation: async () => {
        calls += 1
        throw aborted
      },
      policy: policy(),
      provider: 'exa',
      shouldRetry: () => true,
      signal: new AbortController().signal,
    })

    await expect(promise).rejects.toBe(aborted)
    expect(calls).toBe(1)
  })
})

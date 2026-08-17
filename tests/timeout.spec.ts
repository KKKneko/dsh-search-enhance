import { afterEach, describe, expect, it, vi } from 'vitest'

import { runWithTimeout } from '../src/provider-runtime/index.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('cooperative timeout and caller cancellation', () => {
  it('aborts work at the uniform deadline and waits for it to quiesce', async () => {
    vi.useFakeTimers()
    let quiesced = false
    const promise = runWithTimeout(
      async (signal) => new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          quiesced = true
          resolve('ignored success after abort')
        }, { once: true })
      }),
      {
        capability: 'main_search',
        provider: 'search-api',
        signal: new AbortController().signal,
        timeoutMs: 50,
      },
    )
    const rejection = expect(promise).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    })

    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(quiesced).toBe(true)
  })

  it('lets a completed operation win before its deadline', async () => {
    vi.useFakeTimers()
    const result = await runWithTimeout(async () => 'ok', {
      capability: 'docs_search',
      provider: 'context7',
      signal: new AbortController().signal,
      timeoutMs: 50,
    })

    expect(result).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the caller cancellation reason after owned work settles', async () => {
    const controller = new AbortController()
    const reason = new Error('tool call cancelled')
    let quiesced = false
    const promise = runWithTimeout(
      async (signal) => new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          queueMicrotask(() => {
            quiesced = true
            resolve('ignored')
          })
        }, { once: true })
      }),
      {
        capability: 'web_extract',
        provider: 'direct',
        signal: controller.signal,
        timeoutMs: 60_000,
      },
    )
    const rejection = expect(promise).rejects.toBe(reason)

    controller.abort(reason)
    await rejection
    expect(quiesced).toBe(true)
  })

  it('does not start work when the caller is already cancelled', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before dispatch')
    controller.abort(reason)
    let started = false

    await expect(runWithTimeout(async () => {
      started = true
      return 'unreachable'
    }, {
      capability: 'model_list',
      provider: 'search-api',
      signal: controller.signal,
      timeoutMs: 1000,
    })).rejects.toBe(reason)
    expect(started).toBe(false)
  })
})

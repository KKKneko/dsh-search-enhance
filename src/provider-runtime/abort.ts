import { ProviderError, type ProviderCapability } from './errors.js'

/** Throw the caller's exact Error reason when possible; otherwise use a standard AbortError. */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The operation was aborted', 'AbortError')
}

/** A cancellable delay used by retry backoff. Cancellation clears the timer before rejecting. */
export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(new RangeError('delay must be a finite non-negative number'))
  }

  try {
    throwIfAborted(signal)
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => {
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    })
    const timer = setTimeout(() => finish(resolve), milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface TimeoutOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly provider: string
  readonly capability: ProviderCapability
}

/**
 * Run cooperative work under a deadline. The promise is never raced away from:
 * if work ignores abort, this helper waits for it to settle before reporting timeout/cancellation.
 */
export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive safe integer')
  }
  throwIfAborted(options.signal)

  const controller = new AbortController()
  const timeoutReason = new DOMException('The operation timed out', 'TimeoutError')
  let timedOut = false
  const onCallerAbort = (): void => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(timeoutReason)
  }, options.timeoutMs)

  try {
    const value = await operation(controller.signal)
    throwIfAborted(options.signal)
    if (timedOut) {
      throw new ProviderError({
        capability: options.capability,
        cause: timeoutReason,
        kind: 'timeout',
        provider: options.provider,
      })
    }
    return value
  } catch (error) {
    throwIfAborted(options.signal)
    if (timedOut) {
      throw new ProviderError({
        capability: options.capability,
        cause: error,
        kind: 'timeout',
        provider: options.provider,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onCallerAbort)
  }
}

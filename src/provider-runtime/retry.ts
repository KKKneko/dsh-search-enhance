import type { RetryConfig } from '../config.js'
import { abortableDelay, runWithTimeout, throwIfAborted } from './abort.js'
import {
  isAbortError,
  isProviderError,
  type ProviderCapability,
  type ProviderErrorKind,
} from './errors.js'

export type RetryPolicy = RetryConfig

export interface RetryOperationContext {
  readonly attempt: number
  readonly signal: AbortSignal
}

export interface RetryDecisionContext {
  readonly attempt: number
  readonly maxAttempts: number
}

export interface RetryNotice {
  readonly failedAttempt: number
  readonly nextAttempt: number
  readonly delayMs: number
  readonly delaySource: 'backoff' | 'retry_after'
  readonly errorKind: ProviderErrorKind
  readonly httpStatus?: number
}

export interface RetryResult<T> {
  readonly value: T
  readonly attempts: number
  readonly totalDelayMs: number
}

export interface RetryOperationOptions<T> {
  readonly provider: string
  readonly capability: ProviderCapability
  readonly signal: AbortSignal
  readonly policy: RetryPolicy
  readonly attemptTimeoutMs?: number
  readonly operation: (context: RetryOperationContext) => Promise<T>
  /** Provider-specific idempotency/transience decision; there is deliberately no implicit default. */
  readonly shouldRetry: (error: unknown, context: RetryDecisionContext) => boolean
  readonly random?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Observation failures are contained and cannot change request outcome. */
  readonly onRetry?: (notice: Readonly<RetryNotice>) => void
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
}

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive safe integer')
  }
  for (const [label, value] of [
    ['baseDelayMs', policy.baseDelayMs],
    ['maxDelayMs', policy.maxDelayMs],
    ['maxTotalDelayMs', policy.maxTotalDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`)
    }
  }
  assertFinite(policy.multiplier, 'multiplier')
  if (policy.multiplier < 1) throw new RangeError('multiplier must be at least 1')
  assertFinite(policy.jitterRatio, 'jitterRatio')
  if (policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new RangeError('jitterRatio must be from 0 through 1')
  }
}

/** Parse delta-seconds or an HTTP-date. Invalid and non-finite values return undefined. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  assertFinite(nowMs, 'nowMs')
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : undefined
  }
  const date = Date.parse(trimmed)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, date - nowMs)
}

/** Backoff after a 1-based failed attempt; jitter is symmetric and the final value is capped. */
export function exponentialBackoffMs(
  failedAttempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  validateRetryPolicy(policy)
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError('failedAttempt must be a positive safe integer')
  }
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError('random must return a finite value from 0 through 1')
  }

  const exponential = policy.baseDelayMs * policy.multiplier ** (failedAttempt - 1)
  const boundedBase = Math.min(exponential, policy.maxDelayMs)
  const jitterFactor = 1 + (sample * 2 - 1) * policy.jitterRatio
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(boundedBase * jitterFactor)))
}

/** Safe common predicate. Passing it remains an explicit Provider decision at each call site. */
export function isRetryableProviderError(error: unknown): boolean {
  return isProviderError(error) && error.retryable
}

function notifyRetry(
  callback: RetryOperationOptions<unknown>['onRetry'],
  notice: RetryNotice,
): void {
  if (callback === undefined) return
  try {
    callback(Object.freeze(notice))
  } catch {
    // Diagnostic observers must not alter request execution.
  }
}

/**
 * Retry cooperative Provider work under attempt, per-delay, and cumulative-delay bounds.
 * Caller cancellation and AbortError bypass retry and fallback immediately.
 */
export async function retryProviderOperation<T>(
  options: RetryOperationOptions<T>,
): Promise<RetryResult<T>> {
  validateRetryPolicy(options.policy)
  throwIfAborted(options.signal)
  const sleep = options.sleep ?? abortableDelay
  const random = options.random ?? Math.random
  let totalDelayMs = 0

  for (let attempt = 1; attempt <= options.policy.maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    try {
      const execute = (signal: AbortSignal) => options.operation({ attempt, signal })
      const value = options.attemptTimeoutMs === undefined
        ? await execute(options.signal)
        : await runWithTimeout(execute, {
            capability: options.capability,
            provider: options.provider,
            signal: options.signal,
            timeoutMs: options.attemptTimeoutMs,
          })
      throwIfAborted(options.signal)
      return { attempts: attempt, totalDelayMs, value }
    } catch (error) {
      throwIfAborted(options.signal)
      if (isAbortError(error)) throw error
      if (attempt >= options.policy.maxAttempts) throw error
      if (!options.shouldRetry(error, { attempt, maxAttempts: options.policy.maxAttempts })) {
        throw error
      }

      const retryAfterMs = isProviderError(error) ? error.retryAfterMs : undefined
      const delaySource = retryAfterMs === undefined ? 'backoff' : 'retry_after'
      const requestedDelay = retryAfterMs === undefined
        ? exponentialBackoffMs(attempt, options.policy, random)
        : Math.min(Math.ceil(retryAfterMs), options.policy.maxDelayMs)
      const remainingDelay = options.policy.maxTotalDelayMs - totalDelayMs
      if (requestedDelay > 0 && remainingDelay <= 0) throw error
      const delayMs = Math.min(requestedDelay, Math.max(0, remainingDelay))
      const notice: RetryNotice = {
        delayMs,
        delaySource,
        errorKind: isProviderError(error) ? error.kind : 'unknown',
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        ...(isProviderError(error) && error.status !== undefined
          ? { httpStatus: error.status }
          : {}),
      }
      notifyRetry(options.onRetry, notice)
      await sleep(delayMs, options.signal)
      totalDelayMs += delayMs
    }
  }

  throw new Error('retry loop exhausted without a result')
}

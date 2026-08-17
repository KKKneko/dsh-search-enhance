import type { RetryConfig } from '../config.js'
import {
  isAbortError,
  isProviderError,
  isRetryableProviderError,
  parseRetryAfterMs,
  ProviderError,
  providerHttpError,
  retryProviderOperation,
  throwIfAborted,
  type ProviderCapability,
} from '../provider-runtime/index.js'

export interface ProviderHttpDependencies {
  readonly fetch?: typeof globalThis.fetch
  readonly random?: () => number
  readonly retryNow?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export interface ProviderTextRequest {
  readonly provider: string
  readonly capability: ProviderCapability
  readonly endpoint: string
  readonly init: Omit<RequestInit, 'redirect' | 'signal'>
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly maximumResponseBytes: number
  readonly retry: RetryConfig
  readonly onDispatch?: () => void
}

export interface ProviderTextResponse {
  readonly body: string
  readonly responseBytes: number
  readonly attempts: number
  readonly totalDelayMs: number
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

function observeDispatch(observer: (() => void) | undefined): void {
  if (observer === undefined) return
  try {
    observer()
  } catch {
    // Diagnostics are isolated from dispatch just like retry observers.
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Best effort only; error bodies are never retained or rendered.
  }
}

async function readBoundedText(
  response: Response,
  input: Pick<ProviderTextRequest, 'provider' | 'capability' | 'signal' | 'maximumResponseBytes'>,
): Promise<{ readonly body: string; readonly responseBytes: number }> {
  const maximumBytes = positiveSafeInteger(input.maximumResponseBytes, 'maximumResponseBytes')
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength)
    if (Number.isSafeInteger(length) && length > maximumBytes) {
      await cancelResponseBody(response)
      throw new ProviderError({
        capability: input.capability,
        kind: 'budget_exceeded',
        provider: input.provider,
      })
    }
  }
  if (response.body === null) return { body: '', responseBytes: 0 }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let body = ''
  let responseBytes = 0
  const cancelReader = (): void => {
    void reader.cancel(input.signal.reason).catch(() => undefined)
  }
  input.signal.addEventListener('abort', cancelReader, { once: true })
  try {
    while (true) {
      const chunk = await reader.read()
      throwIfAborted(input.signal)
      if (chunk.done) break
      responseBytes += chunk.value.byteLength
      if (responseBytes > maximumBytes) {
        await reader.cancel()
        throw new ProviderError({
          capability: input.capability,
          kind: 'budget_exceeded',
          provider: input.provider,
        })
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
    return { body, responseBytes }
  } catch (error) {
    throwIfAborted(input.signal)
    if (isProviderError(error)) throw error
    throw new ProviderError({
      capability: input.capability,
      cause: error,
      kind: 'invalid_response',
      provider: input.provider,
    })
  } finally {
    input.signal.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
}

function fetchFailure(
  error: unknown,
  signal: AbortSignal,
  provider: string,
  capability: ProviderCapability,
): never {
  throwIfAborted(signal)
  if (isAbortError(error)) throw error
  if (isProviderError(error)) throw error
  throw new ProviderError({
    capability,
    cause: error,
    kind: 'network',
    provider,
  })
}

/**
 * Registration-free HTTP runtime for credential-bearing Providers. Every
 * attempt uses manual redirects, the active signal, bounded retry, and a full
 * streamed-response byte cap before a parser sees the body.
 */
export class ProviderHttpClient {
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly random: (() => number) | undefined
  private readonly retryNow: () => number
  private readonly sleep: ((milliseconds: number, signal: AbortSignal) => Promise<void>) | undefined

  constructor(dependencies: ProviderHttpDependencies = {}) {
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch
    this.random = dependencies.random
    this.retryNow = dependencies.retryNow ?? Date.now
    this.sleep = dependencies.sleep
  }

  async requestText(input: ProviderTextRequest): Promise<Readonly<ProviderTextResponse>> {
    const result = await retryProviderOperation({
      attemptTimeoutMs: input.timeoutMs,
      capability: input.capability,
      operation: async ({ signal }) => {
        observeDispatch(input.onDispatch)
        let response: Response
        try {
          response = await this.fetchImplementation(input.endpoint, {
            ...input.init,
            redirect: 'manual',
            signal,
          })
          throwIfAborted(signal)
        } catch (error) {
          return fetchFailure(error, signal, input.provider, input.capability)
        }
        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(
            response.headers.get('retry-after'),
            this.retryNow(),
          )
          await cancelResponseBody(response)
          throw providerHttpError({
            capability: input.capability,
            provider: input.provider,
            status: response.status,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          })
        }
        return readBoundedText(response, {
          capability: input.capability,
          maximumResponseBytes: input.maximumResponseBytes,
          provider: input.provider,
          signal,
        })
      },
      policy: input.retry,
      provider: input.provider,
      ...(this.random === undefined ? {} : { random: this.random }),
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      shouldRetry: isRetryableProviderError,
      signal: input.signal,
    })
    return Object.freeze({
      attempts: result.attempts,
      body: result.value.body,
      responseBytes: result.value.responseBytes,
      totalDelayMs: result.totalDelayMs,
    })
  }
}

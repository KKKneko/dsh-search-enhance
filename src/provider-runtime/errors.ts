export const PROVIDER_CAPABILITIES = [
  'main_search',
  'docs_search',
  'web_search',
  'web_extract',
  'site_map',
  'model_list',
] as const

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number]

export const PROVIDER_ERROR_KINDS = [
  'credential_missing',
  'configuration',
  'invalid_request',
  'rate_limited',
  'timeout',
  'network',
  'http',
  'invalid_response',
  'budget_exceeded',
  'unavailable',
  'unknown',
] as const

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number]

export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
])

export interface ProviderErrorOptions {
  readonly provider: string
  readonly capability: ProviderCapability
  readonly kind: ProviderErrorKind
  readonly retryable?: boolean
  readonly status?: number
  readonly retryAfterMs?: number
  /** Accepted at a catch boundary for API symmetry, then deliberately discarded. */
  readonly cause?: unknown
}

const KIND_MESSAGES: Record<ProviderErrorKind, string> = {
  credential_missing: 'credential is not configured',
  configuration: 'configuration is invalid',
  invalid_request: 'request was rejected before dispatch',
  rate_limited: 'request was rate limited',
  timeout: 'operation timed out',
  network: 'network operation failed',
  http: 'HTTP request failed',
  invalid_response: 'response could not be validated',
  budget_exceeded: 'resource budget was exceeded',
  unavailable: 'capability is unavailable',
  unknown: 'operation failed',
}

function validateOptionalNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${label} must be a finite non-negative number`)
  }
}

function defaultRetryable(kind: ProviderErrorKind, status: number | undefined): boolean {
  if (status !== undefined) return RETRYABLE_HTTP_STATUSES.has(status)
  return kind === 'network' || kind === 'rate_limited' || kind === 'timeout'
}

/**
 * Provider-neutral failure. Its message is generated from fixed vocabulary;
 * raw response bodies, headers, URLs, credentials, and causes are neither retained nor interpolated.
 */
export class ProviderError extends Error {
  readonly code: string
  readonly provider: string
  readonly capability: ProviderCapability
  readonly kind: ProviderErrorKind
  readonly retryable: boolean
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined

  constructor(options: ProviderErrorOptions) {
    if (options.provider.trim().length === 0) throw new TypeError('provider must not be empty')
    if (
      options.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)
    ) {
      throw new RangeError('status must be an integer from 100 through 599')
    }
    validateOptionalNonNegative(options.retryAfterMs, 'retryAfterMs')

    const message = `${options.provider}: ${KIND_MESSAGES[options.kind]}`
    super(message)
    this.name = 'ProviderError'
    this.code = `SEARCH_PROVIDER_${options.kind.toUpperCase()}`
    this.provider = options.provider
    this.capability = options.capability
    this.kind = options.kind
    this.retryable = options.retryable ?? defaultRetryable(options.kind, options.status)
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
  }

  /** Safe structured projection: deliberately excludes message, stack, cause, endpoint, and headers. */
  toJSON(): Record<string, boolean | number | string> {
    return {
      capability: this.capability,
      code: this.code,
      kind: this.kind,
      provider: this.provider,
      retryable: this.retryable,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

export interface ProviderHttpErrorOptions {
  readonly provider: string
  readonly capability: ProviderCapability
  readonly status: number
  readonly retryAfterMs?: number
  /** Accepted and discarded by the safe error boundary. */
  readonly cause?: unknown
}

/** Build an HTTP failure without retaining a response body or header collection. */
export function providerHttpError(options: ProviderHttpErrorOptions): ProviderError {
  return new ProviderError({
    capability: options.capability,
    kind: options.status === 429 ? 'rate_limited' : 'http',
    provider: options.provider,
    status: options.status,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  })
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError
}

/** Abort-like exceptions are never converted into ProviderError or retried. */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || ('code' in error && error.code === 'ABORT_ERR')
}

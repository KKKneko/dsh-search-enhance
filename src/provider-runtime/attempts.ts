import {
  isAbortError,
  isProviderError,
  type ProviderCapability,
  type ProviderErrorKind,
} from './errors.js'

export const PROVIDER_ATTEMPT_OUTCOMES = ['success', 'failed', 'aborted', 'skipped'] as const
export type ProviderAttemptOutcome = (typeof PROVIDER_ATTEMPT_OUTCOMES)[number]

export const PROVIDER_SKIP_REASONS = [
  'not_configured',
  'not_applicable',
  'budget_zero',
  'format_unsupported',
  'disabled',
] as const

export type ProviderSkipReason = (typeof PROVIDER_SKIP_REASONS)[number]

/** Secret-free diagnostic record. It has no field for a raw error message or request metadata. */
export interface ProviderAttemptRecord {
  readonly capability: ProviderCapability
  readonly provider: string
  readonly outcome: ProviderAttemptOutcome
  readonly durationMs: number
  readonly attempts: number
  readonly participatedInFallback: boolean
  readonly errorKind?: ProviderErrorKind
  readonly retryable?: boolean
  readonly httpStatus?: number
  readonly skipReason?: ProviderSkipReason
}

export interface ProviderAttemptRecordInput {
  readonly capability: ProviderCapability
  readonly provider: string
  readonly outcome: ProviderAttemptOutcome
  readonly durationMs: number
  readonly attempts: number
  readonly participatedInFallback: boolean
  readonly error?: unknown
  readonly skipReason?: ProviderSkipReason
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function normalizedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('durationMs must be a finite non-negative number')
  }
  const rounded = Math.round(value)
  if (!Number.isSafeInteger(rounded)) throw new RangeError('durationMs is too large')
  return rounded
}

/** Project one attempt onto fixed safe fields; raw causes and messages cannot cross this boundary. */
export function createProviderAttemptRecord(
  input: ProviderAttemptRecordInput,
): Readonly<ProviderAttemptRecord> {
  if (input.provider.trim().length === 0) throw new TypeError('provider must not be empty')
  const durationMs = normalizedDuration(input.durationMs)
  const attempts = nonNegativeInteger(input.attempts, 'attempts')
  if (input.outcome !== 'skipped' && attempts === 0) {
    throw new RangeError('attempts must be positive unless the provider was skipped')
  }
  if (input.outcome === 'skipped' && input.skipReason === undefined) {
    throw new TypeError('a skipped attempt requires skipReason')
  }
  if (input.outcome !== 'skipped' && input.skipReason !== undefined) {
    throw new TypeError('skipReason is valid only for a skipped attempt')
  }

  const providerError = isProviderError(input.error) ? input.error : undefined
  const aborted = input.outcome === 'aborted' || isAbortError(input.error)
  const errorKind = aborted
    ? undefined
    : providerError?.kind ?? (input.outcome === 'failed' ? 'unknown' : undefined)

  return Object.freeze({
    attempts,
    capability: input.capability,
    durationMs,
    outcome: aborted ? 'aborted' : input.outcome,
    participatedInFallback: input.participatedInFallback,
    provider: input.provider,
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(providerError === undefined || aborted ? {} : { retryable: providerError.retryable }),
    ...(providerError?.status === undefined || aborted ? {} : { httpStatus: providerError.status }),
    ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason }),
  })
}

import type { Config } from '../config.js'
import type {
  ProviderAttemptOutcome,
  ProviderAttemptRecord,
  ProviderErrorKind,
  ProviderSkipReason,
} from '../provider-runtime/index.js'

/** Formats accepted by the internal web extraction contract. */
export const WEB_EXTRACT_FORMATS = ['markdown', 'text', 'html', 'json', 'raw'] as const
export type WebExtractFormat = (typeof WEB_EXTRACT_FORMATS)[number]

/** Fixed route identifiers. The identifier is also the safe Provider label. */
export const WEB_EXTRACT_ROUTES = [
  'tavily_extract',
  'firecrawl_scrape',
  'smart_direct',
  'direct',
] as const
export type WebExtractRoute = (typeof WEB_EXTRACT_ROUTES)[number]

/** Evidence classes exposed by the result contract. */
export const WEB_EXTRACT_EVIDENCE_LEVELS = [
  'extracted_content',
  'direct_http_content',
] as const
export type WebExtractEvidenceLevel = (typeof WEB_EXTRACT_EVIDENCE_LEVELS)[number]

/** Route-to-evidence mapping. Remote and cleaned extraction is never direct HTTP evidence. */
export function evidenceLevelForRoute(route: WebExtractRoute): WebExtractEvidenceLevel {
  return route === 'direct' ? 'direct_http_content' : 'extracted_content'
}

/**
 * A safe attempt projection for one route. It deliberately reuses the stage-0
 * attempt vocabulary while narrowing `provider` to the four route identifiers.
 * No URL, header, credential, response body, or arbitrary error message fits
 * this type.
 */
export type WebExtractRouteAttempt = Omit<ProviderAttemptRecord, 'capability' | 'provider'> & {
  readonly capability: 'web_extract'
  readonly provider: WebExtractRoute
}

/** Input accepted by the registration-free orchestrator. */
export interface WebExtractInput {
  readonly url: string
  readonly format?: WebExtractFormat
  /** Optional operation snapshot; otherwise the orchestrator reads Config once. */
  readonly config?: Config
  readonly signal: AbortSignal
}

/** Normalized input handed to one adapter. */
export interface WebExtractAdapterInput {
  readonly url: string
  readonly format: WebExtractFormat
  readonly config: Config
  readonly signal: AbortSignal
  /** Counts actual HTTP dispatches without exposing request details. */
  readonly onDispatch?: () => void
}

/** Explicit direct-response transformations; absence means bounded decoded source text. */
export const DIRECT_CONTENT_TRANSFORMS = [
  'html_to_markdown',
  'html_to_text',
  'json_pretty',
] as const
export type DirectContentTransform = (typeof DIRECT_CONTENT_TRANSFORMS)[number]

/** Why a direct response intentionally contains only a fixed bounded notice. */
export const DIRECT_METADATA_ONLY_REASONS = [
  'attachment',
  'binary_content_type',
  'binary_body',
  'declared_too_large',
  'unsupported_content_encoding',
  'empty_body',
  'encoded_limit',
  'decompressed_limit',
] as const
export type DirectMetadataOnlyReason = (typeof DIRECT_METADATA_ONLY_REASONS)[number]

/**
 * Provider-owned fields before the orchestrator adds route, evidence, request
 * URL, attempts, and output bounds. Metadata is copied only when the upstream
 * response supplied an explicit, validated field. Local transport byte counts
 * are complete observed values for smart_direct; direct may instead expose a
 * bounded prefix when its corresponding truncation flag is true.
 */
export interface WebExtractAdapterResult {
  readonly content: string
  readonly finalUrl?: string
  readonly title?: string
  readonly author?: string
  readonly publishedAt?: string
  readonly canonicalUrl?: string
  readonly contentType?: string
  readonly contentLength?: number
  readonly contentDisposition?: string
  readonly contentEncoding?: string
  readonly statusCode?: number
  readonly encodedBytes?: number
  readonly decompressedBytes?: number
  readonly metadataOnlyReason?: DirectMetadataOnlyReason
  readonly contentTransform?: DirectContentTransform
  readonly encodedBodyTruncated?: true
  readonly decompressedBodyTruncated?: true
  readonly outputTruncated?: true
  readonly metadataTruncated?: true
  /** True when this adapter had to shorten body, output, or metadata. */
  readonly truncated: boolean
}

/** A usable adapter result. */
export interface WebExtractAdapterSuccess {
  readonly state: 'complete'
  readonly result: WebExtractAdapterResult
}

/** Missing credential is an optional route condition, not a provider failure. */
export interface WebExtractAdapterNotConfigured {
  readonly state: 'not_configured'
}

/** The adapter understood the request but produced no usable content. */
export interface WebExtractAdapterUnavailable {
  readonly state: 'unavailable'
}

export type WebExtractAdapterOutcome =
  | WebExtractAdapterSuccess
  | WebExtractAdapterNotConfigured
  | WebExtractAdapterUnavailable

/**
 * Uniform, registration-free adapter seam. `supports` and `enabled` are pure
 * deployment decisions. Credential resolution belongs inside `extract`, once
 * per operation; a missing credential must return `not_configured`.
 *
 * DirectFetchProvider and SmartDirectProvider are the production local-route
 * implementations. Every adapter operation is caller-signal-owned and must
 * settle only after its resources have reached quiescence.
 */
export interface WebExtractAdapter {
  readonly route: WebExtractRoute
  supports(format: WebExtractFormat): boolean
  enabled(config: Config): boolean
  extract(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome>
}

/** Dependencies for the fixed Tavily → Firecrawl → smart_direct → direct chain. */
export interface WebExtractOrchestratorDependencies {
  readonly tavilyExtract: WebExtractAdapter
  readonly firecrawlScrape: WebExtractAdapter
  readonly smartDirect: WebExtractAdapter
  readonly direct: WebExtractAdapter
  readonly getConfig?: () => Config
  /** Injectable clock for deterministic route-status durations. */
  readonly now?: () => number
}

/** Complete internal result envelope; absent metadata means the field was unavailable. */
export interface WebExtractResult {
  readonly requestedUrl: string
  readonly finalUrl?: string
  readonly content: string
  readonly format: WebExtractFormat
  readonly title?: string
  readonly author?: string
  readonly publishedAt?: string
  readonly canonicalUrl?: string
  readonly contentType?: string
  readonly contentLength?: number
  readonly contentDisposition?: string
  readonly contentEncoding?: string
  readonly statusCode?: number
  readonly encodedBytes?: number
  readonly decompressedBytes?: number
  readonly metadataOnlyReason?: DirectMetadataOnlyReason
  readonly contentTransform?: DirectContentTransform
  readonly encodedBodyTruncated?: true
  readonly decompressedBodyTruncated?: true
  readonly outputTruncated?: true
  readonly metadataTruncated?: true
  readonly retrievalRoute: WebExtractRoute
  readonly evidenceLevel: WebExtractEvidenceLevel
  readonly truncated: boolean
  readonly attempts: readonly WebExtractRouteAttempt[]
}

/** Candidate shape used by the independent output-boundary helper. */
export type WebExtractResultCandidate = Omit<WebExtractResult, 'attempts'> & {
  readonly attempts: readonly WebExtractRouteAttempt[]
}

/**
 * Unified all-routes infrastructure failure. `routeStatuses` is safe to log
 * and contains only fixed route/status fields; raw Provider errors are not
 * retained. Cancellation never becomes this error.
 */
export class WebExtractInfrastructureError extends Error {
  readonly code = 'SEARCH_WEB_EXTRACT_FAILED'
  readonly capability = 'web_extract' as const
  readonly kind = 'unavailable' as const
  readonly routeStatuses: readonly WebExtractRouteAttempt[]

  constructor(routeStatuses: readonly WebExtractRouteAttempt[]) {
    super('web_extract: all extraction routes failed')
    this.name = 'WebExtractInfrastructureError'
    this.routeStatuses = Object.freeze(routeStatuses.map(status => Object.freeze({ ...status })))
  }

  /** A safe structured projection; no raw cause, URL, body, or secret. */
  toJSON(): Record<string, unknown> {
    return {
      capability: this.capability,
      code: this.code,
      kind: this.kind,
      routeStatuses: this.routeStatuses,
    }
  }
}

/** Type guard for the fixed format enum at an untyped boundary. */
export function isWebExtractFormat(value: unknown): value is WebExtractFormat {
  return WEB_EXTRACT_FORMATS.includes(value as WebExtractFormat)
}

/** Type guard for the fixed route enum at an adapter boundary. */
export function isWebExtractRoute(value: unknown): value is WebExtractRoute {
  return WEB_EXTRACT_ROUTES.includes(value as WebExtractRoute)
}

/** Type-only aliases useful to consumers inspecting safe route diagnostics. */
export type WebExtractAttemptStatus = ProviderAttemptOutcome
export type WebExtractAttemptErrorKind = ProviderErrorKind
export type WebExtractAttemptSkipReason = ProviderSkipReason

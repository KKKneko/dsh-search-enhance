import type { Config } from '../config.js'

export const SITE_MAP_WARNING_CODES = [
  'invalid_result_url_omitted',
  'duplicate_result_url_omitted',
  'results_truncated',
  'canonical_output_truncated',
] as const

export type SiteMapWarningCode = (typeof SITE_MAP_WARNING_CODES)[number]

/** Parsed Tavily payload after independent URL validation and stable de-duplication. */
export interface ParsedTavilyMapResponse {
  readonly baseUrl?: string
  readonly results: readonly string[]
  readonly responseTime?: number
  readonly invalidResultUrls: number
  readonly duplicateResultUrls: number
}

/** Fixed production operation input; credentials and transport controls come only from Config. */
export interface TavilyMapInput {
  readonly url: string
  readonly instructions?: string
  readonly maxDepth: number
  readonly maxBreadth: number
  readonly limit: number
  readonly config: Config
  readonly signal: AbortSignal
  /** Internal dispatch counter. Observer failures must not affect the request. */
  readonly onDispatch?: () => void
}

/** Complete accepted Provider result before the model-facing count/JSON envelope bounds. */
export interface TavilyMapResult extends ParsedTavilyMapResponse {
  readonly responseBytes: number
  readonly attempts: number
  readonly totalDelayMs: number
}

/** Registration-free Provider seam used by the deferred global Consumer. */
export interface SiteMapProvider {
  readonly provider: 'tavily'
  map(input: TavilyMapInput): Promise<Readonly<TavilyMapResult>>
}

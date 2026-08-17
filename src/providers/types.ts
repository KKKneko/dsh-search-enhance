import type { Config } from '../config.js'
import type { CanonicalSource, SourceProvider } from '../contracts/index.js'
import type { ProviderCapability, ProviderErrorKind } from '../provider-runtime/index.js'

/** One bounded documentation fragment kept separate from presentation text. */
export interface DocumentationSnippet {
  readonly content: string
  readonly title?: string
  readonly libraryId?: string
}

/** Canonical, provider-neutral output after response, item, and JSON-envelope limits. */
export interface BoundedSourceProviderResult {
  readonly sources: readonly CanonicalSource[]
  readonly snippets: readonly DocumentationSnippet[]
  readonly totalSources: number
  readonly returnedSources: number
  readonly totalSnippets: number
  readonly returnedSnippets: number
  readonly responseBytes: number
  readonly truncated: boolean
}

/** A configured operation completed, possibly with a genuine empty result. */
export const SOURCE_PROVIDER_WARNING_CODES = [
  'provider_failed',
  'cache_stale',
  'cache_evicted',
] as const

export type SourceProviderWarningCode = (typeof SOURCE_PROVIDER_WARNING_CODES)[number]

/** Fixed internal warning projected by a reusable Provider operation. */
export interface SourceProviderWarning {
  readonly code: SourceProviderWarningCode
  readonly provider: string
  readonly errorKind?: ProviderErrorKind
}

export interface SourceProviderComplete {
  readonly state: 'complete'
  readonly result: BoundedSourceProviderResult
  readonly attempts: number
  readonly totalDelayMs: number
  readonly warnings?: readonly SourceProviderWarning[]
}

/** The credential disappeared or was absent when this optional operation began. */
export interface SourceProviderNotConfigured {
  readonly state: 'not_configured'
}

export type SourceProviderSearchOutcome = SourceProviderComplete | SourceProviderNotConfigured

/** Fixed request shape shared by internal documentation and discovery Providers. */
export interface SourceProviderSearchInput {
  readonly query: string
  readonly limit: number
  readonly config: Config
  readonly signal: AbortSignal
  /** Internal dispatch counter. Observer failures must not affect the request. */
  readonly onDispatch?: () => void
}

/**
 * Registration-free internal Provider seam. `configured()` exposes no value;
 * `search()` resolves its credential again for every operation and never caches it.
 */
export interface BoundedSourceProvider {
  readonly capability: Extract<ProviderCapability, 'docs_search' | 'web_search'>
  readonly provider: Extract<SourceProvider, 'context7' | 'exa' | 'tavily' | 'firecrawl'>
  configured(config: Config): Promise<boolean>
  search(input: SourceProviderSearchInput): Promise<SourceProviderSearchOutcome>
}

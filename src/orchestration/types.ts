import type { Config, SearchDepth, SearchProfile } from '../config.js'
import type { CanonicalSource, SourceRecordCandidate } from '../contracts/index.js'
import type {
  ProviderAttemptRecord,
  ProviderCapability,
  ProviderErrorKind,
} from '../provider-runtime/index.js'
import type {
  SearchApiResolvedSearchInput,
  SearchApiSearchResult,
} from '../providers/search-api.js'
import type { BoundedSourceProvider } from '../providers/types.js'

export const SEARCH_WARNING_CODES = [
  'main_search_failed',
  'provider_failed',
  'provider_result_truncated',
  'cache_stale',
  'cache_evicted',
  'answer_truncated',
  'sources_truncated',
  'canonical_output_truncated',
  'no_results',
] as const

export type SearchWarningCode = (typeof SEARCH_WARNING_CODES)[number]

/** Stable, secret-free warning; it deliberately has no arbitrary message field. */
export interface SearchWarning {
  readonly code: SearchWarningCode
  readonly capability?: ProviderCapability
  readonly provider?: string
  readonly errorKind?: ProviderErrorKind
}

export interface DiscoveryBudgetAllocation {
  readonly tavily: number
  readonly firecrawl: number
}

/** One operation's fixed policy decision, excluding credentials and endpoints. */
export interface SearchRoutingDecision {
  readonly profile: SearchProfile
  readonly depth: SearchDepth
  readonly documentationEnhancement: boolean
  readonly extraDiscoveryBudget: number
  readonly discoveryAllocation: DiscoveryBudgetAllocation
}

/** Ordinary canonical projection. It contains no routing, attempts, or hidden sources. */
export interface SearchCanonicalResult {
  readonly state: 'complete' | 'partial'
  readonly answer?: string
  readonly sources: readonly CanonicalSource[]
  readonly totalSources: number
  readonly returnedSources: number
  readonly totalAnswerCharacters: number
  readonly returnedAnswerCharacters: number
  readonly truncated: boolean
  readonly evidenceLevel: 'discovery'
  readonly warnings: readonly SearchWarning[]
}

/** Full merged candidate observed before source-record retention. */
export type SearchPersistenceCandidate = SourceRecordCandidate

/** Explicitly internal diagnostics that must not enter the ordinary result projection. */
export interface SearchOrchestrationDiagnostics {
  readonly attempts: readonly ProviderAttemptRecord[]
  readonly routing: SearchRoutingDecision
}

/** Registration-free next-layer result: ordinary output, persistence candidate, diagnostics. */
export interface SearchOrchestrationResult {
  readonly canonical: Readonly<SearchCanonicalResult>
  readonly persistence: Readonly<SearchPersistenceCandidate>
  readonly diagnostics: Readonly<SearchOrchestrationDiagnostics>
}

export interface SearchOrchestrationInput {
  readonly query: string
  readonly profile?: unknown
  readonly depth?: unknown
  /** Optional caller-owned operation snapshot; otherwise `getConfig()` is read once. */
  readonly config?: Config
  readonly signal: AbortSignal
}

/** Minimal main-Provider face used by the registration-free orchestrator. */
export interface MainSearchProvider {
  searchResolved(input: SearchApiResolvedSearchInput): Promise<SearchApiSearchResult>
}

export interface SearchOrchestratorDependencies {
  readonly getConfig: () => Config
  readonly mainSearch: MainSearchProvider
  readonly exa: BoundedSourceProvider
  readonly tavily: BoundedSourceProvider
  readonly firecrawl: BoundedSourceProvider
  /** Injectable monotonic-enough diagnostic clock; values never enter Provider requests. */
  readonly now?: () => number
}

import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type {
  Config,
  FallbackMode,
  MinimumCapabilityProfile,
  SearchApiProtocol,
  SearchDepth,
  SearchProfile,
  ThinkingLevel,
} from '../config.js'
import type { ProviderErrorKind } from '../provider-runtime/index.js'

export const DIAGNOSTIC_ACTIONS = ['show', 'test'] as const
export type DiagnosticAction = (typeof DIAGNOSTIC_ACTIONS)[number]

export const DIAGNOSTIC_CAPABILITIES = [
  'main_search',
  'docs_search',
  'web_extract',
  'site_map',
] as const
export type DiagnosticCapability = (typeof DIAGNOSTIC_CAPABILITIES)[number]

/** Fixed identifiers only; no endpoint, credential ref, or user-controlled label is accepted. */
export const DIAGNOSTIC_PROVIDERS = [
  'search_api',
  'tavily_search',
  'firecrawl_search',
  'context7',
  'exa',
  'tavily_extract',
  'firecrawl_scrape',
  'smart_direct',
  'direct',
  'tavily_map',
] as const
export type DiagnosticProviderName = (typeof DIAGNOSTIC_PROVIDERS)[number]

export const DIAGNOSTIC_PROVIDER_STATES = [
  'configured',
  'missing',
  'disabled',
  'unsupported',
  'unavailable',
] as const
export type DiagnosticProviderState = (typeof DIAGNOSTIC_PROVIDER_STATES)[number]

export const DIAGNOSTIC_ATTEMPT_OUTCOMES = [
  'success',
  'failed',
  'not_configured',
  'disabled',
  'unsupported',
  'cancelled',
] as const
export type DiagnosticAttemptOutcome = (typeof DIAGNOSTIC_ATTEMPT_OUTCOMES)[number]

export const DIAGNOSTIC_WARNING_CODES = [
  'not_configured',
  'probe_failed',
  'unsupported',
  'configuration_unavailable',
  'bounded',
] as const
export type DiagnosticWarningCode = (typeof DIAGNOSTIC_WARNING_CODES)[number]

export interface DiagnosticProviderStatus {
  readonly provider: DiagnosticProviderName
  readonly state: DiagnosticProviderState
}

export interface DiagnosticCapabilityStatus {
  readonly capability: DiagnosticCapability
  readonly available: boolean
  readonly required: boolean
  readonly providers: readonly DiagnosticProviderStatus[]
}

export interface DiagnosticProviderAttempt {
  readonly capability: DiagnosticCapability
  readonly provider: DiagnosticProviderName
  readonly outcome: DiagnosticAttemptOutcome
  readonly durationMs: number
  readonly attempts: number
  readonly errorKind?: ProviderErrorKind
}

export interface DiagnosticMinimumProfile {
  readonly profile: MinimumCapabilityProfile
  readonly satisfied: boolean
}

/** Safe deployment facts. Values, refs, endpoints, proxies, and paths do not fit this type. */
export interface DiagnosticConfigurationStatus {
  readonly defaultProfile: SearchProfile
  readonly defaultDepth: SearchDepth
  readonly searchApiProtocol: SearchApiProtocol
  readonly searchModelConfigured: boolean
  readonly thinkingLevel: ThinkingLevel
  readonly fallbackMode: FallbackMode
  /** Global definition state only; Agent/Preset restrictions determine final visibility. */
  readonly webMapEnabled: boolean
  readonly researchPlanEnabled: boolean
  readonly diagnosticsEnabled: boolean
  readonly tavilySearchEnabled: boolean
  readonly firecrawlSearchEnabled: boolean
  readonly tavilyExtractEnabled: boolean
  readonly firecrawlScrapeEnabled: boolean
  readonly smartDirectEnabled: boolean
  readonly directEnabled: boolean
}

export interface DiagnosticWarning {
  readonly code: DiagnosticWarningCode
  readonly count?: number
}

/** Registration-free internal report. The model Consumer performs a direct field projection. */
export interface SearchDiagnosticReport {
  readonly tested: boolean
  readonly action: DiagnosticAction
  readonly capabilityStatus: readonly DiagnosticCapabilityStatus[]
  readonly providerAttempts: readonly DiagnosticProviderAttempt[]
  readonly providersUsed: readonly DiagnosticProviderName[]
  readonly fallbackUsed: boolean
  readonly minimumProfile: DiagnosticMinimumProfile
  readonly configuration: DiagnosticConfigurationStatus
  readonly warnings: readonly DiagnosticWarning[]
  readonly limitations: readonly string[]
  readonly modelTextMaxBytes: number
}

export interface DiagnosticOperationInput {
  readonly config: Config
  readonly signal: AbortSignal
}

/** Replaceable runtime seam injected into the tool by the root composition. */
export interface DiagnosticReporter {
  show(input: DiagnosticOperationInput): Promise<Readonly<SearchDiagnosticReport>>
  test(input: DiagnosticOperationInput): Promise<Readonly<SearchDiagnosticReport>>
}

export interface DiagnosticProbeInput {
  readonly config: Config
  readonly signal: AbortSignal
  readonly onDispatch: () => void
}

export interface DiagnosticProbeResult {
  readonly state: 'complete' | 'not_configured'
}

/** Registration-free, structured connectivity seam; it never returns presentation text. */
export interface DiagnosticProbe {
  readonly capability: DiagnosticCapability
  readonly provider: DiagnosticProviderName
  probe(input: DiagnosticProbeInput): Promise<Readonly<DiagnosticProbeResult>>
}

export type DiagnosticCredentialDescriber = Pick<CredentialProvider, 'describe'>

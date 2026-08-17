import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

import {
  SMART_DIRECT_BROWSER_PROFILES,
  SMART_DIRECT_OPERATING_SYSTEMS,
  type SmartDirectBrowserProfile,
  type SmartDirectOperatingSystem,
} from './providers/smart-direct-profiles.js'

export const SEARCH_PROFILES = [
  'auto',
  'coding_docs',
  'code_examples',
  'project_research',
  'academic',
  'fact_check',
] as const

export type SearchProfile = (typeof SEARCH_PROFILES)[number]

export const SEARCH_DEPTHS = ['compact', 'normal', 'deep'] as const
export type SearchDepth = (typeof SEARCH_DEPTHS)[number]

export const TOOL_DISCOVERY_MODES = ['progressive', 'all'] as const
export type ToolDiscoveryMode = (typeof TOOL_DISCOVERY_MODES)[number]

export interface ToolDiscoveryConfig {
  /** progressive gates deferred operations per Agent; all activates every operation. */
  readonly mode: ToolDiscoveryMode
}

/** Stable high-level docs_search default; the Settings cap is independently bounded. */
export const DOCS_SEARCH_DEFAULT_MAX_RESULTS = 6
export const DOCS_SEARCH_MAX_RESULTS_LIMIT = 20

/** Model-visible Tavily Map defaults and hard API limits. */
export const SITE_MAP_DEFAULT_MAX_DEPTH = 1
export const SITE_MAP_DEFAULT_MAX_BREADTH = 10
export const SITE_MAP_DEFAULT_LIMIT = 30
export const SITE_MAP_MAX_DEPTH = 5
export const SITE_MAP_MAX_LINKS = 500

/** Hard model-contract bounds for the one-shot offline research planner. */
export const RESEARCH_PLAN_MAX_KNOWN_URLS = 10
export const RESEARCH_PLAN_MAX_SUB_QUERIES = 6

export const SEARCH_API_PROTOCOLS = ['completions', 'responses'] as const
export type SearchApiProtocol = (typeof SEARCH_API_PROTOCOLS)[number]

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export const FALLBACK_MODES = ['auto', 'off'] as const
export type FallbackMode = (typeof FALLBACK_MODES)[number]
export const MINIMUM_CAPABILITY_PROFILES = ['standard', 'off'] as const
export type MinimumCapabilityProfile = (typeof MINIMUM_CAPABILITY_PROFILES)[number]

/** Shared deployment bound for explicit local-route HTTP proxy URLs. */
export const WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS = 2048

export interface OutputBudget {
  readonly maxAnswerCharacters: number
  readonly maxVisibleSources: number
  readonly maxModelTextBytes: number
}

export type ProfileBudgets = Record<SearchDepth, OutputBudget>
export type SearchBudgets = Record<SearchProfile, ProfileBudgets>
export type DiscoveryBudgets = Record<SearchProfile, number>

export interface CredentialReferences {
  readonly searchApi: CredentialRef
  readonly context7: CredentialRef
  readonly exa: CredentialRef
  readonly tavily: CredentialRef
  readonly firecrawl: CredentialRef
}

export interface SearchApiConfig {
  readonly baseUrl: string
  readonly protocol: SearchApiProtocol
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly credentialRef: CredentialRef
  readonly timeoutMs: number
}

export interface DiscoveryProviderConfig {
  readonly baseUrl: string
  readonly credentialRef: CredentialRef
  readonly timeoutMs: number
}

export interface ProviderConfig {
  readonly context7: DiscoveryProviderConfig
  readonly exa: DiscoveryProviderConfig
  readonly tavily: DiscoveryProviderConfig
  readonly firecrawl: DiscoveryProviderConfig
}

export interface RetryConfig {
  /** Total calls, including the first call. */
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly multiplier: number
  readonly maxDelayMs: number
  readonly maxTotalDelayMs: number
  readonly jitterRatio: number
}

export interface RetentionConfig {
  /** Unicode code points accepted in one trimmed model search query. */
  readonly searchQueryMaxCharacters: number
  /** Raw bytes accepted from one Provider response. */
  readonly providerResponseMaxBytes: number
  /** Sources collected from one Provider before cross-Provider merge. */
  readonly providerMaxSources: number
  /** Bytes in one normalized Provider result envelope. */
  readonly providerResultMaxBytes: number
  /** Bytes in the ordinary canonical search projection. */
  readonly canonicalOutputMaxBytes: number
  /** Source-record retention count. The legacy field name is kept for config migration. */
  readonly sourceEventMaxSources: number
  /** Complete private source-record envelope bytes. The legacy field name is kept for config migration. */
  readonly sourceEventMaxBytes: number
  /** Fail-closed capacity for durable source records; existing records are never evicted. */
  readonly sourceStoreMaxRecords: number
  readonly searchSourcesMaxPageSize: number
  readonly searchSourcesPageMaxBytes: number
  readonly searchSourcesSnippetMaxCharacters: number
  /** Settings cap for the model-facing docs_search max_results parameter. */
  readonly docsSearchMaxResults: number
}

export interface CacheConfig {
  readonly context7ResolveTtlHours: number
  readonly context7DocsTtlHours: number
  /** Complete UTF-8 JSON byte ceiling for one persisted Context7 cache record. */
  readonly context7EntryMaxBytes: number
  /** Unicode code-point ceiling for each cached Context7 library text field. */
  readonly context7LibraryTextMaxCharacters: number
  /** Unicode code-point ceiling for each cached Context7 documentation snippet. */
  readonly context7SnippetMaxCharacters: number
  readonly modelListTtlMinutes: number
  /** Maximum accepted ids in one complete model-list response. */
  readonly modelListMaxModels: number
  /** Maximum persisted Context7 records or bounded in-process cache entries. */
  readonly maxEntries: number
}

export interface RemoteExtractConfig {
  /** Deployment switch; this is not a model-facing Provider selector. */
  readonly enabled: boolean
  /** Cooperative timeout for one remote operation. */
  readonly timeoutMs: number
  /** Maximum streamed response bytes before parsing. */
  readonly maxResponseBytes: number
  /** Maximum Unicode code points retained from extracted content. */
  readonly maxContentCharacters: number
}

export interface FirecrawlExtractConfig extends RemoteExtractConfig {
  /** Firecrawl request-body processing timeout, independent of transport timeout. */
  readonly scrapeTimeoutMs: number
  /** Number of empty-content scrape passes before this route is unavailable. */
  readonly maxEmptyAttempts: number
  /** Base waitFor value used by the migrated Firecrawl protocol. */
  readonly waitForBaseMs: number
}

export interface SmartDirectConfig {
  /** Deployment switch; never a model-visible Provider selector. */
  readonly enabled: boolean
  /** Optional deployment-only HTTP proxy origin; omitted means direct transport. */
  readonly proxyUrl?: string
  /** Exact public wreq-js browser fingerprint profile. */
  readonly browser: SmartDirectBrowserProfile
  /** Exact public wreq-js operating-system emulation value. */
  readonly os: SmartDirectOperatingSystem
  /** Cooperative deadline for the complete smart route, including retry and redirects. */
  readonly timeoutMs: number
  /** wreq transport DNS/TCP/TLS connection deadline. */
  readonly connectTimeoutMs: number
  /** wreq transport read-idle deadline. */
  readonly readTimeoutMs: number
  /** DOM construction, bounded scanning, Defuddle, and projection deadline. */
  readonly processingTimeoutMs: number
  /** Maximum normalized public response-header bytes inspected after wreq returns headers. */
  readonly maxHeaderBytes: number
  /** Declared encoded body size accepted before the response stream is read. */
  readonly maxContentLengthBytes: number
  /** Actual encoded bytes read with wreq automatic decompression disabled. */
  readonly maxInputBytes: number
  /** Actual bytes emitted by identity/gzip/deflate/br decompression. */
  readonly maxDecompressedBytes: number
  /** Maximum DOM nodes scanned before Defuddle starts. */
  readonly maxDomNodes: number
  /** Maximum Unicode code points retained from cleaned content. */
  readonly maxExtractedCharacters: number
  /** Maximum UTF-8 bytes retained from cleaned content. */
  readonly maxOutputBytes: number
  /** Maximum Unicode code points retained from each explicit metadata scalar. */
  readonly maxMetadataCharacters: number
  /** Complete SmartDirect adapter-result JSON byte ceiling. */
  readonly maxAdapterBytes: number
  /** Manual HTTP redirects across one smart operation. */
  readonly maxRedirects: number
  /** Retries after the initial request, shared across redirect targets. */
  readonly maxRetries: number
  readonly removeImages: boolean
  readonly includeReplies: boolean | 'extractors'
}

export interface DirectFetchConfig {
  readonly enabled: boolean
  /** Optional deployment-only HTTP proxy origin; omitted means direct transport. */
  readonly proxyUrl?: string
  /** DNS, TCP, and (for HTTPS) TLS establishment deadline per dispatch. */
  readonly connectTimeoutMs: number
  /** Time from an established connection until the first response byte arrives. */
  readonly firstByteTimeoutMs: number
  /** Cooperative deadline for the complete direct route, including retries and redirects. */
  readonly totalTimeoutMs: number
  /** Node HTTP parser ceiling for one response header section. */
  readonly maxHeaderBytes: number
  /** Declared body size above which direct returns metadata without reading the body. */
  readonly maxContentLengthBytes: number
  /** Encoded bytes observed on the wire before the response stream is stopped. */
  readonly maxInputBytes: number
  /** Bytes emitted by identity/gzip/deflate/br decoding before processing is stopped. */
  readonly maxDecompressedBytes: number
  /** UTF-8 byte ceiling for adapter content before the common envelope bound. */
  readonly maxPreviewBytes: number
  /** Bounded prefix inspected for HTML metadata and navigation hints. */
  readonly maxHtmlScanBytes: number
  /** Bounded HTML prefix accepted by deterministic text/Markdown conversion. */
  readonly maxHtmlConversionBytes: number
  /** Unicode code-point ceiling for each response metadata text field. */
  readonly maxMetadataCharacters: number
  /** Shared HTTP/meta-refresh/alternate navigation count. */
  readonly maxRedirects: number
  /** Total retries across every target in one direct operation. */
  readonly maxRetries: number
  /** Largest meta-refresh delay that may be treated as navigation. */
  readonly maxMetaRefreshDelaySeconds: number
  /** Follow a format-matching alternate only below this readable-text size. */
  readonly alternateContentThresholdCharacters: number
}

export interface WebExtractConfig {
  /** Total cooperative deadline for the entire four-route operation. */
  readonly timeoutMs: number
  readonly maxUrlCharacters: number
  /** Complete canonical result-envelope byte ceiling. */
  readonly maxOutputBytes: number
  /** Independent UTF-8 ceiling for the pure Native model-text projection. */
  readonly modelTextMaxBytes: number
  /** Common post-adapter content-character ceiling. */
  readonly maxContentCharacters: number
  /** Independent remote route controls. */
  readonly tavily: RemoteExtractConfig
  readonly firecrawl: FirecrawlExtractConfig
  readonly smartDirect: SmartDirectConfig
  readonly direct: DirectFetchConfig
}

/** @deprecated Accepted for one compatibility cycle but ignored by tool registration and visibility. */
export interface OptionalToolsConfig {
  readonly webMap: boolean
  readonly researchPlan: boolean
  readonly diagnostics: boolean
}

export interface DiagnosticsConfig {
  /** Unified wall-clock budget for status inspection and all concurrent probes. */
  readonly timeoutMs: number
  /** Maximum Provider HTTP dispatches allowed for each fixed probe. */
  readonly maxProbeAttempts: number
  /** Maximum response body accepted by a Provider probe. */
  readonly maxResponseBytes: number
  /** Maximum retained result envelope accepted by a Provider probe. */
  readonly maxResultBytes: number
  /** Maximum canonical diagnostic JSON envelope exposed to the model. */
  readonly maxOutputBytes: number
  /** Independent maximum UTF-8 bytes rendered into model text. */
  readonly modelTextMaxBytes: number
}

export interface ResearchPlanConfig {
  /** Unicode code-point ceiling for the required top-level research question. */
  readonly maxQuestionCharacters: number
  /** Unicode code-point ceiling for each sub-question and stable sub-question id. */
  readonly maxSubQueryCharacters: number
  /** Unicode code-point ceiling for each optional explicit tool query. */
  readonly maxQueryCharacters: number
  /** Unicode code-point ceiling for each sub-question reason. */
  readonly maxReasonCharacters: number
  /** Unicode code-point ceiling for each known or tool-target HTTP(S) URL. */
  readonly maxKnownUrlCharacters: number
  /** Deployment count cap within the model contract's ten-URL hard limit. */
  readonly maxKnownUrls: number
  /** Complete canonical research-plan JSON envelope byte ceiling. */
  readonly maxOutputBytes: number
  /** Independent UTF-8 ceiling for the pure Native model-text projection. */
  readonly modelTextMaxBytes: number
}

export interface SiteMapConfig {
  /** Tavily Map processing and per-attempt transport timeout; sent as whole seconds. */
  readonly timeoutMs: number
  /** Complete streamed Tavily response byte ceiling before JSON parsing. */
  readonly maxResponseBytes: number
  /** Complete public canonical JSON envelope byte ceiling. */
  readonly maxOutputBytes: number
  /** Independent UTF-8 ceiling for the pure Native model-text projection. */
  readonly modelTextMaxBytes: number
  /** Unicode code-point ceiling for the requested and Provider-returned URLs. */
  readonly maxUrlCharacters: number
  /** Unicode code-point ceiling for optional natural-language crawl instructions. */
  readonly maxInstructionsCharacters: number
  /** Deployment ceiling applied to both breadth and total-link model arguments. */
  readonly maxLinks: number
}

export interface Config {
  readonly defaultProfile: SearchProfile
  readonly defaultDepth: SearchDepth
  readonly searchApi: SearchApiConfig
  readonly providers: ProviderConfig
  readonly fallbackMode: FallbackMode
  readonly minimumProfile: MinimumCapabilityProfile
  readonly toolTimeoutMs: number
  readonly retry: RetryConfig
  readonly budgets: SearchBudgets
  readonly extraDiscoverySources: DiscoveryBudgets
  readonly retention: RetentionConfig
  readonly cache: CacheConfig
  /** Deployment-level Agent tool-discovery policy; Settings changes apply on restart. */
  readonly toolDiscovery: ToolDiscoveryConfig
  /** @deprecated Accepted and validated for compatibility, but ignored. */
  readonly optionalTools: OptionalToolsConfig
  /** Independent resource controls for the diagnostics Consumer. */
  readonly diagnostics: DiagnosticsConfig
  /** Stage-4 deterministic offline research-planning resource controls. */
  readonly researchPlan: ResearchPlanConfig
  /** Stage-3 extraction tool and route controls. */
  readonly webExtract: WebExtractConfig
  /** Stage-4 Tavily Map collection and output controls. */
  readonly siteMap: SiteMapConfig
}

export const DEFAULT_CREDENTIAL_REFS: CredentialReferences = Object.freeze({
  searchApi: credentialRef('SEARCH_API_KEY'),
  context7: credentialRef('CONTEXT7_API_KEY'),
  exa: credentialRef('EXA_API_KEY'),
  tavily: credentialRef('TAVILY_API_KEY'),
  firecrawl: credentialRef('FIRECRAWL_API_KEY'),
})

export const DEFAULT_SEARCH_BUDGETS: SearchBudgets = {
  auto: {
    compact: { maxAnswerCharacters: 6000, maxVisibleSources: 8, maxModelTextBytes: 12 * 1024 },
    normal: { maxAnswerCharacters: 12000, maxVisibleSources: 12, maxModelTextBytes: 20 * 1024 },
    deep: { maxAnswerCharacters: 24000, maxVisibleSources: 20, maxModelTextBytes: 32 * 1024 },
  },
  coding_docs: {
    compact: { maxAnswerCharacters: 3500, maxVisibleSources: 6, maxModelTextBytes: 9000 },
    normal: { maxAnswerCharacters: 7000, maxVisibleSources: 10, maxModelTextBytes: 14 * 1024 },
    deep: { maxAnswerCharacters: 14000, maxVisibleSources: 16, maxModelTextBytes: 24 * 1024 },
  },
  code_examples: {
    compact: { maxAnswerCharacters: 4000, maxVisibleSources: 8, maxModelTextBytes: 10000 },
    normal: { maxAnswerCharacters: 8000, maxVisibleSources: 12, maxModelTextBytes: 16 * 1024 },
    deep: { maxAnswerCharacters: 16000, maxVisibleSources: 20, maxModelTextBytes: 26 * 1024 },
  },
  project_research: {
    compact: { maxAnswerCharacters: 6000, maxVisibleSources: 10, maxModelTextBytes: 12 * 1024 },
    normal: { maxAnswerCharacters: 12000, maxVisibleSources: 16, maxModelTextBytes: 20 * 1024 },
    deep: { maxAnswerCharacters: 24000, maxVisibleSources: 24, maxModelTextBytes: 32 * 1024 },
  },
  academic: {
    compact: { maxAnswerCharacters: 12000, maxVisibleSources: 20, maxModelTextBytes: 24 * 1024 },
    normal: { maxAnswerCharacters: 18000, maxVisibleSources: 30, maxModelTextBytes: 32 * 1024 },
    deep: { maxAnswerCharacters: 32000, maxVisibleSources: 40, maxModelTextBytes: 48 * 1024 },
  },
  fact_check: {
    compact: { maxAnswerCharacters: 7000, maxVisibleSources: 12, maxModelTextBytes: 16 * 1024 },
    normal: { maxAnswerCharacters: 12000, maxVisibleSources: 18, maxModelTextBytes: 24 * 1024 },
    deep: { maxAnswerCharacters: 22000, maxVisibleSources: 28, maxModelTextBytes: 36 * 1024 },
  },
}

export const SEARCH_ENHANCE_SETTINGS_NAMESPACE = settingsNamespace('search-enhance')

const httpUrl = (defaultValue: string) =>
  Schema.string()
    .pattern(/^https?:\/\/(?![^/\s?#]*@)[^\s?#]+\/?$/)
    .default(defaultValue)

export function validateWebExtractProxyUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('proxyUrl must be an absolute HTTP proxy origin')
  }
  const hasAuthority = /^http:\/\//i.test(value)
  const remainder = hasAuthority ? value.slice('http://'.length) : ''
  const slashIndex = remainder.indexOf('/')
  const rawPath = slashIndex === -1 ? '' : remainder.slice(slashIndex)
  if ([
    !hasAuthority,
    value.trim() !== value,
    parsed.protocol !== 'http:',
    parsed.hostname.length === 0,
    parsed.username.length > 0,
    parsed.password.length > 0,
    parsed.pathname !== '/',
    !['', '/'].includes(rawPath),
    parsed.search.length > 0,
    parsed.hash.length > 0,
  ].some(Boolean)) {
    throw new TypeError(
      'proxyUrl must be an absolute HTTP proxy origin without userinfo, path, query, or fragment',
    )
  }
  return value
}

const proxyUrl = () => Schema.transform(
  Schema.string().max(WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS),
  validateWebExtractProxyUrl,
)

const positiveInteger = (defaultValue: number, maximum: number) =>
  Schema.number().step(1).min(1).max(maximum).default(defaultValue)

const nonNegativeInteger = (defaultValue: number, maximum: number) =>
  Schema.number().step(1).min(0).max(maximum).default(defaultValue)

const credentialReference = (defaultValue: CredentialRef) =>
  Schema.string()
    .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .role('credential-ref')
    .default(defaultValue) as Schema<CredentialRef>

const outputBudget = (defaults: OutputBudget): Schema<OutputBudget> =>
  Schema.object({
    maxAnswerCharacters: nonNegativeInteger(defaults.maxAnswerCharacters, 100_000),
    maxVisibleSources: nonNegativeInteger(defaults.maxVisibleSources, 1000),
    maxModelTextBytes: positiveInteger(defaults.maxModelTextBytes, 1024 * 1024),
  }) as Schema<OutputBudget>

const profileBudgets = (profile: SearchProfile): Schema<ProfileBudgets> =>
  Schema.object({
    compact: outputBudget(DEFAULT_SEARCH_BUDGETS[profile].compact),
    normal: outputBudget(DEFAULT_SEARCH_BUDGETS[profile].normal),
    deep: outputBudget(DEFAULT_SEARCH_BUDGETS[profile].deep),
  }) as Schema<ProfileBudgets>

const discoveryProvider = (
  baseUrl: string,
  ref: CredentialRef,
): Schema<DiscoveryProviderConfig> =>
  Schema.object({
    baseUrl: httpUrl(baseUrl),
    credentialRef: credentialReference(ref),
    timeoutMs: positiveInteger(120_000, 600_000),
  }) as Schema<DiscoveryProviderConfig>

const remoteExtract = (): Schema<RemoteExtractConfig> => Schema.object({
  enabled: Schema.boolean().default(true),
  timeoutMs: positiveInteger(120_000, 600_000),
  maxResponseBytes: positiveInteger(2 * 1024 * 1024, 32 * 1024 * 1024),
  maxContentCharacters: positiveInteger(50_000, 1_000_000),
}) as Schema<RemoteExtractConfig>

export const Config: Schema<Config> = Schema.object({
  defaultProfile: Schema.union(SEARCH_PROFILES).default('auto'),
  defaultDepth: Schema.union(SEARCH_DEPTHS).default('compact'),
  searchApi: Schema.object({
    baseUrl: httpUrl('https://api.x.ai/v1'),
    protocol: Schema.union(SEARCH_API_PROTOCOLS).default('completions'),
    model: Schema.string().default(''),
    thinkingLevel: Schema.union(THINKING_LEVELS).default('off'),
    credentialRef: credentialReference(DEFAULT_CREDENTIAL_REFS.searchApi),
    timeoutMs: positiveInteger(120_000, 600_000),
  }),
  providers: Schema.object({
    context7: discoveryProvider('https://context7.com', DEFAULT_CREDENTIAL_REFS.context7),
    exa: discoveryProvider('https://api.exa.ai', DEFAULT_CREDENTIAL_REFS.exa),
    tavily: discoveryProvider('https://api.tavily.com', DEFAULT_CREDENTIAL_REFS.tavily),
    firecrawl: discoveryProvider('https://api.firecrawl.dev/v2', DEFAULT_CREDENTIAL_REFS.firecrawl),
  }),
  fallbackMode: Schema.union(['auto', 'off'] as const).default('auto'),
  minimumProfile: Schema.union(['standard', 'off'] as const).default('standard'),
  toolTimeoutMs: positiveInteger(180_000, 900_000),
  retry: Schema.object({
    maxAttempts: positiveInteger(3, 10),
    baseDelayMs: nonNegativeInteger(1000, 120_000),
    multiplier: Schema.number().min(1).max(10).default(2),
    maxDelayMs: nonNegativeInteger(10_000, 300_000),
    maxTotalDelayMs: nonNegativeInteger(20_000, 900_000),
    jitterRatio: Schema.number().min(0).max(1).default(0.2),
  }),
  budgets: Schema.object({
    auto: profileBudgets('auto'),
    coding_docs: profileBudgets('coding_docs'),
    code_examples: profileBudgets('code_examples'),
    project_research: profileBudgets('project_research'),
    academic: profileBudgets('academic'),
    fact_check: profileBudgets('fact_check'),
  }),
  extraDiscoverySources: Schema.object({
    auto: nonNegativeInteger(0, 100),
    coding_docs: nonNegativeInteger(0, 100),
    code_examples: nonNegativeInteger(0, 100),
    project_research: nonNegativeInteger(0, 100),
    academic: nonNegativeInteger(0, 100),
    fact_check: nonNegativeInteger(0, 100),
  }),
  retention: Schema.object({
    searchQueryMaxCharacters: positiveInteger(32_000, 1_000_000),
    providerResponseMaxBytes: positiveInteger(2 * 1024 * 1024, 32 * 1024 * 1024),
    providerMaxSources: positiveInteger(100, 5000),
    providerResultMaxBytes: positiveInteger(256 * 1024, 8 * 1024 * 1024),
    canonicalOutputMaxBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
    sourceEventMaxSources: positiveInteger(100, 5000),
    sourceEventMaxBytes: positiveInteger(256 * 1024, 8 * 1024 * 1024),
    sourceStoreMaxRecords: positiveInteger(100_000, 1_000_000),
    searchSourcesMaxPageSize: Schema.number().step(1).min(20).max(1000).default(100),
    searchSourcesPageMaxBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
    searchSourcesSnippetMaxCharacters: nonNegativeInteger(4000, 100_000),
    docsSearchMaxResults: Schema.number()
      .step(1)
      .min(DOCS_SEARCH_DEFAULT_MAX_RESULTS)
      .max(DOCS_SEARCH_MAX_RESULTS_LIMIT)
      .default(DOCS_SEARCH_MAX_RESULTS_LIMIT),
  }),
  cache: Schema.object({
    context7ResolveTtlHours: positiveInteger(168, 8760),
    context7DocsTtlHours: positiveInteger(24, 8760),
    context7EntryMaxBytes: positiveInteger(256 * 1024, 8 * 1024 * 1024),
    context7LibraryTextMaxCharacters: positiveInteger(4096, 100_000),
    context7SnippetMaxCharacters: positiveInteger(1200, 100_000),
    modelListTtlMinutes: positiveInteger(10, 24 * 60),
    modelListMaxModels: positiveInteger(1000, 100_000),
    maxEntries: positiveInteger(500, 100_000),
  }),
  toolDiscovery: Schema.object({
    mode: Schema.union(TOOL_DISCOVERY_MODES).default('progressive'),
  }),
  optionalTools: Schema.object({
    webMap: Schema.boolean().default(false),
    researchPlan: Schema.boolean().default(false),
    diagnostics: Schema.boolean().default(false),
  })
    .description('Deprecated compatibility input. Values are validated but ignored; use toolDiscovery.mode.')
    .deprecated(),
  diagnostics: Schema.object({
    timeoutMs: positiveInteger(30_000, 120_000),
    maxProbeAttempts: positiveInteger(1, 3),
    maxResponseBytes: positiveInteger(128 * 1024, 4 * 1024 * 1024),
    maxResultBytes: positiveInteger(64 * 1024, 1024 * 1024),
    maxOutputBytes: Schema.number()
      .step(1)
      .min(16 * 1024)
      .max(1024 * 1024)
      .default(64 * 1024),
    modelTextMaxBytes: positiveInteger(16 * 1024, 1024 * 1024),
  }),
  researchPlan: Schema.object({
    maxQuestionCharacters: positiveInteger(32_000, 1_000_000),
    maxSubQueryCharacters: positiveInteger(10_000, 100_000),
    maxQueryCharacters: positiveInteger(10_000, 100_000),
    maxReasonCharacters: positiveInteger(10_000, 100_000),
    maxKnownUrlCharacters: positiveInteger(8192, 65_536),
    maxKnownUrls: Schema.number()
      .step(1)
      .min(1)
      .max(RESEARCH_PLAN_MAX_KNOWN_URLS)
      .default(RESEARCH_PLAN_MAX_KNOWN_URLS),
    maxOutputBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
    modelTextMaxBytes: positiveInteger(64 * 1024, 1024 * 1024),
  }),
  siteMap: Schema.object({
    timeoutMs: Schema.number().step(1000).min(10_000).max(150_000).default(150_000),
    maxResponseBytes: positiveInteger(2 * 1024 * 1024, 32 * 1024 * 1024),
    maxOutputBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
    modelTextMaxBytes: positiveInteger(64 * 1024, 1024 * 1024),
    maxUrlCharacters: positiveInteger(8192, 65_536),
    maxInstructionsCharacters: positiveInteger(10_000, 100_000),
    maxLinks: Schema.number().step(1).min(1).max(SITE_MAP_MAX_LINKS).default(SITE_MAP_MAX_LINKS),
  }),
  webExtract: Schema.object({
    timeoutMs: positiveInteger(180_000, 900_000),
    maxUrlCharacters: positiveInteger(8192, 65_536),
    maxOutputBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
    modelTextMaxBytes: positiveInteger(64 * 1024, 1024 * 1024),
    maxContentCharacters: positiveInteger(50_000, 1_000_000),
    tavily: remoteExtract(),
    firecrawl: Schema.object({
      enabled: Schema.boolean().default(true),
      timeoutMs: positiveInteger(120_000, 600_000),
      maxResponseBytes: positiveInteger(2 * 1024 * 1024, 32 * 1024 * 1024),
      maxContentCharacters: positiveInteger(50_000, 1_000_000),
      scrapeTimeoutMs: positiveInteger(60_000, 600_000),
      maxEmptyAttempts: positiveInteger(3, 10),
      waitForBaseMs: nonNegativeInteger(1500, 30_000),
    }) as Schema<FirecrawlExtractConfig>,
    smartDirect: Schema.object({
      enabled: Schema.boolean().default(true),
      proxyUrl: proxyUrl(),
      browser: Schema.union(SMART_DIRECT_BROWSER_PROFILES).default('chrome_145'),
      os: Schema.union(SMART_DIRECT_OPERATING_SYSTEMS).default('windows'),
      timeoutMs: positiveInteger(15_000, 120_000),
      connectTimeoutMs: positiveInteger(10_000, 120_000),
      readTimeoutMs: positiveInteger(15_000, 120_000),
      processingTimeoutMs: positiveInteger(5000, 120_000),
      maxHeaderBytes: positiveInteger(64 * 1024, 1024 * 1024),
      maxContentLengthBytes: positiveInteger(5 * 1024 * 1024, 64 * 1024 * 1024),
      maxInputBytes: positiveInteger(2 * 1024 * 1024, 32 * 1024 * 1024),
      maxDecompressedBytes: positiveInteger(4 * 1024 * 1024, 64 * 1024 * 1024),
      maxDomNodes: positiveInteger(100_000, 1_000_000),
      maxExtractedCharacters: positiveInteger(50_000, 1_000_000),
      maxOutputBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
      maxMetadataCharacters: positiveInteger(4096, 100_000),
      maxAdapterBytes: positiveInteger(256 * 1024, 4 * 1024 * 1024),
      maxRedirects: nonNegativeInteger(5, 20),
      maxRetries: nonNegativeInteger(2, 10),
      removeImages: Schema.boolean().default(false),
      includeReplies: Schema.union([true, false, 'extractors'] as const).default('extractors'),
    }) as Schema<SmartDirectConfig>,
    direct: Schema.object({
      enabled: Schema.boolean().default(true),
      proxyUrl: proxyUrl(),
      connectTimeoutMs: positiveInteger(10_000, 120_000),
      firstByteTimeoutMs: positiveInteger(30_000, 300_000),
      totalTimeoutMs: positiveInteger(120_000, 600_000),
      maxHeaderBytes: positiveInteger(64 * 1024, 1024 * 1024),
      maxContentLengthBytes: positiveInteger(5 * 1024 * 1024, 64 * 1024 * 1024),
      maxInputBytes: positiveInteger(2 * 1024 * 1024, 32 * 1024 * 1024),
      maxDecompressedBytes: positiveInteger(4 * 1024 * 1024, 64 * 1024 * 1024),
      maxPreviewBytes: positiveInteger(64 * 1024, 4 * 1024 * 1024),
      maxHtmlScanBytes: positiveInteger(512 * 1024, 8 * 1024 * 1024),
      maxHtmlConversionBytes: positiveInteger(2 * 1024 * 1024, 16 * 1024 * 1024),
      maxMetadataCharacters: positiveInteger(4096, 100_000),
      maxRedirects: nonNegativeInteger(5, 20),
      maxRetries: nonNegativeInteger(2, 10),
      maxMetaRefreshDelaySeconds: nonNegativeInteger(5, 60),
      alternateContentThresholdCharacters: nonNegativeInteger(500, 100_000),
    }) as Schema<DirectFetchConfig>,
  }),
}) as Schema<Config>

/** DSH Settings uses the same schema as Loader config; the user layer overrides the Loader base. */
export const SettingsSchema = Config

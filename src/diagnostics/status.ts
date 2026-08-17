import type { Config } from '../config.js'
import { throwIfAborted } from '../provider-runtime/index.js'
import type {
  DiagnosticCapability,
  DiagnosticCapabilityStatus,
  DiagnosticConfigurationStatus,
  DiagnosticCredentialDescriber,
  DiagnosticMinimumProfile,
  DiagnosticProviderName,
  DiagnosticProviderState,
  DiagnosticProviderStatus,
} from './types.js'

interface CredentialState {
  readonly state: 'configured' | 'missing' | 'unavailable'
}

export interface DiagnosticStatusSnapshot {
  readonly capabilityStatus: readonly DiagnosticCapabilityStatus[]
  readonly minimumProfile: DiagnosticMinimumProfile
  readonly configuration: DiagnosticConfigurationStatus
  /** Count of visible Provider rows whose Credentials description was unavailable. */
  readonly unavailableProviders: number
  readonly missingProviders: number
}

function freezeProviderStatus(
  provider: DiagnosticProviderName,
  state: DiagnosticProviderState,
): Readonly<DiagnosticProviderStatus> {
  return Object.freeze({ provider, state })
}

function routeState(
  enabled: boolean,
  credential: CredentialState,
): DiagnosticProviderState {
  if (credential.state === 'unavailable') return 'unavailable'
  if (!enabled) return 'disabled'
  return credential.state === 'configured' ? 'configured' : 'missing'
}

function optionalAuthState(credential: CredentialState): DiagnosticProviderState {
  return credential.state === 'unavailable' ? 'unavailable' : 'configured'
}

async function describeCredential(
  credentials: DiagnosticCredentialDescriber,
  ref: Config['searchApi']['credentialRef'],
  signal: AbortSignal,
): Promise<CredentialState> {
  throwIfAborted(signal)
  try {
    const info = await credentials.describe(ref)
    throwIfAborted(signal)
    return Object.freeze({ state: info.configured ? 'configured' : 'missing' })
  } catch (error) {
    throwIfAborted(signal)
    void error
    return Object.freeze({ state: 'unavailable' })
  }
}

async function credentialStates(
  credentials: DiagnosticCredentialDescriber,
  config: Config,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, CredentialState>> {
  const refs = [
    config.searchApi.credentialRef,
    config.providers.context7.credentialRef,
    config.providers.exa.credentialRef,
    config.providers.tavily.credentialRef,
    config.providers.firecrawl.credentialRef,
  ]
  const unique = [...new Map(refs.map(ref => [String(ref), ref])).values()]
  const settled = await Promise.all(unique.map(async ref => [
    String(ref),
    await describeCredential(credentials, ref, signal),
  ] as const))
  throwIfAborted(signal)
  return new Map(settled)
}

function stateFor(
  states: ReadonlyMap<string, CredentialState>,
  ref: Config['searchApi']['credentialRef'],
): CredentialState {
  return states.get(String(ref)) ?? Object.freeze({ state: 'unavailable' })
}

function capabilityStatus(
  capability: DiagnosticCapability,
  providers: readonly DiagnosticProviderStatus[],
  available: boolean,
  required: boolean,
): Readonly<DiagnosticCapabilityStatus> {
  return Object.freeze({
    available,
    capability,
    providers: Object.freeze([...providers]),
    required,
  })
}

function minimumSatisfied(
  statuses: readonly DiagnosticCapabilityStatus[],
  profile: Config['minimumProfile'],
): boolean {
  if (profile === 'off') return true
  return statuses.every(status => !status.required || status.available)
}

/**
 * Build a secret-free configuration/capability snapshot. This function uses
 * only Credentials.describe plus the already validated Config; it never calls
 * a Provider, resolves a value, or retains refs/endpoints/source labels.
 */
export async function inspectDiagnosticStatus(
  credentials: DiagnosticCredentialDescriber,
  config: Config,
  signal: AbortSignal,
): Promise<Readonly<DiagnosticStatusSnapshot>> {
  const states = await credentialStates(credentials, config, signal)
  const searchCredential = stateFor(states, config.searchApi.credentialRef)
  const context7Credential = stateFor(states, config.providers.context7.credentialRef)
  const exaCredential = stateFor(states, config.providers.exa.credentialRef)
  const tavilyCredential = stateFor(states, config.providers.tavily.credentialRef)
  const firecrawlCredential = stateFor(states, config.providers.firecrawl.credentialRef)
  const discoveryEnabled = Object.values(config.extraDiscoverySources).some(value => value > 0)
  const standard = config.minimumProfile === 'standard'

  const mainProviders = Object.freeze([
    freezeProviderStatus('search_api', searchCredential.state),
    freezeProviderStatus('tavily_search', routeState(discoveryEnabled, tavilyCredential)),
    freezeProviderStatus('firecrawl_search', routeState(discoveryEnabled, firecrawlCredential)),
  ])
  const docsProviders = Object.freeze([
    freezeProviderStatus('context7', optionalAuthState(context7Credential)),
    freezeProviderStatus('exa', routeState(true, exaCredential)),
  ])
  const extractProviders = Object.freeze([
    freezeProviderStatus(
      'tavily_extract',
      routeState(config.webExtract.tavily.enabled, tavilyCredential),
    ),
    freezeProviderStatus(
      'firecrawl_scrape',
      routeState(config.webExtract.firecrawl.enabled, firecrawlCredential),
    ),
    freezeProviderStatus(
      'smart_direct',
      config.webExtract.smartDirect.enabled ? 'configured' : 'disabled',
    ),
    freezeProviderStatus(
      'direct',
      config.webExtract.direct.enabled ? 'configured' : 'disabled',
    ),
  ])
  const mapProviders = Object.freeze([
    freezeProviderStatus(
      'tavily_map',
      routeState(true, tavilyCredential),
    ),
  ])

  const searchModelConfigured = config.searchApi.model.trim().length > 0
  const statuses = Object.freeze([
    capabilityStatus(
      'main_search',
      mainProviders,
      mainProviders[0]?.state === 'configured' && searchModelConfigured,
      standard,
    ),
    capabilityStatus(
      'docs_search',
      docsProviders,
      docsProviders.some(provider => provider.state === 'configured'),
      standard,
    ),
    capabilityStatus(
      'web_extract',
      extractProviders,
      extractProviders.some(provider => provider.state === 'configured'),
      standard,
    ),
    capabilityStatus(
      'site_map',
      mapProviders,
      mapProviders.some(provider => provider.state === 'configured'),
      false,
    ),
  ])

  const configuration: DiagnosticConfigurationStatus = Object.freeze({
    defaultProfile: config.defaultProfile,
    defaultDepth: config.defaultDepth,
    searchApiProtocol: config.searchApi.protocol,
    searchModelConfigured,
    thinkingLevel: config.searchApi.thinkingLevel,
    fallbackMode: config.fallbackMode,
    webMapEnabled: true,
    researchPlanEnabled: true,
    diagnosticsEnabled: true,
    tavilySearchEnabled: discoveryEnabled,
    firecrawlSearchEnabled: discoveryEnabled,
    tavilyExtractEnabled: config.webExtract.tavily.enabled,
    firecrawlScrapeEnabled: config.webExtract.firecrawl.enabled,
    smartDirectEnabled: config.webExtract.smartDirect.enabled,
    directEnabled: config.webExtract.direct.enabled,
  })
  const visibleProviders = statuses.flatMap(status => status.providers)
  return Object.freeze({
    capabilityStatus: statuses,
    configuration,
    minimumProfile: Object.freeze({
      profile: config.minimumProfile,
      satisfied: minimumSatisfied(statuses, config.minimumProfile),
    }),
    unavailableProviders: visibleProviders.filter(provider => provider.state === 'unavailable').length,
    missingProviders: visibleProviders.filter(provider => provider.state === 'missing').length,
  })
}

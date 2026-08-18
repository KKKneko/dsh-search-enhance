export const WEB_CONFIG_PATH = '/dsh-search-enhance/config'
export const WEB_CREDENTIALS_PATH = '/dsh-search-enhance/credentials'
export const WEB_BASE_URL_MAX_CHARACTERS = 8192
export const WEB_MODEL_MAX_CHARACTERS = 4096
export const WEB_CREDENTIAL_REF_MAX_CHARACTERS = 256
export const WEB_CREDENTIAL_VALUE_MAX_CHARACTERS = 16 * 1024

export const WEB_CREDENTIAL_SLOTS = [
  'searchApi',
  'context7',
  'exa',
  'tavily',
  'firecrawl',
] as const

export type WebCredentialSlot = (typeof WEB_CREDENTIAL_SLOTS)[number]

/**
 * Search profiles that carry an editable supplementary discovery budget. The
 * list is spelled here rather than imported: this contract is also the browser
 * half, and a client module must not depend on the Host configuration module.
 * The Host contract test keeps this list aligned with the configuration schema.
 */
export const WEB_EXTRA_DISCOVERY_PROFILES = [
  'auto',
  'coding_docs',
  'code_examples',
  'project_research',
  'academic',
  'fact_check',
] as const

export type WebExtraDiscoveryProfile = (typeof WEB_EXTRA_DISCOVERY_PROFILES)[number]
export type WebExtraDiscoverySources = Record<WebExtraDiscoveryProfile, number>

export const WEB_EDITABLE_PATHS: readonly (readonly string[])[] = [
  ['defaultProfile'],
  ['defaultDepth'],
  ['toolTimeoutMs'],
  ['toolDiscovery', 'mode'],
  ...WEB_EXTRA_DISCOVERY_PROFILES.map(profile => ['extraDiscoverySources', profile]),
  ['searchApi', 'baseUrl'],
  ['searchApi', 'protocol'],
  ['searchApi', 'model'],
  ['searchApi', 'thinkingLevel'],
  ['searchApi', 'credentialRef'],
  ['searchApi', 'timeoutMs'],
  ['providers', 'context7', 'baseUrl'],
  ['providers', 'context7', 'credentialRef'],
  ['providers', 'context7', 'timeoutMs'],
  ['providers', 'exa', 'baseUrl'],
  ['providers', 'exa', 'credentialRef'],
  ['providers', 'exa', 'timeoutMs'],
  ['providers', 'tavily', 'baseUrl'],
  ['providers', 'tavily', 'credentialRef'],
  ['providers', 'tavily', 'timeoutMs'],
  ['providers', 'firecrawl', 'baseUrl'],
  ['providers', 'firecrawl', 'credentialRef'],
  ['providers', 'firecrawl', 'timeoutMs'],
  ['webExtract', 'smartDirect', 'proxyUrl'],
  ['webExtract', 'direct', 'proxyUrl'],
]

export interface WebSearchApiConfig {
  baseUrl: string
  protocol: string
  model: string
  thinkingLevel: string
  credentialRef: string
  timeoutMs: number
}

export interface WebDiscoveryProviderConfig {
  baseUrl: string
  credentialRef: string
  timeoutMs: number
}

export interface WebProxyConfig {
  proxyUrl: string
}

export interface WebEditableConfig {
  defaultProfile: string
  defaultDepth: string
  toolTimeoutMs: number
  toolDiscovery: {
    mode: string
  }
  extraDiscoverySources: WebExtraDiscoverySources
  searchApi: WebSearchApiConfig
  providers: {
    context7: WebDiscoveryProviderConfig
    exa: WebDiscoveryProviderConfig
    tavily: WebDiscoveryProviderConfig
    firecrawl: WebDiscoveryProviderConfig
  }
  webExtract: {
    smartDirect: WebProxyConfig
    direct: WebProxyConfig
  }
}

export type WebConfigLayer = {
  [Key in keyof WebEditableConfig]?: WebEditableConfig[Key] extends object
    ? { [Nested in keyof WebEditableConfig[Key]]?: WebEditableConfig[Key][Nested] extends object
      ? { [Leaf in keyof WebEditableConfig[Key][Nested]]?: WebEditableConfig[Key][Nested][Leaf] }
      : WebEditableConfig[Key][Nested] }
    : WebEditableConfig[Key]
}

export interface WebConfigOptions {
  profiles: readonly string[]
  depths: readonly string[]
  protocols: readonly string[]
  thinkingLevels: readonly string[]
  toolDiscoveryModes: readonly string[]
  proxyUrlMaxCharacters: number
  extraDiscoveryMaxSources: number
}

export interface WebCredentialState {
  ref: string
  configured: boolean
  writable: boolean
  available: boolean
  source?: string
}

export interface WebDiagnosticProviderStatus {
  provider: string
  state: string
}

export interface WebDiagnosticCapabilityStatus {
  capability: string
  available: boolean
  required: boolean
  providers: readonly WebDiagnosticProviderStatus[]
}

export interface WebDiagnosticStatus {
  capabilities: readonly WebDiagnosticCapabilityStatus[]
  minimumProfile: {
    profile: string
    satisfied: boolean
  }
  missingProviders: number
  unavailableProviders: number
}

export interface WebConfigSnapshot {
  namespace: 'search-enhance'
  revision: number
  applies: 'restart'
  writable: boolean
  value: WebEditableConfig
  base?: WebConfigLayer
  user?: WebConfigLayer
  options: WebConfigOptions
  credentials: Record<WebCredentialSlot, WebCredentialState>
  diagnostics: WebDiagnosticStatus
}

export type WebSettingsMutation = {
  op: 'set'
  path: readonly string[]
  value: string | number
} | {
  op: 'unset'
  path: readonly string[]
}

export interface WebSettingsMutationRequest {
  expectedRevision: number
  mutations: readonly WebSettingsMutation[]
}

export interface WebCredentialWriteRequest {
  credential: WebCredentialSlot
  value: string
}

export interface WebCredentialDeleteRequest {
  credential: WebCredentialSlot
}

export interface WebCredentialWriteResult {
  credential: WebCredentialSlot
  state: WebCredentialState
  changed: boolean
}

export interface WebBridgeErrorBody {
  error: {
    code: string
    message: string
    actualRevision?: number
  }
}

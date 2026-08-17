import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import {
  SITE_MAP_MAX_DEPTH,
  SITE_MAP_MAX_LINKS,
  type Config,
} from '../config.js'
import {
  ProviderError,
  throwIfAborted,
} from '../provider-runtime/index.js'
import {
  canonicalSiteMapUrl,
  normalizeSiteMapInstructions,
  normalizeSiteMapUrl,
  type ParsedTavilyMapResponse,
  type SiteMapProvider,
  type TavilyMapInput,
  type TavilyMapResult,
} from '../site-map/index.js'
import {
  isRecord,
  parseProviderJson,
  providerEndpoint,
  resolveOptionalCredential,
} from './helpers.js'
import { ProviderHttpClient, type ProviderHttpDependencies } from './http.js'

const PROVIDER = 'tavily' as const
const CAPABILITY = 'site_map' as const
const MINIMUM_TIMEOUT_MS = 10_000
const MAXIMUM_TIMEOUT_MS = 150_000

export interface TavilyMapProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'resolve'>
}

function responseError(): ProviderError {
  return new ProviderError({
    capability: CAPABILITY,
    kind: 'invalid_response',
    provider: PROVIDER,
  })
}

function stableUrlKey(value: string): string {
  return new URL(value).href
}

/**
 * Strictly parse Tavily's `{ base_url?, results?, response_time? }` payload.
 * Unknown fields are ignored. Invalid result entries are omitted with a count;
 * valid URLs retain first-seen spelling and are de-duplicated in stable order.
 */
export function parseTavilyMapResponse(
  body: string,
  maximumUrlCharacters: number,
): Readonly<ParsedTavilyMapResponse> {
  const data = parseProviderJson(body, PROVIDER, CAPABILITY)
  if (!isRecord(data)) throw responseError()
  const rawResults: unknown[] = []
  if ('results' in data) {
    if (!Array.isArray(data.results)) throw responseError()
    rawResults.push(...data.results)
  }

  const results: string[] = []
  const seen = new Set<string>()
  let invalidResultUrls = 0
  let duplicateResultUrls = 0
  for (const candidate of rawResults) {
    const url = canonicalSiteMapUrl(candidate, maximumUrlCharacters)
    if (url === undefined) {
      invalidResultUrls += 1
      continue
    }
    const key = stableUrlKey(url)
    if (seen.has(key)) {
      duplicateResultUrls += 1
      continue
    }
    seen.add(key)
    results.push(url)
  }

  const baseUrl = canonicalSiteMapUrl(data.base_url, maximumUrlCharacters)
  const responseTime = typeof data.response_time === 'number'
    && Number.isFinite(data.response_time)
    && data.response_time >= 0
    ? data.response_time
    : undefined

  return Object.freeze({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    results: Object.freeze(results),
    ...(responseTime === undefined ? {} : { responseTime }),
    invalidResultUrls,
    duplicateResultUrls,
  })
}

function invalidRequest(): ProviderError {
  return new ProviderError({
    capability: CAPABILITY,
    kind: 'invalid_request',
    provider: PROVIDER,
  })
}

function configurationError(): ProviderError {
  return new ProviderError({
    capability: CAPABILITY,
    kind: 'configuration',
    provider: PROVIDER,
  })
}

function requestInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest()
  }
  return value
}

function providerTimeoutSeconds(config: Config): number {
  const milliseconds = config.siteMap.timeoutMs
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < MINIMUM_TIMEOUT_MS
    || milliseconds > MAXIMUM_TIMEOUT_MS
    || milliseconds % 1000 !== 0
  ) throw configurationError()
  return milliseconds / 1000
}

/** Production, registration-free Tavily `POST /map` Provider. */
export class TavilyMapProvider implements SiteMapProvider {
  readonly provider = PROVIDER
  private readonly credentials: Pick<CredentialProvider, 'resolve'>
  private readonly http: ProviderHttpClient

  constructor(dependencies: TavilyMapProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  async map(input: TavilyMapInput): Promise<Readonly<TavilyMapResult>> {
    throwIfAborted(input.signal)
    const config = input.config
    const deploymentMaximum = config.siteMap.maxLinks
    if (
      !Number.isSafeInteger(deploymentMaximum)
      || deploymentMaximum < 1
      || deploymentMaximum > SITE_MAP_MAX_LINKS
    ) throw configurationError()

    const url = normalizeSiteMapUrl(input.url, config.siteMap.maxUrlCharacters)
    const instructions = normalizeSiteMapInstructions(
      input.instructions,
      config.siteMap.maxInstructionsCharacters,
    )
    const maxDepth = requestInteger(input.maxDepth, 1, SITE_MAP_MAX_DEPTH)
    const maxBreadth = requestInteger(
      input.maxBreadth,
      1,
      Math.min(SITE_MAP_MAX_LINKS, deploymentMaximum),
    )
    const limit = requestInteger(
      input.limit,
      1,
      Math.min(SITE_MAP_MAX_LINKS, deploymentMaximum),
    )
    const timeout = providerTimeoutSeconds(config)
    const providerConfig = config.providers.tavily
    const credential = await resolveOptionalCredential(
      this.credentials,
      providerConfig.credentialRef,
      input.signal,
      PROVIDER,
      CAPABILITY,
    )
    if (credential === undefined) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'credential_missing',
        provider: PROVIDER,
      })
    }

    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: providerEndpoint(providerConfig.baseUrl, '/map'),
      init: {
        body: JSON.stringify({
          url,
          max_depth: maxDepth,
          max_breadth: maxBreadth,
          limit,
          timeout,
          ...(instructions === undefined ? {} : { instructions }),
        }),
        headers: {
          Authorization: `Bearer ${credential.value}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      maximumResponseBytes: config.siteMap.maxResponseBytes,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      provider: PROVIDER,
      retry: config.retry,
      signal: input.signal,
      timeoutMs: config.siteMap.timeoutMs,
    })
    throwIfAborted(input.signal)
    const parsed = parseTavilyMapResponse(response.body, config.siteMap.maxUrlCharacters)
    return Object.freeze({
      ...parsed,
      responseBytes: response.responseBytes,
      attempts: response.attempts,
      totalDelayMs: response.totalDelayMs,
    })
  }
}

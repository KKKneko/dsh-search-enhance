import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type { CanonicalSource } from '../contracts/index.js'
import { ProviderError } from '../provider-runtime/index.js'
import { boundSourceProviderResult } from './bounded-result.js'
import {
  canonicalHttpUrl,
  credentialIsConfigured,
  firstString,
  isRecord,
  nonEmptyQuery,
  parseProviderJson,
  positiveLimit,
  providerEndpoint,
  resolveOptionalCredential,
  type ProviderCredentials,
} from './helpers.js'
import { ProviderHttpClient, type ProviderHttpDependencies } from './http.js'
import type {
  BoundedSourceProvider,
  SourceProviderSearchInput,
  SourceProviderSearchOutcome,
} from './types.js'

const PROVIDER = 'firecrawl'
const CAPABILITY = 'web_search'

export interface FirecrawlSearchProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'describe' | 'resolve'>
}

/** Parse the Firecrawl v2 Search `data.web` discovery route. */
export function parseFirecrawlSearchSources(
  body: string,
  maximumUrlCharacters: number,
): readonly CanonicalSource[] {
  const data = parseProviderJson(body, PROVIDER, CAPABILITY)
  if (!isRecord(data)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  if (data.success === false) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  if (!('data' in data)) return Object.freeze([])
  if (!isRecord(data.data)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  if (!('web' in data.data)) return Object.freeze([])
  if (!Array.isArray(data.data.web)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const sources: CanonicalSource[] = []
  for (const item of data.data.web) {
    if (!isRecord(item)) continue
    const url = canonicalHttpUrl(firstString(item, ['url']), maximumUrlCharacters)
    if (url === undefined) continue
    const title = firstString(item, ['title'])
    const snippet = firstString(item, ['description'])
    sources.push(Object.freeze({
      provider: PROVIDER,
      ...(snippet === undefined ? {} : { snippet }),
      ...(title === undefined ? {} : { title }),
      url,
    }))
  }
  return Object.freeze(sources)
}

/** Internal Firecrawl v2 Search discovery Provider; scrape is intentionally out of scope. */
export class FirecrawlSearchProvider implements BoundedSourceProvider {
  readonly capability = CAPABILITY
  readonly provider = PROVIDER
  private readonly credentials: ProviderCredentials
  private readonly http: ProviderHttpClient

  constructor(dependencies: FirecrawlSearchProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  async configured(config: SourceProviderSearchInput['config']): Promise<boolean> {
    return credentialIsConfigured(
      this.credentials,
      config.providers.firecrawl.credentialRef,
      PROVIDER,
      CAPABILITY,
    )
  }

  async search(input: SourceProviderSearchInput): Promise<SourceProviderSearchOutcome> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = positiveLimit(input.limit, PROVIDER, CAPABILITY)
    const providerConfig = input.config.providers.firecrawl
    const credential = await resolveOptionalCredential(
      this.credentials,
      providerConfig.credentialRef,
      input.signal,
      PROVIDER,
      CAPABILITY,
    )
    if (credential === undefined) return Object.freeze({ state: 'not_configured' })

    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: providerEndpoint(providerConfig.baseUrl, '/search'),
      init: {
        body: JSON.stringify({ limit, query }),
        headers: {
          Authorization: `Bearer ${credential.value}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      maximumResponseBytes: input.config.retention.providerResponseMaxBytes,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      provider: PROVIDER,
      retry: input.config.retry,
      signal: input.signal,
      timeoutMs: providerConfig.timeoutMs,
    })
    const sources = parseFirecrawlSearchSources(
      response.body,
      input.config.webExtract.maxUrlCharacters,
    )
    return Object.freeze({
      attempts: response.attempts,
      result: boundSourceProviderResult({
        capability: CAPABILITY,
        config: input.config,
        provider: PROVIDER,
        requestedSources: limit,
        responseBytes: response.responseBytes,
        sources,
      }),
      state: 'complete',
      totalDelayMs: response.totalDelayMs,
    })
  }
}

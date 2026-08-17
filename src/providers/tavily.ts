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

const PROVIDER = 'tavily'
const CAPABILITY = 'web_search'

export interface TavilySearchProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'describe' | 'resolve'>
}

/** Parse Tavily Search discovery records without consuming its optional answer. */
export function parseTavilySearchSources(
  body: string,
  maximumUrlCharacters: number,
): readonly CanonicalSource[] {
  const data = parseProviderJson(body, PROVIDER, CAPABILITY)
  if (!isRecord(data)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  if (!('results' in data)) return Object.freeze([])
  if (!Array.isArray(data.results)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const sources: CanonicalSource[] = []
  for (const item of data.results) {
    if (!isRecord(item)) continue
    const url = canonicalHttpUrl(firstString(item, ['url']), maximumUrlCharacters)
    if (url === undefined) continue
    const title = firstString(item, ['title'])
    const snippet = firstString(item, ['content'])
    sources.push(Object.freeze({
      provider: PROVIDER,
      ...(snippet === undefined ? {} : { snippet }),
      ...(title === undefined ? {} : { title }),
      url,
    }))
  }
  return Object.freeze(sources)
}

/** Internal Tavily Search discovery Provider; it never consumes Tavily's generated answer. */
export class TavilySearchProvider implements BoundedSourceProvider {
  readonly capability = CAPABILITY
  readonly provider = PROVIDER
  private readonly credentials: ProviderCredentials
  private readonly http: ProviderHttpClient

  constructor(dependencies: TavilySearchProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  async configured(config: SourceProviderSearchInput['config']): Promise<boolean> {
    return credentialIsConfigured(
      this.credentials,
      config.providers.tavily.credentialRef,
      PROVIDER,
      CAPABILITY,
    )
  }

  async search(input: SourceProviderSearchInput): Promise<SourceProviderSearchOutcome> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = positiveLimit(input.limit, PROVIDER, CAPABILITY)
    const providerConfig = input.config.providers.tavily
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
        body: JSON.stringify({
          include_answer: false,
          include_raw_content: false,
          max_results: limit,
          query,
          search_depth: 'advanced',
        }),
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
    const sources = parseTavilySearchSources(
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

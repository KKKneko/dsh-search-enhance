import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type { CanonicalSource, SourceCategory } from '../contracts/index.js'
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

const PROVIDER = 'exa'
const CAPABILITY = 'docs_search'

export interface ExaProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'describe' | 'resolve'>
}

function categoryForExaUrl(url: string): SourceCategory {
  const lower = url.toLowerCase()
  if (lower.includes('github.com/')) return 'code'
  if (/\b(?:arxiv\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov)\b/.test(lower)) return 'academic'
  if (/\/(?:docs?|documentation|reference|api)(?:\/|$)/.test(lower)) return 'documentation'
  return 'unknown'
}

/** Parse Exa neural-search discovery results into canonical source records. */
export function parseExaSources(
  body: string,
  maximumUrlCharacters: number,
): readonly CanonicalSource[] {
  const data = parseProviderJson(body, PROVIDER, CAPABILITY)
  if (!isRecord(data)) {
    throw new ProviderError({
      capability: CAPABILITY,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  if (!('results' in data)) return Object.freeze([])
  if (!Array.isArray(data.results)) {
    throw new ProviderError({
      capability: CAPABILITY,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }

  const sources: CanonicalSource[] = []
  for (const item of data.results) {
    if (!isRecord(item)) continue
    const url = canonicalHttpUrl(
      firstString(item, ['url', 'id']),
      maximumUrlCharacters,
    )
    if (url === undefined) continue
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter((value): value is string => (
          typeof value === 'string' && value.trim().length > 0
        ))
      : []
    const title = firstString(item, ['title'])
    const snippet = highlights[0]?.trim() ?? firstString(item, ['text'])
    const publishedAt = firstString(item, ['publishedDate'])
    sources.push(Object.freeze({
      category: categoryForExaUrl(url),
      provider: PROVIDER,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(title === undefined ? {} : { title }),
      url,
    }))
  }
  return Object.freeze(sources)
}

/** Internal Exa discovery Provider for official sites, GitHub, papers, and product docs. */
export class ExaProvider implements BoundedSourceProvider {
  readonly capability = CAPABILITY
  readonly provider = PROVIDER
  private readonly credentials: ProviderCredentials
  private readonly http: ProviderHttpClient

  constructor(dependencies: ExaProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  async configured(config: SourceProviderSearchInput['config']): Promise<boolean> {
    return credentialIsConfigured(
      this.credentials,
      config.providers.exa.credentialRef,
      PROVIDER,
      CAPABILITY,
    )
  }

  async search(input: SourceProviderSearchInput): Promise<SourceProviderSearchOutcome> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = positiveLimit(input.limit, PROVIDER, CAPABILITY)
    const providerConfig = input.config.providers.exa
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
          contents: { highlights: true },
          numResults: limit,
          query,
          type: 'neural',
          useAutoprompt: true,
        }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': credential.value,
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
    const sources = parseExaSources(response.body, input.config.webExtract.maxUrlCharacters)
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

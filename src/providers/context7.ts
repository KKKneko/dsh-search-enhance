import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type { CanonicalSource } from '../contracts/index.js'
import type {
  CachedContext7Library,
  CachedDocumentationSnippet,
} from '../documentation/cache-domain.js'
import {
  isContext7LibraryId,
  normalizeContext7LibraryId,
  type Context7DocsRemoteResult,
  type Context7ResolveRemoteResult,
} from '../documentation/context7-cache.js'
import { ProviderError, truncateCharacters } from '../provider-runtime/index.js'
import { boundSourceProviderResult } from './bounded-result.js'
import {
  canonicalHttpUrl,
  firstString,
  isRecord,
  nonEmptyQuery,
  positiveLimit,
  providerEndpoint,
  resolveOptionalCredential,
  type ProviderCredentials,
} from './helpers.js'
import { ProviderHttpClient, type ProviderHttpDependencies } from './http.js'
import type {
  BoundedSourceProvider,
  DocumentationSnippet,
  SourceProviderSearchInput,
  SourceProviderSearchOutcome,
} from './types.js'

const PROVIDER = 'context7'
const CAPABILITY = 'docs_search'
const DEFAULT_PARSE_ITEMS = 5000
const DEFAULT_LIBRARY_TEXT_CHARACTERS = 4096
const DEFAULT_SNIPPET_CHARACTERS = 1200

export interface Context7ProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'describe' | 'resolve'>
}

export type Context7Library = CachedContext7Library

export interface ParsedContext7Libraries {
  readonly libraries: readonly Context7Library[]
  readonly totalLibraries: number
  readonly truncated: boolean
}

export interface ParsedContext7Snippets {
  readonly snippets: readonly DocumentationSnippet[]
  readonly totalSnippets: number
  readonly truncated: boolean
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function shortened(value: string, maximumCharacters: number): {
  readonly text: string
  readonly truncated: boolean
} {
  const limited = truncateCharacters(value.trim(), maximumCharacters)
  return { text: limited.text, truncated: limited.truncated }
}

function positiveParserLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

/** Parse and bound the Pi-compatible Context7 v2 library result envelope. */
export function parseContext7LibraryResponse(
  body: string,
  maximumItems: number,
  maximumTextCharacters: number,
): Readonly<ParsedContext7Libraries> {
  positiveParserLimit(maximumItems, 'maximumItems')
  positiveParserLimit(maximumTextCharacters, 'maximumTextCharacters')
  let data: unknown
  try {
    data = JSON.parse(body) as unknown
  } catch (error) {
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.results)
      ? data.results
      : isRecord(data) && !('results' in data)
        ? []
        : undefined
  if (raw === undefined) {
    throw new ProviderError({
      capability: CAPABILITY,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }

  let totalLibraries = 0
  let truncated = false
  const libraries: Context7Library[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    totalLibraries += 1
    if (libraries.length >= maximumItems) {
      truncated = true
      continue
    }
    const text = (keys: readonly string[]): string | undefined => {
      const value = firstString(item, keys)
      if (value === undefined) return undefined
      const limited = shortened(value, maximumTextCharacters)
      truncated ||= limited.truncated
      return limited.text.length === 0 ? undefined : limited.text
    }
    const id = text(['id'])
    const title = text(['title', 'name'])
    const description = text(['description', 'summary'])
    const trustScore = optionalFiniteNumber(item.trustScore)
    const benchmarkScore = optionalFiniteNumber(item.benchmarkScore)
    const totalSnippets = optionalFiniteNumber(item.totalSnippets)
    const stars = optionalFiniteNumber(item.stars)
    let versions: readonly string[] | undefined
    if (Array.isArray(item.versions)) {
      const normalized: string[] = []
      let totalVersions = 0
      for (const version of item.versions) {
        if (typeof version !== 'string' || version.trim().length === 0) continue
        totalVersions += 1
        if (normalized.length >= 1000) {
          truncated = true
          continue
        }
        const limited = shortened(version, maximumTextCharacters)
        truncated ||= limited.truncated
        if (limited.text.length > 0) normalized.push(limited.text)
      }
      truncated ||= normalized.length < totalVersions
      versions = Object.freeze(normalized)
    }
    libraries.push(Object.freeze({
      ...(id === undefined ? {} : { id }),
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(trustScore === undefined ? {} : { trustScore }),
      ...(benchmarkScore === undefined ? {} : { benchmarkScore }),
      ...(totalSnippets === undefined || totalSnippets < 0 ? {} : { totalSnippets }),
      ...(stars === undefined || stars < 0 ? {} : { stars }),
      ...(versions === undefined ? {} : { versions }),
    }))
  }
  return Object.freeze({
    libraries: Object.freeze(libraries),
    totalLibraries,
    truncated: truncated || libraries.length < totalLibraries,
  })
}

/** Compatibility parser with fixed defensive ceilings. */
export function parseContext7Libraries(body: string): readonly Context7Library[] {
  return parseContext7LibraryResponse(
    body,
    DEFAULT_PARSE_ITEMS,
    DEFAULT_LIBRARY_TEXT_CHARACTERS,
  ).libraries
}

function normalizedMatchText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '')
}

function context7LibraryScore(
  item: Context7Library,
  libraryName: string,
  query: string,
): number {
  const wanted = normalizedMatchText(libraryName)
  const rawText = `${item.id ?? ''} ${item.title ?? ''} ${item.description ?? ''}`.toLowerCase()
  const title = normalizedMatchText(item.title)
  const description = normalizedMatchText(item.description)
  const idSegments = (item.id ?? '').split('/').filter(Boolean).map(normalizedMatchText)
  let score = 0

  if (/official.*documentation|documentation.*official|official docs|react\.dev/.test(rawText)) score += 260
  if (rawText.includes('react.dev')) score += 120
  if (wanted.length > 0) {
    if (title === wanted) score += 240
    if (idSegments.some(segment => segment === wanted)) score += 220
    if (idSegments.at(-1) === wanted) score += 40
    if (title.startsWith(wanted)) score += 50
    if (title.includes(wanted)) score += 20
    if (description.includes(wanted)) score += 8
  }
  for (const term of query.toLowerCase().split(/[^a-z0-9@.\-/]+/).filter(term => term.length > 1)) {
    const normalizedTerm = normalizedMatchText(term)
    if (normalizedTerm.length === 0) continue
    if (title === normalizedTerm) score += 24
    else if (title.includes(normalizedTerm)) score += 2
    if (idSegments.some(segment => segment === normalizedTerm)) score += 20
    if (description.includes(normalizedTerm)) score += 1
  }
  if (/official|documentation|docs/.test(rawText)) score += 10
  if (item.trustScore !== undefined) score += item.trustScore * 2
  if (item.benchmarkScore !== undefined) score += item.benchmarkScore / 2
  if (item.totalSnippets !== undefined) {
    score += Math.min(30, Math.log10(Math.max(1, item.totalSnippets)) * 8)
  }
  if (item.stars !== undefined) score += Math.min(20, Math.log10(Math.max(1, item.stars)) * 4)
  return score
}

/** Stable selection by exact name, description relevance, trust, benchmark, and snippet coverage. */
export function selectContext7Library(
  libraries: readonly Context7Library[],
  libraryName: string,
  query = libraryName,
): Context7Library | undefined {
  return libraries
    .map((library, index) => ({
      index,
      library,
      score: context7LibraryScore(library, libraryName, query),
    }))
    .filter(candidate => isContext7LibraryId(candidate.library.id))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.library
}

/** Parse JSON or plain-text Context7 v2 documentation bodies exactly once and bound every snippet. */
export function parseContext7SnippetResponse(
  body: string,
  maximumItems: number,
  maximumCharacters: number,
): Readonly<ParsedContext7Snippets> {
  positiveParserLimit(maximumItems, 'maximumItems')
  positiveParserLimit(maximumCharacters, 'maximumCharacters')
  if (body.trim().length === 0) {
    return Object.freeze({ snippets: Object.freeze([]), totalSnippets: 0, truncated: false })
  }
  let data: unknown
  try {
    data = JSON.parse(body) as unknown
  } catch {
    data = body
  }

  const raw: unknown[] = []
  if (typeof data === 'string') raw.push(data)
  else if (Array.isArray(data)) raw.push(...data)
  else if (isRecord(data)) {
    if (Array.isArray(data.codeSnippets)) raw.push(...data.codeSnippets)
    if (Array.isArray(data.infoSnippets)) raw.push(...data.infoSnippets)
    if (typeof data.content === 'string' && data.content.trim().length > 0) raw.push(data.content)
  } else {
    throw new ProviderError({
      capability: CAPABILITY,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }

  let totalSnippets = 0
  let truncated = false
  const snippets: DocumentationSnippet[] = []
  for (const item of raw) {
    const rawContent = typeof item === 'string'
      ? item
      : isRecord(item)
        ? firstString(item, ['content', 'text', 'description', 'code'])
        : undefined
    if (rawContent === undefined) continue
    totalSnippets += 1
    if (snippets.length >= maximumItems) {
      truncated = true
      continue
    }
    const content = shortened(rawContent, maximumCharacters)
    truncated ||= content.truncated
    const rawTitle = isRecord(item) ? firstString(item, ['title', 'name', 'filePath']) : undefined
    const title = rawTitle === undefined ? undefined : shortened(rawTitle, maximumCharacters)
    truncated ||= title?.truncated === true
    snippets.push(Object.freeze({
      content: content.text,
      ...(title === undefined || title.text.length === 0 ? {} : { title: title.text }),
    }))
  }
  return Object.freeze({
    snippets: Object.freeze(snippets),
    totalSnippets,
    truncated: truncated || snippets.length < totalSnippets,
  })
}

/** Compatibility parser with fixed defensive ceilings. */
export function parseContext7Snippets(body: string): {
  readonly snippets: readonly DocumentationSnippet[]
  readonly totalSnippets: number
  readonly truncated: boolean
} {
  return parseContext7SnippetResponse(body, DEFAULT_PARSE_ITEMS, DEFAULT_SNIPPET_CHARACTERS)
}

export function context7LibraryUrl(
  baseUrl: string,
  id: string,
  maximumCharacters: number,
): string | undefined {
  if (/^https?:\/\//i.test(id)) return canonicalHttpUrl(id, maximumCharacters)
  return canonicalHttpUrl(
    `${baseUrl.replace(/\/+$/, '')}/${id.replace(/^\/+/, '')}`,
    maximumCharacters,
  )
}

export function context7LibrarySource(
  library: Context7Library,
  baseUrl: string,
  maximumUrlCharacters: number,
  snippet?: string,
): Readonly<CanonicalSource> | undefined {
  if (library.id === undefined) return undefined
  const url = context7LibraryUrl(baseUrl, library.id, maximumUrlCharacters)
  if (url === undefined) return undefined
  return Object.freeze({
    category: 'documentation',
    provider: PROVIDER,
    ...(snippet === undefined ? {} : { snippet }),
    title: library.title ?? library.id,
    url,
  })
}

function context7Headers(credential: { readonly value: string } | undefined): Record<string, string> {
  return {
    Accept: 'application/json, text/plain',
    'X-Context7-Source': 'pi-search',
    ...(credential === undefined ? {} : { Authorization: `Bearer ${credential.value}` }),
  }
}

/** Two reusable remote operations. Each resolves the active credential independently. */
export class Context7RemoteClient {
  private readonly credentials: ProviderCredentials
  private readonly http: ProviderHttpClient

  constructor(dependencies: Context7ProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  async resolve(input: SourceProviderSearchInput): Promise<Readonly<Context7ResolveRemoteResult>> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = positiveLimit(input.limit, PROVIDER, CAPABILITY)
    const providerConfig = input.config.providers.context7
    const credential = await resolveOptionalCredential(
      this.credentials,
      providerConfig.credentialRef,
      input.signal,
      PROVIDER,
      CAPABILITY,
    )
    const resolveUrl = new URL(providerEndpoint(providerConfig.baseUrl, '/api/v2/search'))
    resolveUrl.searchParams.set('query', query)
    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: resolveUrl.href,
      init: { headers: context7Headers(credential), method: 'GET' },
      maximumResponseBytes: input.config.retention.providerResponseMaxBytes,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      provider: PROVIDER,
      retry: input.config.retry,
      signal: input.signal,
      timeoutMs: providerConfig.timeoutMs,
    })
    const parsed = parseContext7LibraryResponse(
      response.body,
      limit,
      input.config.cache.context7LibraryTextMaxCharacters,
    )
    return Object.freeze({
      attempts: response.attempts,
      libraries: parsed.libraries,
      responseBytes: response.responseBytes,
      totalDelayMs: response.totalDelayMs,
      totalLibraries: parsed.totalLibraries,
      truncated: parsed.truncated,
    })
  }

  async docs(
    input: SourceProviderSearchInput & { readonly libraryId: string },
  ): Promise<Readonly<Context7DocsRemoteResult>> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = positiveLimit(input.limit, PROVIDER, CAPABILITY)
    const libraryId = normalizeContext7LibraryId(input.libraryId)
    const providerConfig = input.config.providers.context7
    const credential = await resolveOptionalCredential(
      this.credentials,
      providerConfig.credentialRef,
      input.signal,
      PROVIDER,
      CAPABILITY,
    )
    const docsUrl = new URL(providerEndpoint(providerConfig.baseUrl, '/api/v2/context'))
    docsUrl.searchParams.set('libraryId', libraryId)
    docsUrl.searchParams.set('query', query)
    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: docsUrl.href,
      init: { headers: context7Headers(credential), method: 'GET' },
      maximumResponseBytes: input.config.retention.providerResponseMaxBytes,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      provider: PROVIDER,
      retry: input.config.retry,
      signal: input.signal,
      timeoutMs: providerConfig.timeoutMs,
    })
    const parsed = parseContext7SnippetResponse(
      response.body,
      limit,
      input.config.cache.context7SnippetMaxCharacters,
    )
    return Object.freeze({
      attempts: response.attempts,
      responseBytes: response.responseBytes,
      snippets: parsed.snippets,
      totalDelayMs: response.totalDelayMs,
      totalSnippets: parsed.totalSnippets,
      truncated: parsed.truncated,
    })
  }
}

/** Direct resolve-then-docs adapter retained for registration-free Provider use. */
export class Context7Provider implements BoundedSourceProvider {
  readonly capability = CAPABILITY
  readonly provider = PROVIDER
  private readonly remote: Context7RemoteClient

  constructor(dependencies: Context7ProviderDependencies) {
    this.remote = new Context7RemoteClient(dependencies)
  }

  async configured(): Promise<boolean> {
    return true
  }

  async search(input: SourceProviderSearchInput): Promise<SourceProviderSearchOutcome> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = positiveLimit(input.limit, PROVIDER, CAPABILITY)
    const resolved = await this.remote.resolve({ ...input, query, limit })
    const selected = selectContext7Library(resolved.libraries, query, query)
    if (selected?.id === undefined || !isContext7LibraryId(selected.id)) {
      return Object.freeze({
        attempts: resolved.attempts,
        result: boundSourceProviderResult({
          capability: CAPABILITY,
          config: input.config,
          inputTruncated: resolved.truncated,
          provider: PROVIDER,
          requestedSources: limit,
          responseBytes: resolved.responseBytes,
          sources: [],
        }),
        state: 'complete',
        totalDelayMs: resolved.totalDelayMs,
      })
    }

    const libraryId = normalizeContext7LibraryId(selected.id)
    const docs = await this.remote.docs({ ...input, libraryId, query, limit })
    const snippets: DocumentationSnippet[] = docs.snippets.map(snippet => Object.freeze({
      ...snippet,
      libraryId,
    }))
    const source = context7LibrarySource(
      selected,
      input.config.providers.context7.baseUrl,
      input.config.webExtract.maxUrlCharacters,
      snippets[0]?.content ?? selected.description,
    )
    return Object.freeze({
      attempts: resolved.attempts + docs.attempts,
      result: boundSourceProviderResult({
        capability: CAPABILITY,
        config: input.config,
        inputTruncated: resolved.truncated || docs.truncated,
        provider: PROVIDER,
        requestedSources: limit,
        responseBytes: resolved.responseBytes + docs.responseBytes,
        snippets,
        sources: source === undefined ? [] : [source],
      }),
      state: 'complete',
      totalDelayMs: resolved.totalDelayMs + docs.totalDelayMs,
    })
  }
}

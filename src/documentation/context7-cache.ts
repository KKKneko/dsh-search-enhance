import type { Config } from '../config.js'
import {
  isAbortError,
  isProviderError,
  OutputLimitError,
  ProviderError,
  retainJsonPrefix,
  throwIfAborted,
} from '../provider-runtime/index.js'
import {
  CONTEXT7_CACHE_FORMAT_VERSION,
  type CachedContext7Library,
  type CachedDocumentationSnippet,
  type Context7CacheEntry,
  type Context7CacheKey,
  type Context7DocsCacheEntry,
  type Context7DocRef,
  type Context7ResolveCacheEntry,
} from './cache-domain.js'
import {
  Context7CacheError,
  context7DocsCacheKey,
  context7ResolveCacheKey,
  type Context7CacheRepository,
  type Context7CachedDocLookup,
  type Context7CachedDocMatch,
  type Context7CachedDocQuery,
} from './cache.js'

export const CONTEXT7_CACHE_STATES = ['hit', 'miss', 'refresh', 'stale'] as const
export type Context7CacheState = (typeof CONTEXT7_CACHE_STATES)[number]

export interface Context7RemoteDiagnostics {
  readonly attempts: number
  readonly responseBytes: number
  readonly totalDelayMs: number
}

export interface Context7ResolveRemoteResult extends Context7RemoteDiagnostics {
  readonly libraries: readonly CachedContext7Library[]
  readonly totalLibraries: number
  readonly truncated: boolean
}

export interface Context7DocsRemoteResult extends Context7RemoteDiagnostics {
  readonly snippets: readonly CachedDocumentationSnippet[]
  readonly totalSnippets: number
  readonly truncated: boolean
}

export interface CachedContext7Operation<T extends Context7CacheEntry> {
  readonly cache: Context7CacheState
  readonly entry: Readonly<T>
  readonly evictedEntries: number
  readonly remote?: Readonly<Context7RemoteDiagnostics>
  /** Safe Provider/cache failure that caused an expired record to be used. */
  readonly staleCause?: unknown
}

export type Context7OperationPath = 'resolve' | 'docs'

/** Carries only fixed path/cache facts; the original error stays in non-enumerable Error.cause. */
export class Context7OperationFailure extends Error {
  override readonly name = 'Context7OperationFailure'
  readonly code = 'CONTEXT7_OPERATION_FAILED'

  constructor(
    readonly path: Context7OperationPath,
    readonly cache: Exclude<Context7CacheState, 'hit' | 'stale'>,
    cause: unknown,
  ) {
    super(`Context7 ${path} failed with cache ${cache}`, { cause })
  }
}

export interface Context7CacheClock {
  now(): number
}

export interface Context7ResolveCachedInput {
  readonly libraryName: string
  readonly query: string
  readonly maxResults: number
  readonly forceRefresh: boolean
  readonly config: Config
  readonly signal: AbortSignal
  readonly load: () => Promise<Context7ResolveRemoteResult>
}

export interface Context7DocsCachedInput {
  readonly libraryId: string
  readonly query: string
  readonly maxResults: number
  readonly forceRefresh: boolean
  readonly config: Config
  readonly signal: AbortSignal
  readonly load: () => Promise<Context7DocsRemoteResult>
}

function safeNow(clock: Context7CacheClock): number {
  const value = clock.now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Context7 cache clock must return a non-negative safe integer')
  }
  return value
}

function expiresAt(createdAtMs: number, ttlHours: number): number {
  const ttlMs = ttlHours * 60 * 60 * 1000
  const result = createdAtMs + ttlMs
  if (!Number.isSafeInteger(ttlMs) || !Number.isSafeInteger(result)) {
    throw new RangeError('Context7 cache expiry exceeds the safe integer range')
  }
  return result
}

/** Exact expiry is stale: a record is fresh only while now is strictly before expiresAtMs. */
export function context7CacheEntryIsFresh(
  entry: Pick<Context7CacheEntry, 'expiresAtMs'>,
  nowMs: number,
): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('nowMs must be a non-negative safe integer')
  }
  return nowMs < entry.expiresAtMs
}

/** Only transient network/provider failures can consume an expired cache record. */
export function permitsContext7StaleFallback(error: unknown): boolean {
  if (!isProviderError(error)) return false
  if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'rate_limited') {
    return true
  }
  return error.kind === 'http' && error.retryable
}

const LIBRARY_ID_PATTERN = /^\/[^/\s?#]+\/[^/\s?#]+(?:\/[^/\s?#]+)?$/u

export function isContext7LibraryId(value: unknown): value is string {
  return typeof value === 'string'
    && Array.from(value.trim()).length <= 4096
    && LIBRARY_ID_PATTERN.test(value.trim())
}

export function normalizeContext7LibraryId(value: string): string {
  const normalized = value.trim()
  if (!isContext7LibraryId(normalized)) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'context7',
    })
  }
  return normalized
}

function validateRemoteCounts(
  returned: number,
  total: number,
): void {
  if (
    !Number.isSafeInteger(total)
    || total < returned
    || total < 0
  ) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_response',
      provider: 'context7',
    })
  }
}

function retainResolveEntry(input: {
  readonly cacheKey: Context7CacheKey
  readonly config: Config
  readonly createdAtMs: number
  readonly maxResults: number
  readonly remote: Context7ResolveRemoteResult
}): Readonly<Context7ResolveCacheEntry> {
  validateRemoteCounts(input.remote.libraries.length, input.remote.totalLibraries)
  try {
    const prefix = retainJsonPrefix(input.remote.libraries, {
      label: 'Context7 resolve cache entry',
      maxBytes: input.config.cache.context7EntryMaxBytes,
      maxItems: input.maxResults,
      project: retained => ({
        cacheKey: input.cacheKey,
        createdAtMs: input.createdAtMs,
        expiresAtMs: expiresAt(input.createdAtMs, input.config.cache.context7ResolveTtlHours),
        kind: 'resolve' as const,
        libraries: retained,
        maxResults: input.maxResults,
        responseBytes: input.remote.responseBytes,
        totalItems: input.remote.totalLibraries,
        truncated: input.remote.truncated || retained.length < input.remote.totalLibraries,
        version: CONTEXT7_CACHE_FORMAT_VERSION,
      }),
    })
    return Object.freeze({
      cacheKey: input.cacheKey,
      createdAtMs: input.createdAtMs,
      expiresAtMs: expiresAt(input.createdAtMs, input.config.cache.context7ResolveTtlHours),
      kind: 'resolve',
      libraries: Object.freeze([...prefix.retained]),
      maxResults: input.maxResults,
      responseBytes: input.remote.responseBytes,
      totalItems: input.remote.totalLibraries,
      truncated: input.remote.truncated || prefix.truncated,
      version: CONTEXT7_CACHE_FORMAT_VERSION,
    })
  } catch (error) {
    if (!(error instanceof OutputLimitError)) throw error
    throw new Context7CacheError('CONTEXT7_CACHE_ENTRY_BUDGET', { cause: error })
  }
}

function retainDocsEntry(input: {
  readonly config: Config
  readonly createdAtMs: number
  readonly docRef: Context7DocRef
  readonly libraryId: string
  readonly maxResults: number
  readonly remote: Context7DocsRemoteResult
}): Readonly<Context7DocsCacheEntry> {
  validateRemoteCounts(input.remote.snippets.length, input.remote.totalSnippets)
  try {
    const prefix = retainJsonPrefix(input.remote.snippets, {
      label: 'Context7 docs cache entry',
      maxBytes: input.config.cache.context7EntryMaxBytes,
      maxItems: input.maxResults,
      project: retained => ({
        cacheKey: input.docRef as Context7CacheKey,
        createdAtMs: input.createdAtMs,
        docRef: input.docRef,
        expiresAtMs: expiresAt(input.createdAtMs, input.config.cache.context7DocsTtlHours),
        kind: 'docs' as const,
        libraryId: input.libraryId,
        maxResults: input.maxResults,
        responseBytes: input.remote.responseBytes,
        snippets: retained,
        totalItems: input.remote.totalSnippets,
        truncated: input.remote.truncated || retained.length < input.remote.totalSnippets,
        version: CONTEXT7_CACHE_FORMAT_VERSION,
      }),
    })
    return Object.freeze({
      cacheKey: input.docRef as Context7CacheKey,
      createdAtMs: input.createdAtMs,
      docRef: input.docRef,
      expiresAtMs: expiresAt(input.createdAtMs, input.config.cache.context7DocsTtlHours),
      kind: 'docs',
      libraryId: input.libraryId,
      maxResults: input.maxResults,
      responseBytes: input.remote.responseBytes,
      snippets: Object.freeze([...prefix.retained]),
      totalItems: input.remote.totalSnippets,
      truncated: input.remote.truncated || prefix.truncated,
      version: CONTEXT7_CACHE_FORMAT_VERSION,
    })
  } catch (error) {
    if (!(error instanceof OutputLimitError)) throw error
    throw new Context7CacheError('CONTEXT7_CACHE_ENTRY_BUDGET', { cause: error })
  }
}

function remoteDiagnostics(value: Context7RemoteDiagnostics): Readonly<Context7RemoteDiagnostics> {
  return Object.freeze({
    attempts: value.attempts,
    responseBytes: value.responseBytes,
    totalDelayMs: value.totalDelayMs,
  })
}

/** Persistent Context7 resolve/docs operations shared by every documentation Consumer. */
export class Context7CachedOperations {
  private readonly clock: Context7CacheClock

  constructor(
    private readonly cache: Context7CacheRepository,
    clock: Context7CacheClock = { now: Date.now },
  ) {
    this.clock = clock
  }

  async resolve(
    input: Context7ResolveCachedInput,
  ): Promise<Readonly<CachedContext7Operation<Context7ResolveCacheEntry>>> {
    throwIfAborted(input.signal)
    const cacheKey = context7ResolveCacheKey({
      baseUrl: input.config.providers.context7.baseUrl,
      libraryName: input.libraryName,
      maxEntryBytes: input.config.cache.context7EntryMaxBytes,
      maxLibraryTextCharacters: input.config.cache.context7LibraryTextMaxCharacters,
      maxResults: input.maxResults,
      query: input.query,
    })
    const cached = await this.cache.get(cacheKey)
    throwIfAborted(input.signal)
    if (cached !== undefined && cached.kind !== 'resolve') {
      throw new Context7CacheError('CONTEXT7_CACHE_CORRUPT')
    }
    const nowMs = safeNow(this.clock)
    if (!input.forceRefresh && cached !== undefined && context7CacheEntryIsFresh(cached, nowMs)) {
      return Object.freeze({ cache: 'hit', entry: cached, evictedEntries: 0 })
    }
    const status = cached === undefined ? 'miss' : 'refresh'
    try {
      const remote = await input.load()
      throwIfAborted(input.signal)
      const entry = retainResolveEntry({
        cacheKey,
        config: input.config,
        createdAtMs: safeNow(this.clock),
        maxResults: input.maxResults,
        remote,
      })
      const write = await this.cache.put(entry)
      throwIfAborted(input.signal)
      return Object.freeze({
        cache: status,
        entry,
        evictedEntries: write.evictedEntries,
        remote: remoteDiagnostics(remote),
      })
    } catch (error) {
      throwIfAborted(input.signal)
      if (isAbortError(error)) throw error
      if (
        cached !== undefined
        && !context7CacheEntryIsFresh(cached, nowMs)
        && permitsContext7StaleFallback(error)
      ) {
        return Object.freeze({
          cache: 'stale',
          entry: cached,
          evictedEntries: 0,
          staleCause: error,
        })
      }
      throw new Context7OperationFailure('resolve', status, error)
    }
  }

  async docs(
    input: Context7DocsCachedInput,
  ): Promise<Readonly<CachedContext7Operation<Context7DocsCacheEntry>>> {
    throwIfAborted(input.signal)
    const libraryId = normalizeContext7LibraryId(input.libraryId)
    const docRef = context7DocsCacheKey({
      baseUrl: input.config.providers.context7.baseUrl,
      libraryId,
      maxEntryBytes: input.config.cache.context7EntryMaxBytes,
      maxResults: input.maxResults,
      maxSnippetCharacters: input.config.cache.context7SnippetMaxCharacters,
      query: input.query,
    })
    const cached = await this.cache.get(docRef as Context7CacheKey)
    throwIfAborted(input.signal)
    if (cached !== undefined && (cached.kind !== 'docs' || cached.docRef !== docRef)) {
      throw new Context7CacheError('CONTEXT7_CACHE_CORRUPT')
    }
    const nowMs = safeNow(this.clock)
    if (!input.forceRefresh && cached !== undefined && context7CacheEntryIsFresh(cached, nowMs)) {
      return Object.freeze({ cache: 'hit', entry: cached, evictedEntries: 0 })
    }
    const status = cached === undefined ? 'miss' : 'refresh'
    try {
      const remote = await input.load()
      throwIfAborted(input.signal)
      const entry = retainDocsEntry({
        config: input.config,
        createdAtMs: safeNow(this.clock),
        docRef,
        libraryId,
        maxResults: input.maxResults,
        remote,
      })
      const write = await this.cache.put(entry)
      throwIfAborted(input.signal)
      return Object.freeze({
        cache: status,
        entry,
        evictedEntries: write.evictedEntries,
        remote: remoteDiagnostics(remote),
      })
    } catch (error) {
      throwIfAborted(input.signal)
      if (isAbortError(error)) throw error
      if (
        cached !== undefined
        && !context7CacheEntryIsFresh(cached, nowMs)
        && permitsContext7StaleFallback(error)
      ) {
        return Object.freeze({
          cache: 'stale',
          entry: cached,
          evictedEntries: 0,
          staleCause: error,
        })
      }
      throw new Context7OperationFailure('docs', status, error)
    }
  }

  lookupDoc(docRef: unknown): Promise<Readonly<Context7CachedDocLookup>> {
    return this.cache.lookupDoc(docRef)
  }

  findDoc(input: Context7CachedDocQuery): Promise<Readonly<Context7CachedDocMatch>> {
    return this.cache.findDoc(input)
  }
}

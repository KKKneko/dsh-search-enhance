import { Service, type Context } from '@deepseek-ai/cordis'

import type { Config } from '../config.js'
import type { CanonicalSource, SourceRecordCandidate } from '../contracts/index.js'
import {
  createProviderAttemptRecord,
  isAbortError,
  isProviderError,
  ProviderError,
  throwIfAborted,
  type ProviderAttemptRecord,
  type ProviderErrorKind,
} from '../provider-runtime/index.js'
import {
  type Context7RemoteClient,
  context7LibrarySource,
  selectContext7Library,
  type Context7Library,
} from '../providers/context7.js'
import type {
  BoundedSourceProvider,
  DocumentationSnippet,
  SourceProviderSearchInput,
} from '../providers/types.js'
import { applySourceQuality } from '../search/index.js'
import type {
  Context7DocsCacheEntry,
  Context7DocRef,
} from './cache-domain.js'
import {
  CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS,
  type Context7CachedDocLookup,
  type Context7CachedDocMatch,
} from './cache.js'
import {
  CONTEXT7_CACHE_STATES,
  Context7CachedOperations,
  Context7OperationFailure,
  isContext7LibraryId,
  normalizeContext7LibraryId,
  type CachedContext7Operation,
  type Context7OperationPath,
} from './context7-cache.js'

const CONTEXT7_RESOLVE_CANDIDATE_LIMIT = 30
export const DOCUMENTATION_SEARCH_SERVICE_KEY = 'searchEnhanceDocumentation'
export const DOCUMENTATION_SEARCH_PROVIDERS = ['auto', 'context7', 'exa', 'all'] as const
export type DocumentationSearchProvider = (typeof DOCUMENTATION_SEARCH_PROVIDERS)[number]

export const DOCUMENTATION_RESULT_PROVIDERS = ['context7', 'exa'] as const
export type DocumentationResultProvider = (typeof DOCUMENTATION_RESULT_PROVIDERS)[number]

export const DOCUMENTATION_PROVIDER_STATES = ['complete', 'partial', 'failed', 'skipped'] as const
export type DocumentationProviderState = (typeof DOCUMENTATION_PROVIDER_STATES)[number]

export interface DocumentationProviderStatus {
  readonly provider: DocumentationResultProvider
  readonly state: DocumentationProviderState
}

export const DOCUMENTATION_WARNING_CODES = [
  'provider_failed',
  'provider_not_configured',
  'cache_stale',
  'cache_evicted',
  'provider_result_truncated',
  'no_results',
] as const
export type DocumentationWarningCode = (typeof DOCUMENTATION_WARNING_CODES)[number]

export const DOCUMENTATION_CACHE_PATH_STATES = [
  ...CONTEXT7_CACHE_STATES,
  'skipped',
  'failed',
] as const
export type DocumentationCachePathState = (typeof DOCUMENTATION_CACHE_PATH_STATES)[number]

export const DOCUMENTATION_CACHE_SKIP_REASONS = [
  'provider_not_selected',
  'known_library_id',
  'library_not_found',
  'upstream_failed',
] as const
export type DocumentationCacheSkipReason = (typeof DOCUMENTATION_CACHE_SKIP_REASONS)[number]

export interface DocumentationCachePath {
  readonly state: DocumentationCachePathState
  readonly evictedEntries: number
  readonly reason?: DocumentationCacheSkipReason
}

export interface DocumentationCacheReport {
  readonly resolve: Readonly<DocumentationCachePath>
  readonly docs: Readonly<DocumentationCachePath>
}

export interface DocumentationWarning {
  readonly code: DocumentationWarningCode
  readonly provider?: 'context7' | 'exa' | 'context7-cache'
  readonly path?: Context7OperationPath
  readonly errorKind?: ProviderErrorKind
  readonly count?: number
}

export interface DocumentationSearchInput {
  readonly query: string
  readonly provider?: DocumentationSearchProvider
  /** Exact Context7 id; when present it takes priority and bypasses resolve. */
  readonly libraryId?: string
  /** Explicit Context7 package/product identity; never inferred from query. */
  readonly libraryName?: string
  readonly maxResults: number
  readonly forceRefresh?: boolean
  readonly signal: AbortSignal
  /** Optional caller-owned operation snapshot; otherwise getConfig() is read once. */
  readonly config?: Config
}

export interface Context7ResolveInput {
  readonly libraryName: string
  readonly query?: string
  readonly maxResults: number
  readonly forceRefresh?: boolean
  readonly signal: AbortSignal
  /** Optional caller-owned operation snapshot; otherwise getConfig() is read once. */
  readonly config?: Config
}

export interface Context7ResolveResult {
  readonly libraryName: string
  readonly query: string
  readonly candidates: readonly Readonly<Context7Library>[]
  readonly selectedLibrary?: Readonly<Context7Library>
  readonly cache: Readonly<DocumentationCachePath>
  readonly attempts: readonly ProviderAttemptRecord[]
  readonly warnings: readonly DocumentationWarning[]
  readonly totalCandidates: number
  readonly returnedCandidates: number
  readonly responseBytes: number
  readonly truncated: boolean
}

export interface Context7DocsInput {
  readonly libraryId: string
  readonly query: string
  readonly maxResults: number
  readonly forceRefresh?: boolean
  readonly signal: AbortSignal
  /** Optional caller-owned operation snapshot; otherwise getConfig() is read once. */
  readonly config?: Config
}

export interface Context7DocsResult {
  readonly libraryId: string
  readonly query: string
  readonly entry: Readonly<Context7DocsCacheEntry>
  readonly cache: Readonly<DocumentationCachePath>
  readonly attempts: readonly ProviderAttemptRecord[]
  readonly warnings: readonly DocumentationWarning[]
}

export interface Context7CachedDocSearchInput {
  readonly query: string
  readonly libraryId?: string
  readonly maxScanRecords: number
  readonly signal: AbortSignal
  /** Optional caller-owned operation snapshot; otherwise getConfig() is read once. */
  readonly config?: Config
}

export interface DocumentationSearchResult {
  readonly query: string
  readonly provider: DocumentationSearchProvider
  readonly snippets: readonly DocumentationSnippet[]
  readonly sources: readonly CanonicalSource[]
  readonly selectedLibrary?: Readonly<Context7Library>
  readonly docRef?: Context7DocRef
  readonly cache: Readonly<DocumentationCacheReport>
  readonly providers: readonly Readonly<DocumentationProviderStatus>[]
  readonly attempts: readonly ProviderAttemptRecord[]
  readonly warnings: readonly DocumentationWarning[]
  readonly persistence: Readonly<SourceRecordCandidate>
  readonly totalSources: number
  readonly returnedSources: number
  readonly totalSnippets: number
  readonly returnedSnippets: number
  readonly providerResponseBytes: number
  readonly truncated: boolean
}

export class DocumentationSearchInfrastructureError extends Error {
  override readonly name = 'DocumentationSearchInfrastructureError'
  readonly code = 'DOCUMENTATION_SEARCH_FAILED'

  constructor(
    readonly attempts: readonly ProviderAttemptRecord[],
    readonly warnings: readonly DocumentationWarning[],
    readonly cache: Readonly<DocumentationCacheReport>,
    cause: unknown,
  ) {
    super('documentation search infrastructure failed', { cause })
  }
}

export interface DocumentationSearchDependencies {
  readonly context7: Pick<Context7RemoteClient, 'resolve' | 'docs'>
  readonly context7Cache: Context7CachedOperations
  readonly exa: BoundedSourceProvider
  readonly getConfig: () => Config
  /** Injectable diagnostic clock. It never affects cache freshness or public ordering. */
  readonly now?: () => number
}

interface PathOutcome {
  readonly state: 'complete' | 'partial' | 'failed' | 'skipped'
  readonly sources: readonly CanonicalSource[]
  readonly snippets: readonly DocumentationSnippet[]
  readonly attempts: readonly ProviderAttemptRecord[]
  readonly warnings: readonly DocumentationWarning[]
  readonly completedValidPath: boolean
  readonly truncated: boolean
  readonly responseBytes: number
  readonly error?: unknown
  readonly selectedLibrary?: Readonly<Context7Library>
  readonly docRef?: Context7DocRef
  readonly cache?: Readonly<DocumentationCacheReport>
}

function cachePath(
  state: DocumentationCachePathState,
  evictedEntries = 0,
  reason?: DocumentationCacheSkipReason,
): Readonly<DocumentationCachePath> {
  return Object.freeze({
    evictedEntries,
    ...(reason === undefined ? {} : { reason }),
    state,
  })
}

function cacheReport(
  resolve: Readonly<DocumentationCachePath>,
  docs: Readonly<DocumentationCachePath>,
): Readonly<DocumentationCacheReport> {
  return Object.freeze({ docs, resolve })
}

function providerStatus(
  provider: DocumentationResultProvider,
  state: DocumentationProviderState,
): Readonly<DocumentationProviderStatus> {
  return Object.freeze({ provider, state })
}

function fixedWarning(
  code: DocumentationWarningCode,
  options: Omit<DocumentationWarning, 'code'> = {},
): Readonly<DocumentationWarning> {
  return Object.freeze({ code, ...options })
}

function safeClockValue(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('documentation diagnostic clock must return a finite non-negative value')
  }
  return value
}

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, safeClockValue(now) - startedAt)
}

function failureCause(error: unknown): unknown {
  return error instanceof Context7OperationFailure ? error.cause : error
}

function errorKind(error: unknown): ProviderErrorKind {
  const cause = failureCause(error)
  return isProviderError(cause) ? cause.kind : 'unknown'
}

function skippedAttempt(provider: string): Readonly<ProviderAttemptRecord> {
  return createProviderAttemptRecord({
    attempts: 0,
    capability: 'docs_search',
    durationMs: 0,
    outcome: 'skipped',
    participatedInFallback: false,
    provider,
    skipReason: 'not_applicable',
  })
}

function failedAttempt(input: {
  readonly provider: string
  readonly error: unknown
  readonly dispatches: number
  readonly durationMs: number
}): Readonly<ProviderAttemptRecord> {
  return createProviderAttemptRecord({
    attempts: Math.max(1, input.dispatches),
    capability: 'docs_search',
    durationMs: input.durationMs,
    error: failureCause(input.error),
    outcome: 'failed',
    participatedInFallback: false,
    provider: input.provider,
  })
}

function cacheWarnings(
  provider: 'context7-cache',
  path: Context7OperationPath,
  result: CachedContext7Operation<Context7DocsCacheEntry | import('./cache-domain.js').Context7ResolveCacheEntry>,
): readonly DocumentationWarning[] {
  const warnings: DocumentationWarning[] = []
  if (result.cache === 'stale') {
    warnings.push(fixedWarning('cache_stale', {
      errorKind: errorKind(result.staleCause),
      path,
      provider,
    }))
  }
  if (result.evictedEntries > 0) {
    warnings.push(fixedWarning('cache_evicted', {
      count: result.evictedEntries,
      path,
      provider,
    }))
  }
  return Object.freeze(warnings)
}

function successfulCacheAttempts(
  path: Context7OperationPath,
  result: CachedContext7Operation<Context7DocsCacheEntry | import('./cache-domain.js').Context7ResolveCacheEntry>,
  dispatches: number,
  durationMs: number,
): readonly ProviderAttemptRecord[] {
  const cacheProvider = `context7-cache-${path}`
  const remoteProvider = `context7-${path}`
  if (result.cache === 'hit') {
    return Object.freeze([createProviderAttemptRecord({
      attempts: 1,
      capability: 'docs_search',
      durationMs,
      outcome: 'success',
      participatedInFallback: false,
      provider: cacheProvider,
    })])
  }
  if (result.cache === 'stale') {
    return Object.freeze([
      createProviderAttemptRecord({
        attempts: Math.max(1, dispatches),
        capability: 'docs_search',
        durationMs,
        error: result.staleCause,
        outcome: 'failed',
        participatedInFallback: true,
        provider: remoteProvider,
      }),
      createProviderAttemptRecord({
        attempts: 1,
        capability: 'docs_search',
        durationMs: 0,
        outcome: 'success',
        participatedInFallback: true,
        provider: cacheProvider,
      }),
    ])
  }
  return Object.freeze([createProviderAttemptRecord({
    attempts: result.remote?.attempts ?? Math.max(1, dispatches),
    capability: 'docs_search',
    durationMs,
    outcome: 'success',
    participatedInFallback: false,
    provider: remoteProvider,
  })])
}

function validateInput(input: DocumentationSearchInput, config: Config): {
  readonly query: string
  readonly provider: DocumentationSearchProvider
  readonly libraryId?: string
  readonly libraryName?: string
} {
  const query = input.query.trim()
  if (query.length === 0 || Array.from(query).length > config.retention.searchQueryMaxCharacters) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'documentation-search',
    })
  }
  if (!Number.isSafeInteger(input.maxResults) || input.maxResults <= 0) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'documentation-search',
    })
  }
  const provider = input.provider ?? 'auto'
  if (!DOCUMENTATION_SEARCH_PROVIDERS.includes(provider)) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'documentation-search',
    })
  }
  const maxResults = Math.min(input.maxResults, config.retention.providerMaxSources)
  if (maxResults !== input.maxResults) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'documentation-search',
    })
  }
  let libraryId: string | undefined
  if (provider !== 'exa' && input.libraryId !== undefined) {
    if (!isContext7LibraryId(input.libraryId)) {
      throw new ProviderError({
        capability: 'docs_search',
        kind: 'invalid_request',
        provider: 'context7',
      })
    }
    libraryId = normalizeContext7LibraryId(input.libraryId)
  }
  const libraryName = provider !== 'exa'
    && libraryId === undefined
    && input.libraryName !== undefined
    ? context7Text(input.libraryName, config)
    : undefined
  if (
    (provider === 'context7' || provider === 'all')
    && libraryId === undefined
    && libraryName === undefined
  ) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'context7-library-name-or-id-required',
    })
  }
  return {
    ...(libraryId === undefined ? {} : { libraryId }),
    ...(libraryName === undefined ? {} : { libraryName }),
    provider,
    query,
  }
}

function context7Text(value: string, config: Config): string {
  const normalized = value.trim()
  if (
    normalized.length === 0
    || Array.from(normalized).length > config.retention.searchQueryMaxCharacters
  ) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'context7',
    })
  }
  return normalized
}

function context7MaxResults(value: number, config: Config): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > config.retention.providerMaxSources
  ) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'context7',
    })
  }
  return value
}

function frozenPathOutcome(outcome: PathOutcome): Readonly<PathOutcome> {
  return Object.freeze({
    ...outcome,
    attempts: Object.freeze([...outcome.attempts]),
    snippets: Object.freeze([...outcome.snippets]),
    sources: Object.freeze([...outcome.sources]),
    warnings: Object.freeze([...outcome.warnings]),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    searchEnhanceDocumentation: DocumentationSearchService
  }
}

/**
 * Lifecycle-bound documentation core shared by the high-level docs Consumer
 * and the deferred granular Context7 Consumers.
 */
export class DocumentationSearchService extends Service {
  private readonly context7: DocumentationSearchDependencies['context7']
  private readonly context7Cache: Context7CachedOperations
  private readonly exa: BoundedSourceProvider
  private readonly getConfig: () => Config
  private readonly now: () => number
  private readonly lifecycle = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private stopped = false

  constructor(ctx: Context, dependencies: DocumentationSearchDependencies) {
    super(ctx, DOCUMENTATION_SEARCH_SERVICE_KEY)
    this.context7 = dependencies.context7
    this.context7Cache = dependencies.context7Cache
    this.exa = dependencies.exa
    this.getConfig = dependencies.getConfig
    this.now = dependencies.now ?? Date.now
  }

  private run<T>(callerSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new DOMException('documentation service is disposing', 'AbortError'))
    }
    const signal = AbortSignal.any([callerSignal, this.lifecycle.signal])
    const pending = (async () => {
      throwIfAborted(signal)
      return operation(signal)
    })()
    this.active.add(pending)
    void pending.then(
      () => { this.active.delete(pending) },
      () => { this.active.delete(pending) },
    )
    return pending
  }

  async search(input: DocumentationSearchInput): Promise<Readonly<DocumentationSearchResult>> {
    return this.run(input.signal, signal => this.execute(input, signal))
  }

  /** Resolve and select one library through the shared bounded persistent cache path. */
  async resolveContext7(input: Context7ResolveInput): Promise<Readonly<Context7ResolveResult>> {
    const config = input.config ?? this.getConfig()
    const libraryName = context7Text(input.libraryName, config)
    const query = input.query === undefined ? libraryName : context7Text(input.query, config)
    const maxResults = context7MaxResults(input.maxResults, config)
    return this.run(input.signal, signal => this.executeContext7Resolve({
      config,
      forceRefresh: input.forceRefresh === true,
      libraryName,
      maxResults,
      query,
      signal,
    }))
  }

  /** Query one exact Context7 id and return its validated cache-domain entry. */
  async queryContext7Docs(input: Context7DocsInput): Promise<Readonly<Context7DocsResult>> {
    const config = input.config ?? this.getConfig()
    const libraryId = normalizeContext7LibraryId(input.libraryId)
    const query = context7Text(input.query, config)
    const maxResults = context7MaxResults(input.maxResults, config)
    return this.run(input.signal, signal => this.executeContext7Docs({
      config,
      forceRefresh: input.forceRefresh === true,
      libraryId,
      maxResults,
      query,
      signal,
    }))
  }

  lookupDoc(docRef: unknown, signal: AbortSignal): Promise<Readonly<Context7CachedDocLookup>> {
    return this.run(signal, async activeSignal => {
      throwIfAborted(activeSignal)
      const result = await this.context7Cache.lookupDoc(docRef)
      throwIfAborted(activeSignal)
      return result
    })
  }

  /** Deterministically search only this plugin's bounded docs-cache index; never dispatch network. */
  findContext7Doc(input: Context7CachedDocSearchInput): Promise<Readonly<Context7CachedDocMatch>> {
    const config = input.config ?? this.getConfig()
    const query = context7Text(input.query, config)
    if (
      !Number.isSafeInteger(input.maxScanRecords)
      || input.maxScanRecords <= 0
      || input.maxScanRecords > CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS
    ) {
      throw new ProviderError({
        capability: 'docs_search',
        kind: 'invalid_request',
        provider: 'context7-cache',
      })
    }
    const libraryId = input.libraryId === undefined
      ? undefined
      : normalizeContext7LibraryId(input.libraryId)
    return this.run(input.signal, async signal => {
      const result = await this.context7Cache.findDoc({
        query,
        ...(libraryId === undefined ? {} : { libraryId }),
        maxScanRecords: input.maxScanRecords,
        signal,
      })
      throwIfAborted(signal)
      return result
    })
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.lifecycle.abort(new DOMException('documentation service disposed', 'AbortError'))
    }
    await Promise.allSettled([...this.active])
  }

  private async executeContext7Resolve(input: {
    readonly config: Config
    readonly forceRefresh: boolean
    readonly libraryName: string
    readonly maxResults: number
    readonly candidateLimit?: number
    readonly query: string
    readonly signal: AbortSignal
    readonly onDispatch?: () => void
  }): Promise<Readonly<Context7ResolveResult>> {
    const candidateLimit = input.candidateLimit ?? input.maxResults
    const startedAt = safeClockValue(this.now)
    let dispatches = 0
    const resolved = await this.context7Cache.resolve({
      config: input.config,
      forceRefresh: input.forceRefresh,
      load: () => this.context7.resolve({
        config: input.config,
        limit: candidateLimit,
        onDispatch: () => {
          dispatches += 1
          input.onDispatch?.()
        },
        libraryName: input.libraryName,
        query: input.query,
        signal: input.signal,
      }),
      maxResults: candidateLimit,
      libraryName: input.libraryName,
      query: input.query,
      signal: input.signal,
    })
    const candidates = Object.freeze(resolved.entry.libraries.slice(0, input.maxResults))
    const selected = selectContext7Library(
      resolved.entry.libraries,
      input.libraryName,
      input.query,
    )
    return Object.freeze({
      attempts: successfulCacheAttempts(
        'resolve',
        resolved,
        dispatches,
        elapsed(startedAt, this.now),
      ),
      cache: cachePath(resolved.cache, resolved.evictedEntries),
      candidates,
      libraryName: input.libraryName,
      query: input.query,
      responseBytes: resolved.entry.responseBytes,
      returnedCandidates: candidates.length,
      ...(selected === undefined ? {} : { selectedLibrary: selected }),
      totalCandidates: resolved.entry.totalItems,
      truncated: resolved.entry.truncated,
      warnings: cacheWarnings('context7-cache', 'resolve', resolved),
    })
  }

  private async executeContext7Docs(input: {
    readonly config: Config
    readonly forceRefresh: boolean
    readonly libraryId: string
    readonly maxResults: number
    readonly query: string
    readonly signal: AbortSignal
    readonly onDispatch?: () => void
  }): Promise<Readonly<Context7DocsResult>> {
    const startedAt = safeClockValue(this.now)
    let dispatches = 0
    const docs = await this.context7Cache.docs({
      config: input.config,
      forceRefresh: input.forceRefresh,
      libraryId: input.libraryId,
      load: () => this.context7.docs({
        config: input.config,
        libraryId: input.libraryId,
        limit: input.maxResults,
        onDispatch: () => {
          dispatches += 1
          input.onDispatch?.()
        },
        query: input.query,
        signal: input.signal,
      }),
      maxResults: input.maxResults,
      query: input.query,
      signal: input.signal,
    })
    return Object.freeze({
      attempts: successfulCacheAttempts(
        'docs',
        docs,
        dispatches,
        elapsed(startedAt, this.now),
      ),
      cache: cachePath(docs.cache, docs.evictedEntries),
      entry: docs.entry,
      libraryId: input.libraryId,
      query: input.query,
      warnings: cacheWarnings('context7-cache', 'docs', docs),
    })
  }

  private async execute(
    input: DocumentationSearchInput,
    signal: AbortSignal,
  ): Promise<Readonly<DocumentationSearchResult>> {
    const config = input.config ?? this.getConfig()
    const validated = validateInput(input, config)
    const forceRefresh = input.forceRefresh === true
    const hasContext7Identity = validated.libraryId !== undefined || validated.libraryName !== undefined
    const runContext7 = validated.provider === 'context7'
      || validated.provider === 'all'
      || (validated.provider === 'auto' && hasContext7Identity)
    const autoExa = validated.provider === 'auto'
      && (!hasContext7Identity || config.fallbackMode === 'auto')
    const considerExa = validated.provider === 'exa' || validated.provider === 'all' || autoExa

    let exaConfigured = false
    let exaProbeError: unknown
    if (considerExa) {
      try {
        exaConfigured = await this.exa.configured(config)
      } catch (error) {
        throwIfAborted(signal)
        exaProbeError = error
      }
    }
    throwIfAborted(signal)

    const tasks: Array<Promise<Readonly<PathOutcome>>> = []
    if (runContext7) {
      tasks.push(this.runContext7({
        config,
        forceRefresh,
        ...(validated.libraryId === undefined ? {} : { libraryId: validated.libraryId }),
        ...(validated.libraryName === undefined ? {} : { libraryName: validated.libraryName }),
        maxResults: input.maxResults,
        query: validated.query,
        signal,
      }))
    }
    if (considerExa && exaConfigured) {
      tasks.push(this.runExa({
        config,
        limit: input.maxResults,
        query: validated.query,
        signal,
      }))
    }

    const settled = await Promise.allSettled(tasks)
    throwIfAborted(signal)
    for (const task of settled) {
      if (task.status === 'rejected' && isAbortError(task.reason)) throw task.reason
    }

    let taskIndex = 0
    const contextOutcome = runContext7
      ? settled[taskIndex++]?.status === 'fulfilled'
        ? (settled[taskIndex - 1] as PromiseFulfilledResult<Readonly<PathOutcome>>).value
        : frozenPathOutcome({
            attempts: [],
            completedValidPath: false,
            error: (settled[taskIndex - 1] as PromiseRejectedResult | undefined)?.reason,
            responseBytes: 0,
            snippets: [],
            sources: [],
            state: 'failed',
            truncated: false,
            warnings: [fixedWarning('provider_failed', { provider: 'context7' })],
          })
      : frozenPathOutcome({
          attempts: [skippedAttempt('context7')],
          cache: cacheReport(
            cachePath('skipped', 0, 'provider_not_selected'),
            cachePath('skipped', 0, 'provider_not_selected'),
          ),
          completedValidPath: false,
          responseBytes: 0,
          snippets: [],
          sources: [],
          state: 'skipped',
          truncated: false,
          warnings: [],
        })

    let exaOutcome: Readonly<PathOutcome>
    if (!considerExa) {
      exaOutcome = frozenPathOutcome({
        attempts: [skippedAttempt('exa')],
        completedValidPath: false,
        responseBytes: 0,
        snippets: [],
        sources: [],
        state: 'skipped',
        truncated: false,
        warnings: [],
      })
    } else if (exaProbeError !== undefined) {
      exaOutcome = frozenPathOutcome({
        attempts: [failedAttempt({
          dispatches: 1,
          durationMs: 0,
          error: exaProbeError,
          provider: 'exa',
        })],
        completedValidPath: false,
        error: exaProbeError,
        responseBytes: 0,
        snippets: [],
        sources: [],
        state: 'failed',
        truncated: false,
        warnings: [fixedWarning('provider_failed', {
          errorKind: errorKind(exaProbeError),
          provider: 'exa',
        })],
      })
    } else if (!exaConfigured) {
      exaOutcome = frozenPathOutcome({
        attempts: [createProviderAttemptRecord({
          attempts: 0,
          capability: 'docs_search',
          durationMs: 0,
          outcome: 'skipped',
          participatedInFallback: false,
          provider: 'exa',
          skipReason: 'not_configured',
        })],
        completedValidPath: false,
        error: new ProviderError({
          capability: 'docs_search',
          kind: 'credential_missing',
          provider: 'exa',
        }),
        responseBytes: 0,
        snippets: [],
        sources: [],
        state: 'skipped',
        truncated: false,
        warnings: [fixedWarning('provider_not_configured', { provider: 'exa' })],
      })
    } else {
      const exaSettled = settled[taskIndex]
      exaOutcome = exaSettled?.status === 'fulfilled'
        ? exaSettled.value
        : frozenPathOutcome({
            attempts: [],
            completedValidPath: false,
            error: exaSettled?.reason,
            responseBytes: 0,
            snippets: [],
            sources: [],
            state: 'failed',
            truncated: false,
            warnings: [fixedWarning('provider_failed', { provider: 'exa' })],
          })
    }

    const providers = Object.freeze([
      providerStatus('context7', contextOutcome.state),
      providerStatus('exa', exaOutcome.state),
    ])
    const attempts = Object.freeze([...contextOutcome.attempts, ...exaOutcome.attempts])
    const warnings = [...contextOutcome.warnings, ...exaOutcome.warnings]
    const compatibleSources = [...contextOutcome.sources, ...exaOutcome.sources]
    const qualitySources = applySourceQuality(validated.query, compatibleSources)
    const sources = Object.freeze(qualitySources.slice(0, input.maxResults))
    const snippets = Object.freeze(contextOutcome.snippets.slice(0, input.maxResults))
    const truncated = contextOutcome.truncated
      || exaOutcome.truncated
      || sources.length < qualitySources.length
      || snippets.length < contextOutcome.snippets.length
    if (truncated) warnings.push(fixedWarning('provider_result_truncated'))

    const completedValidPath = contextOutcome.completedValidPath || exaOutcome.completedValidPath
    if (sources.length === 0 && snippets.length === 0 && !completedValidPath) {
      const cause = contextOutcome.error ?? exaOutcome.error ?? new ProviderError({
        capability: 'docs_search',
        kind: 'unavailable',
        provider: 'documentation-search',
      })
      const cache = contextOutcome.cache ?? cacheReport(
        cachePath('skipped', 0, 'provider_not_selected'),
        cachePath('skipped', 0, 'provider_not_selected'),
      )
      throw new DocumentationSearchInfrastructureError(
        attempts,
        Object.freeze(warnings),
        cache,
        failureCause(cause),
      )
    }
    if (sources.length === 0 && snippets.length === 0) {
      warnings.push(fixedWarning('no_results'))
    }

    const cache = contextOutcome.cache ?? cacheReport(
      cachePath('skipped', 0, 'provider_not_selected'),
      cachePath('skipped', 0, 'provider_not_selected'),
    )
    const persistence = Object.freeze({
      collectionTruncated: truncated,
      depth: 'compact' as const,
      profile: 'coding_docs' as const,
      query: validated.query,
      sources,
    })
    return Object.freeze({
      attempts,
      cache,
      ...(contextOutcome.docRef === undefined ? {} : { docRef: contextOutcome.docRef }),
      persistence,
      provider: validated.provider,
      providers,
      providerResponseBytes: contextOutcome.responseBytes + exaOutcome.responseBytes,
      query: validated.query,
      returnedSnippets: snippets.length,
      returnedSources: sources.length,
      ...(contextOutcome.selectedLibrary === undefined
        ? {}
        : { selectedLibrary: contextOutcome.selectedLibrary }),
      snippets,
      sources,
      totalSnippets: contextOutcome.snippets.length,
      totalSources: qualitySources.length,
      truncated,
      warnings: Object.freeze(warnings),
    })
  }

  private async runContext7(input: {
    readonly config: Config
    readonly forceRefresh: boolean
    readonly libraryId?: string
    readonly libraryName?: string
    readonly maxResults: number
    readonly query: string
    readonly signal: AbortSignal
  }): Promise<Readonly<PathOutcome>> {
    const attempts: ProviderAttemptRecord[] = []
    const warnings: DocumentationWarning[] = []
    let resolveReport: Readonly<DocumentationCachePath>
    let docsReport = cachePath('skipped', 0, 'upstream_failed')
    let selectedLibrary: Context7Library | undefined
    let responseBytes = 0
    let resolveDispatches = 0

    if (input.libraryId !== undefined) {
      selectedLibrary = Object.freeze({ id: input.libraryId })
      resolveReport = cachePath('skipped', 0, 'known_library_id')
      attempts.push(skippedAttempt('context7-resolve'))
    } else {
      if (input.libraryName === undefined) {
        throw new ProviderError({
          capability: 'docs_search',
          kind: 'invalid_request',
          provider: 'context7-library-name-or-id-required',
        })
      }
      const startedAt = safeClockValue(this.now)
      try {
        const resolved = await this.executeContext7Resolve({
          config: input.config,
          forceRefresh: input.forceRefresh,
          libraryName: input.libraryName,
          maxResults: input.maxResults,
          candidateLimit: Math.min(
            CONTEXT7_RESOLVE_CANDIDATE_LIMIT,
            input.config.retention.providerMaxSources,
          ),
          onDispatch: () => { resolveDispatches += 1 },
          query: input.query,
          signal: input.signal,
        })
        attempts.push(...resolved.attempts)
        warnings.push(...resolved.warnings)
        resolveReport = resolved.cache
        responseBytes += resolved.responseBytes
        selectedLibrary = resolved.selectedLibrary
      } catch (error) {
        throwIfAborted(input.signal)
        const durationMs = elapsed(startedAt, this.now)
        attempts.push(failedAttempt({
          dispatches: resolveDispatches,
          durationMs,
          error,
          provider: 'context7-resolve',
        }))
        const status = error instanceof Context7OperationFailure ? error.cache : 'failed'
        resolveReport = cachePath(status, 0)
        warnings.push(fixedWarning('provider_failed', {
          errorKind: errorKind(error),
          path: 'resolve',
          provider: 'context7',
        }))
        return frozenPathOutcome({
          attempts,
          cache: cacheReport(resolveReport, docsReport),
          completedValidPath: false,
          error,
          responseBytes,
          snippets: [],
          sources: [],
          state: 'failed',
          truncated: false,
          warnings,
        })
      }
    }

    if (selectedLibrary?.id === undefined || !isContext7LibraryId(selectedLibrary.id)) {
      docsReport = cachePath('skipped', 0, 'library_not_found')
      attempts.push(skippedAttempt('context7-docs'))
      return frozenPathOutcome({
        attempts,
        cache: cacheReport(resolveReport, docsReport),
        completedValidPath: true,
        responseBytes,
        snippets: [],
        sources: [],
        state: 'complete',
        truncated: false,
        warnings,
      })
    }

    const libraryId = normalizeContext7LibraryId(selectedLibrary.id)
    let docsDispatches = 0
    const startedAt = safeClockValue(this.now)
    try {
      const docs = await this.executeContext7Docs({
        config: input.config,
        forceRefresh: input.forceRefresh,
        libraryId,
        maxResults: input.maxResults,
        onDispatch: () => { docsDispatches += 1 },
        query: input.query,
        signal: input.signal,
      })
      attempts.push(...docs.attempts)
      warnings.push(...docs.warnings)
      docsReport = docs.cache
      responseBytes += docs.entry.responseBytes
      const snippets = Object.freeze(docs.entry.snippets.map(snippet => Object.freeze({
        ...snippet,
        libraryId,
      })))
      const source = context7LibrarySource(
        selectedLibrary,
        input.config.providers.context7.baseUrl,
        input.config.webExtract.maxUrlCharacters,
        snippets[0]?.content ?? selectedLibrary.description,
      )
      return frozenPathOutcome({
        attempts,
        cache: cacheReport(resolveReport, docsReport),
        completedValidPath: true,
        docRef: docs.entry.docRef,
        responseBytes,
        selectedLibrary: Object.freeze({ ...selectedLibrary, id: libraryId }),
        snippets,
        sources: source === undefined ? [] : [source],
        state: 'complete',
        truncated: docs.entry.truncated,
        warnings,
      })
    } catch (error) {
      throwIfAborted(input.signal)
      const durationMs = elapsed(startedAt, this.now)
      attempts.push(failedAttempt({
        dispatches: docsDispatches,
        durationMs,
        error,
        provider: 'context7-docs',
      }))
      const status = error instanceof Context7OperationFailure ? error.cache : 'failed'
      docsReport = cachePath(status, 0)
      warnings.push(fixedWarning('provider_failed', {
        errorKind: errorKind(error),
        path: 'docs',
        provider: 'context7',
      }))
      const source = context7LibrarySource(
        selectedLibrary,
        input.config.providers.context7.baseUrl,
        input.config.webExtract.maxUrlCharacters,
        selectedLibrary.description,
      )
      return frozenPathOutcome({
        attempts,
        cache: cacheReport(resolveReport, docsReport),
        completedValidPath: source !== undefined,
        error,
        responseBytes,
        selectedLibrary: Object.freeze({ ...selectedLibrary, id: libraryId }),
        snippets: [],
        sources: source === undefined ? [] : [source],
        state: source === undefined ? 'failed' : 'partial',
        truncated: false,
        warnings,
      })
    }
  }

  private async runExa(input: SourceProviderSearchInput): Promise<Readonly<PathOutcome>> {
    let dispatches = 0
    const startedAt = safeClockValue(this.now)
    try {
      const outcome = await this.exa.search({
        ...input,
        onDispatch: () => { dispatches += 1 },
      })
      const durationMs = elapsed(startedAt, this.now)
      if (outcome.state === 'not_configured') {
        return frozenPathOutcome({
          attempts: [createProviderAttemptRecord({
            attempts: 0,
            capability: 'docs_search',
            durationMs,
            outcome: 'skipped',
            participatedInFallback: false,
            provider: 'exa',
            skipReason: 'not_configured',
          })],
          completedValidPath: false,
          error: new ProviderError({
            capability: 'docs_search',
            kind: 'credential_missing',
            provider: 'exa',
          }),
          responseBytes: 0,
          snippets: [],
          sources: [],
          state: 'skipped',
          truncated: false,
          warnings: [fixedWarning('provider_not_configured', { provider: 'exa' })],
        })
      }
      return frozenPathOutcome({
        attempts: [createProviderAttemptRecord({
          attempts: Math.max(1, outcome.attempts),
          capability: 'docs_search',
          durationMs,
          outcome: 'success',
          participatedInFallback: false,
          provider: 'exa',
        })],
        completedValidPath: true,
        responseBytes: outcome.result.responseBytes,
        snippets: [],
        sources: outcome.result.sources,
        state: 'complete',
        truncated: outcome.result.truncated,
        warnings: [],
      })
    } catch (error) {
      throwIfAborted(input.signal)
      if (isAbortError(error)) throw error
      const durationMs = elapsed(startedAt, this.now)
      return frozenPathOutcome({
        attempts: [failedAttempt({ dispatches, durationMs, error, provider: 'exa' })],
        completedValidPath: false,
        error,
        responseBytes: 0,
        snippets: [],
        sources: [],
        state: 'failed',
        truncated: false,
        warnings: [fixedWarning('provider_failed', {
          errorKind: errorKind(error),
          provider: 'exa',
        })],
      })
    }
  }
}

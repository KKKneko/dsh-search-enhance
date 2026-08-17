import { createHmac, randomBytes } from 'node:crypto'

import type { CredentialProvider, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { Config, RetryConfig } from '../config.js'
import type { CanonicalSource } from '../contracts/index.js'
import {
  isAbortError,
  isProviderError,
  isRetryableProviderError,
  parseRetryAfterMs,
  ProviderError,
  providerHttpError,
  retryProviderOperation,
  throwIfAborted,
  type RetryResult,
} from '../provider-runtime/index.js'
import {
  parseSearchApiResponse,
  resolveAutomaticTimeContext,
  resolveSearchStrategy,
  SearchResponseParseError,
  type ResolvedSearchStrategy,
  type SearchClock,
  type TimeZoneSource,
} from '../search/index.js'
import {
  buildSearchApiRequest,
  normalizeSearchApiModel,
  searchApiModelsEndpoint,
  type PreparedSearchApiRequest,
} from './search-api-request.js'

const PROVIDER = 'search-api'
const MODEL_ID_MAX_CHARACTERS = 512

export type SearchApiConfigSource = () => Config

export interface SearchApiProviderDependencies {
  readonly getConfig: SearchApiConfigSource
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  readonly fetch?: typeof globalThis.fetch
  /** Used only for user-visible time context; non-temporal queries do not read it. */
  readonly clock?: SearchClock
  readonly timeZone?: TimeZoneSource
  /** Independent cache clock; it is never rendered or persisted as request context. */
  readonly cacheNow?: () => number
  readonly retryNow?: () => number
  readonly random?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export type ModelListAvailability = 'available' | 'unavailable'
export type ModelListCacheStatus = 'hit' | 'miss' | 'refresh'

export interface SearchApiModelListResult {
  readonly availability: ModelListAvailability
  readonly models: readonly string[]
  readonly cache: ModelListCacheStatus
  readonly attempts: number
  readonly totalDelayMs: number
}

export interface SearchApiModelListOptions {
  readonly refresh?: boolean
  /** Internal diagnostics control: bypass writing the model cache when false. */
  readonly cache?: boolean
  /** Internal bounded snapshot; never exposed through a model-facing schema. */
  readonly config?: Config
  /** Fixed-field observer for bounded diagnostics; failures are contained. */
  readonly onDispatch?: () => void
}

interface CachedModelList {
  readonly availability: ModelListAvailability
  readonly models: readonly string[]
  readonly expiresAt: number
}

export type ModelValidationStatus = 'validated' | 'unavailable'

interface SearchApiSearchOperationInput {
  readonly query: string
  readonly signal: AbortSignal
  /** Internal refresh control; this is not part of a model-facing tool schema. */
  readonly refreshModels?: boolean
  /** Fixed-field dispatch observer used by the orchestrator; failures are contained. */
  readonly onDispatch?: () => void
}

export interface SearchApiSearchInput extends SearchApiSearchOperationInput {
  readonly profile?: unknown
  readonly depth?: unknown
}

/** Already-resolved operation used when an orchestrator owns the single Config/strategy snapshot. */
export interface SearchApiResolvedSearchInput extends SearchApiSearchOperationInput {
  readonly config: Config
  readonly strategy: ResolvedSearchStrategy
}

export interface SearchApiSearchResult {
  readonly answer: string
  readonly sources: readonly CanonicalSource[]
  readonly sourcesTruncated: boolean
  readonly model: string
  readonly protocol: Config['searchApi']['protocol']
  readonly endpoint: string
  readonly attempts: number
  readonly totalDelayMs: number
  readonly modelValidation: ModelValidationStatus
}

function finiteNow(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) throw new RangeError('cache clock must be finite and non-negative')
  return value
}

function characterLength(value: string): number {
  return Array.from(value).length
}

function parseModelList(
  body: string,
  maximumModels: number,
): { readonly availability: ModelListAvailability; readonly models: readonly string[] } {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new ProviderError({
      capability: 'model_list',
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProviderError({
      capability: 'model_list',
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  const record = data as Record<string, unknown>
  if (!('data' in record) || record.data === null || record.data === undefined) {
    return Object.freeze({ availability: 'unavailable', models: Object.freeze([]) })
  }
  if (!Array.isArray(record.data)) {
    throw new ProviderError({
      capability: 'model_list',
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  if (record.data.length > maximumModels) {
    throw new ProviderError({
      capability: 'model_list',
      kind: 'budget_exceeded',
      provider: PROVIDER,
    })
  }

  const models: string[] = []
  const seen = new Set<string>()
  for (const item of record.data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProviderError({
        capability: 'model_list',
        kind: 'invalid_response',
        provider: PROVIDER,
      })
    }
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new ProviderError({
        capability: 'model_list',
        kind: 'invalid_response',
        provider: PROVIDER,
      })
    }
    const model = id.trim()
    if (characterLength(model) > MODEL_ID_MAX_CHARACTERS) {
      throw new ProviderError({
        capability: 'model_list',
        kind: 'budget_exceeded',
        provider: PROVIDER,
      })
    }
    if (!seen.has(model)) {
      seen.add(model)
      models.push(model)
    }
  }
  if (models.length === 0) {
    return Object.freeze({ availability: 'unavailable', models: Object.freeze([]) })
  }
  return Object.freeze({ availability: 'available', models: Object.freeze(models) })
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Discarding an error body is best effort and never changes the safe HTTP error.
  }
}

/** Read and UTF-8 decode a complete response under the configured raw-byte cap. */
async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  capability: 'main_search' | 'model_list',
): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength)
    if (Number.isSafeInteger(length) && length > maximumBytes) {
      await cancelResponseBody(response)
      throw new ProviderError({
        capability,
        kind: 'budget_exceeded',
        provider: PROVIDER,
      })
    }
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let totalBytes = 0
  let output = ''
  const cancelReader = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', cancelReader, { once: true })
  try {
    while (true) {
      const chunk = await reader.read()
      throwIfAborted(signal)
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel()
        throw new ProviderError({
          capability,
          kind: 'budget_exceeded',
          provider: PROVIDER,
        })
      }
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
    return output
  } catch (error) {
    throwIfAborted(signal)
    if (isProviderError(error)) throw error
    throw new ProviderError({
      capability,
      cause: error,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  } finally {
    signal.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
}

function parseHttpFailure(response: Response, capability: 'main_search' | 'model_list', nowMs: number): ProviderError {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), nowMs)
  return providerHttpError({
    capability,
    provider: PROVIDER,
    status: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function observeDispatch(observer: (() => void) | undefined): void {
  if (observer === undefined) return
  try {
    observer()
  } catch {
    // Diagnostics must not change dispatch outcome.
  }
}

function mapFetchFailure(error: unknown, signal: AbortSignal, capability: 'main_search' | 'model_list'): never {
  throwIfAborted(signal)
  if (isAbortError(error)) throw error
  if (isProviderError(error)) throw error
  throw new ProviderError({
    capability,
    cause: error,
    kind: 'network',
    provider: PROVIDER,
  })
}

function parseSearchBody(
  body: string,
  prepared: PreparedSearchApiRequest,
  config: Config,
): { readonly answer: string; readonly sources: readonly CanonicalSource[]; readonly sourcesTruncated: boolean } {
  try {
    return parseSearchApiResponse(body, prepared.protocol, {
      maxResponseBytes: config.retention.providerResponseMaxBytes,
      maxSources: config.retention.providerMaxSources,
      maxUrlCharacters: config.webExtract.maxUrlCharacters,
    })
  } catch (error) {
    if (!(error instanceof SearchResponseParseError)) {
      throw new ProviderError({
        capability: 'main_search',
        cause: error,
        kind: 'invalid_response',
        provider: PROVIDER,
      })
    }
    throw new ProviderError({
      capability: 'main_search',
      kind: error.kind === 'limit' ? 'budget_exceeded' : 'invalid_response',
      provider: PROVIDER,
    })
  }
}

/**
 * Internal Grok search adapter over the supported completions/responses wire
 * protocols. It registers no DSH service, model tool, prompt section, or listener.
 */
export class SearchApiProvider {
  private readonly getConfig: SearchApiConfigSource
  private readonly credentials: Pick<CredentialProvider, 'resolve'>
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly clock: SearchClock | undefined
  private readonly timeZone: TimeZoneSource | undefined
  private readonly cacheNow: () => number
  private readonly retryNow: () => number
  private readonly random: (() => number) | undefined
  private readonly sleep: ((milliseconds: number, signal: AbortSignal) => Promise<void>) | undefined
  private readonly fingerprintSalt = randomBytes(32)
  private readonly modelCache = new Map<string, CachedModelList>()

  constructor(dependencies: SearchApiProviderDependencies) {
    this.getConfig = dependencies.getConfig
    this.credentials = dependencies.credentials
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch
    this.clock = dependencies.clock
    this.timeZone = dependencies.timeZone
    this.cacheNow = dependencies.cacheNow ?? Date.now
    this.retryNow = dependencies.retryNow ?? Date.now
    this.random = dependencies.random
    this.sleep = dependencies.sleep
  }

  private async resolveCredential(
    ref: CredentialRef,
    signal: AbortSignal,
    capability: 'main_search' | 'model_list',
  ): Promise<ResolvedCredential> {
    throwIfAborted(signal)
    let credential: ResolvedCredential | undefined
    try {
      credential = await this.credentials.resolve(ref)
    } catch (error) {
      throwIfAborted(signal)
      throw new ProviderError({
        capability,
        cause: error,
        kind: 'credential_missing',
        provider: PROVIDER,
      })
    }
    throwIfAborted(signal)
    if (credential === undefined || credential.value.length === 0) {
      throw new ProviderError({
        capability,
        kind: 'credential_missing',
        provider: PROVIDER,
      })
    }
    return credential
  }

  private credentialFingerprint(value: string): string {
    return createHmac('sha256', this.fingerprintSalt).update(value).digest('base64url')
  }

  private modelCacheKey(config: Config, credential: ResolvedCredential): string {
    return [
      searchApiModelsEndpoint(config.searchApi.baseUrl),
      String(config.searchApi.credentialRef),
      this.credentialFingerprint(credential.value),
    ].join('\n')
  }

  private cachedModels(key: string, nowMs: number): CachedModelList | undefined {
    const cached = this.modelCache.get(key)
    if (cached === undefined) return undefined
    if (cached.expiresAt <= nowMs) {
      this.modelCache.delete(key)
      return undefined
    }
    this.modelCache.delete(key)
    this.modelCache.set(key, cached)
    return cached
  }

  private storeModels(key: string, value: CachedModelList, config: Config, nowMs: number): void {
    for (const [candidateKey, candidate] of this.modelCache) {
      if (candidate.expiresAt <= nowMs) this.modelCache.delete(candidateKey)
    }
    this.modelCache.delete(key)
    while (this.modelCache.size >= config.cache.maxEntries) {
      const oldest = this.modelCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.modelCache.delete(oldest)
    }
    this.modelCache.set(key, value)
  }

  private retryOptions(config: Config): Pick<
    RetryConfig,
    'maxAttempts' | 'baseDelayMs' | 'multiplier' | 'maxDelayMs' | 'maxTotalDelayMs' | 'jitterRatio'
  > {
    return config.retry
  }

  private async fetchResponse(
    endpoint: string,
    init: RequestInit,
    signal: AbortSignal,
    capability: 'main_search' | 'model_list',
  ): Promise<Response> {
    try {
      const response = await this.fetchImplementation(endpoint, {
        ...init,
        redirect: 'manual',
        signal,
      })
      throwIfAborted(signal)
      return response
    } catch (error) {
      return mapFetchFailure(error, signal, capability)
    }
  }

  private async fetchModels(
    config: Config,
    credential: ResolvedCredential,
    signal: AbortSignal,
    onDispatch?: () => void,
  ): Promise<RetryResult<{ readonly availability: ModelListAvailability; readonly models: readonly string[] }>> {
    const endpoint = searchApiModelsEndpoint(config.searchApi.baseUrl)
    return retryProviderOperation({
      attemptTimeoutMs: config.searchApi.timeoutMs,
      capability: 'model_list',
      operation: async ({ signal: attemptSignal }) => {
        observeDispatch(onDispatch)
        const response = await this.fetchResponse(endpoint, {
          headers: { Authorization: `Bearer ${credential.value}` },
          method: 'GET',
        }, attemptSignal, 'model_list')
        if (!response.ok) {
          await cancelResponseBody(response)
          throw parseHttpFailure(response, 'model_list', this.retryNow())
        }
        const body = await readBoundedResponseBody(
          response,
          config.retention.providerResponseMaxBytes,
          attemptSignal,
          'model_list',
        )
        return parseModelList(body, config.cache.modelListMaxModels)
      },
      policy: this.retryOptions(config),
      provider: PROVIDER,
      ...(this.random === undefined ? {} : { random: this.random }),
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      shouldRetry: isRetryableProviderError,
      signal,
    })
  }

  private async listModelsWithCredential(
    config: Config,
    credential: ResolvedCredential,
    signal: AbortSignal,
    refresh: boolean,
    onDispatch?: () => void,
    storeResult = true,
  ): Promise<SearchApiModelListResult> {
    const nowMs = finiteNow(this.cacheNow)
    const key = this.modelCacheKey(config, credential)
    if (!refresh) {
      const cached = this.cachedModels(key, nowMs)
      if (cached !== undefined) {
        return Object.freeze({
          attempts: 0,
          availability: cached.availability,
          cache: 'hit',
          models: cached.models,
          totalDelayMs: 0,
        })
      }
    }

    const fetched = await this.fetchModels(config, credential, signal, onDispatch)
    const ttlMs = config.cache.modelListTtlMinutes * 60_000
    if (storeResult) {
      this.storeModels(key, {
        availability: fetched.value.availability,
        expiresAt: nowMs + ttlMs,
        models: fetched.value.models,
      }, config, nowMs)
    }
    return Object.freeze({
      attempts: fetched.attempts,
      availability: fetched.value.availability,
      cache: refresh ? 'refresh' : 'miss',
      models: fetched.value.models,
      totalDelayMs: fetched.totalDelayMs,
    })
  }

  /** List models as one credential-resolving operation. */
  async listModels(
    signal: AbortSignal,
    options: SearchApiModelListOptions = {},
  ): Promise<SearchApiModelListResult> {
    const config = options.config ?? this.getConfig()
    const credential = await this.resolveCredential(
      config.searchApi.credentialRef,
      signal,
      'model_list',
    )
    return this.listModelsWithCredential(
      config,
      credential,
      signal,
      options.refresh === true,
      options.onDispatch,
      options.cache !== false,
    )
  }

  /** Force a bounded model-list refresh under the credential resolved for this operation. */
  async refreshModels(signal: AbortSignal): Promise<SearchApiModelListResult> {
    return this.listModels(signal, { refresh: true })
  }

  private async validateModel(
    config: Config,
    credential: ResolvedCredential,
    effectiveModel: string,
    signal: AbortSignal,
    refresh: boolean,
  ): Promise<ModelValidationStatus> {
    let listing: SearchApiModelListResult
    try {
      listing = await this.listModelsWithCredential(config, credential, signal, refresh)
    } catch (error) {
      throwIfAborted(signal)
      if (isAbortError(error)) throw error
      if (isProviderError(error)) return 'unavailable'
      throw error
    }
    if (listing.availability !== 'available' || listing.models.length === 0) return 'unavailable'

    const configuredModel = config.searchApi.model.trim()
    const accepted = listing.models.includes(effectiveModel)
      || (effectiveModel.endsWith(':online') && listing.models.includes(configuredModel))
    if (!accepted) {
      throw new ProviderError({
        capability: 'main_search',
        kind: 'configuration',
        provider: PROVIDER,
      })
    }
    return 'validated'
  }

  private async dispatchSearch(
    prepared: PreparedSearchApiRequest,
    config: Config,
    credential: ResolvedCredential,
    signal: AbortSignal,
    onDispatch: (() => void) | undefined,
  ): Promise<RetryResult<{ readonly answer: string; readonly sources: readonly CanonicalSource[]; readonly sourcesTruncated: boolean }>> {
    return retryProviderOperation({
      attemptTimeoutMs: config.searchApi.timeoutMs,
      capability: 'main_search',
      operation: async ({ signal: attemptSignal }) => {
        throwIfAborted(attemptSignal)
        observeDispatch(onDispatch)
        const response = await this.fetchResponse(prepared.endpoint, {
          body: prepared.serializedBody,
          headers: {
            Authorization: `Bearer ${credential.value}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        }, attemptSignal, 'main_search')
        if (!response.ok) {
          await cancelResponseBody(response)
          throw parseHttpFailure(response, 'main_search', this.retryNow())
        }
        const body = await readBoundedResponseBody(
          response,
          config.retention.providerResponseMaxBytes,
          attemptSignal,
          'main_search',
        )
        return parseSearchBody(body, prepared, config)
      },
      policy: this.retryOptions(config),
      provider: PROVIDER,
      ...(this.random === undefined ? {} : { random: this.random }),
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      shouldRetry: isRetryableProviderError,
      signal,
    })
  }

  /** Execute against one caller-owned Config and strategy snapshot. */
  async searchResolved(input: SearchApiResolvedSearchInput): Promise<SearchApiSearchResult> {
    throwIfAborted(input.signal)
    const query = input.query.trim()
    if (query.length === 0) {
      throw new ProviderError({
        capability: 'main_search',
        kind: 'invalid_request',
        provider: PROVIDER,
      })
    }

    let timeContext
    try {
      timeContext = resolveAutomaticTimeContext(query, {
        ...(this.clock === undefined ? {} : { clock: this.clock }),
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
      })
    } catch (error) {
      throw new ProviderError({
        capability: 'main_search',
        cause: error,
        kind: 'configuration',
        provider: PROVIDER,
      })
    }
    let prepared: PreparedSearchApiRequest
    try {
      prepared = buildSearchApiRequest({
        config: input.config.searchApi,
        query,
        strategy: input.strategy,
        ...(timeContext === undefined ? {} : { timeContext }),
      })
    } catch (error) {
      throw new ProviderError({
        capability: 'main_search',
        cause: error,
        kind: 'configuration',
        provider: PROVIDER,
      })
    }

    const credential = await this.resolveCredential(
      input.config.searchApi.credentialRef,
      input.signal,
      'main_search',
    )
    const effectiveModel = normalizeSearchApiModel(input.config.searchApi.model)
    const modelValidation = await this.validateModel(
      input.config,
      credential,
      effectiveModel,
      input.signal,
      input.refreshModels === true,
    )
    throwIfAborted(input.signal)
    const dispatched = await this.dispatchSearch(
      prepared,
      input.config,
      credential,
      input.signal,
      input.onDispatch,
    )
    return Object.freeze({
      answer: dispatched.value.answer,
      attempts: dispatched.attempts,
      endpoint: prepared.endpoint,
      model: prepared.model,
      modelValidation,
      protocol: prepared.protocol,
      sources: dispatched.value.sources,
      sourcesTruncated: dispatched.value.sourcesTruncated,
      totalDelayMs: dispatched.totalDelayMs,
    })
  }

  /** Execute one main-search operation without registering a model-facing tool. */
  async search(input: SearchApiSearchInput): Promise<SearchApiSearchResult> {
    throwIfAborted(input.signal)
    const config = this.getConfig()
    let strategy: ResolvedSearchStrategy
    try {
      strategy = resolveSearchStrategy(config, {
        ...(input.depth === undefined ? {} : { depth: input.depth }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
      })
    } catch (error) {
      throw new ProviderError({
        capability: 'main_search',
        cause: error,
        kind: 'invalid_request',
        provider: PROVIDER,
      })
    }
    return this.searchResolved({
      config,
      query: input.query,
      signal: input.signal,
      strategy,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      ...(input.refreshModels === undefined ? {} : { refreshModels: input.refreshModels }),
    })
  }
}

export {
  buildSearchApiRequest,
  normalizeSearchApiModel,
  reasoningEffort,
  searchApiEndpoint,
  searchApiModelsEndpoint,
  type BuildSearchApiRequestInput,
  type PreparedSearchApiRequest,
} from './search-api-request.js'

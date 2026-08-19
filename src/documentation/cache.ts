import { createHash } from 'node:crypto'

import type { DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'

import {
  throwIfAborted,
  truncateCharacters,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import {
  CONTEXT7_CACHE_DOMAIN_SPEC,
  CONTEXT7_CACHE_FORMAT_VERSION,
  CONTEXT7_CACHE_KEY_PATTERN,
  CONTEXT7_CACHE_TABLE_NAME,
  CONTEXT7_DOC_REF_PATTERN,
  Context7CacheEntrySchema,
  Context7DocsCacheEntrySchema,
  type Context7CacheDomain,
  type Context7CacheEntry,
  type Context7CacheKey,
  type Context7DocsCacheEntry,
  type Context7DocRef,
} from './cache-domain.js'

export type Context7CacheErrorCode =
  | 'CONTEXT7_CACHE_CLOSED'
  | 'CONTEXT7_CACHE_CORRUPT'
  | 'CONTEXT7_CACHE_ENTRY_BUDGET'
  | 'CONTEXT7_CACHE_WRITE'

/** Fixed-message cache failure. Stored values and backend errors never enter its message. */
export class Context7CacheError extends Error {
  override readonly name = 'Context7CacheError'

  constructor(
    readonly code: Context7CacheErrorCode,
    options: ErrorOptions = {},
  ) {
    super(code, options)
  }
}

export interface Context7CacheLimits {
  readonly maxEntries: number
  readonly maxEntryBytes: number
}

export interface Context7CacheWriteResult {
  readonly evictedEntries: number
}

export interface Context7CachedDocFound {
  readonly state: 'found'
  readonly entry: Readonly<Context7DocsCacheEntry>
}

export interface Context7CachedDocNotFound {
  readonly state: 'not_found'
}

export type Context7CachedDocLookup = Context7CachedDocFound | Context7CachedDocNotFound

export const CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS = 500
export const CONTEXT7_CACHE_QUERY_MAX_TERMS = 32
export const CONTEXT7_CACHE_QUERY_MAX_TEXT_CHARACTERS = 32 * 1024

export interface Context7CachedDocQuery {
  readonly query: string
  readonly libraryId?: string
  readonly maxScanRecords: number
  readonly signal: AbortSignal
}

export interface Context7CachedDocMatchFound extends Context7CachedDocFound {
  readonly scannedRecords: number
  readonly matchedRecords: number
}

export interface Context7CachedDocMatchNotFound extends Context7CachedDocNotFound {
  readonly scannedRecords: number
  readonly matchedRecords: 0
}

export type Context7CachedDocMatch = Context7CachedDocMatchFound | Context7CachedDocMatchNotFound

export interface Context7CacheRepository {
  get(key: Context7CacheKey): Promise<Readonly<Context7CacheEntry> | undefined>
  put(entry: Context7CacheEntry): Promise<Readonly<Context7CacheWriteResult>>
  lookupDoc(docRef: unknown): Promise<Readonly<Context7CachedDocLookup>>
  findDoc(input: Context7CachedDocQuery): Promise<Readonly<Context7CachedDocMatch>>
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value)
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new RangeError('Context7 base URL must be an absolute credential-free HTTP(S) URL')
  }
  return parsed.href.replace(/\/+$/, '')
}

function digestIdentity(kind: 'resolve' | 'docs', identity: Readonly<Record<string, unknown>>): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: CONTEXT7_CACHE_FORMAT_VERSION, kind, ...identity }))
    .digest('base64url')
}

/** Cache identity includes every bounded input that can change a successful resolve value. */
export function context7ResolveCacheKey(input: {
  readonly baseUrl: string
  readonly libraryName: string
  readonly query: string
  readonly maxResults: number
  readonly maxLibraryTextCharacters: number
  readonly maxEntryBytes: number
}): Context7CacheKey {
  positiveSafeInteger(input.maxResults, 'maxResults')
  positiveSafeInteger(input.maxLibraryTextCharacters, 'maxLibraryTextCharacters')
  positiveSafeInteger(input.maxEntryBytes, 'maxEntryBytes')
  const libraryName = input.libraryName.trim()
  const query = input.query.trim()
  if (libraryName.length === 0) throw new RangeError('Context7 library name must not be empty')
  if (query.length === 0) throw new RangeError('Context7 resolve query must not be empty')
  return `ctx7r_${digestIdentity('resolve', {
    baseUrl: normalizedBaseUrl(input.baseUrl),
    libraryName,
    maxEntryBytes: input.maxEntryBytes,
    maxLibraryTextCharacters: input.maxLibraryTextCharacters,
    maxResults: input.maxResults,
    query,
  })}` as Context7CacheKey
}

/** Cache identity includes library/query/result and parser bounds, but never credentials. */
export function context7DocsCacheKey(input: {
  readonly baseUrl: string
  readonly libraryId: string
  readonly query: string
  readonly maxResults: number
  readonly maxSnippetCharacters: number
  readonly maxEntryBytes: number
}): Context7DocRef {
  positiveSafeInteger(input.maxResults, 'maxResults')
  positiveSafeInteger(input.maxSnippetCharacters, 'maxSnippetCharacters')
  positiveSafeInteger(input.maxEntryBytes, 'maxEntryBytes')
  const query = input.query.trim()
  if (query.length === 0) throw new RangeError('Context7 docs query must not be empty')
  return `ctx7d_${digestIdentity('docs', {
    baseUrl: normalizedBaseUrl(input.baseUrl),
    libraryId: input.libraryId,
    maxEntryBytes: input.maxEntryBytes,
    maxResults: input.maxResults,
    maxSnippetCharacters: input.maxSnippetCharacters,
    query,
  })}` as Context7DocRef
}

export function isContext7DocRef(value: unknown): value is Context7DocRef {
  return typeof value === 'string' && CONTEXT7_DOC_REF_PATTERN.test(value)
}

function compareOldest(
  left: readonly [Context7CacheKey, Context7CacheEntry],
  right: readonly [Context7CacheKey, Context7CacheEntry],
): number {
  return left[1].createdAtMs - right[1].createdAtMs || left[0].localeCompare(right[0])
}

function insertSorted(keys: Context7CacheKey[], key: Context7CacheKey): void {
  let low = 0
  let high = keys.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((keys[middle] as string).localeCompare(key) < 0) low = middle + 1
    else high = middle
  }
  if (keys[low] !== key) keys.splice(low, 0, key)
}

function queryTerms(query: string): readonly string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}._/-]+/u)
    .filter(term => term.length > 0)
  return Object.freeze([...new Set(terms)].slice(0, CONTEXT7_CACHE_QUERY_MAX_TERMS))
}

function searchableDocText(entry: Readonly<Context7DocsCacheEntry>): string {
  let remaining = CONTEXT7_CACHE_QUERY_MAX_TEXT_CHARACTERS
  const parts: string[] = []
  const append = (value: string | undefined): void => {
    if (value === undefined || remaining === 0) return
    const retained = truncateCharacters(value.toLowerCase(), remaining)
    parts.push(retained.text)
    remaining -= retained.outputCharacters
  }
  append(entry.libraryId)
  for (const snippet of entry.snippets) {
    append(snippet.title)
    append(snippet.content)
    if (remaining === 0) break
  }
  return parts.join('\n')
}

function docMatchScore(
  entry: Readonly<Context7DocsCacheEntry>,
  normalizedQuery: string,
  terms: readonly string[],
): number {
  const libraryId = entry.libraryId.toLowerCase()
  const text = searchableDocText(entry)
  let score = text.includes(normalizedQuery) ? 1000 : 0
  for (const term of terms) {
    if (libraryId.includes(term)) score += 20
    else if (text.includes(term)) score += 1
  }
  return score
}

function scoredDocMatch(
  lookup: Readonly<Context7CachedDocLookup>,
  libraryId: string | undefined,
  normalizedQuery: string,
  terms: readonly string[],
): { readonly entry: Readonly<Context7DocsCacheEntry>; readonly score: number } | undefined {
  if (lookup.state !== 'found') return undefined
  if (libraryId !== undefined && lookup.entry.libraryId !== libraryId) return undefined
  const score = docMatchScore(lookup.entry, normalizedQuery, terms)
  return score === 0 ? undefined : { entry: lookup.entry, score }
}

/** Durable bounded repository over one already-open public storage-domain table. */
export class Context7CacheStore implements Context7CacheRepository {
  private readonly maxEntries: number
  private readonly maxEntryBytes: number
  private readonly docKeys: Context7CacheKey[]
  private tail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly table: KvTable<Context7CacheKey, Context7CacheEntry>,
    limits: Context7CacheLimits,
  ) {
    this.maxEntries = positiveSafeInteger(limits.maxEntries, 'maxEntries')
    this.maxEntryBytes = positiveSafeInteger(limits.maxEntryBytes, 'maxEntryBytes')
    this.docKeys = [...table.keys()]
      .filter(key => key.startsWith('ctx7d_') && CONTEXT7_CACHE_KEY_PATTERN.test(key))
      .sort((left, right) => left.localeCompare(right))
  }

  private removeDocKey(key: Context7CacheKey): void {
    const index = this.docKeys.indexOf(key)
    if (index >= 0) this.docKeys.splice(index, 1)
  }

  private assertOpen(): void {
    if (this.stopped) throw new Context7CacheError('CONTEXT7_CACHE_CLOSED')
  }

  private validate(
    key: Context7CacheKey,
    value: Context7CacheEntry,
  ): Readonly<Context7CacheEntry> {
    const parsed = Context7CacheEntrySchema.safeParse(value)
    if (
      !parsed.success
      || parsed.data.cacheKey !== key
      || !CONTEXT7_CACHE_KEY_PATTERN.test(key)
      || utf8ByteLength(JSON.stringify(parsed.data)) > this.maxEntryBytes
    ) {
      throw new Context7CacheError('CONTEXT7_CACHE_CORRUPT', {
        ...(!parsed.success ? { cause: parsed.error } : {}),
      })
    }
    return value
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  async get(key: Context7CacheKey): Promise<Readonly<Context7CacheEntry> | undefined> {
    this.assertOpen()
    const value = this.table.get(key)
    return value === undefined ? undefined : this.validate(key, value)
  }

  async put(entry: Context7CacheEntry): Promise<Readonly<Context7CacheWriteResult>> {
    this.assertOpen()
    const parsed = Context7CacheEntrySchema.safeParse(entry)
    const bytes = utf8ByteLength(JSON.stringify(entry))
    if (!parsed.success || parsed.data.cacheKey !== entry.cacheKey || bytes > this.maxEntryBytes) {
      throw new Context7CacheError('CONTEXT7_CACHE_ENTRY_BUDGET', {
        ...(!parsed.success ? { cause: parsed.error } : {}),
      })
    }
    return this.enqueue(async () => {
      this.assertOpen()
      let evictedEntries = 0
      try {
        const replacing = this.table.get(entry.cacheKey) !== undefined
        if (!replacing) {
          const overflow = Math.max(0, this.table.size - this.maxEntries + 1)
          if (overflow > 0) {
            const oldest = [...this.table.entries()]
              .map(([key, value]) => [key, this.validate(key, value)] as const)
              .sort(compareOldest)
              .slice(0, overflow)
            for (const [key] of oldest) {
              if (await this.table.delete(key)) {
                this.removeDocKey(key)
                evictedEntries += 1
              }
            }
          }
        }
        await this.table.put(entry.cacheKey, entry)
        if (entry.kind === 'docs') insertSorted(this.docKeys, entry.cacheKey)
        else this.removeDocKey(entry.cacheKey)
      } catch (error) {
        if (error instanceof Context7CacheError) throw error
        throw new Context7CacheError('CONTEXT7_CACHE_WRITE', { cause: error })
      }
      return Object.freeze({ evictedEntries })
    })
  }

  async lookupDoc(docRef: unknown): Promise<Readonly<Context7CachedDocLookup>> {
    this.assertOpen()
    if (!isContext7DocRef(docRef)) return Object.freeze({ state: 'not_found' })
    const value = await this.get(docRef as Context7CacheKey)
    if (value === undefined) return Object.freeze({ state: 'not_found' })
    const parsed = Context7DocsCacheEntrySchema.safeParse(value)
    if (!parsed.success || parsed.data.docRef !== docRef) {
      throw new Context7CacheError('CONTEXT7_CACHE_CORRUPT', {
        ...(!parsed.success ? { cause: parsed.error } : {}),
      })
    }
    return Object.freeze({ entry: value as Context7DocsCacheEntry, state: 'found' })
  }

  /**
   * Scan at most `maxScanRecords` lexicographically ordered docs records and
   * choose by exact-phrase/token score, then opaque doc_ref. No clock, network,
   * Provider metadata, or backend path participates in matching.
   */
  async findDoc(input: Context7CachedDocQuery): Promise<Readonly<Context7CachedDocMatch>> {
    this.assertOpen()
    const maxScanRecords = positiveSafeInteger(input.maxScanRecords, 'maxScanRecords')
    if (maxScanRecords > CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS) {
      throw new RangeError(
        `maxScanRecords must not exceed ${CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS}`,
      )
    }
    const normalizedQuery = input.query.trim().toLowerCase()
    if (normalizedQuery.length === 0) throw new RangeError('Context7 cache query must not be empty')
    const terms = queryTerms(normalizedQuery)
    const keys = this.docKeys.slice(0, maxScanRecords)
    let scannedRecords = 0
    const matches: Array<{ readonly entry: Readonly<Context7DocsCacheEntry>; readonly score: number }> = []
    for (const key of keys) {
      throwIfAborted(input.signal)
      const lookup = await this.lookupDoc(key)
      throwIfAborted(input.signal)
      scannedRecords += 1
      const match = scoredDocMatch(lookup, input.libraryId, normalizedQuery, terms)
      if (match !== undefined) matches.push(match)
    }
    matches.sort((left, right) => (
      right.score - left.score || left.entry.docRef.localeCompare(right.entry.docRef)
    ))
    const selected = matches[0]
    if (selected === undefined) {
      return Object.freeze({ matchedRecords: 0, scannedRecords, state: 'not_found' })
    }
    return Object.freeze({
      entry: selected.entry,
      matchedRecords: matches.length,
      scannedRecords,
      state: 'found',
    })
  }

  /** Trim records created under a larger former capacity using deterministic oldest-first eviction. */
  async enforceCapacity(): Promise<number> {
    this.assertOpen()
    return this.enqueue(async () => {
      this.assertOpen()
      let evicted = 0
      const overflow = Math.max(0, this.table.size - this.maxEntries)
      if (overflow === 0) return 0
      try {
        const oldest = [...this.table.entries()]
          .map(([key, value]) => [key, this.validate(key, value)] as const)
          .sort(compareOldest)
          .slice(0, overflow)
        for (const [key] of oldest) {
          if (await this.table.delete(key)) {
            this.removeDocKey(key)
            evicted += 1
          }
        }
      } catch (error) {
        if (error instanceof Context7CacheError) throw error
        throw new Context7CacheError('CONTEXT7_CACHE_WRITE', { cause: error })
      }
      return evicted
    })
  }

  stop(): void {
    this.stopped = true
  }

  async drain(): Promise<void> {
    await this.tail
  }
}

interface OpenCache {
  readonly domain: Context7CacheDomain
  readonly store: Context7CacheStore
  readonly initializationEvictions: number
}

/** Lazy domain owner: ordinary searches that do not route to Context7 never open the cache. */
export class PersistentContext7Cache implements Context7CacheRepository {
  private opening: Promise<OpenCache> | undefined
  private stopped = false

  constructor(
    private readonly facility: Pick<DomainFacility, 'open'>,
    private readonly limits: Context7CacheLimits,
  ) {}

  private async open(): Promise<OpenCache> {
    if (this.stopped) throw new Context7CacheError('CONTEXT7_CACHE_CLOSED')
    if (this.opening === undefined) {
      this.opening = (async () => {
        const domain = await this.facility.open(CONTEXT7_CACHE_DOMAIN_SPEC)
        const store = new Context7CacheStore(
          domain.table(CONTEXT7_CACHE_TABLE_NAME),
          this.limits,
        )
        try {
          const initializationEvictions = await store.enforceCapacity()
          if (this.stopped) {
            store.stop()
            await store.drain()
            await domain.close()
            throw new Context7CacheError('CONTEXT7_CACHE_CLOSED')
          }
          return { domain, initializationEvictions, store }
        } catch (error) {
          store.stop()
          await store.drain()
          await domain.close()
          throw error
        }
      })()
    }
    return this.opening
  }

  async get(key: Context7CacheKey): Promise<Readonly<Context7CacheEntry> | undefined> {
    return (await this.open()).store.get(key)
  }

  async put(entry: Context7CacheEntry): Promise<Readonly<Context7CacheWriteResult>> {
    return (await this.open()).store.put(entry)
  }

  async lookupDoc(docRef: unknown): Promise<Readonly<Context7CachedDocLookup>> {
    if (!isContext7DocRef(docRef)) return Object.freeze({ state: 'not_found' })
    return (await this.open()).store.lookupDoc(docRef)
  }

  async findDoc(input: Context7CachedDocQuery): Promise<Readonly<Context7CachedDocMatch>> {
    return (await this.open()).store.findDoc(input)
  }

  async initializationEvictions(): Promise<number> {
    return (await this.open()).initializationEvictions
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.opening === undefined) return
    let opened: OpenCache
    try {
      opened = await this.opening
    } catch {
      return
    }
    opened.store.stop()
    await opened.store.drain()
    await opened.domain.close()
  }
}

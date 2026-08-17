import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  CONTEXT7_CACHE_FORMAT_VERSION,
  Context7CacheError,
  Context7CacheStore,
  Context7CachedOperations,
  Context7OperationFailure,
  context7CacheEntryIsFresh,
  context7DocsCacheKey,
  context7ResolveCacheKey,
  type Context7CacheEntry,
  type Context7CacheKey,
  type Context7CacheRepository,
  type Context7DocsCacheEntry,
  type Context7ResolveCacheEntry,
} from '../src/documentation/index.js'
import { ProviderError } from '../src/provider-runtime/index.js'

function resolveConfig(overrides: Record<string, unknown> = {}): SearchEnhanceConfig {
  const cache = typeof overrides.cache === 'object' && overrides.cache !== null
    ? overrides.cache as Record<string, unknown>
    : {}
  return Config({
    ...overrides,
    cache: {
      context7EntryMaxBytes: 64 * 1024,
      maxEntries: 20,
      ...cache,
    },
    providers: {
      context7: { baseUrl: 'https://context7.test', timeoutMs: 1000 },
    },
    retry: {
      baseDelayMs: 0,
      jitterRatio: 0,
      maxAttempts: 1,
      maxDelayMs: 0,
      maxTotalDelayMs: 0,
      multiplier: 1,
    },
  } as never)
}

class TestCacheTable implements KvTable<Context7CacheKey, Context7CacheEntry> {
  readonly records = new Map<Context7CacheKey, Context7CacheEntry>()

  get size(): number {
    return this.records.size
  }

  get(key: Context7CacheKey): Context7CacheEntry | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[Context7CacheKey, Context7CacheEntry]> {
    return new Map(this.records).entries()
  }

  keys(): IterableIterator<Context7CacheKey> {
    return new Map(this.records).keys()
  }

  async put(key: Context7CacheKey, value: Context7CacheEntry): Promise<void> {
    this.records.set(key, value)
  }

  async delete(key: Context7CacheKey): Promise<boolean> {
    return this.records.delete(key)
  }

  async update(
    key: Context7CacheKey,
    transform: (current: Context7CacheEntry) => Context7CacheEntry,
  ): Promise<Context7CacheEntry> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing')
    const next = transform(current)
    this.records.set(key, next)
    return next
  }
}

function fixture(options: { maxEntries?: number; maxEntryBytes?: number; now?: number } = {}) {
  const table = new TestCacheTable()
  const clock = { value: options.now ?? 1_000 }
  const store = new Context7CacheStore(table, {
    maxEntries: options.maxEntries ?? 20,
    maxEntryBytes: options.maxEntryBytes ?? 64 * 1024,
  })
  const operations = new Context7CachedOperations(store, { now: () => clock.value })
  return { clock, operations, store, table }
}

function resolveRemote(title = 'React', snippetCount = 1200) {
  return {
    attempts: 1,
    libraries: [{
      description: 'React official documentation',
      id: '/reactjs/react.dev',
      title,
      totalSnippets: snippetCount,
      trustScore: 10,
    }],
    responseBytes: 128,
    totalDelayMs: 0,
    totalLibraries: 1,
    truncated: false,
  } as const
}

function docsRemote(content = 'Cleanup runs before the next effect.') {
  return {
    attempts: 1,
    responseBytes: Buffer.byteLength(content, 'utf8'),
    snippets: [{ content, title: 'Cleanup' }],
    totalDelayMs: 0,
    totalSnippets: 1,
    truncated: false,
  } as const
}

function resolveInput(
  config: SearchEnhanceConfig,
  load: () => Promise<ReturnType<typeof resolveRemote>>,
  forceRefresh = false,
) {
  return {
    config,
    forceRefresh,
    load,
    maxResults: 5,
    query: 'React useEffect API docs',
    signal: new AbortController().signal,
  }
}

function docsInput(
  config: SearchEnhanceConfig,
  load: () => Promise<ReturnType<typeof docsRemote>>,
  forceRefresh = false,
) {
  return {
    config,
    forceRefresh,
    libraryId: '/reactjs/react.dev',
    load,
    maxResults: 5,
    query: 'React useEffect API docs',
    signal: new AbortController().signal,
  }
}

describe('Context7 resolve persistent TTL cache', () => {
  it('reports miss, hit, force refresh, exact expiry refresh, and stable keys', async () => {
    const config = resolveConfig({ cache: { context7ResolveTtlHours: 1 } })
    const test = fixture()
    const load = vi.fn(async () => resolveRemote())

    const first = await test.operations.resolve(resolveInput(config, load))
    expect(first.cache).toBe('miss')
    expect(load).toHaveBeenCalledTimes(1)
    expect(first.entry.expiresAtMs).toBe(3_601_000)

    test.clock.value = 3_600_999
    const hit = await test.operations.resolve(resolveInput(config, load))
    expect(hit.cache).toBe('hit')
    expect(hit.entry.cacheKey).toBe(first.entry.cacheKey)
    expect(load).toHaveBeenCalledTimes(1)

    const forced = await test.operations.resolve(resolveInput(config, load, true))
    expect(forced.cache).toBe('refresh')
    expect(forced.entry.cacheKey).toBe(first.entry.cacheKey)
    expect(load).toHaveBeenCalledTimes(2)

    test.clock.value = forced.entry.expiresAtMs
    expect(context7CacheEntryIsFresh(forced.entry, test.clock.value)).toBe(false)
    const exactExpiry = await test.operations.resolve(resolveInput(config, load))
    expect(exactExpiry.cache).toBe('refresh')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('uses expired data only for temporary failures and never for configuration failures', async () => {
    const config = resolveConfig({ cache: { context7ResolveTtlHours: 1 } })
    const test = fixture()
    const first = await test.operations.resolve(resolveInput(config, async () => resolveRemote()))
    test.clock.value = first.entry.expiresAtMs

    const network = new ProviderError({ capability: 'docs_search', kind: 'network', provider: 'context7' })
    const stale = await test.operations.resolve(resolveInput(config, async () => { throw network }))
    expect(stale).toMatchObject({ cache: 'stale', entry: first.entry, staleCause: network })

    const configuration = new ProviderError({
      capability: 'docs_search',
      kind: 'configuration',
      provider: 'context7',
    })
    await expect(test.operations.resolve(resolveInput(config, async () => {
      throw configuration
    }))).rejects.toMatchObject({
      cache: 'refresh',
      path: 'resolve',
    })
  })

  it('does not turn cancellation into stale fallback', async () => {
    const config = resolveConfig({ cache: { context7ResolveTtlHours: 1 } })
    const test = fixture()
    const first = await test.operations.resolve(resolveInput(config, async () => resolveRemote()))
    test.clock.value = first.entry.expiresAtMs
    const controller = new AbortController()
    const reason = new Error('cancel Context7 resolve')
    const pending = test.operations.resolve({
      ...resolveInput(config, async () => {
        controller.abort(reason)
        throw reason
      }),
      signal: controller.signal,
    })
    await expect(pending).rejects.toBe(reason)
  })

  it('observes cancellation while an otherwise fresh cache read is pending', async () => {
    const config = resolveConfig()
    const seeded = fixture()
    const first = await seeded.operations.resolve(resolveInput(config, async () => resolveRemote()))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const repository: Context7CacheRepository = {
      findDoc: async () => ({ matchedRecords: 0, scannedRecords: 0, state: 'not_found' }),
      get: async () => {
        await gate
        return first.entry
      },
      lookupDoc: async () => ({ state: 'not_found' }),
      put: async () => ({ evictedEntries: 0 }),
    }
    const operations = new Context7CachedOperations(repository, { now: () => 1_000 })
    const controller = new AbortController()
    const reason = new Error('cancel pending cache hit')
    const load = vi.fn(async () => resolveRemote())
    const pending = operations.resolve({
      ...resolveInput(config, load),
      signal: controller.signal,
    })

    controller.abort(reason)
    release()

    await expect(pending).rejects.toBe(reason)
    expect(load).not.toHaveBeenCalled()
  })
})

describe('Context7 docs persistent TTL cache and doc_ref', () => {
  it('reports miss, hit, force refresh, exact expiry, and recoverable opaque refs', async () => {
    const config = resolveConfig({ cache: { context7DocsTtlHours: 1 } })
    const test = fixture()
    const load = vi.fn(async () => docsRemote('界🙂 cleanup'))

    const first = await test.operations.docs(docsInput(config, load))
    expect(first.cache).toBe('miss')
    expect(first.entry.docRef).toMatch(/^ctx7d_[A-Za-z0-9_-]{43}$/)
    expect(first.entry.docRef).toBe(first.entry.cacheKey)
    expect(first.entry.docRef).not.toContain('react')
    expect(first.entry.snippets[0]?.content).toBe('界🙂 cleanup')

    const lookup = await test.operations.lookupDoc(first.entry.docRef)
    expect(lookup).toEqual({ entry: first.entry, state: 'found' })
    expect(await test.operations.lookupDoc('ctx7d_invalid')).toEqual({ state: 'not_found' })

    const hit = await test.operations.docs(docsInput(config, load))
    expect(hit.cache).toBe('hit')
    expect(load).toHaveBeenCalledTimes(1)

    const forced = await test.operations.docs(docsInput(config, load, true))
    expect(forced.cache).toBe('refresh')
    expect(forced.entry.docRef).toBe(first.entry.docRef)
    expect(load).toHaveBeenCalledTimes(2)

    test.clock.value = forced.entry.expiresAtMs
    const exactExpiry = await test.operations.docs(docsInput(config, load))
    expect(exactExpiry.cache).toBe('refresh')
    expect(exactExpiry.entry.docRef).toBe(first.entry.docRef)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('uses expired docs after temporary failure but not invalid response or credential failure', async () => {
    const config = resolveConfig({ cache: { context7DocsTtlHours: 1 } })
    const test = fixture()
    const first = await test.operations.docs(docsInput(config, async () => docsRemote()))
    test.clock.value = first.entry.expiresAtMs

    for (const kind of ['invalid_response', 'credential_missing'] as const) {
      await expect(test.operations.docs(docsInput(config, async () => {
        throw new ProviderError({ capability: 'docs_search', kind, provider: 'context7' })
      }))).rejects.toBeInstanceOf(Context7OperationFailure)
    }

    const stale = await test.operations.docs(docsInput(config, async () => {
      throw new ProviderError({ capability: 'docs_search', kind: 'timeout', provider: 'context7' })
    }))
    expect(stale.cache).toBe('stale')
    expect(stale.entry.docRef).toBe(first.entry.docRef)
  })
})

describe('Context7 cached-doc deterministic query lookup', () => {
  it('uses a bounded lexicographic scan, stable score/ref ordering, and an exact library filter', async () => {
    const config = resolveConfig()
    const test = fixture()
    const first = await test.operations.docs({
      ...docsInput(config, async () => docsRemote('shared deterministic marker')),
      libraryId: '/react/react',
      query: 'first cache identity',
    })
    const second = await test.operations.docs({
      ...docsInput(config, async () => docsRemote('shared deterministic marker')),
      libraryId: '/vue/vue',
      query: 'second cache identity',
    })
    const expected = [first.entry, second.entry]
      .sort((left, right) => left.docRef.localeCompare(right.docRef))[0]

    const matched = await test.store.findDoc({
      maxScanRecords: 500,
      query: 'shared deterministic marker',
      signal: new AbortController().signal,
    })
    expect(matched).toMatchObject({
      state: 'found',
      entry: { docRef: expected?.docRef },
      matchedRecords: 2,
      scannedRecords: 2,
    })

    const filtered = await test.store.findDoc({
      libraryId: '/vue/vue',
      maxScanRecords: 500,
      query: 'shared deterministic marker',
      signal: new AbortController().signal,
    })
    expect(filtered).toMatchObject({
      state: 'found',
      entry: { libraryId: '/vue/vue' },
      matchedRecords: 1,
      scannedRecords: 2,
    })

    const bounded = await test.store.findDoc({
      maxScanRecords: 1,
      query: 'shared deterministic marker',
      signal: new AbortController().signal,
    })
    expect(bounded.scannedRecords).toBe(1)
    await expect(test.store.findDoc({
      maxScanRecords: 501,
      query: 'shared deterministic marker',
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RangeError)
  })

  it('returns not_found for misses/evictions and fails closed for cancellation or corruption', async () => {
    const config = resolveConfig()
    const evicting = fixture({ maxEntries: 1 })
    const first = await evicting.operations.docs({
      ...docsInput(config, async () => docsRemote('first marker')),
      query: 'first cache identity',
    })
    await evicting.operations.docs({
      ...docsInput(config, async () => docsRemote('second marker')),
      query: 'second cache identity',
    })
    expect(await evicting.store.lookupDoc(first.entry.docRef)).toEqual({ state: 'not_found' })
    expect(await evicting.store.findDoc({
      maxScanRecords: 500,
      query: 'utterly absent phrase',
      signal: new AbortController().signal,
    })).toEqual({ matchedRecords: 0, scannedRecords: 1, state: 'not_found' })

    const controller = new AbortController()
    const reason = new Error('cancel cache query')
    controller.abort(reason)
    await expect(evicting.store.findDoc({
      maxScanRecords: 500,
      query: 'second marker',
      signal: controller.signal,
    })).rejects.toBe(reason)

    const only = [...evicting.table.records.entries()][0]
    if (only === undefined) throw new Error('expected retained cache entry')
    evicting.table.records.set(only[0], {
      ...only[1],
      totalItems: 0,
    } as Context7CacheEntry)
    await expect(evicting.store.findDoc({
      maxScanRecords: 500,
      query: 'second marker',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTEXT7_CACHE_CORRUPT' })
  })
})

describe('Context7 cache integrity, capacity, and byte boundaries', () => {
  it('fails closed on a structurally damaged or oversized record', async () => {
    const test = fixture({ maxEntryBytes: 64 * 1024 })
    const config = resolveConfig()
    const result = await test.operations.resolve(resolveInput(config, async () => resolveRemote()))
    const damaged = {
      ...result.entry,
      totalItems: 0,
    } as unknown as Context7CacheEntry
    test.table.records.set(result.entry.cacheKey, damaged)

    await expect(test.store.get(result.entry.cacheKey)).rejects.toMatchObject({
      code: 'CONTEXT7_CACHE_CORRUPT',
    })

    const exactBytes = Buffer.byteLength(JSON.stringify(result.entry), 'utf8')
    const exact = new Context7CacheStore(new TestCacheTable(), {
      maxEntries: 1,
      maxEntryBytes: exactBytes,
    })
    await expect(exact.put(result.entry)).resolves.toEqual({ evictedEntries: 0 })
    const over = new Context7CacheStore(new TestCacheTable(), {
      maxEntries: 1,
      maxEntryBytes: exactBytes - 1,
    })
    await expect(over.put(result.entry)).rejects.toBeInstanceOf(Context7CacheError)
  })

  it('evicts the deterministic oldest record at capacity and reports the eviction', async () => {
    const config = resolveConfig()
    const test = fixture({ maxEntries: 2, now: 100 })
    const first = await test.operations.resolve({
      ...resolveInput(config, async () => resolveRemote('First')),
      query: 'first library docs',
    })
    test.clock.value = 200
    const second = await test.operations.resolve({
      ...resolveInput(config, async () => resolveRemote('Second')),
      query: 'second library docs',
    })
    test.clock.value = 300
    const third = await test.operations.resolve({
      ...resolveInput(config, async () => resolveRemote('Third')),
      query: 'third library docs',
    })

    expect(third.evictedEntries).toBe(1)
    expect(test.table.size).toBe(2)
    expect(test.table.get(first.entry.cacheKey)).toBeUndefined()
    expect(test.table.get(second.entry.cacheKey)).toBeDefined()
    expect(test.table.get(third.entry.cacheKey)).toBeDefined()
  })

  it('keys every response-shaping identity while excluding query text and secrets', () => {
    const base = {
      baseUrl: 'https://context7.test',
      maxEntryBytes: 1024,
      maxLibraryTextCharacters: 100,
      maxResults: 5,
      query: 'React secret-shaped query',
    }
    const first = context7ResolveCacheKey(base)
    expect(first).not.toContain('React')
    expect(first).not.toContain('secret')
    expect(context7ResolveCacheKey({ ...base, maxResults: 6 })).not.toBe(first)
    expect(context7ResolveCacheKey({ ...base, query: 'Vue docs' })).not.toBe(first)

    const doc = context7DocsCacheKey({
      baseUrl: base.baseUrl,
      libraryId: '/reactjs/react.dev',
      maxEntryBytes: 1024,
      maxResults: 5,
      maxSnippetCharacters: 1200,
      query: base.query,
    })
    expect(doc).not.toContain('reactjs')
    expect(doc).not.toContain('secret')
  })

  it('retains complete Unicode snippets under an exact JSON byte ceiling', async () => {
    const config = resolveConfig()
    const seed = fixture()
    const result = await seed.operations.docs(docsInput(config, async () => docsRemote('界🙂')))
    const bytes = Buffer.byteLength(JSON.stringify(result.entry), 'utf8')
    const exact = new Context7CacheStore(new TestCacheTable(), {
      maxEntries: 1,
      maxEntryBytes: bytes,
    })
    await exact.put(result.entry)
    expect((await exact.lookupDoc(result.entry.docRef))).toMatchObject({
      entry: { snippets: [{ content: '界🙂' }] },
      state: 'found',
    })
  })

  it('keeps record constructors internally consistent', () => {
    const config = resolveConfig()
    const resolveKey = context7ResolveCacheKey({
      baseUrl: config.providers.context7.baseUrl,
      maxEntryBytes: config.cache.context7EntryMaxBytes,
      maxLibraryTextCharacters: config.cache.context7LibraryTextMaxCharacters,
      maxResults: 1,
      query: 'react',
    })
    const resolveEntry: Context7ResolveCacheEntry = {
      cacheKey: resolveKey,
      createdAtMs: 0,
      expiresAtMs: 1,
      kind: 'resolve',
      libraries: [],
      maxResults: 1,
      responseBytes: 0,
      totalItems: 0,
      truncated: false,
      version: CONTEXT7_CACHE_FORMAT_VERSION,
    }
    const docRef = context7DocsCacheKey({
      baseUrl: config.providers.context7.baseUrl,
      libraryId: '/react/react',
      maxEntryBytes: config.cache.context7EntryMaxBytes,
      maxResults: 1,
      maxSnippetCharacters: config.cache.context7SnippetMaxCharacters,
      query: 'react',
    })
    const docsEntry: Context7DocsCacheEntry = {
      cacheKey: docRef,
      createdAtMs: 0,
      docRef,
      expiresAtMs: 1,
      kind: 'docs',
      libraryId: '/react/react',
      maxResults: 1,
      responseBytes: 0,
      snippets: [],
      totalItems: 0,
      truncated: false,
      version: CONTEXT7_CACHE_FORMAT_VERSION,
    }
    expect(resolveEntry.cacheKey).toMatch(/^ctx7r_/)
    expect(docsEntry.cacheKey).toBe(docsEntry.docRef)
  })
})

import { Context } from '@deepseek-ai/cordis'
import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import type {
  Context7CacheEntry,
  Context7CacheKey,
} from '../src/documentation/cache-domain.js'
import {
  Context7CacheStore,
  Context7CachedOperations,
  DocumentationContext7Provider,
  DocumentationSearchInfrastructureError,
  DocumentationSearchService,
} from '../src/documentation/index.js'
import { SearchOrchestrator } from '../src/orchestration/index.js'
import { ExaProvider } from '../src/providers/exa.js'
import { Context7RemoteClient } from '../src/providers/context7.js'
import type {
  BoundedSourceProvider,
  SourceProviderSearchOutcome,
} from '../src/providers/types.js'

function resolveConfig(overrides: Record<string, unknown> = {}): SearchEnhanceConfig {
  const cache = typeof overrides.cache === 'object' && overrides.cache !== null
    ? overrides.cache as Record<string, unknown>
    : {}
  return Config({
    ...overrides,
    cache: {
      context7DocsTtlHours: 1,
      context7EntryMaxBytes: 64 * 1024,
      context7ResolveTtlHours: 1,
      maxEntries: 20,
      ...cache,
    },
    providers: {
      context7: { baseUrl: 'https://context7.test', timeoutMs: 1000 },
      exa: { baseUrl: 'https://exa.test', timeoutMs: 1000 },
    },
    retention: {
      providerMaxSources: 20,
      providerResponseMaxBytes: 64 * 1024,
      providerResultMaxBytes: 64 * 1024,
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
  get size(): number { return this.records.size }
  get(key: Context7CacheKey): Context7CacheEntry | undefined { return this.records.get(key) }
  entries(): IterableIterator<[Context7CacheKey, Context7CacheEntry]> {
    return new Map(this.records).entries()
  }
  keys(): IterableIterator<Context7CacheKey> { return new Map(this.records).keys() }
  async put(key: Context7CacheKey, value: Context7CacheEntry): Promise<void> {
    this.records.set(key, value)
  }
  async delete(key: Context7CacheKey): Promise<boolean> { return this.records.delete(key) }
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

interface CredentialFixture extends Pick<CredentialProvider, 'describe' | 'resolve'> {
  readonly describe: ReturnType<typeof vi.fn<CredentialProvider['describe']>>
  readonly resolve: ReturnType<typeof vi.fn<CredentialProvider['resolve']>>
}

function credentials(values: { readonly context7?: string; readonly exa?: string }): CredentialFixture {
  return {
    describe: vi.fn<CredentialProvider['describe']>(async (ref: CredentialRef) => ({
      configured: String(ref) === 'EXA_API_KEY' ? values.exa !== undefined : values.context7 !== undefined,
      writable: true,
    })),
    resolve: vi.fn<CredentialProvider['resolve']>(async (
      ref: CredentialRef,
    ): Promise<ResolvedCredential | undefined> => {
      const value = String(ref) === 'EXA_API_KEY' ? values.exa : values.context7
      return value === undefined ? undefined : { source: 'test', value }
    }),
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

interface FixtureOptions {
  readonly config?: SearchEnhanceConfig
  readonly context7Credential?: string
  readonly exaCredential?: string
  readonly fetch?: typeof fetch
  readonly now?: number
}

const activeFixtures: Array<{
  readonly context: Context
  readonly service: DocumentationSearchService
}> = []

function fixture(options: FixtureOptions = {}) {
  const config = options.config ?? resolveConfig()
  const credentialFixture = credentials({
    ...(options.context7Credential === undefined
      ? {}
      : { context7: options.context7Credential }),
    ...(options.exaCredential === undefined ? {} : { exa: options.exaCredential }),
  })
  const calls: string[] = []
  const defaultFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://context7.test/api/v2/search?')) {
      return jsonResponse({
        results: [
          {
            benchmarkScore: 90,
            description: 'Unofficial hook collection',
            id: '/community/react-hooks',
            title: 'React Hooks',
            totalSnippets: 500,
            trustScore: 9,
          },
          {
            benchmarkScore: 89,
            description: 'React.dev is the official documentation website for React.',
            id: '/reactjs/react.dev',
            title: 'React',
            totalSnippets: 7000,
            trustScore: 10,
          },
        ],
      })
    }
    if (url.startsWith('https://context7.test/api/v2/context?')) {
      return jsonResponse({
        codeSnippets: [{ content: 'return () => unsubscribe();', title: 'Cleanup' }],
      })
    }
    if (url === 'https://exa.test/search') {
      return jsonResponse({
        results: [{
          highlights: ['Official React API reference'],
          title: 'React API Reference',
          url: 'https://react.dev/reference/react',
        }],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }) as typeof fetch
  const fetchImplementation = options.fetch ?? defaultFetch
  const table = new TestCacheTable()
  const cacheStore = new Context7CacheStore(table, {
    maxEntries: config.cache.maxEntries,
    maxEntryBytes: config.cache.context7EntryMaxBytes,
  })
  const clock = { value: options.now ?? 1_000 }
  const context = new Context()
  const service = new DocumentationSearchService(context, {
    context7: new Context7RemoteClient({
      credentials: credentialFixture,
      fetch: fetchImplementation,
      random: () => 0.5,
      sleep: async () => undefined,
    }),
    context7Cache: new Context7CachedOperations(cacheStore, { now: () => clock.value }),
    exa: new ExaProvider({
      credentials: credentialFixture,
      fetch: fetchImplementation,
      random: () => 0.5,
      sleep: async () => undefined,
    }),
    getConfig: () => config,
    now: () => clock.value,
  })
  activeFixtures.push({ context, service })
  return { calls, clock, config, credentialFixture, service, table }
}

afterEach(async () => {
  await Promise.all(activeFixtures.splice(0).map(async ({ context, service }) => {
    await service.stop()
    await context.fiber.dispose()
  }))
})

function input(
  provider: 'auto' | 'context7' | 'exa' | 'all',
  overrides: Partial<Parameters<DocumentationSearchService['search']>[0]> = {},
) {
  return {
    maxResults: 5,
    provider,
    query: 'React useEffect API docs',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('high-level documentation provider routing', () => {
  it.each([
    ['context7', 'auto', 2, false],
    ['context7', 'auto-off', 2, false],
    ['exa', 'exa', 1, true],
    ['all', 'all', 3, true],
    ['auto', 'auto', 3, true],
  ] as const)('routes %s for the %s policy', async (provider, policy, expectedCalls, withExa) => {
    const config = resolveConfig({ fallbackMode: policy === 'auto-off' ? 'off' : 'auto' })
    const test = fixture({ config, ...(withExa ? { exaCredential: 'exa-secret' } : {}) })
    const actualProvider = policy === 'auto-off' ? 'auto' : provider

    const result = await test.service.search(input(actualProvider))

    expect(test.calls).toHaveLength(expectedCalls)
    expect(test.calls.filter(url => url === 'https://exa.test/search')).toHaveLength(withExa ? 1 : 0)
    expect(result.provider).toBe(actualProvider)
    expect(result.providers).toEqual(actualProvider === 'exa'
      ? [
          { provider: 'context7', state: 'skipped' },
          { provider: 'exa', state: 'complete' },
        ]
      : [
          { provider: 'context7', state: 'complete' },
          { provider: 'exa', state: withExa ? 'complete' : 'skipped' },
        ])
    expect(result.persistence).toMatchObject({
      depth: 'compact',
      profile: 'coding_docs',
      query: 'React useEffect API docs',
    })
    expect(result.sources.length).toBeGreaterThan(0)
  })

  it('skips Context7 resolve for a known valid libraryId', async () => {
    const test = fixture()

    const result = await test.service.search(input('context7', {
      libraryId: '/reactjs/react.dev',
    }))

    expect(test.calls).toHaveLength(1)
    expect(test.calls[0]).toContain('/api/v2/context?')
    expect(result.cache).toMatchObject({
      docs: { state: 'miss' },
      resolve: { reason: 'known_library_id', state: 'skipped' },
    })
    expect(result.selectedLibrary?.id).toBe('/reactjs/react.dev')
    expect(result.docRef).toMatch(/^ctx7d_/)
  })

  it('selects the stable official candidate using exact/relevance/trust/benchmark/snippet signals', async () => {
    const test = fixture()

    const first = await test.service.search(input('context7'))
    const second = await test.service.search(input('context7'))

    expect(first.selectedLibrary?.id).toBe('/reactjs/react.dev')
    expect(second.selectedLibrary).toEqual(first.selectedLibrary)
    expect(first.sources[0]).toMatchObject({
      category: 'documentation',
      provider: 'context7',
      title: 'React',
    })
    expect(second.cache).toMatchObject({ docs: { state: 'hit' }, resolve: { state: 'hit' } })
    expect(test.calls).toHaveLength(2)
  })

  it('handles Exa configured and unconfigured states without confusing empty success', async () => {
    const unconfigured = fixture()
    const auto = await unconfigured.service.search(input('auto'))
    expect(auto.sources.some(source => source.provider === 'context7')).toBe(true)
    expect(auto.warnings).toContainEqual(expect.objectContaining({
      code: 'provider_not_configured',
      provider: 'exa',
    }))

    await expect(unconfigured.service.search(input('exa'))).rejects.toMatchObject({
      code: 'DOCUMENTATION_SEARCH_FAILED',
      warnings: [expect.objectContaining({ code: 'provider_not_configured' })],
    })

    const configured = fixture({ exaCredential: 'exa-secret' })
    const exa = await configured.service.search(input('exa'))
    expect(exa.sources).toEqual([
      expect.objectContaining({ provider: 'exa', url: 'https://react.dev/reference/react' }),
    ])
    expect(exa.cache.resolve.state).toBe('skipped')
  })
})

describe('documentation partial success, empty results, cache fallback, and cancellation', () => {
  it('retains Exa when Context7 fails and throws only when every effective path fails', async () => {
    const fetchMock = vi.fn(async (request: Parameters<typeof fetch>[0]) => {
      const url = String(request)
      if (url.startsWith('https://context7.test/')) throw new TypeError('local fixture network failure')
      if (url === 'https://exa.test/search') {
        return jsonResponse({
          results: [{ title: 'Official SDK', url: 'https://sdk.test/docs' }],
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as typeof fetch
    const partial = fixture({ exaCredential: 'exa-secret', fetch: fetchMock })

    const result = await partial.service.search(input('all'))
    expect(result.sources).toEqual([
      expect.objectContaining({ provider: 'exa', url: 'https://sdk.test/docs' }),
    ])
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'provider_failed',
      errorKind: 'network',
      provider: 'context7',
    }))
    expect(result.providers).toEqual([
      { provider: 'context7', state: 'failed' },
      { provider: 'exa', state: 'complete' },
    ])

    const allFailed = fixture({
      exaCredential: 'exa-secret',
      fetch: vi.fn(async () => { throw new TypeError('all local routes down') }) as typeof fetch,
    })
    await expect(allFailed.service.search(input('all'))).rejects.toBeInstanceOf(
      DocumentationSearchInfrastructureError,
    )
  })

  it('preserves a resolved Context7 source when only the docs subpath fails', async () => {
    const fetchMock = vi.fn(async (request: Parameters<typeof fetch>[0]) => {
      const url = String(request)
      if (url.includes('/api/v2/search')) {
        return jsonResponse({ results: [{
          description: 'Official library docs',
          id: '/official/library',
          title: 'Library',
        }] })
      }
      throw new TypeError('docs route temporarily failed')
    }) as typeof fetch
    const test = fixture({ fetch: fetchMock })

    const result = await test.service.search(input('context7'))

    expect(result.sources).toEqual([
      expect.objectContaining({ provider: 'context7', title: 'Library' }),
    ])
    expect(result.snippets).toEqual([])
    expect(result.cache.docs.state).toBe('miss')
    expect(result.providers).toEqual([
      { provider: 'context7', state: 'partial' },
      { provider: 'exa', state: 'skipped' },
    ])
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'provider_failed',
      path: 'docs',
    }))
  })

  it('returns genuine empty results when at least one effective path completed', async () => {
    const empty = fixture({
      exaCredential: 'exa-secret',
      fetch: vi.fn(async (request: Parameters<typeof fetch>[0]) => (
        String(request) === 'https://exa.test/search'
          ? jsonResponse({ results: [] })
          : jsonResponse({ results: [] })
      )) as typeof fetch,
    })

    const result = await empty.service.search(input('all'))

    expect(result.sources).toEqual([])
    expect(result.snippets).toEqual([])
    expect(result.warnings).toContainEqual({ code: 'no_results' })
  })

  it('returns explicit stale cache states and warnings after temporary failure', async () => {
    let offline = false
    const fetchMock = vi.fn(async (request: Parameters<typeof fetch>[0]) => {
      if (offline) throw new TypeError('offline fixture')
      const url = String(request)
      return url.includes('/api/v2/search')
        ? jsonResponse({ results: [{ id: '/react/react', title: 'React' }] })
        : jsonResponse({ codeSnippets: [{ content: 'cached snippet' }] })
    }) as typeof fetch
    const test = fixture({ fetch: fetchMock, now: 1_000 })
    const fresh = await test.service.search(input('context7'))
    test.clock.value = 3_601_000
    offline = true

    const stale = await test.service.search(input('context7'))

    expect(stale.cache).toMatchObject({ docs: { state: 'stale' }, resolve: { state: 'stale' } })
    expect(stale.docRef).toBe(fresh.docRef)
    expect(stale.snippets[0]?.content).toBe('cached snippet')
    expect(stale.providers).toEqual([
      { provider: 'context7', state: 'complete' },
      { provider: 'exa', state: 'skipped' },
    ])
    expect(stale.warnings.filter(warning => warning.code === 'cache_stale')).toHaveLength(2)
    expect(stale.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'failed', participatedInFallback: true }),
      expect.objectContaining({ outcome: 'success', participatedInFallback: true }),
    ]))
  })

  it('does not use stale cache when the caller cancels', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel documentation service')
    let offline = false
    const fetchMock = vi.fn(async (request: Parameters<typeof fetch>[0]) => {
      const url = String(request)
      if (!offline) {
        return url.includes('/api/v2/search')
          ? jsonResponse({ results: [{ id: '/react/react', title: 'React' }] })
          : jsonResponse({ codeSnippets: [{ content: 'cached snippet' }] })
      }
      controller.abort(reason)
      throw reason
    }) as typeof fetch
    const test = fixture({ fetch: fetchMock, now: 1_000 })
    await test.service.search(input('context7'))
    test.clock.value = 3_601_000
    offline = true

    await expect(test.service.search(input('context7', {
      signal: controller.signal,
    }))).rejects.toBe(reason)
  })
})

describe('web_search documentation integration', () => {
  it('reuses the persistent Context7 operations and leaves non-document queries untouched', async () => {
    const test = fixture()
    const emptyOutcome: SourceProviderSearchOutcome = {
      attempts: 1,
      result: {
        responseBytes: 0,
        returnedSnippets: 0,
        returnedSources: 0,
        snippets: [],
        sources: [],
        totalSnippets: 0,
        totalSources: 0,
        truncated: false,
      },
      state: 'complete',
      totalDelayMs: 0,
    }
    const unavailable = (provider: 'exa' | 'tavily' | 'firecrawl', capability: 'docs_search' | 'web_search'): BoundedSourceProvider => ({
      capability,
      configured: async () => false,
      provider,
      search: async () => emptyOutcome,
    })
    const orchestrator = new SearchOrchestrator({
      context7: new DocumentationContext7Provider(test.service),
      exa: unavailable('exa', 'docs_search'),
      firecrawl: unavailable('firecrawl', 'web_search'),
      getConfig: () => test.config,
      mainSearch: {
        searchResolved: async () => ({
          answer: 'main answer',
          attempts: 1,
          endpoint: 'https://search.test/chat/completions',
          model: 'fixture-model',
          modelValidation: 'unavailable',
          protocol: 'completions',
          sources: [],
          sourcesTruncated: false,
          totalDelayMs: 0,
        }),
      },
      now: () => test.clock.value,
      tavily: unavailable('tavily', 'web_search'),
    })

    const run = (query: string, profile: 'coding_docs' | 'fact_check') => orchestrator.search({
      config: test.config,
      profile,
      query,
      signal: new AbortController().signal,
    })
    const first = await run('React useEffect API docs', 'coding_docs')
    const second = await run('React useEffect API docs', 'coding_docs')

    expect(first.canonical.sources.some(source => source.provider === 'context7')).toBe(true)
    expect(second.canonical.sources).toEqual(first.canonical.sources)
    expect(test.calls).toHaveLength(2)

    await run('compare quarterly revenue reports', 'fact_check')
    expect(test.calls).toHaveLength(2)
  })
})

describe('documentation secrecy and service lifecycle', () => {
  it('keeps credentials out of cache records, results, attempts, and fixed errors', async () => {
    const secret = 'context-super-secret-value'
    const test = fixture({ context7Credential: secret })

    const result = await test.service.search(input('context7'))
    const serialized = JSON.stringify({
      cache: [...test.table.records.values()],
      result,
    })

    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('Authorization')
    expect(result.persistence.sources).toEqual(result.sources)

    const failed = fixture({
      context7Credential: secret,
      fetch: vi.fn(async () => { throw new Error(`must not escape ${secret}`) }) as typeof fetch,
    })
    let failure: unknown
    try {
      await failed.service.search(input('context7'))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(DocumentationSearchInfrastructureError)
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(failure instanceof Error ? failure.message : '').not.toContain(secret)
  })

  it('stops admission and drains on disposal', async () => {
    const test = fixture()
    await test.service.stop()

    await expect(test.service.search(input('context7'))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

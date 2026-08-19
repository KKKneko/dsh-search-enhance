import { Buffer } from 'node:buffer'

import { Context } from '@deepseek-ai/cordis'
import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { ToolRuntime, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  Context7CacheStore,
  Context7CachedOperations,
  DocumentationSearchService,
  type Context7CacheEntry,
  type Context7CacheKey,
} from '../src/documentation/index.js'
import { Context7RemoteClient } from '../src/providers/context7.js'
import type { BoundedSourceProvider } from '../src/providers/types.js'
import {
  CONTEXT7_GET_CACHED_DOC_RAW_PARAMETERS,
  CONTEXT7_GET_LIBRARY_DOCS_PARAMETERS,
  CONTEXT7_QUERY_DOCS_PARAMETERS,
  CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETERS,
  ForegroundOperationScope,
  boundContext7QueryDocsOutput,
  createContext7Tools,
  isContext7ModelTextTruncated,
  renderContext7Text,
  type Context7QueryDocsOutput,
} from '../src/tools/index.js'

function resolvedConfig(overrides: Record<string, unknown> = {}): SearchEnhanceConfig {
  const cache = typeof overrides.cache === 'object' && overrides.cache !== null
    ? overrides.cache as Record<string, unknown>
    : {}
  const retention = typeof overrides.retention === 'object' && overrides.retention !== null
    ? overrides.retention as Record<string, unknown>
    : {}
  return Config({
    ...overrides,
    cache: {
      context7DocsTtlHours: 1,
      context7EntryMaxBytes: 256 * 1024,
      context7ResolveTtlHours: 1,
      maxEntries: 500,
      ...cache,
    },
    providers: {
      context7: { baseUrl: 'https://context7.test', timeoutMs: 1000 },
    },
    retention: {
      canonicalOutputMaxBytes: 256 * 1024,
      providerMaxSources: 20,
      providerResponseMaxBytes: 256 * 1024,
      ...retention,
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

function credentials(values: readonly (string | undefined)[]): CredentialFixture {
  let index = 0
  return {
    describe: vi.fn<CredentialProvider['describe']>(async () => ({
      configured: values.some(value => value !== undefined),
      writable: true,
    })),
    resolve: vi.fn<CredentialProvider['resolve']>(async (
      _ref: CredentialRef,
    ): Promise<ResolvedCredential | undefined> => {
      const value = values[Math.min(index, values.length - 1)]
      index += 1
      return value === undefined ? undefined : { source: 'test', value }
    }),
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

function defaultResponse(url: string): Response {
  if (url.startsWith('https://context7.test/api/v2/libs/search?')) {
    return jsonResponse({
      results: [
        {
          id: '/community/react-hooks',
          title: 'React Hooks',
          description: 'Unofficial hook collection',
          trustScore: 8,
          benchmarkScore: 75,
          totalSnippets: 400,
          unexpectedSecretField: 'must-not-project',
        },
        {
          id: '/reactjs/react.dev',
          title: 'React',
          description: 'React.dev official documentation',
          trustScore: 10,
          benchmarkScore: 95,
          totalSnippets: 7000,
          stars: 230000,
          versions: Array.from({ length: 25 }, (_value, index) => `v${index + 1}`),
        },
      ],
    })
  }
  if (url.startsWith('https://context7.test/api/v2/context?')) {
    const query = new URL(url).searchParams.get('query') ?? ''
    return jsonResponse({
      codeSnippets: Array.from({ length: 20 }, (_value, index) => ({
        title: `Snippet ${index + 1}`,
        content: `${query} — 界面 snippet ${index + 1}`,
        unsafeExtension: 'must-not-project',
      })),
      endpoint: 'https://internal.invalid',
      authorization: 'Bearer must-not-project',
    })
  }
  throw new Error(`Unexpected URL: ${url}`)
}

interface FixtureOptions {
  readonly config?: SearchEnhanceConfig
  readonly fetch?: typeof fetch
  readonly credentials?: readonly (string | undefined)[]
  readonly now?: number
}

interface Fixture {
  readonly config: SearchEnhanceConfig
  readonly context: Context
  readonly credentialFixture: CredentialFixture
  readonly fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  readonly clock: { value: number }
  readonly operations: ForegroundOperationScope
  readonly runtime: ToolRuntime
  readonly service: DocumentationSearchService
  readonly table: TestCacheTable
  readonly toolFiber: ReturnType<Context['plugin']>
}

const active: Fixture[] = []

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const config = options.config ?? resolvedConfig()
  const credentialFixture = credentials(options.credentials ?? ['context7-secret'])
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.redirect).toBe('manual')
    return options.fetch === undefined
      ? defaultResponse(String(input))
      : options.fetch(input, init)
  })
  const table = new TestCacheTable()
  const cache = new Context7CacheStore(table, {
    maxEntries: config.cache.maxEntries,
    maxEntryBytes: config.cache.context7EntryMaxBytes,
  })
  const clock = { value: options.now ?? 1_000 }
  const context = new Context()
  const service = new DocumentationSearchService(context, {
    context7: new Context7RemoteClient({
      credentials: credentialFixture,
      fetch: fetchMock,
      random: () => 0.5,
      sleep: async () => undefined,
    }),
    context7Cache: new Context7CachedOperations(cache, { now: () => clock.value }),
    exa: {
      capability: 'docs_search',
      provider: 'exa',
      configured: async () => false,
      search: async () => ({ state: 'not_configured' }),
    } satisfies BoundedSourceProvider,
    getConfig: () => config,
    now: () => clock.value,
  })
  const operations = new ForegroundOperationScope()
  new SystemPrompt(context, {})
  const runtime = new ToolRuntime(context, { mode: 'both' })
  const toolFiber = context.plugin(pluginContext => {
    for (const definition of createContext7Tools({
      documentation: service,
      getConfig: () => config,
      operations,
    })) pluginContext.tools.register(definition)
  })
  await toolFiber.await()
  const value = {
    config,
    context,
    credentialFixture,
    fetchMock,
    clock,
    operations,
    runtime,
    service,
    table,
    toolFiber,
  }
  active.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(active.splice(0).map(async value => {
    await value.toolFiber.dispose()
    await value.operations.stop()
    await value.service.stop()
    await value.context.fiber.dispose()
  }))
})

let callCounter = 0

async function execute(
  test: Fixture,
  name: string,
  args: unknown,
  options: { signal?: AbortSignal; nested?: boolean } = {},
): Promise<ToolExecutionResult> {
  callCounter += 1
  return test.runtime.execute({
    callId: CallId(`context7-tool-${callCounter}`),
    name,
    arguments: args,
    ...(options.nested ? { parent: Symbol('code-parent') as never } : {}),
    signal: options.signal ?? new AbortController().signal,
  })
}

async function successful(
  test: Fixture,
  name: string,
  args: unknown,
  options: { nested?: boolean } = {},
): Promise<Extract<ToolExecutionResult, { isError: false }> & { value: any }> {
  const result = await execute(test, name, args, options)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(JSON.stringify(result.error))
  return result as Extract<ToolExecutionResult, { isError: false }> & { value: any }
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('granular Context7 closed contracts', () => {
  it('registers exactly four closed schemas with the documented defaults', async () => {
    const test = await fixture()
    expect(test.runtime.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith('context7_'))).toEqual([
      'context7_resolve_library_id',
      'context7_query_docs',
      'context7_get_library_docs',
      'context7_get_cached_doc_raw',
    ])
    expect(test.runtime.schemas()
      .filter(schema => schema.name.startsWith('context7_'))
      .map(schema => schema.parameters.additionalProperties)).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETERS).toMatchObject({
      additionalProperties: false,
      required: ['library_name'],
      properties: { max_results: { default: 8, enum: expect.arrayContaining([1, 20]) } },
    })
    expect(CONTEXT7_QUERY_DOCS_PARAMETERS).toMatchObject({
      additionalProperties: false,
      required: ['library_id', 'query'],
      properties: { max_snippets: { default: 5 } },
    })
    expect(CONTEXT7_GET_LIBRARY_DOCS_PARAMETERS).toMatchObject({
      additionalProperties: false,
      required: ['query'],
      properties: { max_results: { default: 8 }, max_snippets: { default: 8 } },
    })
    expect(CONTEXT7_GET_CACHED_DOC_RAW_PARAMETERS).toMatchObject({
      additionalProperties: false,
    })
    expect(CONTEXT7_GET_CACHED_DOC_RAW_PARAMETERS).not.toHaveProperty('required')
    expect(serialized(test.runtime.schemas())).not.toMatch(/api.?key|authorization|base.?url/i)
  })

  it.each([
    ['context7_resolve_library_id', { library_name: '' }],
    ['context7_resolve_library_id', { library_name: 'react', extra: true }],
    ['context7_resolve_library_id', { library_name: 'react', max_results: 21 }],
    ['context7_query_docs', { library_id: 'react', query: 'hooks' }],
    ['context7_query_docs', { library_id: '/react/react', query: ' ' }],
    ['context7_query_docs', { library_id: '/react/react', query: 'hooks', max_snippets: 0 }],
    ['context7_get_library_docs', { query: 'hooks' }],
    ['context7_get_library_docs', { query: 'hooks', library_name: '' }],
    ['context7_get_cached_doc_raw', {}],
    ['context7_get_cached_doc_raw', { doc_ref: 'ctx7d_invalid' }],
    ['context7_get_cached_doc_raw', { query: '', library_id: '/react/react' }],
  ])('rejects invalid %s arguments before dispatch', async (name, args) => {
    const test = await fixture()
    const result = await execute(test, name, args)
    expect(result.isError).toBe(true)
    expect(test.fetchMock).not.toHaveBeenCalled()
  })
})

describe('context7_resolve_library_id', () => {
  it('selects the best safe candidate and reports miss, hit, refresh, and Provider facts', async () => {
    const test = await fixture()
    const args = { library_name: 'React', query: 'official React hooks', max_results: 8 }
    const miss = await successful(test, 'context7_resolve_library_id', args)
    const hit = await successful(test, 'context7_resolve_library_id', args)
    const refresh = await successful(test, 'context7_resolve_library_id', {
      ...args,
      force_refresh: true,
    })

    expect(miss.value).toMatchObject({
      state: 'found',
      selected_library: {
        id: '/reactjs/react.dev',
        trust_score: 10,
        benchmark_score: 95,
        total_snippets: 7000,
        versions_truncated: true,
      },
      cache: { state: 'miss' },
      total_candidates: 2,
      returned_candidates: 2,
      evidence_level: 'discovery',
    })
    expect(hit.value.cache.state).toBe('hit')
    expect(refresh.value.cache.state).toBe('refresh')
    expect(hit.value.attempts).toEqual([
      expect.objectContaining({ provider: 'context7-cache-resolve', outcome: 'success' }),
    ])
    expect(refresh.value.attempts).toEqual([
      expect.objectContaining({ provider: 'context7-resolve', outcome: 'success', count: 1 }),
    ])
    expect(test.fetchMock).toHaveBeenCalledTimes(2)
    const resolveUrl = new URL(String(test.fetchMock.mock.calls[0]?.[0]))
    expect(resolveUrl.pathname).toBe('/api/v2/libs/search')
    expect(resolveUrl.searchParams.get('libraryName')).toBe('React')
    expect(resolveUrl.searchParams.get('query')).toBe('official React hooks')
    expect(serialized([miss.value, miss.content, miss.meta])).not.toMatch(
      /context7-secret|must-not-project|authorization|endpoint/i,
    )
  })

  it('returns stable not_found and uses stale cache only after a transient failure', async () => {
    let offline = false
    const test = await fixture({
      fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (offline) throw new TypeError('offline fixture raw detail')
        return defaultResponse(String(input))
      }) as typeof fetch,
    })
    const args = { library_name: 'React', query: 'official docs' }
    const fresh = await successful(test, 'context7_resolve_library_id', args)
    test.clock.value = 3_601_000
    offline = true
    const stale = await successful(test, 'context7_resolve_library_id', args)
    expect(stale.value).toMatchObject({ cache: { state: 'stale' }, state: 'found' })
    expect(stale.value.warnings).toContainEqual(expect.objectContaining({
      code: 'cache_stale',
      error_kind: 'network',
      path: 'resolve',
    }))
    expect(stale.value.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'failed', fallback: true }),
      expect.objectContaining({ outcome: 'success', fallback: true }),
    ]))
    expect(stale.value.selected_library).toEqual(fresh.value.selected_library)
    expect(serialized(stale.value)).not.toContain('offline fixture raw detail')

    const empty = await fixture({ fetch: vi.fn(async () => jsonResponse({ results: [] })) as typeof fetch })
    const notFound = await successful(empty, 'context7_resolve_library_id', {
      library_name: 'missing',
    })
    expect(notFound.value).toMatchObject({ state: 'not_found', candidates: [] })
    expect(notFound.value.warnings).toContainEqual({ code: 'no_results' })
  })
})

describe('Context7 docs and cache Consumers', () => {
  it('queries an exact id, returns doc_ref, and keeps raw false/true inside the safe envelope', async () => {
    const test = await fixture()
    const args = {
      library_id: '/reactjs/react.dev',
      query: 'useEffect cleanup',
      max_snippets: 5,
    }
    const ordinary = await successful(test, 'context7_query_docs', args)
    const raw = await successful(test, 'context7_query_docs', { ...args, raw: true })

    expect(ordinary.value).toMatchObject({
      state: 'found',
      library_id: '/reactjs/react.dev',
      raw: false,
      cache: { state: 'miss' },
      total_snippets: 20,
      returned_snippets: 5,
    })
    expect(ordinary.value.doc_ref).toMatch(/^ctx7d_[A-Za-z0-9_-]{43}$/)
    expect(ordinary.value.snippets).toHaveLength(5)
    expect(raw.value).toMatchObject({
      raw: true,
      snippets: [],
      cache: { state: 'hit' },
      raw_envelope: {
        kind: 'docs',
        doc_ref: ordinary.value.doc_ref,
        library_id: '/reactjs/react.dev',
        returned_items: 5,
      },
    })
    expect(serialized(raw.value)).not.toMatch(
      /unsafeExtension|must-not-project|internal\.invalid|authorization|context7-secret/i,
    )
  })

  it('reports docs force-refresh and stale fallback without exposing the Provider failure', async () => {
    let offline = false
    const test = await fixture({
      fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (offline) throw new TypeError('private docs outage detail')
        return defaultResponse(String(input))
      }) as typeof fetch,
    })
    const args = {
      library_id: '/reactjs/react.dev',
      query: 'stale docs marker',
      max_snippets: 3,
    }
    await successful(test, 'context7_query_docs', args)
    const refreshed = await successful(test, 'context7_query_docs', {
      ...args,
      force_refresh: true,
    })
    expect(refreshed.value.cache.state).toBe('refresh')
    test.clock.value = 3_601_000
    offline = true
    const stale = await successful(test, 'context7_query_docs', args)
    expect(stale.value.cache.state).toBe('stale')
    expect(stale.value.warnings).toContainEqual(expect.objectContaining({
      code: 'cache_stale',
      path: 'docs',
      error_kind: 'network',
    }))
    expect(serialized(stale.value)).not.toContain('private docs outage detail')
  })

  it('strictly skips resolve for a known id and reuses resolve/select for a name', async () => {
    const test = await fixture()
    const known = await successful(test, 'context7_get_library_docs', {
      query: 'known id docs',
      library_id: '/reactjs/react.dev',
      library_name: 'ignored for resolve',
      max_snippets: 1,
    })
    expect(known.value).toMatchObject({
      state: 'found',
      library_id: '/reactjs/react.dev',
      cache: {
        resolve: { state: 'skipped', reason: 'known_library_id' },
        docs: { state: 'miss' },
      },
      resolve_total_candidates: 0,
      returned_snippets: 1,
    })
    expect(test.fetchMock.mock.calls.map(call => String(call[0]))).toHaveLength(1)
    expect(String(test.fetchMock.mock.calls[0]?.[0])).toContain('/api/v2/context?')

    const named = await successful(test, 'context7_get_library_docs', {
      query: 'official hooks docs',
      library_name: 'React',
      max_results: 20,
      max_snippets: 20,
    })
    expect(named.value).toMatchObject({
      state: 'found',
      library_id: '/reactjs/react.dev',
      selected_library: { id: '/reactjs/react.dev', trust_score: 10 },
      cache: { resolve: { state: 'miss' }, docs: { state: 'miss' } },
      returned_snippets: 20,
    })
  })

  it('reads exact and deterministic query-matched raw cache records with filtering and not-found', async () => {
    const test = await fixture()
    const seeded = await successful(test, 'context7_query_docs', {
      library_id: '/reactjs/react.dev',
      query: 'deterministic cleanup marker',
      max_snippets: 3,
    })
    const exact = await successful(test, 'context7_get_cached_doc_raw', {
      doc_ref: seeded.value.doc_ref,
    })
    expect(exact.value).toMatchObject({
      state: 'found',
      lookup: 'doc_ref',
      cache: 'hit',
      doc_ref: seeded.value.doc_ref,
      scanned_records: 0,
      matched_records: 1,
    })

    const matched = await successful(test, 'context7_get_cached_doc_raw', {
      query: 'deterministic cleanup marker',
      library_id: '/reactjs/react.dev',
    })
    expect(matched.value).toMatchObject({
      state: 'found',
      lookup: 'query',
      cache: 'hit',
      library_id: '/reactjs/react.dev',
      scanned_records: 1,
      matched_records: 1,
      scan_limit: 500,
    })

    const filtered = await successful(test, 'context7_get_cached_doc_raw', {
      doc_ref: seeded.value.doc_ref,
      library_id: '/other/library',
    })
    expect(filtered.value).toMatchObject({
      state: 'not_found',
      code: 'CONTEXT7_CACHE_NOT_FOUND',
      cache: 'miss',
    })
    expect(filtered.value).not.toHaveProperty('raw_envelope')

    const stored = test.table.records.get(seeded.value.doc_ref as Context7CacheKey)
    if (stored === undefined) throw new Error('expected cached docs entry')
    test.table.records.set(stored.cacheKey, { ...stored, totalItems: 0 } as Context7CacheEntry)
    const corrupt = await execute(test, 'context7_get_cached_doc_raw', {
      doc_ref: seeded.value.doc_ref,
    })
    expect(corrupt.isError).toBe(true)
    expect(corrupt).not.toHaveProperty('value')
    expect(serialized(corrupt)).not.toMatch(/\.json|authorization|context7-secret/i)

    expect(serialized([exact.value, matched.value])).not.toMatch(
      /context7-secret|endpoint|authorization|storage|\.json/i,
    )
  })
})

describe('Context7 independent output boundaries and runtime semantics', () => {
  it('reports independent canonical and model-text truncation on a real tool result', async () => {
    const base = resolvedConfig()
    const config: SearchEnhanceConfig = {
      ...base,
      retention: { ...base.retention, canonicalOutputMaxBytes: 1200 },
      budgets: {
        ...base.budgets,
        coding_docs: {
          ...base.budgets.coding_docs,
          compact: {
            ...base.budgets.coding_docs.compact,
            maxModelTextBytes: 300,
          },
        },
      },
    }
    const test = await fixture({ config })
    const result = await successful(test, 'context7_query_docs', {
      library_id: '/reactjs/react.dev',
      query: 'bounded actual output',
      max_snippets: 20,
    })
    expect(result.value.canonical_output_truncated).toBe(true)
    expect(result.value.model_text_truncated).toBe(true)
    expect(result.value.warnings).toContainEqual({ code: 'canonical_output_truncated' })
    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThanOrEqual(1200)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(300)
    expect(text).toContain('Context7 model text truncated')
  })

  it('bounds canonical and Native model text at tiny, exact, over, and multibyte limits', async () => {
    const test = await fixture()
    const result = await successful(test, 'context7_query_docs', {
      library_id: '/reactjs/react.dev',
      query: '界面 boundary',
      max_snippets: 5,
    })
    const value = result.value as unknown as Context7QueryDocsOutput
    const exactCanonicalBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    expect(boundContext7QueryDocsOutput(value, exactCanonicalBytes)).toEqual(value)
    const over = boundContext7QueryDocsOutput(value, exactCanonicalBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeLessThanOrEqual(
      exactCanonicalBytes - 1,
    )
    expect(over.canonical_output_truncated).toBe(true)
    expect(over.warnings).toContainEqual({ code: 'canonical_output_truncated' })
    expect(() => boundContext7QueryDocsOutput(value, 1)).toThrowError(
      expect.objectContaining({ kind: 'budget_exceeded' }),
    )

    const unlimited = { ...value, model_text_max_bytes: 1024 * 1024, model_text_truncated: false }
    let exactTextValue = { ...unlimited }
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const bytes = Buffer.byteLength(renderContext7Text(exactTextValue), 'utf8')
      exactTextValue = { ...exactTextValue, model_text_max_bytes: bytes }
    }
    const exactText = renderContext7Text(exactTextValue)
    const exactTextBytes = Buffer.byteLength(exactText, 'utf8')
    expect(exactTextBytes).toBe(exactTextValue.model_text_max_bytes)
    expect(isContext7ModelTextTruncated(exactTextValue)).toBe(false)
    expect(renderContext7Text(exactTextValue)).toBe(exactText)
    const shortened = {
      ...unlimited,
      model_text_max_bytes: exactTextBytes - 1,
      model_text_truncated: true,
    }
    expect(isContext7ModelTextTruncated(shortened)).toBe(true)
    expect(Buffer.byteLength(renderContext7Text(shortened), 'utf8')).toBeLessThanOrEqual(
      exactTextBytes - 1,
    )
    expect(Buffer.byteLength(renderContext7Text({
      ...shortened,
      model_text_max_bytes: 2,
    }), 'utf8')).toBeLessThanOrEqual(2)
    expect(Buffer.byteLength(renderContext7Text({
      ...shortened,
      model_text_max_bytes: 3,
    }), 'utf8')).toBeLessThanOrEqual(3)
  })

  it('keeps Native and nested Code canonical values identical on cache hits', async () => {
    const test = await fixture()
    const args = {
      library_id: '/reactjs/react.dev',
      query: 'canonical parity',
      max_snippets: 3,
    }
    await successful(test, 'context7_query_docs', args)
    const native = await successful(test, 'context7_query_docs', args)
    const nested = await successful(test, 'context7_query_docs', args, { nested: true })
    expect(nested.value).toEqual(native.value)
    expect(native.meta).toMatchObject({ type: 'context7_query_docs', state: 'found' })
    expect(nested.meta).toBeUndefined()
    const definition = test.runtime.get('context7_query_docs')
    const liveCard = definition?.presentResult?.(args, {
      content: native.content,
      isError: false,
      ...(native.meta === undefined ? {} : { meta: native.meta }),
    })
    const replayCard = definition?.presentResult?.(args, {
      content: native.content,
      isError: false,
      meta: JSON.parse(JSON.stringify(native.meta)),
    })
    expect(replayCard).toEqual(liveCard)
    expect(liveCard).toMatchObject({ card: 'generic', title: expect.stringContaining('Context7') })
  })

  it('honors cancellation, credential rotation, manual redirects, and secret exclusion', async () => {
    const headers: string[] = []
    const rotating = await fixture({
      credentials: ['first-secret', 'second-secret'],
      fetch: vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        headers.push(String((init?.headers as Record<string, string>).Authorization))
        return defaultResponse(String(_input))
      }) as typeof fetch,
    })
    await successful(rotating, 'context7_resolve_library_id', { library_name: 'React' })
    await successful(rotating, 'context7_query_docs', {
      library_id: '/reactjs/react.dev',
      query: 'rotation',
    })
    expect(headers).toEqual(['Bearer first-secret', 'Bearer second-secret'])
    expect(rotating.credentialFixture.resolve).toHaveBeenCalledTimes(2)

    let dispatched = false
    const pending = await fixture({
      fetch: vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        dispatched = true
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }) as typeof fetch,
    })
    const controller = new AbortController()
    const running = execute(pending, 'context7_resolve_library_id', {
      library_name: 'React',
    }, { signal: controller.signal })
    while (!dispatched) await Promise.resolve()
    controller.abort(new DOMException('cancel granular Context7', 'AbortError'))
    const cancelled = await running
    expect(cancelled.isError).toBe(true)
    expect(cancelled).not.toHaveProperty('value')
    expect(serialized(cancelled)).not.toMatch(/first-secret|second-secret/)
  })
})

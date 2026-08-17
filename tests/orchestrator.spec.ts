import { describe, expect, it, vi } from 'vitest'

import {
  Config,
  type Config as SearchEnhanceConfig,
  type OutputBudget,
  type SearchProfile,
} from '../src/config.js'
import type { CanonicalSource, SourceProvider } from '../src/contracts/index.js'
import {
  boundSearchOrchestrationResult,
  SearchOrchestrator,
  shouldEnhanceDocumentation,
  splitDiscoveryBudget,
  type MainSearchProvider,
  type SearchCanonicalResult,
} from '../src/orchestration/index.js'
import {
  ProviderError,
  type ProviderCapability,
} from '../src/provider-runtime/index.js'
import type { SearchApiSearchResult } from '../src/providers/search-api.js'
import { applySourceQuality, parseSearchAnswerText } from '../src/search/index.js'
import {
  createSourceRef,
  paginateSourceRecord,
  parseSourcePageRequest,
  retainSourceRecord,
} from '../src/source-storage/index.js'
import { projectSearchSourcesOutput } from '../src/tools/search-sources.js'
import type {
  BoundedSourceProvider,
  BoundedSourceProviderResult,
  SourceProviderComplete,
  SourceProviderSearchOutcome,
} from '../src/providers/types.js'
import { SDK_QUALITY_FIXTURE } from './fixtures/source-quality.js'

interface ConfigOptions {
  readonly profile?: SearchProfile
  readonly budget?: Partial<OutputBudget>
  readonly extraDiscoverySources?: number
  readonly canonicalOutputMaxBytes?: number
  readonly providerMaxSources?: number
  readonly toolTimeoutMs?: number
  readonly fallbackMode?: SearchEnhanceConfig['fallbackMode']
}

function resolveConfig(options: ConfigOptions = {}): SearchEnhanceConfig {
  const profile = options.profile ?? 'fact_check'
  const base = Config({
    defaultDepth: 'compact',
    defaultProfile: profile,
    retry: {
      baseDelayMs: 0,
      jitterRatio: 0,
      maxAttempts: 1,
      maxDelayMs: 0,
      maxTotalDelayMs: 0,
      multiplier: 1,
    },
    searchApi: { model: 'model-a' },
  } as never)
  return {
    ...base,
    fallbackMode: options.fallbackMode ?? base.fallbackMode,
    toolTimeoutMs: options.toolTimeoutMs ?? base.toolTimeoutMs,
    budgets: {
      ...base.budgets,
      [profile]: {
        ...base.budgets[profile],
        compact: {
          ...base.budgets[profile].compact,
          ...options.budget,
        },
      },
    },
    extraDiscoverySources: {
      ...base.extraDiscoverySources,
      [profile]: options.extraDiscoverySources ?? base.extraDiscoverySources[profile],
    },
    retention: {
      ...base.retention,
      canonicalOutputMaxBytes: options.canonicalOutputMaxBytes ?? 128 * 1024,
      providerMaxSources: options.providerMaxSources ?? base.retention.providerMaxSources,
    },
  }
}

function source(url: string, provider: SourceProvider, title: string = provider): CanonicalSource {
  return Object.freeze({ provider, title, url })
}

function mainResult(
  answer = 'Main answer',
  sources: readonly CanonicalSource[] = [source('https://main.test/a', 'search-api')],
  overrides: Partial<SearchApiSearchResult> = {},
): SearchApiSearchResult {
  return Object.freeze({
    answer,
    attempts: 1,
    endpoint: 'https://search.test/chat/completions',
    model: 'model-a',
    modelValidation: 'unavailable',
    protocol: 'completions',
    sources,
    sourcesTruncated: false,
    totalDelayMs: 0,
    ...overrides,
  })
}

function boundedResult(
  sources: readonly CanonicalSource[] = [],
  truncated = false,
): BoundedSourceProviderResult {
  return Object.freeze({
    responseBytes: 10,
    returnedSnippets: 0,
    returnedSources: sources.length,
    snippets: Object.freeze([]),
    sources: Object.freeze([...sources]),
    totalSnippets: 0,
    totalSources: sources.length + (truncated ? 1 : 0),
    truncated,
  })
}

function complete(
  sources: readonly CanonicalSource[] = [],
  truncated = false,
): SourceProviderComplete {
  return Object.freeze({
    attempts: 1,
    result: boundedResult(sources, truncated),
    state: 'complete',
    totalDelayMs: 0,
  })
}

interface FakeSourceProvider extends BoundedSourceProvider {
  readonly configured: ReturnType<typeof vi.fn<BoundedSourceProvider['configured']>>
  readonly search: ReturnType<typeof vi.fn<BoundedSourceProvider['search']>>
}

function fakeSourceProvider(
  provider: Extract<SourceProvider, 'context7' | 'exa' | 'tavily' | 'firecrawl'>,
  capability: Extract<ProviderCapability, 'docs_search' | 'web_search'>,
  options: {
    readonly configured?: boolean | BoundedSourceProvider['configured']
    readonly search?: SourceProviderSearchOutcome | BoundedSourceProvider['search']
  } = {},
): FakeSourceProvider {
  let configured: BoundedSourceProvider['configured']
  if (typeof options.configured === 'function') configured = options.configured
  else {
    const configuredValue = options.configured ?? false
    configured = async () => configuredValue
  }
  let execute: BoundedSourceProvider['search']
  if (typeof options.search === 'function') execute = options.search
  else {
    const searchValue = options.search ?? complete()
    execute = async () => searchValue
  }
  return {
    capability,
    configured: vi.fn<BoundedSourceProvider['configured']>(configured),
    provider,
    search: vi.fn<BoundedSourceProvider['search']>(execute),
  }
}

interface FixtureOptions {
  readonly config?: SearchEnhanceConfig
  readonly main?: MainSearchProvider['searchResolved']
  readonly context7?: FakeSourceProvider
  readonly exa?: FakeSourceProvider
  readonly tavily?: FakeSourceProvider
  readonly firecrawl?: FakeSourceProvider
}

function fixture(options: FixtureOptions = {}) {
  const config = options.config ?? resolveConfig()
  const main = vi.fn<MainSearchProvider['searchResolved']>(options.main ?? (async () => mainResult()))
  const context7 = options.context7 ?? fakeSourceProvider('context7', 'docs_search')
  const exa = options.exa ?? fakeSourceProvider('exa', 'docs_search')
  const tavily = options.tavily ?? fakeSourceProvider('tavily', 'web_search')
  const firecrawl = options.firecrawl ?? fakeSourceProvider('firecrawl', 'web_search')
  let now = 0
  const getConfig = vi.fn(() => config)
  return {
    config,
    context7,
    exa,
    firecrawl,
    getConfig,
    main,
    orchestrator: new SearchOrchestrator({
      context7,
      exa,
      firecrawl,
      getConfig,
      mainSearch: { searchResolved: main },
      now: () => {
        now += 1
        return now
      },
      tavily,
    }),
    tavily,
  }
}

function input(query = 'ordinary query', signal = new AbortController().signal) {
  return { query, signal }
}

describe('documentation intent and discovery budget policy', () => {
  it.each([
    ['auto', 'ordinary query', true],
    ['coding_docs', 'ordinary query', true],
    ['code_examples', 'ordinary query', true],
    ['project_research', 'ordinary query', true],
    ['academic', 'ordinary query', false],
    ['fact_check', 'ordinary query', false],
    ['academic', 'React SDK migration API', true],
    ['fact_check', 'GitHub README release changelog', true],
  ] as const)('resolves docs intent for %s / %s', (profile, query, expected) => {
    expect(shouldEnhanceDocumentation(profile, query)).toBe(expected)
  })

  it('does not probe or call documentation Providers for a non-triggering fixture', async () => {
    const test = fixture({ config: resolveConfig({ profile: 'academic' }) })

    const result = await test.orchestrator.search(input('compare statistical methods'))

    expect(result.canonical.state).toBe('complete')
    expect(test.context7.configured).not.toHaveBeenCalled()
    expect(test.context7.search).not.toHaveBeenCalled()
    expect(test.exa.configured).not.toHaveBeenCalled()
    expect(test.exa.search).not.toHaveBeenCalled()
  })

  it('does not probe docs when fallback is disabled', async () => {
    const config = resolveConfig({ fallbackMode: 'off', profile: 'coding_docs' })
    const context7 = fakeSourceProvider('context7', 'docs_search', { configured: true })
    const exa = fakeSourceProvider('exa', 'docs_search', { configured: true })
    const test = fixture({ config, context7, exa })

    await test.orchestrator.search(input('React API'))

    expect(context7.configured).not.toHaveBeenCalled()
    expect(exa.configured).not.toHaveBeenCalled()
    expect(context7.search).not.toHaveBeenCalled()
    expect(exa.search).not.toHaveBeenCalled()
  })

  it('keeps Provider collection and persistence independent from zero visible sources', async () => {
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: complete([source('https://docs.test/hidden', 'context7')]),
    })
    const test = fixture({
      config: resolveConfig({
        budget: { maxVisibleSources: 0 },
        profile: 'coding_docs',
        providerMaxSources: 7,
      }),
      context7,
      main: async () => mainResult('answer', [
        source('https://main.test/hidden-a', 'search-api'),
        source('https://main.test/hidden-b', 'search-api'),
      ]),
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(context7.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }))
    expect(result.canonical).toMatchObject({
      returnedSources: 0,
      sources: [],
      totalSources: 3,
    })
    expect(result.canonical).not.toHaveProperty('attempts')
    expect(result.canonical).not.toHaveProperty('routing')
    expect(result.persistence.sources.map(item => item.url)).toEqual([
      'https://main.test/hidden-a',
      'https://main.test/hidden-b',
      'https://docs.test/hidden',
    ])
    expect(result.diagnostics.attempts.length).toBeGreaterThan(0)
  })

  it('preserves answer-cited sources in the persistence candidate at the Provider cap', async () => {
    const parsed = parseSearchAnswerText(`Use the [official URL API reference](https://developer.mozilla.org/en-US/docs/Web/API/URL).

Sources:
- [One](https://one.test)
- [Two](https://two.test)`, { maxSources: 2 })
    const test = fixture({
      config: resolveConfig({ extraDiscoverySources: 0, providerMaxSources: 2 }),
      main: async () => mainResult(parsed.answer, parsed.sources, {
        sourcesTruncated: parsed.sourcesTruncated,
      }),
    })

    const result = await test.orchestrator.search(input('verify URL behavior'))

    expect(result.persistence.collectionTruncated).toBe(true)
    expect(result.persistence.sources.map(item => item.url)).toEqual([
      'https://developer.mozilla.org/en-US/docs/Web/API/URL',
      'https://one.test/',
    ])
  })

  it('runs Context7 first in merge order and supplements with configured Exa', async () => {
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: complete([source('https://docs.test/context7', 'context7')]),
    })
    const exa = fakeSourceProvider('exa', 'docs_search', {
      configured: true,
      search: complete([source('https://docs.test/exa', 'exa')]),
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
      exa,
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical.sources.map(item => item.provider)).toEqual(['search-api', 'context7', 'exa'])
    expect(result.persistence.sources.map(item => item.provider)).toEqual(['search-api', 'context7', 'exa'])
    expect(context7.search).toHaveBeenCalledTimes(1)
    expect(exa.search).toHaveBeenCalledTimes(1)
  })

  it.each([
    [0, true, true, { firecrawl: 0, tavily: 0 }],
    [1, true, true, { firecrawl: 0, tavily: 1 }],
    [2, true, true, { firecrawl: 0, tavily: 2 }],
    [4, true, true, { firecrawl: 1, tavily: 3 }],
    [5, true, true, { firecrawl: 2, tavily: 3 }],
    [5, true, false, { firecrawl: 0, tavily: 5 }],
    [5, false, true, { firecrawl: 5, tavily: 0 }],
    [5, false, false, { firecrawl: 0, tavily: 0 }],
  ] as const)('splits shared budget %i without amplification', (total, hasTavily, hasFirecrawl, expected) => {
    const allocation = splitDiscoveryBudget(total, hasTavily, hasFirecrawl)
    expect(allocation).toEqual(expected)
    expect(allocation.tavily + allocation.firecrawl).toBeLessThanOrEqual(total)
  })

  it('does not probe discovery Providers at budget zero', async () => {
    const test = fixture({ config: resolveConfig({ extraDiscoverySources: 0 }) })
    await test.orchestrator.search(input())
    expect(test.tavily.configured).not.toHaveBeenCalled()
    expect(test.firecrawl.configured).not.toHaveBeenCalled()
    expect(test.tavily.search).not.toHaveBeenCalled()
    expect(test.firecrawl.search).not.toHaveBeenCalled()
  })

  it('assigns the whole budget only to the available discovery Provider', async () => {
    const tavily = fakeSourceProvider('tavily', 'web_search', { configured: false })
    const firecrawl = fakeSourceProvider('firecrawl', 'web_search', {
      configured: true,
      search: complete([source('https://firecrawl.test/result', 'firecrawl')]),
    })
    const test = fixture({
      config: resolveConfig({ extraDiscoverySources: 5 }),
      firecrawl,
      tavily,
    })

    const result = await test.orchestrator.search(input())

    expect(result.diagnostics.routing.discoveryAllocation).toEqual({ firecrawl: 5, tavily: 0 })
    expect(tavily.search).not.toHaveBeenCalled()
    expect(firecrawl.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }))
  })

  it('passes dual-Provider allocations whose total never exceeds the profile budget', async () => {
    const tavily = fakeSourceProvider('tavily', 'web_search', { configured: true })
    const firecrawl = fakeSourceProvider('firecrawl', 'web_search', { configured: true })
    const test = fixture({
      config: resolveConfig({ extraDiscoverySources: 5 }),
      firecrawl,
      tavily,
    })

    const result = await test.orchestrator.search(input())

    const tavilyLimit = tavily.search.mock.calls[0]?.[0].limit ?? 0
    const firecrawlLimit = firecrawl.search.mock.calls[0]?.[0].limit ?? 0
    expect([tavilyLimit, firecrawlLimit]).toEqual([3, 2])
    expect(tavilyLimit + firecrawlLimit).toBe(5)
    expect(result.diagnostics.routing.discoveryAllocation).toEqual({ firecrawl: 2, tavily: 3 })
  })
})

describe('orchestrator settlement, partial success, and diagnostics', () => {
  it('trims the query and rejects empty or over-limit Unicode input before dispatch', async () => {
    const base = resolveConfig()
    const config = {
      ...base,
      retention: { ...base.retention, searchQueryMaxCharacters: 2 },
    }
    const exact = fixture({ config })
    await expect(exact.orchestrator.search(input('  界面  '))).resolves.toMatchObject({
      persistence: { query: '界面' },
    })
    expect(exact.main).toHaveBeenCalledTimes(1)

    const empty = fixture({ config })
    await expect(empty.orchestrator.search(input('   '))).rejects.toMatchObject({
      kind: 'invalid_request',
    })
    expect(empty.main).not.toHaveBeenCalled()

    const over = fixture({ config })
    await expect(over.orchestrator.search(input('界面中'))).rejects.toMatchObject({
      kind: 'invalid_request',
    })
    expect(over.main).not.toHaveBeenCalled()
  })

  it('resolves Config once and starts every decided path with the same snapshot', async () => {
    const context7 = fakeSourceProvider('context7', 'docs_search', { configured: true })
    const exa = fakeSourceProvider('exa', 'docs_search', { configured: true })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
      exa,
    })

    await test.orchestrator.search(input('React API'))

    expect(test.getConfig).toHaveBeenCalledTimes(1)
    expect(test.main.mock.calls[0]?.[0].config).toBe(test.config)
    expect(context7.search.mock.calls[0]?.[0].config).toBe(test.config)
    expect(exa.search.mock.calls[0]?.[0].config).toBe(test.config)
    expect(test.main.mock.calls[0]?.[0].strategy.profile).toBe('coding_docs')
  })

  it('keeps main success complete when optional Providers are absent', async () => {
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: complete(),
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical).toMatchObject({ state: 'complete', warnings: [] })
    expect(result.diagnostics.attempts.find(item => item.provider === 'exa')).toMatchObject({
      outcome: 'skipped',
      skipReason: 'not_configured',
    })
  })

  it('keeps the main answer and records a safe warning when a started Provider fails', async () => {
    const secretError = new Error('header Authorization: Bearer should-not-leak')
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: async () => { throw secretError },
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical.state).toBe('complete')
    expect(result.canonical.answer).toBe('Main answer')
    expect(result.canonical.warnings).toContainEqual({
      capability: 'docs_search',
      code: 'provider_failed',
      errorKind: 'unknown',
      provider: 'context7',
    })
    expect(result.diagnostics.attempts.find(item => item.provider === 'context7')).toMatchObject({
      errorKind: 'unknown',
      outcome: 'failed',
    })
    expect(JSON.stringify(result)).not.toContain('should-not-leak')
  })

  it('projects fixed cache diagnostics from a completed documentation Provider', async () => {
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: {
        ...complete([source('https://docs.test/cached', 'context7')]),
        warnings: [
          { code: 'cache_stale', errorKind: 'timeout', provider: 'context7-cache' },
          { code: 'cache_evicted', provider: 'context7-cache' },
        ],
      },
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical.warnings).toEqual([
      {
        capability: 'docs_search',
        code: 'cache_stale',
        errorKind: 'timeout',
        provider: 'context7-cache',
      },
      {
        capability: 'docs_search',
        code: 'cache_evicted',
        provider: 'context7-cache',
      },
    ])
  })

  it('returns explicit partial state only when main fails and supplemental sources exist', async () => {
    const mainError = new ProviderError({
      capability: 'main_search',
      kind: 'network',
      provider: 'search-api',
    })
    const exa = fakeSourceProvider('exa', 'docs_search', {
      configured: true,
      search: complete([source('https://docs.test/exa', 'exa')]),
    })
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: async () => {
        throw new ProviderError({ capability: 'docs_search', kind: 'http', provider: 'context7' })
      },
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
      exa,
      main: async () => { throw mainError },
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical).toMatchObject({
      answer: '主搜索失败，仅返回补充来源。',
      state: 'partial',
      sources: [{ provider: 'exa', url: 'https://docs.test/exa' }],
    })
    expect(result.diagnostics.attempts.find(item => item.provider === 'exa')).toMatchObject({
      outcome: 'success',
      participatedInFallback: true,
    })
    expect(result.canonical.warnings.map(item => item.code)).toEqual([
      'main_search_failed',
      'provider_failed',
    ])
  })

  it('keeps partial success when the visible-source cap is zero but persistence has evidence', async () => {
    const exa = fakeSourceProvider('exa', 'docs_search', {
      configured: true,
      search: complete([source('https://docs.test/persisted-only', 'exa')]),
    })
    const test = fixture({
      config: resolveConfig({
        budget: { maxVisibleSources: 0 },
        profile: 'coding_docs',
      }),
      exa,
      main: async () => {
        throw new ProviderError({
          capability: 'main_search',
          kind: 'network',
          provider: 'search-api',
        })
      },
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical).toMatchObject({
      answer: '主搜索失败，仅返回补充来源。',
      returnedSources: 0,
      sources: [],
      state: 'partial',
      totalSources: 1,
    })
    expect(result.persistence.sources).toEqual([
      source('https://docs.test/persisted-only', 'exa'),
    ])
  })

  it('throws the main infrastructure failure when no supplemental source succeeds', async () => {
    const mainError = new ProviderError({
      capability: 'main_search',
      kind: 'network',
      provider: 'search-api',
    })
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: async () => {
        throw new ProviderError({ capability: 'docs_search', kind: 'network', provider: 'context7' })
      },
    })
    const exa = fakeSourceProvider('exa', 'docs_search', {
      configured: true,
      search: async () => {
        throw new ProviderError({ capability: 'docs_search', kind: 'http', provider: 'exa' })
      },
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
      exa,
      main: async () => { throw mainError },
    })

    await expect(test.orchestrator.search(input('React API'))).rejects.toBe(mainError)
    expect(context7.search).toHaveBeenCalledTimes(1)
    expect(exa.search).toHaveBeenCalledTimes(1)
  })

  it('treats genuine main and optional empty results as complete, not failed', async () => {
    const test = fixture({
      main: async () => mainResult('', []),
    })

    const result = await test.orchestrator.search(input())

    expect(result.canonical).toMatchObject({
      returnedSources: 0,
      sources: [],
      state: 'complete',
      totalSources: 0,
      warnings: [{ code: 'no_results' }],
    })
    expect(result.diagnostics.attempts[0]).toMatchObject({ outcome: 'success' })
  })

  it('waits for every started task after main search has already settled', async () => {
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const pendingProvider = new Promise<SourceProviderSearchOutcome>((resolve) => {
      release = () => resolve(complete())
    })
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: async () => {
        markStarted()
        return pendingProvider
      },
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
    })
    let settled = false

    const pending = test.orchestrator.search(input('React API')).finally(() => { settled = true })
    await started
    await Promise.resolve()
    expect(settled).toBe(false)
    release()

    await expect(pending).resolves.toMatchObject({
      canonical: { state: 'complete' },
    })
    expect(settled).toBe(true)
  })

  it('aborts all running paths immediately and never falls back on caller cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel whole search')
    let startedCount = 0
    let abortedCount = 0
    let markBothStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve })
    const waitForAbort = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
      startedCount += 1
      if (startedCount === 2) markBothStarted()
      signal.addEventListener('abort', () => {
        abortedCount += 1
        reject(signal.reason)
      }, { once: true })
    })
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: input => waitForAbort(input.signal),
    })
    const test = fixture({
      config: resolveConfig({ profile: 'coding_docs' }),
      context7,
      main: input => waitForAbort(input.signal),
    })

    const pending = test.orchestrator.search(input('React API', controller.signal))
    await bothStarted
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(abortedCount).toBe(2)
  })

  it('turns the total tool deadline into failure after aborting all running work', async () => {
    let aborted = false
    const test = fixture({
      config: resolveConfig({ toolTimeoutMs: 5 }),
      main: input => new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          aborted = true
          reject(input.signal.reason)
        }, { once: true })
      }),
    })

    await expect(test.orchestrator.search(input())).rejects.toMatchObject({
      kind: 'timeout',
      provider: 'search-orchestrator',
    })
    expect(aborted).toBe(true)
  })
})

describe('source order, exact deduplication, and independent output limits', () => {
  it('orders Search API, Context7/Exa, then Tavily/Firecrawl with exact URL dedupe only', async () => {
    const duplicate = 'https://same.test/path?x=1'
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: complete([
        source(duplicate, 'context7'),
        source('https://context7.test/only', 'context7'),
      ]),
    })
    const exa = fakeSourceProvider('exa', 'docs_search', {
      configured: true,
      search: complete([source('https://exa.test/only', 'exa')]),
    })
    const tavily = fakeSourceProvider('tavily', 'web_search', {
      configured: true,
      search: complete([
        source('https://context7.test/only', 'tavily'),
        source('https://same.test/path?x=2', 'tavily'),
      ]),
    })
    const firecrawl = fakeSourceProvider('firecrawl', 'web_search', {
      configured: true,
      search: complete([source('https://firecrawl.test/only', 'firecrawl')]),
    })
    const test = fixture({
      config: resolveConfig({
        budget: { maxVisibleSources: 10 },
        extraDiscoverySources: 4,
        profile: 'coding_docs',
      }),
      context7,
      exa,
      firecrawl,
      main: async () => mainResult('answer', [
        source('https://main.test/only', 'search-api'),
        source(duplicate, 'search-api'),
      ]),
      tavily,
    })

    const result = await test.orchestrator.search(input('React API'))

    expect(result.canonical.sources.map(item => item.url)).toEqual([
      'https://main.test/only',
      duplicate,
      'https://context7.test/only',
      'https://exa.test/only',
      'https://same.test/path?x=2',
      'https://firecrawl.test/only',
    ])
  })

  it('applies one quality result to visible and persistent sources without changing answer or diagnostics', async () => {
    const providerSources = (provider: SourceProvider): readonly CanonicalSource[] => (
      SDK_QUALITY_FIXTURE.sources.filter(item => item.provider === provider)
    )
    const context7 = fakeSourceProvider('context7', 'docs_search', {
      configured: true,
      search: complete(providerSources('context7')),
    })
    const exa = fakeSourceProvider('exa', 'docs_search', {
      configured: true,
      search: complete(providerSources('exa')),
    })
    const tavily = fakeSourceProvider('tavily', 'web_search', {
      configured: true,
      search: complete(providerSources('tavily')),
    })
    const firecrawl = fakeSourceProvider('firecrawl', 'web_search', {
      configured: true,
      search: complete(providerSources('firecrawl')),
    })
    const test = fixture({
      config: resolveConfig({
        budget: { maxVisibleSources: 10 },
        extraDiscoverySources: 4,
        profile: 'coding_docs',
      }),
      context7,
      exa,
      firecrawl,
      main: async () => mainResult('Version-specific answer', providerSources('search-api')),
      tavily,
    })

    const result = await test.orchestrator.search(input(SDK_QUALITY_FIXTURE.query))
    const expectedUrls = [
      'https://docs.acme.example/sdk/v4.2/api?a=1&b=2',
      'https://github.com/acme/sdk/releases/tag/v4.2.0',
      'https://github.com/acme/sdk/blob/v4.2.0/CHANGELOG.md',
      'https://community.example/acme/sdk/v4.2/notes',
      'https://docs.acme.example/sdk/v3/api?lang=en',
      'https://community.example/acme/sdk/v3.8/migration',
    ]

    expect(result.canonical).toMatchObject({
      answer: 'Version-specific answer',
      evidenceLevel: 'discovery',
      state: 'complete',
      totalSources: 6,
      warnings: [],
    })
    expect(result.canonical.sources.map(item => item.url)).toEqual(expectedUrls)
    expect(result.persistence.sources.map(item => item.url)).toEqual(expectedUrls)
    expect(result.canonical.sources.every((item, index) => (
      item === result.persistence.sources[index]
    ))).toBe(true)
    expect(result.diagnostics.attempts.map(item => [item.provider, item.outcome])).toEqual([
      ['search-api', 'success'],
      ['context7', 'success'],
      ['exa', 'success'],
      ['tavily', 'success'],
      ['firecrawl', 'success'],
    ])
    expect(result.diagnostics).not.toHaveProperty('quality')
  })

  it('preserves low-ranked bounded-answer citations through visibility, retention, and search_sources', async () => {
    const rawCitedUrls = [
      'https://api-docs.deepseek.com/quick_start/pricing/',
      'https://opencode.ai/docs/go#install',
      'https://x.com/opencode/status/123456',
    ] as const
    const expectedCitedUrls = [
      'https://api-docs.deepseek.com/quick_start/pricing',
      'https://opencode.ai/docs/go',
      'https://x.com/opencode/status/123456',
    ]
    const answer = [
      `See [DeepSeek pricing](${rawCitedUrls[0]}).`,
      `Compare [OpenCode Go documentation](${rawCitedUrls[1]}).`,
      `Check [the release announcement](${rawCitedUrls[2]}).`,
    ].join(' ')
    const trailingSources = Array.from(
      { length: 100 },
      (_value, index) => `- [Release ${index}](https://github.com/acme/repository-${index}/releases/tag/v1.0.0)`,
    ).join('\n')
    const parsed = parseSearchAnswerText(`${answer}\n\nSources:\n${trailingSources}`, {
      maxSources: 100,
    })
    const supplementalSources = Array.from({ length: 9 }, (_value, index) => Object.freeze({
      category: 'official' as const,
      provider: 'tavily' as const,
      title: `Official supplemental ${index}`,
      url: `https://official.example.test/${index}`,
    }))
    const tavily = fakeSourceProvider('tavily', 'web_search', {
      configured: true,
      search: complete(supplementalSources),
    })
    const config = resolveConfig({
      budget: {
        maxAnswerCharacters: Array.from(answer).length,
        maxVisibleSources: 10,
      },
      extraDiscoverySources: 9,
    })
    const query = 'current external pricing evidence'
    const test = fixture({
      config,
      main: async () => mainResult(parsed.answer, parsed.sources, {
        sourcesTruncated: parsed.sourcesTruncated,
      }),
      tavily,
    })

    expect(parsed.sources).toHaveLength(100)
    expect(parsed.sourcesTruncated).toBe(true)
    const qualityOnly = applySourceQuality(query, [...parsed.sources, ...supplementalSources])
    expect(expectedCitedUrls.map(url => qualityOnly.findIndex(source => source.url === url))).toEqual([
      106,
      107,
      108,
    ])

    const result = await test.orchestrator.search(input(query))
    const sourceRef = createSourceRef(size => new Uint8Array(size).fill(7))
    const stored = retainSourceRecord({
      call: {
        callId: 'citation-chain-call',
        mode: 'top-level',
        name: 'web_search',
        rootCallId: 'citation-chain-call',
      },
      candidate: result.persistence,
      ownerSessionId: 'citation-chain-session',
      sourceRef,
    }, { maxBytes: 512 * 1024, maxSources: 100 })
    const firstPage = projectSearchSourcesOutput(paginateSourceRecord(
      stored,
      parseSourcePageRequest({
        format: 'compact',
        limit: 20,
        offset: 0,
        source_ref: sourceRef,
      }, 100),
      { maxPageBytes: 128 * 1024, maxSnippetCharacters: 4000 },
    ))
    if (firstPage.state !== 'found') throw new Error('expected retained source page')

    expect(result.canonical.sources).toHaveLength(10)
    expect(result.persistence.sources).toHaveLength(109)
    expect(stored).toMatchObject({
      collectionTruncated: true,
      totalBeforeRetention: 109,
      truncated: true,
    })
    expect(stored.sources).toHaveLength(100)
    expect(firstPage).toMatchObject({
      offset: 0,
      returned: 20,
      total: 100,
      total_before_retention: 109,
      truncated: true,
    })
    for (const sources of [
      result.canonical.sources,
      result.persistence.sources,
      stored.sources,
      firstPage.sources,
    ]) {
      expect(sources.slice(0, expectedCitedUrls.length).map(source => source.url))
        .toEqual(expectedCitedUrls)
    }
  })

  it('matches citation URL variants once and does not duplicate a trailing source record', async () => {
    const parsed = parseSearchAnswerText(`Use the [Canonical documentation page](https://EXAMPLE.test:443/path/#overview).

Sources:
- [Canonical documentation page](https://example.test/path/)
- [Other page](https://other.example.test/page)`)
    const test = fixture({
      config: resolveConfig({ budget: { maxVisibleSources: 10 }, extraDiscoverySources: 0 }),
      main: async () => mainResult(parsed.answer, parsed.sources),
    })

    expect(parsed.sources).toHaveLength(3)
    const result = await test.orchestrator.search(input('compare canonical documentation'))

    expect(result.persistence.sources.map(source => source.url)).toEqual([
      'https://example.test/path',
      'https://other.example.test/page',
    ])
    expect(result.canonical.sources).toEqual(result.persistence.sources)
    expect(result.canonical.totalSources).toBe(2)
  })

  it('uses the exact bounded answer for citation priority and ignores a truncated citation', async () => {
    const visibleAnswer = 'Read [the visible citation](https://cited.example.test/visible).'
    const fullAnswer = `${visibleAnswer} Then read [the hidden citation](https://cited.example.test/hidden).`
    const sources = [
      source('https://cited.example.test/visible', 'search-api', 'Visible citation'),
      source('https://cited.example.test/hidden', 'search-api', 'Hidden citation'),
      source('https://github.com/acme/sdk/releases/tag/v1.0.0', 'search-api', 'High quality release'),
    ]
    const config = resolveConfig({
      budget: {
        maxAnswerCharacters: Array.from(visibleAnswer).length,
        maxVisibleSources: 3,
      },
      extraDiscoverySources: 0,
    })
    const exactTest = fixture({
      config,
      main: async () => mainResult(visibleAnswer, sources),
    })
    const truncatedTest = fixture({
      config,
      main: async () => mainResult(fullAnswer, sources),
    })

    const exact = await exactTest.orchestrator.search(input('release evidence'))
    expect(exact.canonical.answer).toBe(visibleAnswer)
    expect(exact.canonical.warnings.map(warning => warning.code)).not.toContain('answer_truncated')

    const truncated = await truncatedTest.orchestrator.search(input('release evidence'))
    expect(truncated.canonical).toMatchObject({
      answer: visibleAnswer,
      returnedAnswerCharacters: Array.from(visibleAnswer).length,
      totalAnswerCharacters: Array.from(fullAnswer).length,
    })
    expect(truncated.canonical.warnings.map(warning => warning.code)).toContain('answer_truncated')
    expect(truncated.persistence.sources.map(source => source.url)).toEqual([
      'https://cited.example.test/visible',
      'https://github.com/acme/sdk/releases/tag/v1.0.0',
      'https://cited.example.test/hidden',
    ])
  })

  it('applies answer code-point and visible-source limits independently at tiny/exact/over boundaries', async () => {
    const test = fixture({
      config: resolveConfig({ budget: { maxAnswerCharacters: 2, maxVisibleSources: 1 } }),
      main: async () => mainResult('界🙂X', [
        source('https://main.test/one', 'search-api'),
        source('https://main.test/two', 'search-api'),
      ]),
    })

    const result = await test.orchestrator.search(input())

    expect(result.canonical).toMatchObject({
      answer: '界🙂',
      returnedAnswerCharacters: 2,
      returnedSources: 1,
      totalAnswerCharacters: 3,
      totalSources: 2,
      truncated: true,
    })
    expect(result.canonical.warnings.map(item => item.code)).toEqual(['answer_truncated', 'sources_truncated'])
  })

  it('keeps the merged persistence candidate unchanged by canonical byte truncation', async () => {
    const sources = [
      source('https://main.test/persist-1', 'search-api'),
      source('https://main.test/persist-2', 'search-api'),
      source('https://main.test/persist-3', 'search-api'),
    ]
    const fullTest = fixture({
      config: resolveConfig({ budget: { maxVisibleSources: 3 } }),
      main: async () => mainResult('canonical answer', sources),
    })
    const full = await fullTest.orchestrator.search(input())
    const exactBytes = Buffer.byteLength(JSON.stringify(full.canonical), 'utf8')
    const boundedTest = fixture({
      config: resolveConfig({
        budget: { maxVisibleSources: 3 },
        canonicalOutputMaxBytes: exactBytes - 1,
      }),
      main: async () => mainResult('canonical answer', sources),
    })

    const bounded = await boundedTest.orchestrator.search(input())

    expect(bounded.persistence.sources).toEqual(sources)
    expect(bounded.canonical.truncated).toBe(true)
    expect(bounded.canonical.warnings.map(item => item.code)).toContain('canonical_output_truncated')
    expect(Buffer.byteLength(JSON.stringify(bounded.canonical), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(JSON.stringify(bounded.canonical)).not.toContain('attempts')
    expect(JSON.stringify(bounded.canonical)).not.toContain('routing')
  })

  it('accepts an exact canonical byte envelope and truncates an over-limit candidate', () => {
    const candidate: SearchCanonicalResult = {
      answer: '界🙂 answer',
      evidenceLevel: 'discovery',
      returnedAnswerCharacters: 9,
      returnedSources: 1,
      sources: [source('https://example.test/source', 'search-api')],
      state: 'complete',
      totalAnswerCharacters: 9,
      totalSources: 1,
      truncated: false,
      warnings: [],
    }
    const exactBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')

    const exact = boundSearchOrchestrationResult(candidate, exactBytes)
    expect(exact).toEqual(candidate)

    const over = boundSearchOrchestrationResult(candidate, exactBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(over.truncated).toBe(true)
    expect(over.warnings.map(item => item.code)).toContain('canonical_output_truncated')
  })

  it('fails a tiny canonical budget that cannot represent the fixed envelope', () => {
    const candidate: SearchCanonicalResult = {
      evidenceLevel: 'discovery',
      returnedAnswerCharacters: 0,
      returnedSources: 0,
      sources: [],
      state: 'complete',
      totalAnswerCharacters: 0,
      totalSources: 0,
      truncated: false,
      warnings: [],
    }

    expect(() => boundSearchOrchestrationResult(candidate, 1)).toThrowError(ProviderError)
    try {
      boundSearchOrchestrationResult(candidate, 1)
    } catch (error) {
      expect(error).toMatchObject({ kind: 'budget_exceeded' })
    }
  })
})

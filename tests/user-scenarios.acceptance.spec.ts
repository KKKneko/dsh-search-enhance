import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import {
  Config,
  type Config as SearchEnhanceConfig,
} from '../src/config.js'
import type { CanonicalSource } from '../src/contracts/index.js'
import {
  SearchOrchestrator,
  type MainSearchProvider,
} from '../src/orchestration/index.js'
import { renderWebSearchText } from '../src/presentation/render.js'
import type { SearchApiResolvedSearchInput, SearchApiSearchResult } from '../src/providers/search-api.js'
import type {
  BoundedSourceProvider,
  SourceProviderSearchInput,
  SourceProviderSearchOutcome,
} from '../src/providers/types.js'
import { resolveSearchStrategy } from '../src/search/index.js'
import { projectWebSearchOutput } from '../src/tools/web-search.js'
import {
  ACCEPTANCE_SEARCH_PROVIDERS,
  FINANCIAL_FACT_CHECK_ACCEPTANCE,
  SDK_VERSIONED_DOCS_ACCEPTANCE,
  type AcceptanceSearchProvider,
  type UserScenarioAcceptanceFixture,
} from './fixtures/user-scenarios.js'

const NUMERIC_EVIDENCE_POLICY = 'If a key numeric claim lacks sufficient independent support, label that number `unverified` or `unresolved`.'

type SupplementalProvider = Exclude<AcceptanceSearchProvider, 'search-api'>

interface TrackedSourceProvider extends BoundedSourceProvider {
  readonly configured: ReturnType<typeof vi.fn<BoundedSourceProvider['configured']>>
  readonly search: ReturnType<typeof vi.fn<BoundedSourceProvider['search']>>
}

interface ExecutedScenario {
  readonly config: SearchEnhanceConfig
  readonly mainSearch: ReturnType<typeof vi.fn<MainSearchProvider['searchResolved']>>
  readonly modelText: string
  readonly output: ReturnType<typeof projectWebSearchOutput>
  readonly providers: Readonly<Record<SupplementalProvider, TrackedSourceProvider>>
}

function completeSources(
  sources: readonly CanonicalSource[],
): SourceProviderSearchOutcome {
  return Object.freeze({
    attempts: 1,
    result: Object.freeze({
      responseBytes: Buffer.byteLength(JSON.stringify(sources), 'utf8'),
      returnedSnippets: 0,
      returnedSources: sources.length,
      snippets: Object.freeze([]),
      sources: Object.freeze([...sources]),
      totalSnippets: 0,
      totalSources: sources.length,
      truncated: false,
    }),
    state: 'complete',
    totalDelayMs: 0,
  })
}

function trackedProvider(
  provider: SupplementalProvider,
  sources: readonly CanonicalSource[],
): TrackedSourceProvider {
  const capability = provider === 'exa' ? 'docs_search' : 'web_search'
  const configured = vi.fn<BoundedSourceProvider['configured']>(async () => true)
  const search = vi.fn<BoundedSourceProvider['search']>(async (
    input: SourceProviderSearchInput,
  ) => {
    input.onDispatch?.()
    return completeSources(sources)
  })
  return { capability, configured, provider, search }
}

function scenarioConfig(
  fixture: Readonly<UserScenarioAcceptanceFixture>,
): SearchEnhanceConfig {
  const base = Config({
    defaultDepth: 'compact',
    defaultProfile: fixture.profile,
    fallbackMode: 'auto',
    searchApi: { model: 'acceptance-model' },
    retry: {
      maxAttempts: 1,
      baseDelayMs: 0,
      multiplier: 1,
      maxDelayMs: 0,
      maxTotalDelayMs: 0,
      jitterRatio: 0,
    },
  } as never)
  return {
    ...base,
    toolTimeoutMs: 10_000,
    budgets: {
      ...base.budgets,
      [fixture.profile]: {
        ...base.budgets[fixture.profile],
        compact: {
          maxAnswerCharacters: 600,
          maxVisibleSources: 12,
          maxModelTextBytes: 16 * 1024,
        },
      },
    },
    extraDiscoverySources: {
      ...base.extraDiscoverySources,
      [fixture.profile]: 4,
    },
    retention: {
      ...base.retention,
      canonicalOutputMaxBytes: 128 * 1024,
      providerMaxSources: 12,
    },
  }
}

async function executeScenario(
  fixture: Readonly<UserScenarioAcceptanceFixture>,
): Promise<ExecutedScenario> {
  const config = scenarioConfig(fixture)
  const providers = {
    exa: trackedProvider('exa', fixture.sources.exa),
    tavily: trackedProvider('tavily', fixture.sources.tavily),
    firecrawl: trackedProvider('firecrawl', fixture.sources.firecrawl),
  }
  const mainSearch = vi.fn<MainSearchProvider['searchResolved']>(async (
    input: SearchApiResolvedSearchInput,
  ): Promise<SearchApiSearchResult> => {
    input.onDispatch?.()
    return Object.freeze({
      answer: fixture.answer,
      attempts: 1,
      endpoint: 'https://search.acceptance.test/chat/completions',
      model: 'acceptance-model',
      modelValidation: 'validated',
      protocol: 'completions',
      sources: fixture.sources['search-api'],
      sourcesTruncated: false,
      totalDelayMs: 0,
    })
  })
  let tick = 0
  const orchestrator = new SearchOrchestrator({
    exa: providers.exa,
    firecrawl: providers.firecrawl,
    getConfig: () => config,
    mainSearch: { searchResolved: mainSearch },
    now: () => {
      tick += 1
      return tick
    },
    tavily: providers.tavily,
  })
  const result = await orchestrator.search({
    depth: 'compact',
    profile: fixture.profile,
    query: fixture.query,
    signal: new AbortController().signal,
  })
  const output = projectWebSearchOutput(result, config)
  const modelText = renderWebSearchText(output)
  return { config, mainSearch, modelText, output, providers }
}

function expectExactlyOneBoundedSearch(executed: ExecutedScenario): void {
  const dispatchCounts = [
    executed.mainSearch.mock.calls.length,
    ...Object.values(executed.providers).map(provider => provider.search.mock.calls.length),
  ]
  expect(dispatchCounts).toEqual(ACCEPTANCE_SEARCH_PROVIDERS.map(() => 1))
  expect(dispatchCounts.reduce((total, count) => total + count, 0)).toBe(4)
  for (const provider of Object.values(executed.providers)) {
    expect(provider.configured).toHaveBeenCalledTimes(1)
  }
  const mainInput = executed.mainSearch.mock.calls[0]?.[0]
  expect(mainInput).toBeDefined()
  if (mainInput === undefined) throw new Error('acceptance main search was not dispatched')
  expect(Array.from(executed.output.answer ?? '').length).toBeLessThanOrEqual(
    executed.config.budgets[mainInput.strategy.profile][mainInput.strategy.depth]
      .maxAnswerCharacters,
  )
  expect(Buffer.byteLength(executed.modelText, 'utf8')).toBeLessThanOrEqual(
    executed.output.model_text_max_bytes,
  )
}

function expectExecutableDiscoveryRecord(
  source: ExecutedScenario['output']['sources'][number],
): void {
  const parsed = new URL(source.url)
  expect(['http:', 'https:']).toContain(parsed.protocol)
  expect(parsed.username).toBe('')
  expect(parsed.password).toBe('')
  expect(source.snippet?.trim().length).toBeGreaterThan(0)
  expect(source.publishedAt?.trim().length).toBeGreaterThan(0)
}

describe('fixed user-scenario acceptance gate', () => {
  it('returns one bounded financial fact-check with ranked, de-duplicated, conflicting discovery evidence', async () => {
    const strategy = resolveSearchStrategy(scenarioConfig(FINANCIAL_FACT_CHECK_ACCEPTANCE), {
      depth: 'compact',
      profile: 'fact_check',
    })
    expect(strategy.profilePrompt).toContain(NUMERIC_EVIDENCE_POLICY)

    const executed = await executeScenario(FINANCIAL_FACT_CHECK_ACCEPTANCE)
    expectExactlyOneBoundedSearch(executed)

    expect(executed.output.state).toBe('complete')
    expect(executed.output.answer).toContain('42.7% margin is unverified')
    expect(executed.output.answer).toContain('Verdict: unresolved')
    expect(executed.modelText).toContain('42.7% margin is unverified')
    expect(executed.modelText).toContain('Top sources')
    expect(executed.modelText).toContain('Snippet:')
    expect(executed.modelText).toContain('Date:')

    const urls = executed.output.sources.map(source => source.url)
    expect(urls).toEqual([
      'https://investor.alpha.example/releases/q1?lang=en',
      'https://wire.example/reports/alpha-results?edition=global',
      'https://wire.example/reports/alpha-preview?edition=global',
      'https://analyst.example/alpha-results-counterpoint',
      'https://regional.example/zh/alpha-quarterly-results',
      'https://agg.example/markets/alpha-results?lang=zh',
    ])
    expect(urls.filter(url => url.includes('/releases/q1'))).toHaveLength(1)
    expect(urls.some(url => /(?:utm_|gclid|fbclid)/u.test(url))).toBe(false)
    expect(urls.indexOf('https://investor.alpha.example/releases/q1?lang=en')).toBeLessThan(
      urls.indexOf('https://agg.example/markets/alpha-results?lang=zh'),
    )
    expect(urls.indexOf('https://wire.example/reports/alpha-results?edition=global')).toBeLessThan(
      urls.indexOf('https://regional.example/zh/alpha-quarterly-results'),
    )
    const counterevidence = executed.output.sources.find(source => (
      source.url === 'https://analyst.example/alpha-results-counterpoint'
    ))
    expect(counterevidence?.snippet).toContain('disputes')
    for (const source of executed.output.sources) expectExecutableDiscoveryRecord(source)

    expect({
      scenario: FINANCIAL_FACT_CHECK_ACCEPTANCE.name,
      canonical: executed.output,
      model_visible_text: executed.modelText,
    }).toMatchSnapshot()
  })

  it('keeps complete versioned SDK records while ranking current official material before old community guidance', async () => {
    const executed = await executeScenario(SDK_VERSIONED_DOCS_ACCEPTANCE)
    expectExactlyOneBoundedSearch(executed)

    const urls = executed.output.sources.map(source => source.url)
    expect(urls).toEqual([
      'https://docs.acme.example/sdk/v4.2/api?a=1&b=2',
      'https://github.com/acme/sdk/releases/tag/v4.2.0',
      'https://github.com/acme/sdk/blob/v4.2.0/CHANGELOG.md',
      'https://community.example/acme/sdk/v4.2/notes',
      'https://docs.acme.example/sdk/v3/api?lang=en',
      'https://community.example/acme/sdk/v3.8/migration',
    ])
    const oldCommunityIndex = urls.indexOf('https://community.example/acme/sdk/v3.8/migration')
    for (const currentOfficialUrl of [
      'https://docs.acme.example/sdk/v4.2/api?a=1&b=2',
      'https://github.com/acme/sdk/releases/tag/v4.2.0',
      'https://github.com/acme/sdk/blob/v4.2.0/CHANGELOG.md',
    ]) {
      expect(urls.indexOf(currentOfficialUrl)).toBeLessThan(oldCommunityIndex)
    }
    expect(urls).toContain('https://docs.acme.example/sdk/v3/api?lang=en')
    expect(urls).toContain('https://community.example/acme/sdk/v3.8/migration')
    expect(urls.filter(url => url.includes('/sdk/v4.2/api'))).toHaveLength(1)
    for (const source of executed.output.sources) expectExecutableDiscoveryRecord(source)
    expect(executed.modelText).toContain('Official v4.2 API and migration reference')
    expect(executed.modelText).toContain('Official Acme SDK v3 API reference retained')

    expect({
      scenario: SDK_VERSIONED_DOCS_ACCEPTANCE.name,
      canonical: executed.output,
      model_visible_text: executed.modelText,
    }).toMatchSnapshot()
  })
})

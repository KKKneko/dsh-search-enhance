import Schema from '@deepseek-ai/schemastery'
import { getOperatingSystems, getProfiles } from 'wreq-js'
import { describe, expect, it } from 'vitest'

import {
  Config,
  DEFAULT_CREDENTIAL_REFS,
  DEFAULT_SEARCH_BUDGETS,
  EXTRA_DISCOVERY_SOURCES_MAX,
  SEARCH_ENHANCE_SETTINGS_NAMESPACE,
  WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS,
} from '../src/config.js'
import {
  SMART_DIRECT_BROWSER_PROFILES,
  SMART_DIRECT_OPERATING_SYSTEMS,
} from '../src/providers/smart-direct-profiles.js'

const resolveConfig = (input: unknown) => Config(input as never)

describe('stage 0 configuration contract', () => {
  it('resolves all deployment defaults without credentials', () => {
    const config = resolveConfig({})

    expect(config.defaultProfile).toBe('auto')
    expect(config.defaultDepth).toBe('compact')
    expect(config.searchApi).toMatchObject({
      baseUrl: 'https://api.x.ai/v1',
      credentialRef: DEFAULT_CREDENTIAL_REFS.searchApi,
      model: '',
      protocol: 'completions',
      thinkingLevel: 'off',
      timeoutMs: 120_000,
    })
    expect(config.budgets).toEqual(DEFAULT_SEARCH_BUDGETS)
    expect(config.extraDiscoverySources).toEqual({
      academic: 0,
      auto: 0,
      code_examples: 0,
      coding_docs: 0,
      fact_check: 0,
      project_research: 0,
    })
    expect(resolveConfig({ extraDiscoverySources: { auto: 1 } }).extraDiscoverySources.auto).toBe(1)
    expect(() => resolveConfig({
      extraDiscoverySources: { auto: EXTRA_DISCOVERY_SOURCES_MAX + 1 },
    })).toThrow()
    expect(config.retry).toEqual({
      baseDelayMs: 1000,
      jitterRatio: 0.2,
      maxAttempts: 3,
      maxDelayMs: 10_000,
      maxTotalDelayMs: 20_000,
      multiplier: 2,
    })
    expect(config.cache).toMatchObject({
      context7DocsTtlHours: 24,
      context7EntryMaxBytes: 256 * 1024,
      context7LibraryTextMaxCharacters: 4096,
      context7ResolveTtlHours: 168,
      context7SnippetMaxCharacters: 1200,
      maxEntries: 500,
      modelListMaxModels: 1000,
      modelListTtlMinutes: 10,
    })
    expect(config.retention).toMatchObject({
      canonicalOutputMaxBytes: 256 * 1024,
      docsSearchMaxResults: 20,
      searchQueryMaxCharacters: 32_000,
      providerMaxSources: 100,
      providerResponseMaxBytes: 2 * 1024 * 1024,
      providerResultMaxBytes: 256 * 1024,
      searchSourcesMaxPageSize: 100,
      searchSourcesPageMaxBytes: 256 * 1024,
      searchSourcesSnippetMaxCharacters: 4000,
      sourceEventMaxBytes: 256 * 1024,
      sourceEventMaxSources: 100,
      sourceStoreMaxRecords: 100_000,
    })
    expect(config.toolDiscovery).toEqual({ mode: 'progressive' })
    expect(config.optionalTools).toEqual({
      webMap: false,
      researchPlan: false,
      diagnostics: false,
    })
    expect(config.diagnostics).toEqual({
      timeoutMs: 30_000,
      maxProbeAttempts: 1,
      maxResponseBytes: 128 * 1024,
      maxResultBytes: 64 * 1024,
      maxOutputBytes: 64 * 1024,
      modelTextMaxBytes: 16 * 1024,
    })
    expect(config.siteMap).toEqual({
      timeoutMs: 150_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxOutputBytes: 256 * 1024,
      modelTextMaxBytes: 64 * 1024,
      maxUrlCharacters: 8192,
      maxInstructionsCharacters: 10_000,
      maxLinks: 500,
    })
    expect(config.researchPlan).toEqual({
      maxQuestionCharacters: 32_000,
      maxSubQueryCharacters: 10_000,
      maxQueryCharacters: 10_000,
      maxReasonCharacters: 10_000,
      maxKnownUrlCharacters: 8192,
      maxKnownUrls: 10,
      maxOutputBytes: 256 * 1024,
      modelTextMaxBytes: 64 * 1024,
    })
    expect(config.webExtract.smartDirect).toEqual({
      browser: 'chrome_145',
      connectTimeoutMs: 10_000,
      enabled: true,
      includeReplies: 'extractors',
      maxAdapterBytes: 256 * 1024,
      maxContentLengthBytes: 5 * 1024 * 1024,
      maxDecompressedBytes: 4 * 1024 * 1024,
      maxDomNodes: 100_000,
      maxExtractedCharacters: 50_000,
      maxHeaderBytes: 64 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      maxMetadataCharacters: 4096,
      maxOutputBytes: 256 * 1024,
      maxRedirects: 5,
      maxRetries: 2,
      os: 'windows',
      processingTimeoutMs: 5000,
      readTimeoutMs: 15_000,
      removeImages: false,
      timeoutMs: 15_000,
    })
    expect(config.webExtract.smartDirect.proxyUrl).toBeUndefined()
    expect(config.webExtract.direct.proxyUrl).toBeUndefined()
    expect(String(SEARCH_ENHANCE_SETTINGS_NAMESPACE)).toBe('search-enhance')
  })

  it.each([
    [{ defaultProfile: 'other' }, 'profile enum'],
    [{ defaultDepth: 'sources_only' }, 'depth enum'],
    [{ fallbackMode: 'on' }, 'fallback enum'],
    [{ minimumProfile: 'full' }, 'minimum capability enum'],
    [{ searchApi: { protocol: 'chat' } }, 'Search API protocol enum'],
    [{ searchApi: { thinkingLevel: 'none' } }, 'thinking-level enum'],
    [{ searchApi: { baseUrl: 'file:///tmp/search' } }, 'HTTP endpoint'],
    [{ searchApi: { baseUrl: 'https://secret@search.test/v1' } }, 'credential-bearing endpoint'],
    [{ searchApi: { baseUrl: 'https://search.test/v1?key=secret' } }, 'endpoint query'],
    [{ searchApi: { credentialRef: 'not-a-shell-name' } }, 'credential reference'],
    [{ retry: { maxAttempts: 0 } }, 'positive retry attempts'],
    [{ cache: { context7DocsTtlHours: 0 } }, 'positive Context7 docs TTL'],
    [{ cache: { context7EntryMaxBytes: 0 } }, 'positive Context7 cache bytes'],
    [{ cache: { context7LibraryTextMaxCharacters: 0 } }, 'positive Context7 library text limit'],
    [{ cache: { context7SnippetMaxCharacters: 0 } }, 'positive Context7 snippet limit'],
    [{ retention: { sourceEventMaxBytes: -1 } }, 'positive byte limit'],
    [{ retention: { searchQueryMaxCharacters: 0 } }, 'positive query limit'],
    [{ retention: { providerMaxSources: 0 } }, 'positive Provider source limit'],
    [{ retention: { sourceStoreMaxRecords: 0 } }, 'positive source-store capacity'],
    [{ retention: { searchSourcesMaxPageSize: 19 } }, 'page-size limit below the default page'],
    [{ retention: { searchSourcesPageMaxBytes: 0 } }, 'positive page-byte limit'],
    [{ retention: { searchSourcesSnippetMaxCharacters: -1 } }, 'non-negative snippet limit'],
    [{ retention: { docsSearchMaxResults: 5 } }, 'docs_search cap below its default'],
    [{ retention: { docsSearchMaxResults: 21 } }, 'docs_search cap above the schema maximum'],
    [{ toolDiscovery: { mode: 'dynamic' } }, 'tool-discovery mode enum'],
    [{ optionalTools: { webMap: 'yes' } }, 'deprecated boolean compatibility input'],
    [{ optionalTools: { researchPlan: 'yes' } }, 'deprecated research-plan compatibility input'],
    [{ optionalTools: { diagnostics: 'yes' } }, 'deprecated diagnostics compatibility input'],
    [{ diagnostics: { timeoutMs: 0 } }, 'positive diagnostics timeout'],
    [{ diagnostics: { maxProbeAttempts: 0 } }, 'positive diagnostics attempts'],
    [{ diagnostics: { maxProbeAttempts: 4 } }, 'diagnostics attempt hard cap'],
    [{ diagnostics: { maxResponseBytes: 0 } }, 'positive diagnostics response bytes'],
    [{ diagnostics: { maxResultBytes: 0 } }, 'positive diagnostics result bytes'],
    [{ diagnostics: { maxOutputBytes: 16 * 1024 - 1 } }, 'diagnostics envelope minimum'],
    [{ diagnostics: { modelTextMaxBytes: 0 } }, 'positive diagnostics model text bytes'],
    [{ researchPlan: { maxQuestionCharacters: 0 } }, 'positive research question limit'],
    [{ researchPlan: { maxSubQueryCharacters: 0 } }, 'positive research sub-query limit'],
    [{ researchPlan: { maxQueryCharacters: 0 } }, 'positive research query limit'],
    [{ researchPlan: { maxReasonCharacters: 0 } }, 'positive research reason limit'],
    [{ researchPlan: { maxKnownUrlCharacters: 0 } }, 'positive research URL limit'],
    [{ researchPlan: { maxKnownUrls: 0 } }, 'positive research URL count'],
    [{ researchPlan: { maxKnownUrls: 11 } }, 'research URL count hard limit'],
    [{ researchPlan: { maxOutputBytes: 0 } }, 'positive research canonical bytes'],
    [{ researchPlan: { modelTextMaxBytes: 0 } }, 'positive research model text bytes'],
    [{ siteMap: { timeoutMs: 9999 } }, 'Tavily Map timeout below API minimum'],
    [{ siteMap: { timeoutMs: 10_500 } }, 'Tavily Map timeout with fractional seconds'],
    [{ siteMap: { maxResponseBytes: 0 } }, 'positive Tavily Map response bytes'],
    [{ siteMap: { maxOutputBytes: 0 } }, 'positive Tavily Map output bytes'],
    [{ siteMap: { modelTextMaxBytes: 0 } }, 'positive Tavily Map model text bytes'],
    [{ siteMap: { maxUrlCharacters: 0 } }, 'positive Tavily Map URL limit'],
    [{ siteMap: { maxInstructionsCharacters: 0 } }, 'positive Tavily Map instructions limit'],
    [{ siteMap: { maxLinks: 501 } }, 'Tavily Map deployment link cap'],
    [{ webExtract: { smartDirect: { browser: 'chrome_future' } } }, 'wreq browser profile'],
    [{ webExtract: { smartDirect: { os: 'plan9' } } }, 'wreq operating system'],
    [{ webExtract: { smartDirect: { maxDomNodes: 0 } } }, 'positive DOM node limit'],
    [{ webExtract: { smartDirect: { maxRetries: -1 } } }, 'non-negative smart retry limit'],
    [{ webExtract: { direct: { maxRedirects: -1 } } }, 'non-negative redirect limit'],
  ])('rejects an invalid %s (%s)', (input, _reason) => {
    expect(() => resolveConfig(input)).toThrow()
  })

  it.each(['smartDirect', 'direct'] as const)(
    'strictly validates the optional webExtract.%s HTTP proxy origin',
    route => {
      const invalid = [
        'not a URL',
        '/relative-proxy',
        'http:proxy.example.test:8080',
        'https://proxy.example.test:8443',
        'socks5://proxy.example.test:1080',
        'ftp://proxy.example.test',
        'http://proxy.example.test:8080/#fragment',
        'http://proxy-user:proxy-secret@proxy.example.test:8080',
        'http://proxy.example.test:8080/path',
        'http://proxy.example.test:8080/./',
        'http://proxy.example.test:8080?mode=forward',
        `http://${'a'.repeat(WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS)}.test`,
      ]
      for (const proxyUrl of invalid) {
        let message = ''
        try {
          resolveConfig({ webExtract: { [route]: { proxyUrl } } })
        } catch (error) {
          message = String(error)
        }
        expect(message).not.toBe('')
        expect(message).not.toContain('proxy-secret')
      }
    },
  )

  it('preserves proxy validation across Schemastery Settings serialization', () => {
    const restored = new Schema(JSON.parse(JSON.stringify(Config)))
    const value = restored({
      webExtract: {
        smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
        direct: { proxyUrl: 'http://127.0.0.1:7891/' },
      },
    }) as ReturnType<typeof Config>

    expect(value.webExtract.smartDirect.proxyUrl).toBe('http://127.0.0.1:7890')
    expect(value.webExtract.direct.proxyUrl).toBe('http://127.0.0.1:7891/')
    expect(() => restored({
      webExtract: { direct: { proxyUrl: 'http://user:proxy-secret@127.0.0.1:7891' } },
    })).toThrow(/proxyUrl must be an absolute HTTP proxy origin/)
  })

  it('pins Settings browser and OS enums to the exact public wreq-js 2.3.1 lists', () => {
    expect(getProfiles()).toEqual([...SMART_DIRECT_BROWSER_PROFILES])
    expect(getOperatingSystems()).toEqual([...SMART_DIRECT_OPERATING_SYSTEMS])
  })

  it('accepts explicit bounded overrides', () => {
    const config = resolveConfig({
      defaultDepth: 'deep',
      retry: {
        jitterRatio: 0,
        maxAttempts: 1,
      },
      searchApi: {
        baseUrl: 'https://search.example.test/v1',
        credentialRef: 'DEPLOYMENT_SEARCH_KEY',
        protocol: 'responses',
      },
      retention: {
        docsSearchMaxResults: 10,
      },
      siteMap: {
        timeoutMs: 10_000,
        maxLinks: 25,
      },
      researchPlan: {
        maxQuestionCharacters: 12,
        maxSubQueryCharacters: 13,
        maxQueryCharacters: 14,
        maxReasonCharacters: 15,
        maxKnownUrlCharacters: 16,
        maxKnownUrls: 2,
        maxOutputBytes: 17_000,
        modelTextMaxBytes: 18_000,
      },
      toolDiscovery: {
        mode: 'all',
      },
      webExtract: {
        smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
        direct: { proxyUrl: 'http://127.0.0.1:7891/' },
      },
      optionalTools: {
        webMap: true,
        diagnostics: true,
      },
      diagnostics: {
        timeoutMs: 10_000,
        maxProbeAttempts: 2,
        maxResponseBytes: 32_000,
        maxResultBytes: 24_000,
        maxOutputBytes: 20_000,
        modelTextMaxBytes: 17_000,
      },
    })

    expect(config.defaultDepth).toBe('deep')
    expect(config.retry.maxAttempts).toBe(1)
    expect(config.retention.docsSearchMaxResults).toBe(10)
    expect(config.siteMap).toMatchObject({
      timeoutMs: 10_000,
      maxLinks: 25,
    })
    expect(config.researchPlan).toEqual({
      maxQuestionCharacters: 12,
      maxSubQueryCharacters: 13,
      maxQueryCharacters: 14,
      maxReasonCharacters: 15,
      maxKnownUrlCharacters: 16,
      maxKnownUrls: 2,
      maxOutputBytes: 17_000,
      modelTextMaxBytes: 18_000,
    })
    expect(config.toolDiscovery).toEqual({ mode: 'all' })
    expect(config.webExtract.smartDirect.proxyUrl).toBe('http://127.0.0.1:7890')
    expect(config.webExtract.direct.proxyUrl).toBe('http://127.0.0.1:7891/')
    expect(config.optionalTools).toEqual({
      webMap: true,
      researchPlan: false,
      diagnostics: true,
    })
    expect(config.diagnostics).toEqual({
      timeoutMs: 10_000,
      maxProbeAttempts: 2,
      maxResponseBytes: 32_000,
      maxResultBytes: 24_000,
      maxOutputBytes: 20_000,
      modelTextMaxBytes: 17_000,
    })
    expect(config.searchApi).toMatchObject({
      baseUrl: 'https://search.example.test/v1',
      credentialRef: 'DEPLOYMENT_SEARCH_KEY',
      protocol: 'responses',
    })
  })
})

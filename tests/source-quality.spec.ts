import { describe, expect, it, vi } from 'vitest'

import type { CanonicalSource, SourceCategory } from '../src/contracts/index.js'
import {
  DEFAULT_SOURCE_QUALITY_LIMITS,
  applySourceQuality,
  normalizeSourceUrl,
  type SourceQualityLimits,
} from '../src/search/index.js'
import {
  FINANCIAL_QUALITY_FIXTURE,
  SDK_QUALITY_FIXTURE,
  SIMILAR_TITLE_INDEPENDENT_FIXTURE,
} from './fixtures/source-quality.js'

function source(
  url: string,
  category: SourceCategory,
  title: string = category,
  snippet = '',
): CanonicalSource {
  return Object.freeze({
    category,
    provider: 'search-api',
    ...(snippet.length === 0 ? {} : { snippet }),
    title,
    url,
  })
}

function generousLimits(overrides: Partial<SourceQualityLimits> = {}): SourceQualityLimits {
  return {
    ...DEFAULT_SOURCE_QUALITY_LIMITS,
    maxComparableSources: 100,
    maxPublishedAtCharacters: 100,
    maxQueryCharacters: 100,
    maxSnippetCharacters: 100,
    maxTitleCharacters: 100,
    maxTotalComparisonCharacters: 10_000,
    maxUrlCharacters: 1_000,
    ...overrides,
  }
}

describe('source URL normalization', () => {
  it('uses a stable same-page spelling while preserving ordinary parameters', () => {
    expect(normalizeSourceUrl(
      'HTTPS://Example.COM:443/docs/api/?z=2&utm_source=mail&id=42&fbclid=x&z=1&redirect=https%3A%2F%2Ftarget.test#part',
      1_000,
    )).toBe(
      'https://example.com/docs/api?id=42&redirect=https%3A%2F%2Ftarget.test&z=1&z=2',
    )
    expect(normalizeSourceUrl('http://EXAMPLE.com:80/#fragment', 100)).toBe('http://example.com/')
    expect(normalizeSourceUrl('https://example.com/docs///', 100)).toBe('https://example.com/docs')
  })

  it('rejects non-HTTP, malformed, userinfo-bearing, and over-limit URLs', () => {
    expect(normalizeSourceUrl('ftp://example.com/file', 100)).toBeUndefined()
    expect(normalizeSourceUrl('https://[invalid', 100)).toBeUndefined()
    expect(normalizeSourceUrl('https://user:secret@example.com/path', 100)).toBeUndefined()
    const unicodeUrl = 'https://example.com/界'
    const exactCharacters = Array.from(unicodeUrl).length
    expect(normalizeSourceUrl(unicodeUrl, exactCharacters)).toBe(
      'https://example.com/%E7%95%8C',
    )
    expect(normalizeSourceUrl(unicodeUrl, exactCharacters - 1)).toBeUndefined()
    expect(normalizeSourceUrl(unicodeUrl, 0)).toBeUndefined()
  })
})

describe('fixed Provider source-quality fixtures', () => {
  it('puts official and original financial sources first, merges tracking variants, and keeps counterevidence', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('quality sorting must not read the current time')
    })
    try {
      const ranked = applySourceQuality(
        FINANCIAL_QUALITY_FIXTURE.query,
        FINANCIAL_QUALITY_FIXTURE.sources,
      )

      expect(ranked.map(item => item.url)).toEqual([
        'https://investor.alpha.example/releases/q1?lang=en',
        'https://wire.example/reports/alpha-results?edition=global',
        'https://wire.example/reports/alpha-preview?edition=global',
        'https://analyst.example/alpha-results-counterpoint',
        'https://regional.example/zh/alpha-quarterly-results',
        'https://agg.example/markets/alpha-results?lang=zh',
      ])
      expect(ranked.filter(item => item.url.includes('/releases/q1'))).toHaveLength(1)
      expect(ranked.some(item => item.title?.includes('disputes'))).toBe(true)
      expect(ranked.map(item => item.publishedAt)).toContain('2025-05-04')
    } finally {
      now.mockRestore()
    }
  })

  it('promotes explicit SDK version matches without dropping different-version documentation', () => {
    const ranked = applySourceQuality(SDK_QUALITY_FIXTURE.query, SDK_QUALITY_FIXTURE.sources)

    expect(ranked.map(item => item.url)).toEqual([
      'https://docs.acme.example/sdk/v4.2/api?a=1&b=2',
      'https://github.com/acme/sdk/releases/tag/v4.2.0',
      'https://github.com/acme/sdk/blob/v4.2.0/CHANGELOG.md',
      'https://community.example/acme/sdk/v4.2/notes',
      'https://docs.acme.example/sdk/v3/api?lang=en',
      'https://community.example/acme/sdk/v3.8/migration',
    ])
    expect(ranked.filter(item => item.url.includes('/sdk/v4.2/api'))).toHaveLength(1)
    expect(ranked.some(item => item.url.includes('/sdk/v3/api'))).toBe(true)
  })

  it('does not infer a preferred version when the query has no explicit version token', () => {
    const ranked = applySourceQuality('Acme SDK API migration', SDK_QUALITY_FIXTURE.sources)

    expect(ranked.slice(0, 2).map(item => item.url)).toEqual([
      'https://docs.acme.example/sdk/v3/api?lang=en',
      'https://docs.acme.example/sdk/v4.2/api?a=1&b=2',
    ])
  })

  it('never merges explicit version, date, or stance conflicts at one normalized URL', () => {
    const ranked = applySourceQuality('Acme SDK v4 API', [
      Object.freeze({
        category: 'documentation',
        provider: 'search-api',
        publishedAt: '2025-01-01',
        snippet: 'Maintainers support this migration.',
        title: 'Acme SDK v4 reference',
        url: 'https://docs.example/acme/api/?utm_source=one',
      }),
      Object.freeze({
        category: 'documentation',
        provider: 'context7',
        publishedAt: '2025-01-01',
        snippet: 'Maintainers support this migration.',
        title: 'Acme SDK v4 reference',
        url: 'https://docs.example/acme/api',
      }),
      Object.freeze({
        category: 'documentation',
        provider: 'exa',
        publishedAt: '2024-01-01',
        snippet: 'Maintainers oppose this migration.',
        title: 'Acme SDK v5 reference',
        url: 'https://docs.example/acme/api?utm_campaign=two',
      }),
      Object.freeze({
        category: 'documentation',
        provider: 'tavily',
        publishedAt: '2025-02-01',
        snippet: 'Maintainers oppose this migration.',
        title: 'Acme SDK v4 reference',
        url: 'https://docs.example/acme/api?fbclid=three',
      }),
    ])

    expect(ranked).toHaveLength(3)
    expect(ranked.map(item => item.title)).toEqual([
      'Acme SDK v4 reference',
      'Acme SDK v4 reference',
      'Acme SDK v5 reference',
    ])
    expect(ranked.every(item => item.url === 'https://docs.example/acme/api')).toBe(true)
    expect(ranked.map(item => item.publishedAt)).toEqual([
      '2025-01-01',
      '2025-02-01',
      '2024-01-01',
    ])
  })

  it('retains similar titles at distinct URLs across dates and opposing positions', () => {
    const ranked = applySourceQuality(
      SIMILAR_TITLE_INDEPENDENT_FIXTURE.query,
      SIMILAR_TITLE_INDEPENDENT_FIXTURE.sources,
    )

    expect(ranked).toHaveLength(SIMILAR_TITLE_INDEPENDENT_FIXTURE.sources.length)
    expect(new Set(ranked.map(item => item.url))).toEqual(new Set(
      SIMILAR_TITLE_INDEPENDENT_FIXTURE.sources.map(item => item.url),
    ))
    expect(ranked.map(item => item.publishedAt)).toEqual([
      '2025-01-10',
      '2025-01-11',
      '2025-02-01',
    ])
    expect(ranked.some(item => item.snippet?.includes('opposes'))).toBe(true)
  })

  it('uses only parseable Provider dates for temporal tie-breaking and preserves invalid values', () => {
    const ranked = applySourceQuality('latest date fixture', [
      Object.freeze({
        category: 'news',
        provider: 'search-api',
        publishedAt: 'not-a-date',
        title: 'Invalid date',
        url: 'https://news.example/invalid',
      }),
      Object.freeze({
        category: 'news',
        provider: 'tavily',
        publishedAt: '2025-01-02T00:00:00Z',
        title: 'Valid date',
        url: 'https://news.example/valid',
      }),
      Object.freeze({
        category: 'news',
        provider: 'exa',
        title: 'Missing date',
        url: 'https://news.example/missing',
      }),
    ])

    expect(ranked.map(item => item.url)).toEqual([
      'https://news.example/valid',
      'https://news.example/invalid',
      'https://news.example/missing',
    ])
    expect(ranked[1]?.publishedAt).toBe('not-a-date')
    expect(ranked[2]).not.toHaveProperty('publishedAt')
  })
})

describe('source-quality comparison budgets', () => {
  const shortSources = [
    source('https://a.test/界', 'aggregate', '界🙂'),
    source('https://b.test/界', 'official', '界🙂'),
  ] as const

  it('ranks at exact Unicode field limits but falls back to Provider order at tiny and over limits', () => {
    const exact = applySourceQuality('q', shortSources, generousLimits({
      maxTitleCharacters: 2,
    }))
    expect(exact.map(item => item.category)).toEqual(['official', 'aggregate'])

    for (const maximum of [0, 1]) {
      const fallback = applySourceQuality('q', shortSources, generousLimits({
        maxTitleCharacters: maximum,
      }))
      expect(fallback.map(item => item.category)).toEqual(['aggregate', 'official'])
    }
  })

  it('bounds snippets and total comparison characters without discarding metadata', () => {
    const sources = [
      source('https://a.test/item', 'aggregate', 'first title', '界🙂X'),
      source('https://b.test/item', 'official', 'second title', '界🙂X'),
    ]
    const exactSnippet = applySourceQuality('q', sources, generousLimits({
      maxSnippetCharacters: 3,
    }))
    expect(exactSnippet.map(item => item.category)).toEqual(['official', 'aggregate'])

    const overSnippet = applySourceQuality('q', sources, generousLimits({
      maxSnippetCharacters: 2,
    }))
    expect(overSnippet.map(item => item.category)).toEqual(['aggregate', 'official'])
    expect(overSnippet[0]?.snippet).toBe('界🙂X')

    const exactTotal = Array.from('q').length + sources.reduce((total, item) => (
      total
      + Array.from(item.url).length
      + Array.from(item.title ?? '').length
      + Array.from(item.snippet ?? '').length
    ), 0)
    expect(applySourceQuality('q', sources, generousLimits({
      maxTotalComparisonCharacters: exactTotal,
    })).map(item => item.category)).toEqual(['official', 'aggregate'])
    expect(applySourceQuality('q', sources, generousLimits({
      maxTotalComparisonCharacters: exactTotal - 1,
    })).map(item => item.category)).toEqual(['aggregate', 'official'])
  })

  it('keeps over-limit HTTP(S) URLs opaque and stable instead of parsing unbounded input', () => {
    const longUrl = `https://opaque.test/${'界'.repeat(20)}`
    const sources = [
      source(longUrl, 'aggregate'),
      source('https://official.test/item', 'official'),
    ]

    const ranked = applySourceQuality('q', sources, generousLimits({ maxUrlCharacters: 30 }))

    expect(ranked.map(item => item.url)).toEqual([
      longUrl,
      'https://official.test/item',
    ])
    expect(applySourceQuality('q', [source(
      `https://user:secret@opaque.test/${'界'.repeat(20)}`,
      'official',
    )], generousLimits({ maxUrlCharacters: 30 }))).toEqual([])
  })

  it('uses the comparable-source cap at exact and over boundaries', () => {
    expect(applySourceQuality('q', shortSources, generousLimits({
      maxComparableSources: 2,
    })).map(item => item.category)).toEqual(['official', 'aggregate'])
    expect(applySourceQuality('q', shortSources, generousLimits({
      maxComparableSources: 1,
    })).map(item => item.category)).toEqual(['aggregate', 'official'])
  })
})

import type { CanonicalSource } from '../../src/contracts/index.js'

export interface SourceQualityFixture {
  readonly query: string
  readonly sources: readonly CanonicalSource[]
}

function fixtureSource(source: CanonicalSource): Readonly<CanonicalSource> {
  return Object.freeze(source)
}

export const FINANCIAL_QUALITY_FIXTURE: Readonly<SourceQualityFixture> = Object.freeze({
  query: '最新 Alpha Corp 季度业绩争议',
  sources: Object.freeze([
    fixtureSource({
      category: 'aggregate',
      provider: 'search-api',
      publishedAt: '2025-05-03',
      snippet: 'Aggregated from several market feeds.',
      title: 'Alpha results translated roundup',
      url: 'https://AGG.example/markets/alpha-results/?utm_source=newsletter&lang=zh',
    }),
    fixtureSource({
      category: 'primary',
      provider: 'search-api',
      publishedAt: '2025-05-02T09:00:00Z',
      snippet: 'Original reporting based on direct interviews.',
      title: 'Alpha reports quarterly results',
      url: 'https://wire.example/reports/alpha-results?edition=global',
    }),
    fixtureSource({
      category: 'official',
      provider: 'search-api',
      publishedAt: '2025-05-01',
      snippet: 'Issuer announcement and filing links.',
      title: 'Alpha Corp quarterly announcement',
      url: 'HTTPS://Investor.Alpha.Example:443/releases/q1/?utm_medium=email&gclid=tracking&lang=en#results',
    }),
    fixtureSource({
      category: 'official',
      provider: 'tavily',
      publishedAt: '2025-05-01',
      snippet: 'Issuer announcement and filing links.',
      title: 'Alpha Corp quarterly announcement',
      url: 'https://investor.alpha.example/releases/q1?lang=en&utm_campaign=spring',
    }),
    fixtureSource({
      category: 'news',
      provider: 'firecrawl',
      publishedAt: '2025-05-04',
      snippet: '译自 Alpha market desk 的多语言转载。',
      title: '阿尔法季度业绩（译自原报道）',
      url: 'https://regional.example/zh/alpha-quarterly-results',
    }),
    fixtureSource({
      category: 'primary',
      provider: 'exa',
      publishedAt: '2025-04-20',
      snippet: 'Earlier original reporting before the filing.',
      title: 'What to expect from Alpha results',
      url: 'https://wire.example/reports/alpha-preview?edition=global',
    }),
    fixtureSource({
      category: 'community',
      provider: 'tavily',
      publishedAt: '2025-05-04',
      snippet: 'Independent analyst disputes the company interpretation.',
      title: 'Analyst disputes Alpha management claims',
      url: 'https://analyst.example/alpha-results-counterpoint',
    }),
  ]),
})

export const SDK_QUALITY_FIXTURE: Readonly<SourceQualityFixture> = Object.freeze({
  query: 'Acme SDK v4.2 API migration',
  sources: Object.freeze([
    fixtureSource({
      category: 'community',
      provider: 'search-api',
      publishedAt: '2022-08-01',
      title: 'Acme SDK v3.8 migration guide',
      url: 'https://community.example/acme/sdk/v3.8/migration',
    }),
    fixtureSource({
      category: 'documentation',
      provider: 'context7',
      publishedAt: '2023-02-01',
      title: 'Acme SDK v3 API reference',
      url: 'https://docs.acme.example/sdk/v3/api?lang=en',
    }),
    fixtureSource({
      category: 'code',
      provider: 'exa',
      publishedAt: '2025-03-04T10:30:00Z',
      title: 'Acme SDK v4.2 release',
      url: 'https://github.com/acme/sdk/releases/tag/v4.2.0?utm_source=release-mail',
    }),
    fixtureSource({
      category: 'documentation',
      provider: 'search-api',
      publishedAt: '2025-03-05',
      snippet: 'Official v4.2 API and migration reference.',
      title: 'Acme SDK v4.2 API reference',
      url: 'HTTPS://DOCS.ACME.EXAMPLE:443/sdk/v4.2/api/?b=2&utm_campaign=launch&a=1#authentication',
    }),
    fixtureSource({
      category: 'documentation',
      provider: 'tavily',
      publishedAt: '2025-03-05',
      snippet: 'Official v4.2 API and migration reference.',
      title: 'Acme SDK v4.2 API reference',
      url: 'https://docs.acme.example/sdk/v4.2/api?a=1&fbclid=tracking&b=2',
    }),
    fixtureSource({
      category: 'code',
      provider: 'firecrawl',
      publishedAt: '2025-03-04',
      title: 'Acme SDK v4.2 changelog',
      url: 'https://github.com/acme/sdk/blob/v4.2.0/CHANGELOG.md',
    }),
    fixtureSource({
      category: 'community',
      provider: 'tavily',
      publishedAt: '2025-03-06',
      title: 'Practical Acme SDK v4.2 migration notes',
      url: 'https://community.example/acme/sdk/v4.2/notes',
    }),
  ]),
})

export const SIMILAR_TITLE_INDEPENDENT_FIXTURE: Readonly<SourceQualityFixture> = Object.freeze({
  query: 'Alpha merger analysis',
  sources: Object.freeze([
    fixtureSource({
      category: 'news',
      provider: 'search-api',
      publishedAt: '2025-01-10',
      snippet: 'The transaction is supported by the board.',
      title: 'Alpha merger: what changes next?',
      url: 'https://news-one.example/alpha-merger-analysis',
    }),
    fixtureSource({
      category: 'news',
      provider: 'exa',
      publishedAt: '2025-01-11',
      snippet: 'Shareholder group opposes the transaction.',
      title: 'Alpha merger — what changes next',
      url: 'https://news-two.example/alpha-merger-opposition',
    }),
    fixtureSource({
      category: 'news',
      provider: 'tavily',
      publishedAt: '2025-02-01',
      snippet: 'A later review confirms revised transaction dates.',
      title: 'Alpha merger: what changes next?',
      url: 'https://news-three.example/alpha-merger-later-review',
    }),
  ]),
})

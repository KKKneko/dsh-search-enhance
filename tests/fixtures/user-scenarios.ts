import type { SearchProfile } from '../../src/config.js'
import type { CanonicalSource, SourceProvider } from '../../src/contracts/index.js'

export const ACCEPTANCE_SEARCH_PROVIDERS = [
  'search-api',
  'exa',
  'tavily',
  'firecrawl',
] as const satisfies readonly SourceProvider[]

export type AcceptanceSearchProvider = (typeof ACCEPTANCE_SEARCH_PROVIDERS)[number]

export interface UserScenarioAcceptanceFixture {
  readonly name: string
  readonly query: string
  readonly profile: SearchProfile
  readonly answer: string
  readonly sources: Readonly<Record<AcceptanceSearchProvider, readonly CanonicalSource[]>>
}

function frozenSource(source: CanonicalSource): Readonly<CanonicalSource> {
  return Object.freeze(source)
}

function frozenSources(
  sources: readonly CanonicalSource[],
): readonly Readonly<CanonicalSource>[] {
  return Object.freeze(sources.map(frozenSource))
}

export const FINANCIAL_FACT_CHECK_ACCEPTANCE: Readonly<UserScenarioAcceptanceFixture> = Object.freeze({
  name: 'financial-temporal-fact-check',
  query: 'latest Alpha Corp Q1 earnings release margin fact-check',
  profile: 'fact_check',
  answer: [
    'Verdict: unresolved.',
    "Alpha Corp's reported 42.7% margin is unverified because only the issuer filing supports that key number; the wire report repeats the announcement and an independent analyst disputes management's interpretation.",
    'The bounded evidence supports reporting the disagreement, not converting the number into a verified fact.',
  ].join(' '),
  sources: Object.freeze({
    'search-api': frozenSources([
      {
        category: 'aggregate',
        provider: 'search-api',
        publishedAt: '2025-05-03',
        snippet: 'Aggregated from several market feeds; this is a translated roundup of the announcement.',
        title: 'Alpha results translated roundup',
        url: 'https://AGG.example/markets/alpha-results/?utm_source=newsletter&lang=zh',
      },
      {
        category: 'primary',
        provider: 'search-api',
        publishedAt: '2025-05-02T09:00:00Z',
        snippet: 'Original wire reporting says the company announced quarterly results; it does not independently audit the margin.',
        title: 'Alpha reports quarterly results',
        url: 'https://wire.example/reports/alpha-results?edition=global',
      },
      {
        category: 'official',
        provider: 'search-api',
        publishedAt: '2025-05-01',
        snippet: 'Issuer filing reports a 42.7% margin and links the signed quarterly announcement.',
        title: 'Alpha Corp quarterly announcement',
        url: 'HTTPS://Investor.Alpha.Example:443/releases/q1/?utm_medium=email&gclid=tracking&lang=en#results',
      },
    ]),
    exa: frozenSources([
      {
        category: 'primary',
        provider: 'exa',
        publishedAt: '2025-04-20',
        snippet: 'Earlier original reporting describes expectations before the filing without confirming the final margin.',
        title: 'What to expect from Alpha results',
        url: 'https://wire.example/reports/alpha-preview?edition=global',
      },
      {
        category: 'community',
        provider: 'exa',
        publishedAt: '2025-05-04',
        snippet: 'Independent analyst disputes management methodology and does not independently confirm the 42.7% figure.',
        title: 'Analyst disputes Alpha management claims',
        url: 'https://analyst.example/alpha-results-counterpoint',
      },
    ]),
    tavily: frozenSources([
      {
        category: 'official',
        provider: 'tavily',
        publishedAt: '2025-05-01',
        snippet: 'Issuer filing reports a 42.7% margin and links the signed quarterly announcement.',
        title: 'Alpha Corp quarterly announcement',
        url: 'https://investor.alpha.example/releases/q1?lang=en&fbclid=tavily',
      },
    ]),
    firecrawl: frozenSources([
      {
        category: 'news',
        provider: 'firecrawl',
        publishedAt: '2025-05-04',
        snippet: '译自 Alpha market desk 的多语言转载，重复公司公告中的季度数字。',
        title: '阿尔法季度业绩（译自原报道）',
        url: 'https://regional.example/zh/alpha-quarterly-results',
      },
    ]),
  }),
})

export const SDK_VERSIONED_DOCS_ACCEPTANCE: Readonly<UserScenarioAcceptanceFixture> = Object.freeze({
  name: 'sdk-versioned-coding-docs',
  query: 'Acme SDK v4.2 API migration',
  profile: 'coding_docs',
  answer: 'Use the official Acme SDK v4.2 API reference together with the v4.2 release and changelog; retain the v3 material only as explicitly older migration context.',
  sources: Object.freeze({
    'search-api': frozenSources([
      {
        category: 'community',
        provider: 'search-api',
        publishedAt: '2022-08-01',
        snippet: 'Community migration notes for Acme SDK v3.8; commands target the older API.',
        title: 'Acme SDK v3.8 migration guide',
        url: 'https://community.example/acme/sdk/v3.8/migration',
      },
      {
        category: 'documentation',
        provider: 'search-api',
        publishedAt: '2025-03-05',
        snippet: 'Official v4.2 API and migration reference with executable request examples.',
        title: 'Acme SDK v4.2 API reference',
        url: 'HTTPS://DOCS.ACME.EXAMPLE:443/sdk/v4.2/api/?b=2&utm_campaign=launch&a=1#authentication',
      },
    ]),
    exa: frozenSources([
      {
        category: 'code',
        provider: 'exa',
        publishedAt: '2025-03-04T10:30:00Z',
        snippet: 'Official v4.2.0 release notes list migration-sensitive API changes.',
        title: 'Acme SDK v4.2 release',
        url: 'https://github.com/acme/sdk/releases/tag/v4.2.0?utm_source=release-mail',
      },
      {
        category: 'documentation',
        provider: 'exa',
        publishedAt: '2023-02-01',
        snippet: 'Official Acme SDK v3 API reference retained for old-version comparison.',
        title: 'Acme SDK v3 API reference',
        url: 'https://docs.acme.example/sdk/v3/api?lang=en',
      },
    ]),
    tavily: frozenSources([
      {
        category: 'documentation',
        provider: 'tavily',
        publishedAt: '2025-03-05',
        snippet: 'Official v4.2 API and migration reference with executable request examples.',
        title: 'Acme SDK v4.2 API reference',
        url: 'https://docs.acme.example/sdk/v4.2/api?a=1&fbclid=tracking&b=2',
      },
      {
        category: 'community',
        provider: 'tavily',
        publishedAt: '2025-03-06',
        snippet: 'Community v4.2 field notes supplement but do not replace the official reference.',
        title: 'Practical Acme SDK v4.2 migration notes',
        url: 'https://community.example/acme/sdk/v4.2/notes',
      },
    ]),
    firecrawl: frozenSources([
      {
        category: 'code',
        provider: 'firecrawl',
        publishedAt: '2025-03-04',
        snippet: 'Official v4.2 changelog records the removed and renamed API members.',
        title: 'Acme SDK v4.2 changelog',
        url: 'https://github.com/acme/sdk/blob/v4.2.0/CHANGELOG.md',
      },
    ]),
  }),
})

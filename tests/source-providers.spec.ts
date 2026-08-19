import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import {
  Context7RemoteClient,
  context7LibrarySource,
  selectContext7Library,
  ExaProvider,
  FirecrawlSearchProvider,
  TavilySearchProvider,
  type BoundedSourceProvider,
} from '../src/providers/index.js'

function resolveConfig(overrides: Record<string, unknown> = {}): SearchEnhanceConfig {
  const retention = typeof overrides.retention === 'object' && overrides.retention !== null
    ? overrides.retention as Record<string, unknown>
    : {}
  const retry = typeof overrides.retry === 'object' && overrides.retry !== null
    ? overrides.retry as Record<string, unknown>
    : {}
  return Config({
    ...overrides,
    providers: {
      context7: { baseUrl: 'https://context7.test', timeoutMs: 1000 },
      exa: { baseUrl: 'https://exa.test', timeoutMs: 1000 },
      firecrawl: { baseUrl: 'https://firecrawl.test/v2', timeoutMs: 1000 },
      tavily: { baseUrl: 'https://tavily.test', timeoutMs: 1000 },
    },
    retention: {
      canonicalOutputMaxBytes: 64 * 1024,
      providerMaxSources: 20,
      providerResponseMaxBytes: 64 * 1024,
      providerResultMaxBytes: 64 * 1024,
      sourceEventMaxSources: 20,
      ...retention,
    },
    retry: {
      baseDelayMs: 0,
      jitterRatio: 0,
      maxAttempts: 1,
      maxDelayMs: 0,
      maxTotalDelayMs: 0,
      multiplier: 1,
      ...retry,
    },
  } as never)
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

interface CredentialsFixture extends Pick<CredentialProvider, 'describe' | 'resolve'> {
  readonly describe: ReturnType<typeof vi.fn<CredentialProvider['describe']>>
  readonly resolve: ReturnType<typeof vi.fn<CredentialProvider['resolve']>>
}

function credentials(values: Array<string | undefined>, configured = values[0] !== undefined): CredentialsFixture {
  const queue = [...values]
  return {
    describe: vi.fn<CredentialProvider['describe']>(async () => ({ configured, writable: true })),
    resolve: vi.fn<CredentialProvider['resolve']>(async (
      _ref: CredentialRef,
    ): Promise<ResolvedCredential | undefined> => {
      const value = queue.shift()
      return value === undefined ? undefined : { source: 'test', value }
    }),
  }
}

function providerInput(
  config: SearchEnhanceConfig,
  query = 'React useEffect API docs',
  limit = 3,
  signal = new AbortController().signal,
) {
  return { config, limit, query, signal }
}

describe('Context7 and Exa documentation Providers', () => {
  it('resolves an explicit Context7 library, queries docs, and bounds snippets', async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = []
    const credentialFixture = credentials(['context-secret', 'context-secret'])
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      calls.push({ ...(init === undefined ? {} : { init }), url })
      if (url.startsWith('https://context7.test/api/v2/libs/search?')) {
        return jsonResponse({
          results: [
            { id: '/uidotdev/usehooks', title: 'React Hooks', description: 'Hook collection', trustScore: 9 },
            { id: '/reactjs/react.dev', title: 'React', description: 'React.dev official documentation', trustScore: 10 },
          ],
        })
      }
      if (url.startsWith('https://context7.test/api/v2/context?')) {
        return jsonResponse({
          codeSnippets: [{ title: 'Cleanup', content: 'return () => unsubscribe();' }],
          infoSnippets: [{ title: 'Lifecycle', content: 'Cleanup runs before the next effect.' }],
        })
      }
      throw new Error(`Unexpected route: ${url}`)
    }) as typeof fetch
    const client = new Context7RemoteClient({
      credentials: credentialFixture,
      fetch: fetchMock,
      random: () => 0.5,
      sleep: async () => undefined,
    })
    const request = providerInput(resolveConfig())

    const resolved = await client.resolve({ ...request, libraryName: 'React' })
    const selected = selectContext7Library(resolved.libraries, 'React', request.query)
    expect(selected?.id).toBe('/reactjs/react.dev')
    if (selected?.id === undefined) throw new Error('expected a selected Context7 library')
    const docs = await client.docs({ ...request, libraryId: selected.id })
    const source = context7LibrarySource(selected, 'https://context7.test', 4096)

    expect(resolved.attempts).toBe(1)
    expect(docs.attempts).toBe(1)
    expect(docs).toMatchObject({
      totalSnippets: 2,
      truncated: false,
    })
    expect(docs.snippets).toHaveLength(2)
    expect(source).toMatchObject({
      provider: 'context7',
      title: 'React',
      url: 'https://context7.test/reactjs/react.dev',
    })
    expect(docs.snippets[0]).toMatchObject({
      content: 'return () => unsubscribe();',
      title: 'Cleanup',
    })
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(2)
    const resolveUrl = new URL(calls[0]?.url ?? '')
    expect(resolveUrl.pathname).toBe('/api/v2/libs/search')
    expect(resolveUrl.searchParams.get('query')).toBe('React useEffect API docs')
    expect(resolveUrl.searchParams.get('libraryName')).toBe('React')
    expect(calls[1]?.url).toContain('libraryId=%2Freactjs%2Freact.dev')
    for (const call of calls) {
      expect(call.init?.redirect).toBe('manual')
      expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer context-secret')
      expect((call.init?.headers as Record<string, string>)['X-Context7-Source']).toBe('pi-search')
    }
  })

  it('uses Context7 keylessly when its optional credential is absent and parses plain text once', async () => {
    const credentialFixture = credentials([undefined, undefined], false)
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      expect((init?.headers as Record<string, string>)).not.toHaveProperty('Authorization')
      return url.includes('/api/v2/libs/search')
        ? jsonResponse([{ id: '/plain/docs', title: 'Plain Docs' }])
        : new Response('Plain Context7 documentation body')
    }) as typeof fetch
    const client = new Context7RemoteClient({ credentials: credentialFixture, fetch: fetchMock })
    const request = providerInput(resolveConfig(), 'Plain docs')

    const resolved = await client.resolve({ ...request, libraryName: 'Plain Docs' })
    const selected = selectContext7Library(resolved.libraries, 'Plain Docs', request.query)
    expect(selected?.id).toBe('/plain/docs')
    if (selected?.id === undefined) throw new Error('expected a selected keyless library')
    const docs = await client.docs({ ...request, libraryId: selected.id })

    expect(docs.snippets).toEqual([{ content: 'Plain Context7 documentation body' }])
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
  })

  it('re-resolves a rotated Context7 credential for each remote resolve and docs operation', async () => {
    const credentialFixture = credentials([
      'first-resolve-context',
      'first-docs-context',
      'second-resolve-context',
      'second-docs-context',
    ])
    const authorization: string[] = []
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      authorization.push((init?.headers as Record<string, string>).Authorization ?? '')
      return String(input).includes('/api/v2/libs/search')
        ? jsonResponse({ results: [{ id: '/react/react', title: 'React' }] })
        : jsonResponse({ codeSnippets: [] })
    }) as typeof fetch
    const client = new Context7RemoteClient({ credentials: credentialFixture, fetch: fetchMock })
    const config = resolveConfig()

    for (const query of ['first React API', 'second React API']) {
      const request = providerInput(config, query)
      const resolved = await client.resolve({ ...request, libraryName: 'React' })
      const libraryId = resolved.libraries[0]?.id
      if (libraryId === undefined) throw new Error('expected a resolved library')
      await client.docs({ ...request, libraryId })
    }

    expect(authorization).toEqual([
      'Bearer first-resolve-context',
      'Bearer first-docs-context',
      'Bearer second-resolve-context',
      'Bearer second-docs-context',
    ])
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(4)
  })

  it('keeps generic query phrases below explicit Context7 library identity', () => {
    const libraries = [
      {
        id: '/alibaba/hooks',
        title: 'Hooks',
        description: 'Official hooks documentation and API reference.',
        trustScore: 10,
        benchmarkScore: 100,
        totalSnippets: 50_000,
      },
      {
        id: '/example/api-reference',
        title: 'API Reference',
        description: 'Official API reference documentation.',
        trustScore: 10,
        benchmarkScore: 100,
        totalSnippets: 50_000,
      },
      {
        id: '/reactjs/react.dev',
        title: 'React',
        description: 'Official React documentation with API references and tutorials.',
        trustScore: 10,
        benchmarkScore: 89.45,
        totalSnippets: 6064,
        stars: 11_311,
      },
      {
        id: '/react/react',
        title: 'React',
        description: 'React source repository.',
        trustScore: 8.3,
        benchmarkScore: 78,
        totalSnippets: 6600,
        stars: 245_000,
      },
    ]

    expect(selectContext7Library(
      libraries,
      'React',
      'React useEffect API reference and hooks documentation',
    )?.id).toBe('/reactjs/react.dev')
  })

  it('sends the migrated Exa neural-search protocol and parses discovery metadata', async () => {
    const credentialFixture = credentials(['exa-secret'])
    let requestBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('https://exa.test/search')
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('exa-secret')
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        results: [{
          highlights: ['Official React reference'],
          publishedDate: '2026-01-01',
          title: 'React API Reference',
          url: 'https://react.dev/reference/react',
        }],
      })
    }) as typeof fetch
    const provider = new ExaProvider({ credentials: credentialFixture, fetch: fetchMock })

    const outcome = await provider.search(providerInput(resolveConfig()))

    expect(requestBody).toEqual({
      contents: { highlights: true },
      numResults: 3,
      query: 'React useEffect API docs',
      type: 'neural',
      useAutoprompt: true,
    })
    expect(outcome).toMatchObject({
      attempts: 1,
      state: 'complete',
      result: {
        sources: [{
          provider: 'exa',
          publishedAt: '2026-01-01',
          snippet: 'Official React reference',
          title: 'React API Reference',
          url: 'https://react.dev/reference/react',
        }],
      },
    })
  })
})

describe('Tavily and Firecrawl discovery Providers', () => {
  it('uses Tavily Search only for sources and never asks for an answer', async () => {
    const credentialFixture = credentials(['tavily-secret'])
    let body: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('https://tavily.test/search')
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tavily-secret')
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        answer: 'must be ignored',
        results: [{ content: 'Candidate excerpt', title: 'Candidate', url: 'https://example.test/a' }],
      })
    }) as typeof fetch
    const provider = new TavilySearchProvider({ credentials: credentialFixture, fetch: fetchMock })

    const outcome = await provider.search(providerInput(resolveConfig(), 'query', 2))

    expect(body).toEqual({
      include_answer: false,
      include_raw_content: false,
      max_results: 2,
      query: 'query',
      search_depth: 'advanced',
    })
    expect(outcome).toMatchObject({
      state: 'complete',
      result: { sources: [{ provider: 'tavily', url: 'https://example.test/a' }] },
    })
    expect(JSON.stringify(outcome)).not.toContain('must be ignored')
  })

  it('uses the Firecrawl v2 search route and data.web response', async () => {
    const credentialFixture = credentials(['firecrawl-secret'])
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('https://firecrawl.test/v2/search')
      expect(init?.redirect).toBe('manual')
      expect(JSON.parse(String(init?.body))).toEqual({ limit: 2, query: 'query' })
      return jsonResponse({
        data: { web: [{ description: 'Discovery only', title: 'Result', url: 'https://example.test/b' }] },
      })
    }) as typeof fetch
    const provider = new FirecrawlSearchProvider({ credentials: credentialFixture, fetch: fetchMock })

    await expect(provider.search(providerInput(resolveConfig(), 'query', 2))).resolves.toMatchObject({
      state: 'complete',
      result: { sources: [{ provider: 'firecrawl', url: 'https://example.test/b' }] },
    })
  })

  it.each([
    ['exa', (fixture: CredentialsFixture) => new ExaProvider({ credentials: fixture, fetch: vi.fn() as unknown as typeof fetch })],
    ['tavily', (fixture: CredentialsFixture) => new TavilySearchProvider({ credentials: fixture, fetch: vi.fn() as unknown as typeof fetch })],
    ['firecrawl', (fixture: CredentialsFixture) => new FirecrawlSearchProvider({ credentials: fixture, fetch: vi.fn() as unknown as typeof fetch })],
  ] as const)('treats a missing %s credential as not configured, not failed', async (_name, makeProvider) => {
    const credentialFixture = credentials([undefined], false)
    const provider = makeProvider(credentialFixture)

    await expect(provider.configured(resolveConfig())).resolves.toBe(false)
    await expect(provider.search(providerInput(resolveConfig()))).resolves.toEqual({ state: 'not_configured' })
  })

  it.each([
    {
      make: (credentialFixture: CredentialsFixture, fetchMock: typeof fetch) => (
        new ExaProvider({ credentials: credentialFixture, fetch: fetchMock })
      ),
      name: 'exa',
      response: { results: [] },
      secret: (headers: Record<string, string>) => headers['x-api-key'] ?? '',
    },
    {
      make: (credentialFixture: CredentialsFixture, fetchMock: typeof fetch) => (
        new TavilySearchProvider({ credentials: credentialFixture, fetch: fetchMock })
      ),
      name: 'tavily',
      response: { results: [] },
      secret: (headers: Record<string, string>) => headers.Authorization ?? '',
    },
    {
      make: (credentialFixture: CredentialsFixture, fetchMock: typeof fetch) => (
        new FirecrawlSearchProvider({ credentials: credentialFixture, fetch: fetchMock })
      ),
      name: 'firecrawl',
      response: { data: { web: [] } },
      secret: (headers: Record<string, string>) => headers.Authorization ?? '',
    },
  ])('resolves rotated $name credentials on the next operation without retaining them', async ({
    make,
    response,
    secret,
  }) => {
    const credentialFixture = credentials(['first-secret', 'second-secret'])
    const authorization: string[] = []
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      authorization.push(secret(init?.headers as Record<string, string>))
      return jsonResponse(response)
    }) as typeof fetch
    const provider = make(credentialFixture, fetchMock)
    const config = resolveConfig()

    await provider.search(providerInput(config, 'first'))
    await provider.search(providerInput(config, 'second'))

    const expected = provider.provider === 'exa'
      ? ['first-secret', 'second-secret']
      : ['Bearer first-secret', 'Bearer second-secret']
    expect(authorization).toEqual(expected)
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(provider)).not.toContain('first-secret')
    expect(JSON.stringify(provider)).not.toContain('second-secret')
  })
})

describe('supplemental Provider failure and resource boundaries', () => {
  function tavilyProvider(
    fetchImplementation: typeof fetch,
    config = resolveConfig(),
  ): { readonly config: SearchEnhanceConfig; readonly provider: BoundedSourceProvider } {
    return {
      config,
      provider: new TavilySearchProvider({
        credentials: credentials(['secret']),
        fetch: fetchImplementation,
        random: () => 0.5,
        sleep: async () => undefined,
      }),
    }
  }

  it('retries transient HTTP status and does not retry a permanent status', async () => {
    let transientCalls = 0
    const transientConfig = resolveConfig({ retry: { maxAttempts: 2 } })
    const transient = tavilyProvider(vi.fn(async () => {
      transientCalls += 1
      return transientCalls === 1
        ? new Response(null, { headers: { 'retry-after': '0' }, status: 503 })
        : jsonResponse({ results: [] })
    }) as typeof fetch, transientConfig)
    await expect(transient.provider.search(providerInput(transient.config))).resolves.toMatchObject({
      attempts: 2,
      state: 'complete',
    })
    expect(transientCalls).toBe(2)

    let permanentCalls = 0
    const permanent = tavilyProvider(vi.fn(async () => {
      permanentCalls += 1
      return new Response(null, { status: 400 })
    }) as typeof fetch, resolveConfig({ retry: { maxAttempts: 3 } }))
    await expect(permanent.provider.search(providerInput(permanent.config))).rejects.toMatchObject({
      kind: 'http',
      retryable: false,
      status: 400,
    })
    expect(permanentCalls).toBe(1)
  })

  it('enforces the exact streamed response byte limit including multibyte input', async () => {
    const body = JSON.stringify({ results: [{ content: '界🙂', url: 'https://example.test/multi' }] })
    const exactBytes = Buffer.byteLength(body, 'utf8')
    const fetchFactory = () => vi.fn(async () => new Response(body)) as typeof fetch

    const exact = tavilyProvider(fetchFactory(), resolveConfig({
      retention: { providerResponseMaxBytes: exactBytes },
    }))
    await expect(exact.provider.search(providerInput(exact.config))).resolves.toMatchObject({
      state: 'complete',
    })

    const over = tavilyProvider(fetchFactory(), resolveConfig({
      retention: { providerResponseMaxBytes: exactBytes - 1 },
    }))
    await expect(over.provider.search(providerInput(over.config))).rejects.toMatchObject({
      kind: 'budget_exceeded',
    })
  })

  it('keeps Provider source/result limits independent from source-record and canonical limits', async () => {
    const response = {
      results: Array.from({ length: 3 }, (_value, index) => ({
        content: `snippet ${index}`,
        title: `title ${index}`,
        url: `https://example.test/independent-${index}`,
      })),
    }
    const fetchFactory = () => vi.fn(async () => jsonResponse(response)) as typeof fetch
    const config = resolveConfig({
      retention: {
        canonicalOutputMaxBytes: 1,
        providerMaxSources: 2,
        providerResultMaxBytes: 64 * 1024,
        sourceEventMaxSources: 1,
      },
    })
    const independent = tavilyProvider(fetchFactory(), config)

    const outcome = await independent.provider.search(providerInput(config, 'query', 3))

    expect(outcome).toMatchObject({
      state: 'complete',
      result: {
        returnedSources: 2,
        totalSources: 3,
        truncated: true,
      },
    })
    if (outcome.state !== 'complete') throw new Error('expected complete outcome')
    const exactBytes = Buffer.byteLength(JSON.stringify(outcome.result), 'utf8')
    const exactConfig = resolveConfig({
      retention: { providerMaxSources: 2, providerResultMaxBytes: exactBytes },
    })
    await expect(tavilyProvider(fetchFactory(), exactConfig).provider.search(
      providerInput(exactConfig, 'query', 3),
    )).resolves.toMatchObject({ state: 'complete', result: { returnedSources: 2 } })

    const overConfig = resolveConfig({
      retention: { providerMaxSources: 2, providerResultMaxBytes: exactBytes - 1 },
    })
    await expect(tavilyProvider(fetchFactory(), overConfig).provider.search(
      providerInput(overConfig, 'query', 3),
    )).resolves.toMatchObject({
      state: 'complete',
      result: { returnedSources: 1, totalSources: 3, truncated: true },
    })
  })

  it('propagates caller cancellation exactly and starts no retry', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel supplemental request')
    let calls = 0
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const config = resolveConfig({ retry: { maxAttempts: 3 } })
    const fixture = tavilyProvider(vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      calls += 1
      started()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }) as typeof fetch, config)

    const pending = fixture.provider.search(providerInput(config, 'query', 2, controller.signal))
    await startedPromise
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(calls).toBe(1)
    try {
      await pending
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderError)
    }
  })

  it('reports genuine empty envelopes as complete and malformed envelopes as failures', async () => {
    const empty = tavilyProvider(vi.fn(async () => jsonResponse({})) as typeof fetch)
    await expect(empty.provider.search(providerInput(empty.config))).resolves.toMatchObject({
      state: 'complete',
      result: { sources: [], totalSources: 0 },
    })

    const malformed = tavilyProvider(vi.fn(async () => jsonResponse({ results: {} })) as typeof fetch)
    await expect(malformed.provider.search(providerInput(malformed.config))).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })
})

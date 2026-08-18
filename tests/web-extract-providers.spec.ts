import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  FirecrawlScrapeProvider,
  parseFirecrawlScrapeResponse,
  TavilyExtractProvider,
  parseTavilyExtractResponse,
} from '../src/providers/index.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import {
  WebExtractOrchestrator,
  type WebExtractAdapter,
  type WebExtractAdapterInput,
  type WebExtractFormat,
} from '../src/web-extract/index.js'

interface CredentialsFixture extends Pick<CredentialProvider, 'resolve'> {
  readonly resolve: ReturnType<typeof vi.fn<CredentialProvider['resolve']>>
}

function credentials(values: Array<string | undefined>): CredentialsFixture {
  const queue = [...values]
  return {
    resolve: vi.fn<CredentialProvider['resolve']>(async (
      _ref: CredentialRef,
    ): Promise<ResolvedCredential | undefined> => {
      const value = queue.shift()
      return value === undefined ? undefined : { source: 'fixture', value }
    }),
  }
}

type WebExtractOverrides = Partial<Omit<
  SearchEnhanceConfig['webExtract'],
  'tavily' | 'firecrawl' | 'smartDirect' | 'direct'
>> & {
  readonly tavily?: Partial<SearchEnhanceConfig['webExtract']['tavily']>
  readonly firecrawl?: Partial<SearchEnhanceConfig['webExtract']['firecrawl']>
  readonly smartDirect?: Partial<SearchEnhanceConfig['webExtract']['smartDirect']>
  readonly direct?: Partial<SearchEnhanceConfig['webExtract']['direct']>
}

function providerConfig(overrides: {
  readonly retry?: Partial<SearchEnhanceConfig['retry']>
  readonly webExtract?: WebExtractOverrides
} = {}): SearchEnhanceConfig {
  const base = Config({
    providers: {
      tavily: { baseUrl: 'https://tavily.fixture.test' },
      firecrawl: { baseUrl: 'https://firecrawl.fixture.test/v2' },
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
  const webExtract = overrides.webExtract
  return {
    ...base,
    retry: { ...base.retry, ...overrides.retry },
    webExtract: {
      ...base.webExtract,
      ...webExtract,
      tavily: { ...base.webExtract.tavily, ...webExtract?.tavily },
      firecrawl: { ...base.webExtract.firecrawl, ...webExtract?.firecrawl },
      smartDirect: { ...base.webExtract.smartDirect, ...webExtract?.smartDirect },
      direct: { ...base.webExtract.direct, ...webExtract?.direct },
    },
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function adapterInput(
  config: SearchEnhanceConfig,
  format: WebExtractFormat,
  signal = new AbortController().signal,
  onDispatch?: () => void,
): WebExtractAdapterInput {
  return {
    config,
    format,
    signal,
    url: 'https://example.test/article',
    ...(onDispatch === undefined ? {} : { onDispatch }),
  }
}

describe('Tavily Extract remote adapter', () => {
  it('uses the Pi POST protocol, supported formats, manual redirects, and explicit metadata', async () => {
    const credentialFixture = credentials(['tavily-secret'])
    let requestBody: unknown
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://tavily.fixture.test/extract')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tavily-secret')
      requestBody = JSON.parse(String(init?.body))
      return jsonResponse({
        results: [{
          raw_content: '  Tavily extracted body  ',
          url: 'https://example.test/final',
        }],
      })
    }) as typeof fetch
    const config = providerConfig()
    const provider = new TavilyExtractProvider({ credentials: credentialFixture, fetch: fetchMock })

    expect(provider.supports('markdown')).toBe(true)
    expect(provider.supports('text')).toBe(true)
    expect(provider.supports('html')).toBe(false)
    const outcome = await provider.extract(adapterInput(config, 'text'))

    expect(requestBody).toEqual({ format: 'text', urls: ['https://example.test/article'] })
    expect(outcome).toEqual({
      result: {
        content: 'Tavily extracted body',
        finalUrl: 'https://example.test/final',
        truncated: false,
      },
      state: 'complete',
    })
    expect(JSON.stringify(outcome)).not.toContain('tavily-secret')
  })

  it('resolves a rotated credential once per operation and retains no secret', async () => {
    const credentialFixture = credentials(['first-tavily', 'second-tavily'])
    const authorization: string[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      authorization.push((init?.headers as Record<string, string>).Authorization ?? '')
      return jsonResponse({ results: [{ raw_content: 'body' }] })
    }) as typeof fetch
    const provider = new TavilyExtractProvider({ credentials: credentialFixture, fetch: fetchMock })
    const config = providerConfig()

    await provider.extract(adapterInput(config, 'markdown'))
    await provider.extract(adapterInput(config, 'markdown'))

    expect(authorization).toEqual(['Bearer first-tavily', 'Bearer second-tavily'])
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(provider)).not.toContain('first-tavily')
    expect(JSON.stringify(provider)).not.toContain('second-tavily')
  })

  it('treats a missing credential and blank content as unavailable/skip states', async () => {
    const missing = new TavilyExtractProvider({
      credentials: credentials([undefined]),
      fetch: vi.fn() as unknown as typeof fetch,
    })
    const config = providerConfig()
    await expect(missing.extract(adapterInput(config, 'markdown'))).resolves.toEqual({
      state: 'not_configured',
    })

    const empty = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => jsonResponse({ results: [{ raw_content: '  ' }] })) as typeof fetch,
    })
    await expect(empty.extract(adapterInput(config, 'markdown'))).resolves.toEqual({
      state: 'unavailable',
    })
  })

  it('retries transient HTTP errors, never retries permanent errors, and preserves manual redirects', async () => {
    let transientCalls = 0
    const transientFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      transientCalls += 1
      return transientCalls === 1
        ? new Response(null, { status: 503, headers: { 'retry-after': '0' } })
        : jsonResponse({ results: [{ raw_content: 'recovered' }] })
    }) as typeof fetch
    const transient = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: transientFetch,
      sleep: async () => undefined,
    })
    const retryConfig = providerConfig({ retry: { maxAttempts: 2 } })
    await expect(transient.extract(adapterInput(retryConfig, 'markdown'))).resolves.toMatchObject({
      state: 'complete',
    })
    expect(transientCalls).toBe(2)

    let permanentCalls = 0
    const permanent = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        permanentCalls += 1
        expect(init?.redirect).toBe('manual')
        return new Response(null, {
          headers: { location: 'https://should-not-follow.fixture.test' },
          status: 302,
        })
      }) as typeof fetch,
    })
    await expect(permanent.extract(adapterInput(providerConfig({ retry: { maxAttempts: 3 } }), 'markdown')))
      .rejects.toMatchObject({ kind: 'http', status: 302, retryable: false })
    expect(permanentCalls).toBe(1)
  })

  it('propagates caller cancellation only after the owned request quiesces', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel Tavily fixture')
    let fetchQuiesced = false
    const fetchMock = vi.fn<typeof fetch>(async (_request, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === null || signal === undefined) throw new Error('fixture signal is missing')
      signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          fetchQuiesced = true
          reject(signal.reason)
        })
      }, { once: true })
    }))
    const provider = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: fetchMock,
    })
    const operation = provider.extract(adapterInput(providerConfig(), 'markdown', controller.signal))
    const rejection = expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })

    controller.abort(reason)

    await rejection
    expect(fetchQuiesced).toBe(true)
  })

  it('enforces exact streamed response bytes and Unicode content bounds', async () => {
    const body = JSON.stringify({ results: [{ raw_content: 'A界🙂' }] })
    const exactBytes = Buffer.byteLength(body, 'utf8')
    const exactConfig = providerConfig({
      webExtract: { tavily: { maxResponseBytes: exactBytes, maxContentCharacters: 3 } },
    })
    const exact = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    })
    await expect(exact.extract(adapterInput(exactConfig, 'markdown'))).resolves.toMatchObject({
      result: { content: 'A界🙂', truncated: false },
    })

    const overResponse = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    })
    await expect(overResponse.extract(adapterInput(providerConfig({
      webExtract: { tavily: { maxResponseBytes: exactBytes - 1 } },
    }), 'markdown'))).rejects.toMatchObject({ kind: 'budget_exceeded' })

    const truncated = new TavilyExtractProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    })
    await expect(truncated.extract(adapterInput(providerConfig({
      webExtract: { tavily: { maxContentCharacters: 2 } },
    }), 'markdown'))).resolves.toMatchObject({
      result: { content: 'A界', truncated: true },
    })
  })

  it('rejects malformed response envelopes with a fixed error category', () => {
    expect(() => parseTavilyExtractResponse(
      JSON.stringify({ results: {} }),
      'markdown',
      1000,
      1000,
    )).toThrowError(ProviderError)
  })
})

describe('Firecrawl Scrape remote adapter', () => {
  it('uses the Pi v2 endpoint/body and maps markdown, html, and raw formats', async () => {
    const requestBodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://firecrawl.fixture.test/v2/scrape')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer firecrawl-secret')
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const format = (requestBodies.at(-1)?.formats as string[] | undefined)?.[0]
      if (format === undefined) throw new Error('fixture format is missing')
      const field = format === 'rawHtml' ? 'rawHtml' : format
      return jsonResponse({ data: { [field]: `content-${format}` } })
    }) as typeof fetch
    const provider = new FirecrawlScrapeProvider({
      credentials: credentials(['firecrawl-secret', 'firecrawl-secret', 'firecrawl-secret']),
      fetch: fetchMock,
    })
    const config = providerConfig()

    expect(provider.supports('markdown')).toBe(true)
    expect(provider.supports('html')).toBe(true)
    expect(provider.supports('raw')).toBe(true)
    expect(provider.supports('text')).toBe(false)
    expect(provider.supports('json')).toBe(false)

    await expect(provider.extract(adapterInput(config, 'markdown'))).resolves.toMatchObject({
      result: { content: 'content-markdown' },
    })
    await expect(provider.extract(adapterInput(config, 'html'))).resolves.toMatchObject({
      result: { content: 'content-html' },
    })
    await expect(provider.extract(adapterInput(config, 'raw'))).resolves.toMatchObject({
      result: { content: 'content-rawHtml' },
    })
    expect(requestBodies).toEqual([
      { formats: ['markdown'], timeout: 60_000, url: 'https://example.test/article', waitFor: 1500 },
      { formats: ['html'], timeout: 60_000, url: 'https://example.test/article', waitFor: 1500 },
      { formats: ['rawHtml'], timeout: 60_000, url: 'https://example.test/article', waitFor: 1500 },
    ])
  })

  it('keeps only explicit Firecrawl metadata and never upgrades it to direct evidence', async () => {
    const provider = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => jsonResponse({
        data: {
          markdown: 'Firecrawl body',
          metadata: {
            author: 'Ada',
            canonicalUrl: 'https://example.test/canonical',
            contentType: 'text/html; charset=utf-8',
            publishedTime: '2026-01-02',
            sourceURL: 'https://example.test/final',
            statusCode: 201,
            title: 'Explicit title',
          },
        },
      })) as typeof fetch,
    })
    const outcome = await provider.extract(adapterInput(providerConfig(), 'markdown'))
    expect(outcome).toEqual({
      result: {
        author: 'Ada',
        canonicalUrl: 'https://example.test/canonical',
        content: 'Firecrawl body',
        contentType: 'text/html; charset=utf-8',
        finalUrl: 'https://example.test/final',
        publishedAt: '2026-01-02',
        statusCode: 201,
        title: 'Explicit title',
        truncated: false,
      },
      state: 'complete',
    })
  })

  it('resolves rotated Firecrawl credentials independently for each operation', async () => {
    const credentialFixture = credentials(['first-firecrawl', 'second-firecrawl'])
    const authorizations: Array<string | null> = []
    const fetchMock = vi.fn<typeof fetch>(async (_request, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return jsonResponse({ data: { markdown: 'body' } })
    })
    const provider = new FirecrawlScrapeProvider({
      credentials: credentialFixture,
      fetch: fetchMock,
    })

    await provider.extract(adapterInput(providerConfig(), 'markdown'))
    await provider.extract(adapterInput(providerConfig(), 'markdown'))

    expect(authorizations).toEqual(['Bearer first-firecrawl', 'Bearer second-firecrawl'])
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(provider)).not.toMatch(/first-firecrawl|second-firecrawl/)
  })

  it('retries empty scrape passes with Pi waitFor values and resolves one credential', async () => {
    let calls = 0
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return calls < 3
        ? jsonResponse({ data: { markdown: '' } })
        : jsonResponse({ data: { markdown: 'eventual body' } })
    }) as typeof fetch
    const credentialFixture = credentials(['rotated-once'])
    const provider = new FirecrawlScrapeProvider({ credentials: credentialFixture, fetch: fetchMock })

    await expect(provider.extract(adapterInput(providerConfig(), 'markdown'))).resolves.toMatchObject({
      result: { content: 'eventual body' },
    })
    expect(bodies.map(body => body.waitFor)).toEqual([1500, 3000, 4500])
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(1)
    expect(calls).toBe(3)
  })

  it('does not retry an anti-bot challenge as an empty scrape pass', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>'
    const fetchMock = vi.fn(async () => jsonResponse({ data: { markdown: challenge } })) as typeof fetch
    const provider = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: fetchMock,
    })

    await expect(provider.extract(adapterInput(
      providerConfig({ webExtract: { firecrawl: { maxEmptyAttempts: 3 } } }),
      'markdown',
    ))).rejects.toMatchObject({ kind: 'unavailable', provider: 'firecrawl_scrape' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns unavailable for empty content and skips text before any credential/network work', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { markdown: ' ' } })) as typeof fetch
    const provider = new FirecrawlScrapeProvider({ credentials: credentials(['secret']), fetch: fetchMock })
    const config = providerConfig({ webExtract: { firecrawl: { maxEmptyAttempts: 2 } } })

    await expect(provider.extract(adapterInput(config, 'markdown'))).resolves.toEqual({
      state: 'unavailable',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(provider.extract(adapterInput(config, 'text'))).resolves.toEqual({
      state: 'unavailable',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries temporary HTTP errors but stops on permanent errors and redirects manually', async () => {
    let temporaryCalls = 0
    const temporary = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual')
        temporaryCalls += 1
        return temporaryCalls === 1
          ? new Response(null, { status: 503 })
          : jsonResponse({ data: { html: '<p>recovered</p>' } })
      }) as typeof fetch,
      sleep: async () => undefined,
    })
    await expect(temporary.extract(adapterInput(providerConfig({ retry: { maxAttempts: 2 } }), 'html')))
      .resolves.toMatchObject({ result: { content: '<p>recovered</p>' } })
    expect(temporaryCalls).toBe(2)

    let permanentCalls = 0
    const permanent = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        permanentCalls += 1
        expect(init?.redirect).toBe('manual')
        return new Response(null, { status: 400 })
      }) as typeof fetch,
    })
    await expect(permanent.extract(adapterInput(providerConfig({ retry: { maxAttempts: 3 } }), 'markdown')))
      .rejects.toMatchObject({ kind: 'http', status: 400, retryable: false })
    expect(permanentCalls).toBe(1)
  })

  it('enforces response-byte and extracted-content Unicode limits', async () => {
    const body = JSON.stringify({ data: { markdown: 'A界🙂' } })
    const exactBytes = Buffer.byteLength(body, 'utf8')
    const exact = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    })
    await expect(exact.extract(adapterInput(providerConfig({
      webExtract: { firecrawl: { maxResponseBytes: exactBytes, maxContentCharacters: 3 } },
    }), 'markdown'))).resolves.toMatchObject({
      result: { content: 'A界🙂', truncated: false },
    })

    const over = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    })
    await expect(over.extract(adapterInput(providerConfig({
      webExtract: { firecrawl: { maxResponseBytes: exactBytes - 1 } },
    }), 'markdown'))).rejects.toMatchObject({ kind: 'budget_exceeded' })

    const bounded = new FirecrawlScrapeProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    })
    await expect(bounded.extract(adapterInput(providerConfig({
      webExtract: { firecrawl: { maxContentCharacters: 2 } },
    }), 'markdown'))).resolves.toMatchObject({
      result: { content: 'A界', truncated: true },
    })
  })

  it('parses malformed Firecrawl envelopes as fixed invalid responses', () => {
    expect(() => parseFirecrawlScrapeResponse(
      JSON.stringify({ data: [] }),
      'markdown',
      1000,
      1000,
    )).toThrowError(ProviderError)
    expect(() => parseFirecrawlScrapeResponse(
      JSON.stringify({ success: false }),
      'markdown',
      1000,
      1000,
    )).toThrowError(ProviderError)
  })
})

describe('remote extraction composition', () => {
  it('skips an unconfigured Tavily route and returns Firecrawl as extracted-content evidence', async () => {
    const credentialFixture = credentials([undefined, 'firecrawl-secret'])
    const fetchMock = vi.fn<typeof fetch>(async (request, init) => {
      expect(String(request)).toBe('https://firecrawl.fixture.test/v2/scrape')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer firecrawl-secret')
      return jsonResponse({
        data: {
          markdown: 'Firecrawl fallback body',
          metadata: { sourceURL: 'https://example.test/final', statusCode: 200 },
        },
      })
    })
    const unavailable = (route: 'smart_direct' | 'direct'): WebExtractAdapter => ({
      route,
      enabled: () => true,
      supports: () => true,
      extract: vi.fn(async () => ({ state: 'unavailable' as const })),
    })
    const resolvedConfig = providerConfig()
    const extractor = new WebExtractOrchestrator({
      tavilyExtract: new TavilyExtractProvider({ credentials: credentialFixture, fetch: fetchMock }),
      firecrawlScrape: new FirecrawlScrapeProvider({ credentials: credentialFixture, fetch: fetchMock }),
      smartDirect: unavailable('smart_direct'),
      direct: unavailable('direct'),
      getConfig: () => resolvedConfig,
      now: () => 100,
    })

    const result = await extractor.extract({
      format: 'markdown',
      signal: new AbortController().signal,
      url: 'https://example.test/article',
    })

    expect(result).toMatchObject({
      content: 'Firecrawl fallback body',
      evidenceLevel: 'extracted_content',
      finalUrl: 'https://example.test/final',
      retrievalRoute: 'firecrawl_scrape',
      statusCode: 200,
    })
    expect(result.attempts).toEqual([
      expect.objectContaining({
        outcome: 'skipped',
        provider: 'tavily_extract',
        skipReason: 'not_configured',
      }),
      expect.objectContaining({ outcome: 'success', provider: 'firecrawl_scrape' }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toContain('firecrawl-secret')
    expect(JSON.stringify(result)).not.toContain('direct_http_content')
  })

  it('continues through Tavily and Firecrawl challenge content to the next route', async () => {
    const challenge = '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>anti-bot-remote-secret'
    const credentialFixture = credentials(['tavily-secret', 'firecrawl-secret'])
    const fetchMock = vi.fn<typeof fetch>(async request => {
      const endpoint = String(request)
      if (endpoint.endsWith('/extract')) {
        return jsonResponse({ results: [{ raw_content: challenge, status: 200 }] })
      }
      if (endpoint.endsWith('/scrape')) {
        return jsonResponse({
          data: {
            markdown: 'Performing security verification. Verify you are human. anti-bot-remote-secret',
            metadata: { statusCode: 403 },
          },
        })
      }
      throw new Error('unexpected remote extraction endpoint')
    })
    const smartExtract = vi.fn(async () => ({
      result: { content: 'safe smart fallback content', truncated: false },
      state: 'complete' as const,
    }))
    const directExtract = vi.fn(async () => ({ state: 'unavailable' as const }))
    const config = providerConfig()
    const extractor = new WebExtractOrchestrator({
      tavilyExtract: new TavilyExtractProvider({ credentials: credentialFixture, fetch: fetchMock }),
      firecrawlScrape: new FirecrawlScrapeProvider({ credentials: credentialFixture, fetch: fetchMock }),
      smartDirect: {
        route: 'smart_direct',
        enabled: () => true,
        supports: () => true,
        extract: smartExtract,
      },
      direct: {
        route: 'direct',
        enabled: () => true,
        supports: () => true,
        extract: directExtract,
      },
      getConfig: () => config,
      now: () => 100,
    })

    const result = await extractor.extract({
      format: 'markdown',
      signal: new AbortController().signal,
      url: 'https://example.test/article',
    })

    expect(result).toMatchObject({
      content: 'safe smart fallback content',
      retrievalRoute: 'smart_direct',
    })
    expect(result.attempts).toEqual([
      expect.objectContaining({
        errorKind: 'unavailable',
        outcome: 'failed',
        provider: 'tavily_extract',
      }),
      expect.objectContaining({
        errorKind: 'unavailable',
        outcome: 'failed',
        provider: 'firecrawl_scrape',
      }),
      expect.objectContaining({ outcome: 'success', provider: 'smart_direct' }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(smartExtract).toHaveBeenCalledTimes(1)
    expect(directExtract).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('anti-bot-remote-secret')
  })
})

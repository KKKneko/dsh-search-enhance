import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  parseTavilyMapResponse,
  TavilyMapProvider,
} from '../src/providers/index.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import type { TavilyMapInput } from '../src/site-map/index.js'

interface CredentialsFixture extends Pick<CredentialProvider, 'resolve'> {
  readonly resolve: ReturnType<typeof vi.fn<CredentialProvider['resolve']>>
}

function credentials(values: Array<string | undefined | Error>): CredentialsFixture {
  const queue = [...values]
  return {
    resolve: vi.fn<CredentialProvider['resolve']>(async (
      _ref: CredentialRef,
    ): Promise<ResolvedCredential | undefined> => {
      const value = queue.shift()
      if (value instanceof Error) throw value
      return value === undefined ? undefined : { source: 'fixture', value }
    }),
  }
}

function config(overrides: {
  readonly retry?: Partial<SearchEnhanceConfig['retry']>
  readonly siteMap?: Partial<SearchEnhanceConfig['siteMap']>
} = {}): SearchEnhanceConfig {
  const base = Config({
    providers: { tavily: { baseUrl: 'https://tavily.fixture.test' } },
    retry: {
      baseDelayMs: 0,
      jitterRatio: 0,
      maxAttempts: 1,
      maxDelayMs: 0,
      maxTotalDelayMs: 0,
      multiplier: 1,
    },
  } as never)
  return {
    ...base,
    retry: { ...base.retry, ...overrides.retry },
    siteMap: { ...base.siteMap, ...overrides.siteMap },
  }
}

function input(
  value: SearchEnhanceConfig,
  signal = new AbortController().signal,
  overrides: Partial<TavilyMapInput> = {},
): TavilyMapInput {
  return {
    url: 'https://docs.example.test/',
    instructions: '  only API pages  ',
    maxDepth: 2,
    maxBreadth: 9,
    limit: 12,
    config: value,
    signal,
    ...overrides,
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(value)
  return new Response(body, {
    ...init,
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Tavily Map response parser', () => {
  it('accepts the strict optional shape, ignores unknown fields, validates URLs, and de-duplicates stably', () => {
    const parsed = parseTavilyMapResponse(JSON.stringify({
      base_url: ' https://docs.example.test/ ',
      results: [
        'https://Example.test/docs',
        'https://example.test/docs',
        'https://example.test/界🙂',
        'ftp://example.test/file',
        'https://user:secret@example.test/private',
        42,
        `https://example.test/${'x'.repeat(200)}`,
      ],
      response_time: 0,
      ignored: { authorization: 'must not be inspected' },
    }), 80)

    expect(parsed).toEqual({
      baseUrl: 'https://docs.example.test/',
      results: [
        'https://Example.test/docs',
        'https://example.test/界🙂',
      ],
      responseTime: 0,
      invalidResultUrls: 4,
      duplicateResultUrls: 1,
    })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.results)).toBe(true)
  })

  it('treats omitted results as a legitimate empty map and preserves no inferred optional facts', () => {
    expect(parseTavilyMapResponse(JSON.stringify({
      base_url: 'docs.example.test',
      response_time: 'fast',
      extra: true,
    }), 100)).toEqual({
      results: [],
      invalidResultUrls: 0,
      duplicateResultUrls: 0,
    })
  })

  it.each([
    ['not JSON', '{'],
    ['non-object root', '[]'],
    ['non-array results', '{"results":{}}'],
  ])('rejects %s with one generic invalid-response error', (_label, body) => {
    expect(() => parseTavilyMapResponse(body, 100)).toThrowError(ProviderError)
    try {
      parseTavilyMapResponse(body, 100)
    } catch (error) {
      expect(error).toMatchObject({
        capability: 'site_map',
        kind: 'invalid_response',
        provider: 'tavily',
      })
      expect(String(error)).not.toContain(body)
    }
  })
})

describe('Tavily Map production Provider', () => {
  it('sends the exact bounded read-only POST protocol, auth, timeout seconds, and manual redirect policy', async () => {
    const credentialFixture = credentials(['tavily-map-secret'])
    let capturedBody: unknown
    let dispatches = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://tavily.fixture.test/map')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tavily-map-secret')
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
      capturedBody = JSON.parse(String(init?.body))
      return jsonResponse({
        base_url: 'https://docs.example.test/',
        results: ['https://docs.example.test/api'],
        response_time: 1.25,
      })
    }) as typeof fetch
    const provider = new TavilyMapProvider({ credentials: credentialFixture, fetch: fetchMock })
    const value = config({ siteMap: { timeoutMs: 10_000 } })

    const result = await provider.map(input(value, undefined, {
      onDispatch: () => { dispatches += 1 },
    }))

    expect(capturedBody).toEqual({
      url: 'https://docs.example.test/',
      max_depth: 2,
      max_breadth: 9,
      limit: 12,
      timeout: 10,
      instructions: 'only API pages',
    })
    expect(result).toMatchObject({
      baseUrl: 'https://docs.example.test/',
      results: ['https://docs.example.test/api'],
      responseTime: 1.25,
      invalidResultUrls: 0,
      duplicateResultUrls: 0,
      attempts: 1,
      totalDelayMs: 0,
    })
    expect(result.responseBytes).toBeGreaterThan(0)
    expect(dispatches).toBe(1)
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('tavily-map-secret')
    expect(JSON.stringify(provider)).not.toContain('tavily-map-secret')
  })

  it('omits blank instructions and resolves a rotated credential once per operation', async () => {
    const credentialFixture = credentials(['first-map-key', 'second-map-key'])
    const authorization: string[] = []
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      authorization.push((init?.headers as Record<string, string>).Authorization ?? '')
      bodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({ results: [] })
    }) as typeof fetch
    const provider = new TavilyMapProvider({ credentials: credentialFixture, fetch: fetchMock })
    const value = config()

    await provider.map(input(value, undefined, { instructions: '   ' }))
    const { instructions: _instructions, ...withoutInstructions } = input(value)
    void _instructions
    await provider.map(withoutInstructions)

    expect(authorization).toEqual(['Bearer first-map-key', 'Bearer second-map-key'])
    expect(bodies).toHaveLength(2)
    expect(bodies.every(body => !Object.hasOwn(body as object, 'instructions'))).toBe(true)
    expect(credentialFixture.resolve).toHaveBeenCalledTimes(2)
  })

  it('fails missing or unreadable credentials at call time without dispatch or raw causes', async () => {
    for (const credentialFixture of [credentials([undefined]), credentials([new Error('raw secret backend')])]) {
      const fetchMock = vi.fn() as unknown as typeof fetch
      const provider = new TavilyMapProvider({ credentials: credentialFixture, fetch: fetchMock })
      let caught: unknown
      try {
        await provider.map(input(config()))
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({
        capability: 'site_map',
        kind: 'credential_missing',
        provider: 'tavily',
      })
      expect(String(caught)).not.toContain('raw secret backend')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it.each([408, 429, 500, 502, 503, 504])('retries transient HTTP %i for the read-only map operation', async status => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? new Response(null, { status, headers: status === 429 ? { 'retry-after': '0' } : {} })
        : jsonResponse({ results: ['https://docs.example.test/recovered'] })
    }) as typeof fetch
    const provider = new TavilyMapProvider({
      credentials: credentials(['secret']),
      fetch: fetchMock,
      sleep: async () => undefined,
    })

    const result = await provider.map(input(config({ retry: { maxAttempts: 2 } })))

    expect(result.attempts).toBe(2)
    expect(calls).toBe(2)
  })

  it.each([302, 400, 401, 403, 404])('does not retry permanent HTTP %i or follow redirects', async status => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, {
      status,
      headers: { location: 'https://credential-leak.invalid/' },
    }))
    const fetchMock = fetchSpy as typeof fetch
    const provider = new TavilyMapProvider({ credentials: credentials(['secret']), fetch: fetchMock })

    await expect(provider.map(input(config({ retry: { maxAttempts: 3 } }))))
      .rejects.toMatchObject({ kind: 'http', retryable: false, status })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  it('maps network failure to a generic retryable ProviderError without retaining the raw cause', async () => {
    const provider = new TavilyMapProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => { throw new Error('raw socket and header details') }) as typeof fetch,
    })

    let caught: unknown
    try {
      await provider.map(input(config()))
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      capability: 'site_map',
      kind: 'network',
      provider: 'tavily',
      retryable: true,
    })
    expect(String(caught)).not.toContain('raw socket and header details')
  })

  it('propagates caller cancellation only after the owned request quiesces', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel map fixture')
    let quiesced = false
    const fetchMock = vi.fn<typeof fetch>(async (_request, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === null || signal === undefined) throw new Error('fixture signal missing')
      signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          quiesced = true
          reject(signal.reason)
        })
      }, { once: true })
    }))
    const provider = new TavilyMapProvider({ credentials: credentials(['secret']), fetch: fetchMock })
    const operation = provider.map(input(config(), controller.signal))
    const rejected = expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })

    controller.abort(reason)

    await rejected
    expect(quiesced).toBe(true)
  })

  it('turns the configured deadline into a generic timeout after fetch quiesces', async () => {
    vi.useFakeTimers()
    let quiesced = false
    const fetchMock = vi.fn<typeof fetch>(async (_request, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === null || signal === undefined) throw new Error('fixture signal missing')
      signal.addEventListener('abort', () => {
        quiesced = true
        reject(signal.reason)
      }, { once: true })
    }))
    const provider = new TavilyMapProvider({ credentials: credentials(['secret']), fetch: fetchMock })
    const operation = provider.map(input(config({ siteMap: { timeoutMs: 10_000 } })))
    const rejected = expect(operation).rejects.toMatchObject({
      capability: 'site_map',
      kind: 'timeout',
      provider: 'tavily',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)

    await rejected
    expect(quiesced).toBe(true)
  })

  it('enforces complete response bytes at exact and over boundaries before parsing', async () => {
    const body = JSON.stringify({ results: ['https://docs.example.test/界🙂'] })
    const bytes = Buffer.byteLength(body)
    const exactProvider = new TavilyMapProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body, {
        headers: { 'content-length': String(bytes) },
      })) as typeof fetch,
    })
    await expect(exactProvider.map(input(config({ siteMap: { maxResponseBytes: bytes } }))))
      .resolves.toMatchObject({ results: ['https://docs.example.test/界🙂'], responseBytes: bytes })

    const overProvider = new TavilyMapProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn(async () => new Response(body, {
        headers: { 'content-length': String(bytes) },
      })) as typeof fetch,
    })
    await expect(overProvider.map(input(config({ siteMap: { maxResponseBytes: bytes - 1 } }))))
      .rejects.toMatchObject({ kind: 'budget_exceeded' })
  })

  it('rejects malformed Provider JSON/schema and invalid deployment/request bounds generically', async () => {
    for (const response of [new Response('{'), jsonResponse({ results: {} })]) {
      const provider = new TavilyMapProvider({
        credentials: credentials(['secret']),
        fetch: vi.fn(async () => response) as typeof fetch,
      })
      await expect(provider.map(input(config()))).rejects.toMatchObject({ kind: 'invalid_response' })
    }

    const provider = new TavilyMapProvider({
      credentials: credentials(['secret']),
      fetch: vi.fn() as unknown as typeof fetch,
    })
    await expect(provider.map(input(config(), undefined, { maxBreadth: 501 })))
      .rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(provider.map(input(config({ siteMap: { maxLinks: 5 } }), undefined, { limit: 6, maxBreadth: 5 })))
      .rejects.toMatchObject({ kind: 'invalid_request' })
    const invalidTimeoutConfig = {
      ...config(),
      siteMap: { ...config().siteMap, timeoutMs: 10_500 },
    }
    await expect(provider.map(input(invalidTimeoutConfig)))
      .rejects.toMatchObject({ kind: 'configuration' })
  })
})

import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import { resolveSearchStrategy } from '../src/search/index.js'
import {
  SearchApiProvider,
  type SearchApiProviderDependencies,
} from '../src/providers/search-api.js'

function resolveConfig(overrides: Record<string, unknown> = {}): SearchEnhanceConfig {
  const searchApi = typeof overrides.searchApi === 'object' && overrides.searchApi !== null
    ? overrides.searchApi as Record<string, unknown>
    : {}
  const retry = typeof overrides.retry === 'object' && overrides.retry !== null
    ? overrides.retry as Record<string, unknown>
    : {}
  const cache = typeof overrides.cache === 'object' && overrides.cache !== null
    ? overrides.cache as Record<string, unknown>
    : {}
  const retention = typeof overrides.retention === 'object' && overrides.retention !== null
    ? overrides.retention as Record<string, unknown>
    : {}
  return Config({
    ...overrides,
    cache: {
      maxEntries: 5,
      modelListMaxModels: 10,
      modelListTtlMinutes: 1,
      ...cache,
    },
    retention: {
      providerResponseMaxBytes: 64 * 1024,
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
    searchApi: {
      baseUrl: 'https://search.test/v1',
      model: 'model-a',
      timeoutMs: 1000,
      ...searchApi,
    },
  } as never)
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

function completionsResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] })
}

let nextSession = 0
function session(): Session {
  nextSession += 1
  return Session.create(SessionId(`search-provider-${nextSession}`))
}

function pluginEvents(value: Session) {
  return value.events.filter(event => String(event.type).startsWith('search-enhance/'))
}

interface ProviderFixtureOptions {
  readonly config?: SearchEnhanceConfig
  readonly fetch: typeof globalThis.fetch
  readonly resolveCredential?: SearchApiProviderDependencies['credentials']['resolve']
  readonly clock?: SearchApiProviderDependencies['clock']
  readonly timeZone?: SearchApiProviderDependencies['timeZone']
  readonly cacheNow?: SearchApiProviderDependencies['cacheNow']
  readonly retryNow?: SearchApiProviderDependencies['retryNow']
}

function providerFixture(options: ProviderFixtureOptions): {
  readonly provider: SearchApiProvider
  readonly resolveCredential: ReturnType<typeof vi.fn>
  readonly getConfig: ReturnType<typeof vi.fn>
} {
  const config = options.config ?? resolveConfig()
  const resolveCredential = vi.fn(options.resolveCredential ?? (async () => ({
    source: 'test',
    value: 'secret-a',
  })))
  const getConfig = vi.fn(() => config)
  return {
    getConfig,
    provider: new SearchApiProvider({
      credentials: { resolve: resolveCredential },
      fetch: options.fetch,
      getConfig,
      random: () => 0.5,
      sleep: async () => undefined,
      ...(options.cacheNow === undefined ? {} : { cacheNow: options.cacheNow }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.retryNow === undefined ? {} : { retryNow: options.retryNow }),
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    }),
    resolveCredential,
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('Search API provider dispatch without session auditing', () => {
  it('dispatches with manual redirects without appending plugin events or flushing sessions', async () => {
    const operationSession = session()
    const legacyFlush = vi.fn(async () => true)
    const order: string[] = []
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      requests.push({ init, url })
      if (url.endsWith('/models')) {
        order.push('models')
        return jsonResponse({ data: [{ id: 'model-a', ignored: true }] })
      }
      order.push('dispatch')
      expect(pluginEvents(operationSession)).toHaveLength(0)
      return completionsResponse(`Verified answer.

Sources:
- [Primary](https://primary.example.test/record)`)
    }) as typeof fetch
    const resolveCredential = vi.fn(async () => ({ source: 'test', value: 'secret-a' }))
    const legacyDependencies = {
      credentials: { resolve: resolveCredential },
      fetch: fetchMock,
      getConfig: () => resolveConfig(),
      random: () => 0.5,
      sessions: { flush: legacyFlush },
      sleep: async () => undefined,
    }
    const provider = new SearchApiProvider(legacyDependencies)
    const legacyInput = {
      depth: 'normal',
      profile: 'fact_check',
      query: 'verify this claim',
      session: operationSession,
      signal: signal(),
    }

    const result = await provider.search(legacyInput)

    expect(order).toEqual(['models', 'dispatch'])
    expect(result).toMatchObject({
      answer: 'Verified answer.',
      attempts: 1,
      model: 'model-a',
      modelValidation: 'validated',
      protocol: 'completions',
      sources: [{
        provider: 'search-api',
        title: 'Primary',
        url: 'https://primary.example.test/record',
      }],
    })
    expect(resolveCredential).toHaveBeenCalledTimes(1)
    expect(legacyFlush).not.toHaveBeenCalled()
    expect(pluginEvents(operationSession)).toHaveLength(0)
    expect(operationSession.events).toHaveLength(0)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.init?.redirect).toBe('manual')
      expect((request.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-a')
    }
    const dispatchedBody = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>
    expect(dispatchedBody).toMatchObject({ model: 'model-a', stream: true })
    expect(JSON.stringify(dispatchedBody)).toContain('# Search Profile: Fact Check')
    expect(JSON.stringify(operationSession.events)).not.toContain('secret-a')
  })

  it('uses the Provider collection cap while preserving answer-cited sources', async () => {
    const config = resolveConfig({
      retention: {
        providerMaxSources: 100,
        sourceEventMaxSources: 1,
      },
    })
    const trailingSources = Array.from(
      { length: 100 },
      (_, index) => `- [Tail ${index + 1}](https://tail.example.test/${index + 1})`,
    ).join('\n')
    let postedBody = ''
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      postedBody = String(init?.body)
      return completionsResponse(`Use the [official URL API reference](https://developer.mozilla.org/en-US/docs/Web/API/URL).\n\nSources:\n${trailingSources}`)
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    const result = await fixture.provider.search({
      query: 'collect sources',
      signal: signal(),
    })

    const sourceUrls = result.sources.map(source => source.url)
    expect(sourceUrls).toHaveLength(100)
    expect(sourceUrls.slice(0, 2)).toEqual([
      'https://developer.mozilla.org/en-US/docs/Web/API/URL',
      'https://tail.example.test/1',
    ])
    expect(sourceUrls.at(-1)).toBe('https://tail.example.test/99')
    expect(sourceUrls).not.toContain('https://tail.example.test/100')
    expect(result.sourcesTruncated).toBe(true)
    expect(postedBody).toContain('Return at most 100 source links')
  })

  it('dispatches the Responses protocol body and parses its non-streaming envelope', async () => {
    let endpoint = ''
    let body: Record<string, unknown> | undefined
    const config = resolveConfig({
      searchApi: {
        protocol: 'responses',
        thinkingLevel: 'xhigh',
      },
    })
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      endpoint = String(input)
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ output_text: 'Responses answer' })
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    const result = await fixture.provider.search({
      query: 'query',
      signal: signal(),
    })

    expect(endpoint).toBe('https://search.test/v1/responses')
    expect(body).toMatchObject({
      input: 'query',
      model: 'model-a',
      reasoning: { effort: 'xhigh' },
      store: false,
      stream: true,
    })
    expect(body).not.toHaveProperty('messages')
    expect(result).toMatchObject({ answer: 'Responses answer', protocol: 'responses' })
  })

  it('uses a caller-owned Config/strategy snapshot without resolving Config again', async () => {
    const operationConfig = resolveConfig({ defaultProfile: 'project_research' })
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('/models')
        ? jsonResponse({})
        : completionsResponse('Resolved answer')) as typeof fetch
    const fixture = providerFixture({ fetch: fetchMock })

    const result = await fixture.provider.searchResolved({
      config: operationConfig,
      query: 'project release notes',
      signal: signal(),
      strategy: resolveSearchStrategy(operationConfig, {
        depth: 'normal',
        profile: 'project_research',
      }),
    })

    expect(result.answer).toBe('Resolved answer')
    expect(fixture.getConfig).not.toHaveBeenCalled()
  })

  it('captures temporal context once and skips the user clock for non-temporal work', async () => {
    const clock = vi.fn(() => new Date('2026-02-03T04:05:06Z'))
    const postedInputs: string[] = []
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      postedInputs.push(body.messages.at(-1)?.content ?? '')
      return completionsResponse('Answer')
    }) as typeof fetch
    const fixture = providerFixture({ clock, fetch: fetchMock, timeZone: 'UTC' })

    await fixture.provider.search({
      query: 'What is the latest release?',
      signal: signal(),
    })
    expect(clock).toHaveBeenCalledTimes(1)
    expect(postedInputs[0]).toBe(
      '[Current Time Context]\n'
      + '- Date: 2026-02-03\n'
      + '- Time: 04:05:06\n'
      + '- Timezone: UTC\n\n'
      + 'What is the latest release?',
    )

    clock.mockClear()
    await fixture.provider.search({
      query: 'Explain dependency injection.',
      signal: signal(),
    })
    expect(clock).not.toHaveBeenCalled()
    expect(postedInputs[1]).toBe('Explain dependency injection.')
  })

  it('resolves credentials per operation and applies rotation to the next request', async () => {
    const secrets = ['secret-a', 'secret-b']
    const mainAuthorization: string[] = []
    const modelAuthorization: string[] = []
    const resolveCredential = vi.fn(async () => ({
      source: 'test',
      value: secrets.shift() ?? 'unexpected',
    }))
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).Authorization ?? ''
      if (String(input).endsWith('/models')) {
        modelAuthorization.push(authorization)
        return jsonResponse({})
      }
      mainAuthorization.push(authorization)
      return completionsResponse('Answer')
    }) as typeof fetch
    const fixture = providerFixture({ fetch: fetchMock, resolveCredential })

    await fixture.provider.search({ query: 'first', signal: signal() })
    await fixture.provider.search({ query: 'second', signal: signal() })

    expect(resolveCredential).toHaveBeenCalledTimes(2)
    expect(mainAuthorization).toEqual(['Bearer secret-a', 'Bearer secret-b'])
    expect(modelAuthorization).toEqual(['Bearer secret-a', 'Bearer secret-b'])
    expect(JSON.stringify(fixture.provider)).not.toContain('secret-a')
    expect(JSON.stringify(fixture.provider)).not.toContain('secret-b')
  })

  it('does not dispatch when credential resolution is missing or cancellation wins first', async () => {
    const noCredentialSession = session()
    const fetchMock = vi.fn() as unknown as typeof fetch
    const missing = providerFixture({
      fetch: fetchMock,
      resolveCredential: async () => undefined,
    })
    const missingInput = {
      query: 'query',
      session: noCredentialSession,
      signal: signal(),
    }

    await expect(missing.provider.search(missingInput)).rejects.toMatchObject({
      kind: 'credential_missing',
    })
    expect(pluginEvents(noCredentialSession)).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()

    const controller = new AbortController()
    const reason = new Error('caller cancelled before dispatch')
    const cancelledSession = session()
    const cancelled = providerFixture({
      fetch: fetchMock,
      resolveCredential: async () => {
        controller.abort(reason)
        return { source: 'test', value: 'secret' }
      },
    })
    const cancelledInput = {
      query: 'query',
      session: cancelledSession,
      signal: controller.signal,
    }
    await expect(cancelled.provider.search(cancelledInput)).rejects.toBe(reason)
    expect(pluginEvents(cancelledSession)).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'http'],
    [200, 'invalid_response'],
  ])('appends no plugin event after a %i HTTP/parse failure', async (status, kind) => {
    const operationSession = session()
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      return status === 200 ? new Response('{broken-json') : new Response(null, { status })
    }) as typeof fetch
    const fixture = providerFixture({ fetch: fetchMock })

    const legacyInput = {
      query: 'query',
      session: operationSession,
      signal: signal(),
    }
    await expect(fixture.provider.search(legacyInput)).rejects.toMatchObject({ kind })
    expect(pluginEvents(operationSession)).toHaveLength(0)
    expect(operationSession.events).toHaveLength(0)
  })
})

describe('Search API model discovery and validation', () => {
  it('implements bounded TTL hit, miss, expiry, and explicit refresh', async () => {
    let now = 0
    let listNumber = 0
    const fetchSpy = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: RequestInit,
    ) => {
      listNumber += 1
      return jsonResponse({ data: [{ id: `model-${listNumber}` }] })
    })
    const fixture = providerFixture({
      cacheNow: () => now,
      fetch: fetchSpy as unknown as typeof fetch,
    })

    const miss = await fixture.provider.listModels(signal())
    const hit = await fixture.provider.listModels(signal())
    now = 60_000
    const expired = await fixture.provider.listModels(signal())
    const refreshed = await fixture.provider.refreshModels(signal())

    expect(miss).toMatchObject({ cache: 'miss', models: ['model-1'] })
    expect(hit).toMatchObject({ attempts: 0, cache: 'hit', models: ['model-1'] })
    expect(expired).toMatchObject({ cache: 'miss', models: ['model-2'] })
    expect(refreshed).toMatchObject({ cache: 'refresh', models: ['model-3'] })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    for (const call of fetchSpy.mock.calls) {
      expect(call[1]?.redirect).toBe('manual')
    }
  })

  it('supports a bounded diagnostic refresh without reading or writing the model cache', async () => {
    let listNumber = 0
    const onDispatch = vi.fn()
    const fetchSpy = vi.fn(async () => {
      listNumber += 1
      return jsonResponse({ data: [{ id: `model-${listNumber}` }] })
    })
    const fixture = providerFixture({ fetch: fetchSpy as unknown as typeof fetch })

    const diagnostic = await fixture.provider.listModels(signal(), {
      cache: false,
      refresh: true,
      onDispatch,
    })
    const ordinary = await fixture.provider.listModels(signal())

    expect(diagnostic).toMatchObject({ cache: 'refresh', models: ['model-1'] })
    expect(ordinary).toMatchObject({ cache: 'miss', models: ['model-2'] })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(onDispatch).toHaveBeenCalledTimes(1)
  })

  it('retries a transient model-list request under the bounded policy', async () => {
    let calls = 0
    const config = resolveConfig({ retry: { maxAttempts: 2 } })
    const fetchMock = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? new Response(null, { status: 503 })
        : jsonResponse({ data: [{ id: 'model-a' }] })
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    const result = await fixture.provider.listModels(signal())
    expect(result).toMatchObject({ attempts: 2, models: ['model-a'] })
    expect(calls).toBe(2)
  })

  it('does not reject a configured model when no non-empty list is available', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('/models')
        ? jsonResponse({ metadata: { list: 'not advertised' } })
        : completionsResponse('Answer')) as typeof fetch
    const fixture = providerFixture({ fetch: fetchMock })

    const result = await fixture.provider.search({
      query: 'query',
      signal: signal(),
    })
    expect(result.modelValidation).toBe('unavailable')
    expect(result.answer).toBe('Answer')
  })

  it('rejects an explicit model only when a valid non-empty list disproves it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'other-model' }] })) as typeof fetch
    const fixture = providerFixture({ fetch: fetchMock })

    await expect(fixture.provider.search({
      query: 'query',
      signal: signal(),
    })).rejects.toMatchObject({ kind: 'configuration' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ data: 'broken' }, 'invalid_response'],
    [{ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, 'budget_exceeded'],
  ])('rejects a damaged or over-limit model list (%s)', async (payload, kind) => {
    const config = resolveConfig({ cache: { modelListMaxModels: 2 } })
    const fixture = providerFixture({
      config,
      fetch: vi.fn(async () => jsonResponse(payload)) as typeof fetch,
    })
    await expect(fixture.provider.listModels(signal())).rejects.toMatchObject({ kind })
  })

  it('treats damaged model discovery as unavailable during search, not as a false mismatch', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('/models')
        ? jsonResponse({ data: 'broken' })
        : completionsResponse('Main search still ran')) as typeof fetch
    const fixture = providerFixture({ fetch: fetchMock })

    const result = await fixture.provider.search({
      query: 'query',
      signal: signal(),
    })
    expect(result).toMatchObject({
      answer: 'Main search still ran',
      modelValidation: 'unavailable',
    })
  })

  it('evicts model-list cache entries at the configured entry bound', async () => {
    const credentials = ['one', 'two', 'one']
    const config = resolveConfig({ cache: { maxEntries: 1 } })
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'model-a' }] })) as typeof fetch
    const fixture = providerFixture({
      config,
      fetch: fetchMock,
      resolveCredential: async () => ({ source: 'test', value: credentials.shift() ?? 'missing' }),
    })

    await fixture.provider.listModels(signal())
    await fixture.provider.listModels(signal())
    await fixture.provider.listModels(signal())
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('Search API retries, cancellation, timeout, and response bounds', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries transient HTTP %i exactly once', async (status) => {
    let mainCalls = 0
    const config = resolveConfig({ retry: { maxAttempts: 2 } })
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      mainCalls += 1
      if (mainCalls === 1) {
        return new Response(null, {
          headers: status === 429 ? { 'retry-after': '0' } : {},
          status,
        })
      }
      return completionsResponse('Recovered')
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    const result = await fixture.provider.search({
      query: 'query',
      signal: signal(),
    })
    expect(result).toMatchObject({ answer: 'Recovered', attempts: 2 })
    expect(mainCalls).toBe(2)
  })

  it.each([400, 401, 403, 404, 409, 422])('does not retry non-transient HTTP %i', async (status) => {
    let mainCalls = 0
    const config = resolveConfig({ retry: { maxAttempts: 3 } })
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      mainCalls += 1
      return new Response(null, { status })
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    await expect(fixture.provider.search({
      query: 'query',
      signal: signal(),
    })).rejects.toMatchObject({ status })
    expect(mainCalls).toBe(1)
  })

  it('ends immediately on caller cancellation without starting a retry', async () => {
    const controller = new AbortController()
    const reason = new Error('stop now')
    let mainCalls = 0
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const config = resolveConfig({ retry: { maxAttempts: 3 } })
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      mainCalls += 1
      started()
      return new Promise<Response>((_resolve, reject) => {
        const requestSignal = init?.signal
        requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
      })
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    const pending = fixture.provider.search({
      query: 'query',
      signal: controller.signal,
    })
    await startedPromise
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(mainCalls).toBe(1)
  })

  it('maps a uniform request deadline to timeout rather than cancellation', async () => {
    const config = resolveConfig({ searchApi: { timeoutMs: 5 } })
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/models')) return jsonResponse({})
      return new Promise<Response>((_resolve, reject) => {
        const requestSignal = init?.signal
        requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
      })
    }) as typeof fetch
    const fixture = providerFixture({ config, fetch: fetchMock })

    await expect(fixture.provider.search({
      query: 'query',
      signal: signal(),
    })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('accepts an exact multibyte response cap and rejects one byte below it', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: '界🙂' } }] })
    const exactBytes = Buffer.byteLength(body, 'utf8')
    const makeFetch = () => vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('/models') ? jsonResponse({}) : new Response(body)) as typeof fetch

    const exact = providerFixture({
      config: resolveConfig({ retention: { providerResponseMaxBytes: exactBytes } }),
      fetch: makeFetch(),
    })
    await expect(exact.provider.search({
      query: 'query',
      signal: signal(),
    })).resolves.toMatchObject({ answer: '界🙂' })

    const over = providerFixture({
      config: resolveConfig({ retention: { providerResponseMaxBytes: exactBytes - 1 } }),
      fetch: makeFetch(),
    })
    await expect(over.provider.search({
      query: 'query',
      signal: signal(),
    })).rejects.toMatchObject({ kind: 'budget_exceeded' })
  })

  it('never wraps explicit caller cancellation in ProviderError', async () => {
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)
    const fixture = providerFixture({ fetch: vi.fn() as unknown as typeof fetch })

    try {
      await fixture.provider.search({
        query: 'query',
        signal: controller.signal,
      })
      throw new Error('expected cancellation')
    } catch (error) {
      expect(error).toBe(reason)
      expect(error).not.toBeInstanceOf(ProviderError)
    }
  })
})

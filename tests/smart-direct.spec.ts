import { Context, type Context as CordisContext } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DefuddleResponse } from 'defuddle/node'

import { Config, type Config as ConfigValue, type SmartDirectConfig } from '../src/config.js'
import {
  OutputLimitError,
  ProviderError,
} from '../src/provider-runtime/index.js'
import {
  SmartDirectProvider,
  type SmartDirectExtract,
  type SmartDirectProviderDependencies,
} from '../src/providers/smart-direct.js'
import {
  SMART_DIRECT_ACCEPT,
  SMART_DIRECT_ACCEPT_ENCODING,
  SMART_DIRECT_ACCEPT_LANGUAGE,
  type SmartDirectResponseHeaders,
  type SmartDirectTransportHandle,
  type SmartDirectWreqOptions,
  type SmartDirectWreqResponse,
} from '../src/providers/smart-direct-transport.js'
import type {
  WebExtractAdapterInput,
  WebExtractAdapterResult,
  WebExtractFormat,
} from '../src/web-extract/types.js'
import { createHttpProxyFixture } from './proxy-fixture.js'

interface LocalFixture {
  readonly origin: string
  readonly sockets: ReadonlySet<Socket>
  close(): Promise<void>
}

const fixtures: LocalFixture[] = []

async function localFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalFixture> {
  const sockets = new Set<Socket>()
  const server = createServer(handler)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const fixture: LocalFixture = {
    origin: `http://127.0.0.1:${address.port}`,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (fixtures.length > 0) await fixtures.pop()?.close()
})

interface TestConfigOverrides {
  readonly smart?: Partial<SmartDirectConfig>
  readonly retry?: Partial<ConfigValue['retry']>
  readonly maxUrlCharacters?: number
  readonly maxContentCharacters?: number
}

function testConfig(overrides: TestConfigOverrides = {}): ConfigValue {
  return Config({
    retry: overrides.retry ?? {},
    webExtract: {
      ...(overrides.maxUrlCharacters === undefined ? {} : { maxUrlCharacters: overrides.maxUrlCharacters }),
      ...(overrides.maxContentCharacters === undefined ? {} : { maxContentCharacters: overrides.maxContentCharacters }),
      smartDirect: overrides.smart ?? {},
    },
  } as never)
}

function adapterInput(
  url: string,
  config: ConfigValue,
  format: WebExtractFormat = 'markdown',
  signal: AbortSignal = new AbortController().signal,
  onDispatch?: () => void,
): WebExtractAdapterInput {
  return {
    config,
    format,
    signal,
    url,
    ...(onDispatch === undefined ? {} : { onDispatch }),
  }
}

async function completeResult(
  provider: SmartDirectProvider,
  input: WebExtractAdapterInput,
): Promise<WebExtractAdapterResult> {
  const outcome = await provider.extract(input)
  expect(outcome.state).toBe('complete')
  if (outcome.state !== 'complete') throw new Error(`expected complete, received ${outcome.state}`)
  return outcome.result
}

const ARTICLE_TEXT = [
  'This deterministic article contains enough meaningful words for Defuddle to select it.',
  'A second paragraph verifies extraction while scripts remain entirely unexecuted.',
].join(' ')

function articleHtml(extraHead = '', body = ARTICLE_TEXT): string {
  return `<!doctype html><html><head><title>Fixture title</title><meta name="author" content="Ada"><meta property="article:published_time" content="2026-08-15"><link rel="canonical" href="/canonical">${extraHead}</head><body><nav>Noise</nav><main><article><h1>Fixture title</h1><p>${body}</p><p>Additional stable words keep this readable article non-empty.</p></article></main></body></html>`
}

function defuddleResult(content: string, wordCount = 10): DefuddleResponse {
  return {
    author: 'inferred author must not be copied',
    content,
    description: '',
    domain: 'inferred.test',
    favicon: '',
    image: '',
    language: '',
    parseTime: 1,
    published: 'inferred date must not be copied',
    schemaOrgData: [],
    site: '',
    title: 'inferred title must not be copied',
    wordCount,
  }
}

class TestHeaders implements SmartDirectResponseHeaders {
  private readonly values: readonly [string, string][]

  constructor(values: Record<string, string>) {
    this.values = Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])
  }

  get(name: string): string | null {
    return this.values.find(([candidate]) => candidate === name.toLowerCase())?.[1] ?? null
  }

  [Symbol.iterator](): Iterator<[string, string]> {
    return this.values[Symbol.iterator]()
  }
}

function fakeResponse(input: {
  readonly body?: string | Buffer
  readonly headers?: Record<string, string>
  readonly status?: number
  readonly url?: string
  readonly chunks?: readonly Buffer[]
  readonly onCancel?: () => void
} = {}): SmartDirectWreqResponse {
  const bytes = typeof input.body === 'string'
    ? Buffer.from(input.body)
    : input.body ?? Buffer.from(articleHtml())
  const readable = Readable.from(input.chunks ?? [bytes])
  let cancelled = false
  return {
    body: {
      async cancel() {
        if (cancelled) return
        cancelled = true
        input.onCancel?.()
        readable.destroy()
      },
    },
    headers: new TestHeaders({
      'content-type': 'text/html; charset=utf-8',
      ...(input.headers ?? {}),
    }),
    readable: () => readable,
    status: input.status ?? 200,
    url: input.url ?? 'https://target.example/article',
  }
}

function fakeTransport(): SmartDirectTransportHandle & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(async () => undefined) }
}

function fakeProvider(input: {
  readonly response?: () => SmartDirectWreqResponse | Promise<SmartDirectWreqResponse>
  readonly extract?: SmartDirectExtract
  readonly createTransport?: SmartDirectProviderDependencies['createTransport']
  readonly sleep?: SmartDirectProviderDependencies['sleep']
  readonly now?: SmartDirectProviderDependencies['now']
} = {}): {
  readonly provider: SmartDirectProvider
  readonly transport: ReturnType<typeof fakeTransport>
  readonly fetch: ReturnType<typeof vi.fn>
  readonly createTransport: ReturnType<typeof vi.fn>
} {
  const transport = fakeTransport()
  const createTransport = vi.fn(input.createTransport ?? (async () => transport))
  const fetch = vi.fn(async () => input.response?.() ?? fakeResponse())
  return {
    createTransport,
    fetch,
    provider: new SmartDirectProvider({
      createTransport,
      fetch,
      ...(input.extract === undefined ? { extract: async () => defuddleResult('cleaned content') } : { extract: input.extract }),
      ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    transport,
  }
}

describe('SmartDirectProvider public wreq transport', () => {
  it('supports only markdown/html/text and is enabled by default', () => {
    const provider = new SmartDirectProvider()
    const config = testConfig()
    expect(provider.route).toBe('smart_direct')
    expect(provider.enabled(config)).toBe(true)
    expect(['markdown', 'html', 'text'].map(format => provider.supports(format as WebExtractFormat))).toEqual([true, true, true])
    expect(provider.supports('json')).toBe(false)
    expect(provider.supports('raw')).toBe(false)
  })

  it('passes fixed fingerprints, timeouts, headers, manual redirect, raw compression, and signal through public wreq options', async () => {
    const extract = vi.fn(async () => defuddleResult('# Cleaned\n\nBody words'))
    const seam = fakeProvider({ extract })
    let dispatches = 0
    const config = testConfig({
      smart: {
        browser: 'firefox_147',
        connectTimeoutMs: 1234,
        includeReplies: true,
        os: 'linux',
        processingTimeoutMs: 4321,
        proxyUrl: 'http://127.0.0.1:7890',
        readTimeoutMs: 2345,
        removeImages: true,
        timeoutMs: 5432,
      },
    })
    const result = await completeResult(
      seam.provider,
      adapterInput('https://target.example/article', config, 'markdown', undefined, () => { dispatches += 1 }),
    )

    expect(dispatches).toBe(1)
    expect(seam.createTransport).toHaveBeenCalledWith({
      browser: 'firefox_147',
      connectTimeout: 1234,
      os: 'linux',
      readTimeout: 2345,
      proxy: 'http://127.0.0.1:7890',
    })
    expect(seam.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = seam.fetch.mock.calls[0] as unknown as [string, SmartDirectWreqOptions]
    expect(url).toBe('https://target.example/article')
    expect(options).toMatchObject({
      compress: false,
      method: 'GET',
      redirect: 'manual',
      timeout: 5432,
      transport: seam.transport,
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.headers).toEqual({
      Accept: SMART_DIRECT_ACCEPT,
      'Accept-Encoding': SMART_DIRECT_ACCEPT_ENCODING,
      'Accept-Language': SMART_DIRECT_ACCEPT_LANGUAGE,
      Connection: 'close',
    })
    expect(extract).toHaveBeenCalledWith(expect.anything(), 'https://target.example/article', {
      includeReplies: true,
      markdown: true,
      removeImages: true,
      useAsync: false,
    })
    expect(seam.transport.close).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      content: '# Cleaned\n\nBody words',
      decompressedBytes: Buffer.byteLength(articleHtml()),
      encodedBytes: Buffer.byteLength(articleHtml()),
      finalUrl: 'https://target.example/article',
      statusCode: 200,
      truncated: false,
    })
  })

  it('omits wreq proxy configuration when proxyUrl is absent', async () => {
    const seam = fakeProvider()
    await completeResult(
      seam.provider,
      adapterInput('https://target.example/direct-default', testConfig()),
    )
    expect(seam.createTransport).toHaveBeenCalledTimes(1)
    expect(seam.createTransport.mock.calls[0]?.[0]).not.toHaveProperty('proxy')
  })

  it.each([
    'http:proxy.example.test:8080',
    'http://proxy-user:proxy-secret@proxy.example.test:8080',
    'http://proxy.example.test:8080/./',
  ])('rejects a forged child proxy URL before wreq dispatch: %s', async proxyUrl => {
    let dispatches = 0
    let caught: unknown
    const base = testConfig({ smart: { timeoutMs: 1000 } })
    const forgedConfig: ConfigValue = {
      ...base,
      webExtract: {
        ...base.webExtract,
        smartDirect: { ...base.webExtract.smartDirect, proxyUrl },
      },
    }
    try {
      await new SmartDirectProvider().extract(adapterInput(
        'http://child-proxy-validation.invalid/resource',
        forgedConfig,
        'text',
        undefined,
        () => { dispatches += 1 },
      ))
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ kind: 'invalid_response', provider: 'smart_direct' })
    expect(`${String(caught)}\n${JSON.stringify(caught)}`).not.toContain('proxy-secret')
    expect(dispatches).toBe(0)
  })

  it('routes production child redirects and retries through the same explicit HTTP proxy', async () => {
    const paths: string[] = []
    let articleRequests = 0
    const origin = await localFixture((request, response) => {
      paths.push(request.url ?? '')
      if (request.url === '/start') {
        response.writeHead(302, { location: '/article' })
        response.end()
        return
      }
      articleRequests += 1
      if (articleRequests === 1) {
        response.writeHead(503)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(articleHtml())
    })
    const proxy = await createHttpProxyFixture()
    fixtures.push(proxy)
    const port = new URL(origin.origin).port
    const target = `http://smart-origin.invalid:${port}/start`
    const result = await completeResult(
      new SmartDirectProvider({ sleep: async () => undefined }),
      adapterInput(target, testConfig({
        retry: { baseDelayMs: 0, jitterRatio: 0, maxAttempts: 2, maxDelayMs: 0 },
        smart: { maxRetries: 1, proxyUrl: proxy.origin },
      })),
    )

    expect(paths).toEqual(['/start', '/article', '/article'])
    expect(proxy.requests).toEqual([
      target,
      `http://smart-origin.invalid:${port}/article`,
      `http://smart-origin.invalid:${port}/article`,
    ])
    expect(result.finalUrl).toBe(`http://smart-origin.invalid:${port}/article`)
  })

  it('does not bypass a failed explicit proxy to a directly reachable target', async () => {
    let bypassRequests = 0
    const origin = await localFixture((_request, response) => {
      bypassRequests += 1
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(articleHtml())
    })
    const closedProxy = await createHttpProxyFixture()
    const closedProxyUrl = closedProxy.origin
    await closedProxy.close()

    await expect(new SmartDirectProvider().extract(adapterInput(
      `${origin.origin}/must-use-proxy`,
      testConfig({ smart: { maxRetries: 0, proxyUrl: closedProxyUrl } }),
    ))).rejects.toMatchObject({ kind: 'network', provider: 'smart_direct' })
    expect(bypassRequests).toBe(0)
  })

  it('does not read proxy environment variables without explicit Config', async () => {
    const proxy = await createHttpProxyFixture({ rejectHttp: true })
    fixtures.push(proxy)
    const origin = await localFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(articleHtml())
    })
    const previous = [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.ALL_PROXY]
    process.env.HTTP_PROXY = proxy.origin
    process.env.HTTPS_PROXY = proxy.origin
    process.env.ALL_PROXY = proxy.origin
    try {
      await completeResult(new SmartDirectProvider(), adapterInput(origin.origin, testConfig()))
    } finally {
      const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
      names.forEach((name, index) => {
        const value = previous[index]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      })
    }
    expect(proxy.requests).toEqual([])
    expect(proxy.connects).toEqual([])
  })

  it('manually follows a relative redirect and reaches localhost without network-class filtering', async () => {
    const requests: string[] = []
    const observedHeaders: Array<Record<string, string | string[] | undefined>> = []
    const fixture = await localFixture((request, response) => {
      requests.push(request.url ?? '')
      observedHeaders.push(request.headers)
      if (request.url === '/start') {
        response.writeHead(302, { location: '/article' })
        response.end()
        return
      }
      const body = articleHtml()
      response.writeHead(200, {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(body)
    })

    const result = await completeResult(
      new SmartDirectProvider(),
      adapterInput(`${fixture.origin}/start`, testConfig()),
    )

    expect(requests).toEqual(['/start', '/article'])
    expect(observedHeaders[0]).toMatchObject({
      accept: SMART_DIRECT_ACCEPT,
      'accept-encoding': SMART_DIRECT_ACCEPT_ENCODING,
      'accept-language': SMART_DIRECT_ACCEPT_LANGUAGE,
      'sec-ch-ua-platform': '"Windows"',
    })
    expect(observedHeaders[0]?.['user-agent']).toContain('Chrome/145')
    expect(result).toMatchObject({
      author: 'Ada',
      canonicalUrl: `${fixture.origin}/canonical`,
      contentType: 'text/html; charset=utf-8',
      finalUrl: `${fixture.origin}/article`,
      publishedAt: '2026-08-15',
      statusCode: 200,
      title: 'Fixture title',
      truncated: false,
    })
    expect(result.content).toContain('deterministic article')
  })

  it('detects redirect loops and enforces the redirect count before a later dispatch', async () => {
    let requests = 0
    const fixture = await localFixture((request, response) => {
      requests += 1
      response.writeHead(302, { location: request.url === '/a' ? '/b' : '/a' })
      response.end()
    })
    await expect(new SmartDirectProvider().extract(adapterInput(
      `${fixture.origin}/a`,
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'smart_direct' })
    expect(requests).toBe(2)

    requests = 0
    const limited = await localFixture((_request, response) => {
      requests += 1
      response.writeHead(302, { location: '/next' })
      response.end()
    })
    await expect(new SmartDirectProvider().extract(adapterInput(
      `${limited.origin}/start`,
      testConfig({ smart: { maxRedirects: 0 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded', provider: 'smart_direct' })
    expect(requests).toBe(1)
  })

  it('rejects oversized normalized headers and declared encoded length before reading', async () => {
    let cancelled = 0
    const headerSeam = fakeProvider({
      response: () => fakeResponse({
        headers: { 'x-large': 'x'.repeat(200) },
        onCancel: () => { cancelled += 1 },
      }),
    })
    await expect(headerSeam.provider.extract(adapterInput(
      'https://target.example/header',
      testConfig({ smart: { maxHeaderBytes: 64 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded' })

    const lengthSeam = fakeProvider({
      response: () => fakeResponse({
        headers: { 'content-length': '101' },
        onCancel: () => { cancelled += 1 },
      }),
    })
    await expect(lengthSeam.provider.extract(adapterInput(
      'https://target.example/length',
      testConfig({ smart: { maxContentLengthBytes: 100, maxInputBytes: 100 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded' })
    const malformedSeam = fakeProvider({
      response: () => fakeResponse({
        headers: { 'content-length': 'not-a-length' },
        onCancel: () => { cancelled += 1 },
      }),
    })
    await expect(malformedSeam.provider.extract(adapterInput(
      'https://target.example/malformed-length',
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response' })
    expect(cancelled).toBe(3)
  })

  it('enforces actual encoded stream bytes at exact and over-limit chunked boundaries', async () => {
    const body = Buffer.from(articleHtml())
    const fixture = await localFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write(body.subarray(0, Math.floor(body.length / 2)))
      response.end(body.subarray(Math.floor(body.length / 2)))
    })
    const exact = await completeResult(
      new SmartDirectProvider(),
      adapterInput(fixture.origin, testConfig({ smart: { maxInputBytes: body.length } })),
    )
    expect(exact.encodedBytes).toBe(body.length)

    await expect(new SmartDirectProvider().extract(adapterInput(
      fixture.origin,
      testConfig({ smart: { maxInputBytes: body.length - 1 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded' })
  })

  it('counts raw gzip input and decompressed bytes independently at exact and over limits', async () => {
    const body = Buffer.from(articleHtml())
    const encoded = gzipSync(body)
    const fixture = await localFixture((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(encoded)
    })
    const exact = await completeResult(
      new SmartDirectProvider(),
      adapterInput(fixture.origin, testConfig({
        smart: {
          maxDecompressedBytes: body.length,
          maxInputBytes: encoded.length,
        },
      })),
    )
    expect(exact).toMatchObject({
      contentEncoding: 'gzip',
      decompressedBytes: body.length,
      encodedBytes: encoded.length,
    })

    await expect(new SmartDirectProvider().extract(adapterInput(
      fixture.origin,
      testConfig({ smart: { maxDecompressedBytes: body.length - 1 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded' })
  })

  it('returns unavailable for missing/unsupported MIME, attachments, unsupported charset, and encoding', async () => {
    for (const headers of [
      { 'content-type': '' },
      { 'content-type': 'application/json' },
      { 'content-disposition': 'attachment; filename=x.html' },
      { 'content-type': 'text/html; charset=iso-8859-1' },
      { 'content-encoding': 'zstd' },
    ]) {
      const seam = fakeProvider({ response: () => fakeResponse({ headers }) })
      await expect(seam.provider.extract(adapterInput(
        'https://target.example/unavailable',
        testConfig(),
      ))).resolves.toEqual({ state: 'unavailable' })
      expect(seam.transport.close).toHaveBeenCalledTimes(1)
    }
  })

  it.each([408, 429, 500, 502, 503, 504])('retries transient HTTP %s once and then succeeds', async status => {
    let requests = 0
    const fixture = await localFixture((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.writeHead(status)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(articleHtml())
    })
    const sleep = vi.fn(async () => undefined)
    const result = await completeResult(
      new SmartDirectProvider({ sleep }),
      adapterInput(fixture.origin, testConfig({
        retry: { baseDelayMs: 0, jitterRatio: 0, maxAttempts: 2, maxDelayMs: 0 },
        smart: { maxRetries: 1 },
      })),
    )
    expect(result.statusCode).toBe(200)
    expect(requests).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('honors bounded Retry-After and does not retry permanent HTTP failure', async () => {
    let calls = 0
    const retrySleep = vi.fn(async () => undefined)
    const retry = fakeProvider({
      response: () => {
        calls += 1
        return calls === 1
          ? fakeResponse({ headers: { 'retry-after': '9' }, status: 429 })
          : fakeResponse()
      },
      sleep: retrySleep,
    })
    await completeResult(retry.provider, adapterInput(
      'https://target.example/retry',
      testConfig({
        retry: { maxAttempts: 2, maxDelayMs: 1234 },
        smart: { maxRetries: 1 },
      }),
    ))
    expect(retrySleep).toHaveBeenCalledWith(1234, expect.any(AbortSignal))

    const permanent = fakeProvider({ response: () => fakeResponse({ status: 404 }) })
    await expect(permanent.provider.extract(adapterInput(
      'https://target.example/not-found',
      testConfig({ smart: { maxRetries: 2 } }),
    ))).rejects.toMatchObject({ kind: 'http', status: 404 })
    expect(permanent.fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels retry waiting immediately and starts no later request', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel smart retry')
    let sleeping = false
    const sleep = vi.fn((_milliseconds: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      sleeping = true
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const seam = fakeProvider({ response: () => fakeResponse({ status: 503 }), sleep })
    const operation = seam.provider.extract(adapterInput(
      'https://target.example/retry-cancel',
      testConfig({ smart: { maxRetries: 2 } }),
      'markdown',
      controller.signal,
    ))
    await vi.waitFor(() => expect(sleeping).toBe(true))
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    expect(seam.fetch).toHaveBeenCalledTimes(1)
    expect(seam.transport.close).toHaveBeenCalledTimes(1)
  })

  it('settles the isolated child and proxy socket on explicit-proxy timeout and cancellation', async () => {
    const timedOutProxy = await createHttpProxyFixture({ hangHttp: true })
    fixtures.push(timedOutProxy)
    await expect(new SmartDirectProvider().extract(adapterInput(
      'http://smart-timeout.invalid/resource',
      testConfig({ smart: { proxyUrl: timedOutProxy.origin, timeoutMs: 40 } }),
    ))).rejects.toMatchObject({ kind: 'timeout', provider: 'smart_direct' })
    await vi.waitFor(() => expect(timedOutProxy.sockets.size).toBe(0))

    const cancelledProxy = await createHttpProxyFixture({ hangHttp: true })
    fixtures.push(cancelledProxy)
    const controller = new AbortController()
    const reason = new Error('cancel proxied smart request')
    const operation = new SmartDirectProvider().extract(adapterInput(
      'http://smart-cancel.invalid/resource',
      testConfig({ smart: { proxyUrl: cancelledProxy.origin, timeoutMs: 2000 } }),
      'markdown',
      controller.signal,
    ))
    await vi.waitFor(() => expect(cancelledProxy.requests).toHaveLength(1))
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => expect(cancelledProxy.sockets.size).toBe(0))
  })

  it('enforces the complete route timeout and closes a hanging local body', async () => {
    const fixture = await localFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write('<html><body><article>')
    })
    await expect(new SmartDirectProvider().extract(adapterInput(
      fixture.origin,
      testConfig({ smart: { timeoutMs: 40 } }),
    ))).rejects.toMatchObject({ kind: 'timeout', provider: 'smart_direct' })
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('forwards caller cancellation to wreq and waits for the local socket to close', async () => {
    const fixture = await localFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write('<html><body><article>')
    })
    const controller = new AbortController()
    const reason = new Error('cancel smart body')
    const operation = new SmartDirectProvider().extract(adapterInput(
      fixture.origin,
      testConfig({ smart: { timeoutMs: 2000 } }),
      'markdown',
      controller.signal,
    ))
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(1))
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })
})

describe('SmartDirectProvider linkedom and Defuddle projection', () => {
  it.each([
    ['markdown', '# Heading\n\nA [link](https://example.test).', '# Heading\n\nA [link](https://example.test).'],
    ['text', '# Heading\n\nA [link](https://example.test).', 'Heading\n\nA link.'],
    ['html', '<article><h2>Heading</h2><p>Body</p></article>', '<article><h2>Heading</h2><p>Body</p></article>'],
  ] as const)('returns semantically distinct %s output', async (format, extracted, expected) => {
    const seam = fakeProvider({ extract: async () => defuddleResult(extracted) })
    const result = await completeResult(
      seam.provider,
      adapterInput('https://target.example/article', testConfig(), format),
    )
    expect(result.content).toBe(expected)
  })

  it('accepts explicit XHTML and sends the bounded DOM through Defuddle', async () => {
    const extract = vi.fn(async () => defuddleResult('xhtml cleaned body'))
    const seam = fakeProvider({
      extract,
      response: () => fakeResponse({ headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' } }),
    })
    const result = await completeResult(
      seam.provider,
      adapterInput('https://target.example/article.xhtml', testConfig(), 'markdown'),
    )
    expect(result.content).toBe('xhtml cleaned body')
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('uses only explicit DOM metadata, resolves canonical, and bounds Unicode metadata', async () => {
    const html = articleHtml('<meta property="og:title" content="标题🙂Z">')
      .replace('content="Ada"', 'content="作者🙂Z"')
    const seam = fakeProvider({
      extract: async () => defuddleResult('clean body'),
      response: () => fakeResponse({ body: html }),
    })
    const result = await completeResult(
      seam.provider,
      adapterInput('https://target.example/article', testConfig({ smart: { maxMetadataCharacters: 2 } })),
    )
    expect(result).toMatchObject({
      author: '作者',
      canonicalUrl: 'https://target.example/canonical',
      metadataTruncated: true,
      publishedAt: '20',
      title: '标题',
      truncated: true,
    })
    expect(result.title).not.toContain('inferred')
  })

  it('treats empty content or wordCount zero as unavailable and maps extractor exceptions safely', async () => {
    for (const response of [
      defuddleResult('', 10),
      defuddleResult('non-empty', 0),
    ]) {
      const seam = fakeProvider({ extract: async () => response })
      await expect(seam.provider.extract(adapterInput(
        'https://target.example/empty',
        testConfig(),
      ))).resolves.toEqual({ state: 'unavailable' })
    }

    const failing = fakeProvider({ extract: async () => { throw new Error('secret extractor details') } })
    await expect(failing.provider.extract(adapterInput(
      'https://target.example/fail',
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'smart_direct' })
  })

  it('bounds the DOM scan before Defuddle starts', async () => {
    const extract = vi.fn(async () => defuddleResult('must not run'))
    const seam = fakeProvider({ extract })
    await expect(seam.provider.extract(adapterInput(
      'https://target.example/dom',
      testConfig({ smart: { maxDomNodes: 2 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('bounds extracted characters, UTF-8 output, and complete adapter envelope without splitting Unicode', async () => {
    const unicode = 'A界🙂Z'
    const characterSeam = fakeProvider({ extract: async () => defuddleResult(unicode) })
    const characters = await completeResult(
      characterSeam.provider,
      adapterInput('https://target.example/chars', testConfig({ smart: { maxExtractedCharacters: 3 } })),
    )
    expect(characters).toMatchObject({ content: 'A界🙂', outputTruncated: true, truncated: true })

    const byteSeam = fakeProvider({ extract: async () => defuddleResult(unicode) })
    const bytes = await completeResult(
      byteSeam.provider,
      adapterInput('https://target.example/bytes', testConfig({ smart: { maxOutputBytes: 7 } })),
    )
    expect(bytes).toMatchObject({ content: 'A界', outputTruncated: true, truncated: true })

    const exactSeam = fakeProvider({ extract: async () => defuddleResult('A界') })
    const exact = await completeResult(
      exactSeam.provider,
      adapterInput('https://target.example/exact', testConfig({
        smart: { maxExtractedCharacters: 2, maxOutputBytes: 4 },
      })),
    )
    expect(exact.outputTruncated).toBeUndefined()
    expect(exact.truncated).toBe(false)

    const tinySeam = fakeProvider({ extract: async () => defuddleResult(unicode) })
    await expect(tinySeam.provider.extract(adapterInput(
      'https://target.example/tiny',
      testConfig({ smart: { maxAdapterBytes: 1 } }),
    ))).rejects.toBeInstanceOf(OutputLimitError)
  })

  it('fails rather than returning malformed truncated Defuddle HTML', async () => {
    const seam = fakeProvider({
      extract: async () => defuddleResult('<article><p>long HTML body</p></article>'),
    })
    await expect(seam.provider.extract(adapterInput(
      'https://target.example/html-limit',
      testConfig({ smart: { maxOutputBytes: 10 } }),
      'html',
    ))).rejects.toBeInstanceOf(OutputLimitError)
  })

  it('supports verified plain and Markdown MIME paths without invoking Defuddle', async () => {
    const extract = vi.fn(async () => defuddleResult('must not run'))
    const plain = fakeProvider({
      extract,
      response: () => fakeResponse({ body: 'plain <text> & data', headers: { 'content-type': 'text/plain' } }),
    })
    expect((await completeResult(
      plain.provider,
      adapterInput('https://target.example/plain', testConfig(), 'html'),
    )).content).toBe('<pre>plain &lt;text&gt; &amp; data</pre>')

    const markdown = fakeProvider({
      extract,
      response: () => fakeResponse({ body: '# Heading\n\nA [link](https://example.test).', headers: { 'content-type': 'text/markdown' } }),
    })
    expect((await completeResult(
      markdown.provider,
      adapterInput('https://target.example/readme', testConfig(), 'text'),
    )).content).toBe('Heading\n\nA link.')

    const markdownHtml = fakeProvider({
      extract,
      response: () => fakeResponse({ body: '# Heading', headers: { 'content-type': 'text/markdown' } }),
    })
    await expect(markdownHtml.provider.extract(adapterInput(
      'https://target.example/readme',
      testConfig(),
      'html',
    ))).resolves.toEqual({ state: 'unavailable' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('checks elapsed synchronous processing time even when the event-loop timer cannot preempt it', async () => {
    const times = [0, 0, 0, 6]
    const seam = fakeProvider({
      extract: async () => defuddleResult('clean body'),
      now: () => times.shift() ?? 6,
    })
    await expect(seam.provider.extract(adapterInput(
      'https://target.example/slow',
      testConfig({ smart: { processingTimeoutMs: 5 } }),
    ))).rejects.toMatchObject({ kind: 'timeout', provider: 'smart_direct' })
  })
})

describe('SmartDirectProvider lifecycle quiescence', () => {
  it('quiesces in-flight wreq sockets when an owning Fiber reloads and disposes', async () => {
    let requests = 0
    const fixture = await localFixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write('<html><body><article>')
    })
    const context = new Context()
    const provider = new SmartDirectProvider()
    const settled: Promise<void>[] = []
    const controllers: AbortController[] = []
    const plugin = (ctx: CordisContext): void => {
      ctx.effect(() => {
        const generation = controllers.length + 1
        const controller = new AbortController()
        controllers.push(controller)
        const operation = provider.extract(adapterInput(
          `${fixture.origin}/generation-${generation}`,
          testConfig({ smart: { timeoutMs: 2000 } }),
          'markdown',
          controller.signal,
        )).then(() => undefined, () => undefined)
        settled.push(operation)
        return async () => {
          controller.abort(new Error(`smart generation ${generation} disposed`))
          await operation
        }
      })
    }
    const fiber = context.plugin(plugin)
    await fiber
    await vi.waitFor(() => expect(requests).toBe(1))

    await fiber.restart()
    await vi.waitFor(() => expect(requests).toBe(2))
    expect(controllers[0]?.signal.aborted).toBe(true)

    await fiber.dispose()
    await Promise.all(settled)
    expect(controllers).toHaveLength(2)
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true)
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
    await context.fiber.dispose()
  })

  it('waits for an uninterruptible Defuddle promise before Fiber disposal settles', async () => {
    let release!: (value: DefuddleResponse) => void
    const extracting = new Promise<DefuddleResponse>(resolve => { release = resolve })
    const extract = vi.fn(() => extracting)
    const seam = fakeProvider({ extract })
    const context = new Context()
    let operationError: unknown
    const plugin = (ctx: CordisContext): void => {
      ctx.effect(() => {
        const controller = new AbortController()
        const operation = seam.provider.extract(adapterInput(
          'https://target.example/deferred',
          testConfig({ smart: { processingTimeoutMs: 2000, timeoutMs: 3000 } }),
          'markdown',
          controller.signal,
        )).then(() => undefined, error => { operationError = error })
        return async () => {
          controller.abort(new Error('deferred Defuddle disposed'))
          await operation
        }
      })
    }
    const fiber = context.plugin(plugin)
    await fiber
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))

    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    release(defuddleResult('late result'))
    await disposal
    expect(operationError).toBeInstanceOf(Error)
    expect((operationError as Error).message).toBe('deferred Defuddle disposed')
    expect(seam.transport.close).toHaveBeenCalledTimes(1)
    await context.fiber.dispose()
  })
})

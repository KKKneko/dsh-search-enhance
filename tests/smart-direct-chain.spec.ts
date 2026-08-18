import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as ConfigValue } from '../src/config.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import { DirectFetchProvider } from '../src/providers/direct-fetch.js'
import { SmartDirectProvider } from '../src/providers/smart-direct.js'
import {
  WebExtractInfrastructureError,
  WebExtractOrchestrator,
  type WebExtractAdapter,
  type WebExtractAdapterOutcome,
  type WebExtractRoute,
} from '../src/web-extract/index.js'
import {
  createHttpProxyFixture,
  PROXY_REJECTION_SECRET,
} from './proxy-fixture.js'

interface Fixture {
  readonly origin: string
  readonly sockets: ReadonlySet<Socket>
  close(): Promise<void>
}

const fixtures: Fixture[] = []

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fixture> {
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
  const value: Fixture = {
    origin: `http://127.0.0.1:${address.port}`,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
  fixtures.push(value)
  return value
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (fixtures.length > 0) await fixtures.pop()?.close()
})

function articleHtml(): string {
  return '<!doctype html><html><head><title>Smart chain title</title><meta name="author" content="Ada"><meta property="article:published_time" content="2026-08-15"><link rel="canonical" href="/canonical"></head><body><article><h1>Smart chain title</h1><p>The production smart route extracts this deterministic article with enough useful words for Defuddle.</p><p>A second paragraph keeps the result stable and readable.</p></article></body></html>'
}

function stub(
  route: WebExtractRoute,
  outcome: WebExtractAdapterOutcome | (() => Promise<WebExtractAdapterOutcome>),
  supports = true,
): WebExtractAdapter {
  return {
    route,
    enabled: () => true,
    supports: () => supports,
    extract: typeof outcome === 'function' ? outcome : async () => outcome,
  }
}

function orchestrator(input: {
  readonly tavily?: WebExtractAdapter
  readonly firecrawl?: WebExtractAdapter
  readonly smart?: WebExtractAdapter
  readonly direct?: WebExtractAdapter
  readonly config?: ConfigValue
}): WebExtractOrchestrator {
  return new WebExtractOrchestrator({
    tavilyExtract: input.tavily ?? stub('tavily_extract', { state: 'not_configured' }),
    firecrawlScrape: input.firecrawl ?? stub('firecrawl_scrape', { state: 'not_configured' }),
    smartDirect: input.smart ?? new SmartDirectProvider(),
    direct: input.direct ?? new DirectFetchProvider(),
    getConfig: () => input.config ?? Config({} as never),
    now: () => 100,
  })
}

describe('production four-route web extraction chain', () => {
  it('returns smart_direct extracted evidence after remote skip/failure', async () => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      const body = articleHtml()
      response.writeHead(200, {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(body)
    })
    const direct = new DirectFetchProvider()
    const directExtract = vi.spyOn(direct, 'extract')

    const result = await orchestrator({
      direct,
      firecrawl: stub('firecrawl_scrape', async () => {
        throw new ProviderError({
          capability: 'web_extract',
          kind: 'http',
          provider: 'firecrawl_scrape',
          status: 503,
        })
      }),
    }).extract({
      format: 'markdown',
      signal: new AbortController().signal,
      url: `${page.origin}/article`,
    })

    expect(result).toMatchObject({
      author: 'Ada',
      canonicalUrl: `${page.origin}/canonical`,
      contentLength: Buffer.byteLength(articleHtml()),
      decompressedBytes: Buffer.byteLength(articleHtml()),
      encodedBytes: Buffer.byteLength(articleHtml()),
      evidenceLevel: 'extracted_content',
      finalUrl: `${page.origin}/article`,
      publishedAt: '2026-08-15',
      retrievalRoute: 'smart_direct',
      statusCode: 200,
      title: 'Smart chain title',
      truncated: false,
    })
    expect(result.content).toContain('production smart route')
    expect(result.attempts.map(attempt => [attempt.provider, attempt.outcome])).toEqual([
      ['tavily_extract', 'skipped'],
      ['firecrawl_scrape', 'failed'],
      ['smart_direct', 'success'],
    ])
    expect(result.attempts.at(-1)?.participatedInFallback).toBe(true)
    expect(requests).toBe(1)
    expect(directExtract).not.toHaveBeenCalled()
  })

  it('uses independent SmartDirect and Direct proxy settings in one fallback operation', async () => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': requests === 1 ? 'text/html' : 'text/plain' })
      response.end(requests === 1
        ? '<html><head><title>Empty</title></head><body><nav>Only noise</nav></body></html>'
        : 'direct body from its independent proxy')
    })
    const smartProxy = await createHttpProxyFixture()
    const directProxy = await createHttpProxyFixture()
    fixtures.push(smartProxy, directProxy)
    const port = new URL(page.origin).port
    const target = `http://independent-origin.invalid:${port}/article`
    const value = Config({
      webExtract: {
        smartDirect: { proxyUrl: smartProxy.origin },
        direct: { proxyUrl: directProxy.origin },
      },
    } as never)

    const result = await orchestrator({ config: value }).extract({
      format: 'text',
      signal: new AbortController().signal,
      url: target,
    })

    expect(result).toMatchObject({
      content: 'direct body from its independent proxy',
      retrievalRoute: 'direct',
    })
    expect(smartProxy.requests).toEqual([target])
    expect(directProxy.requests).toEqual([target])
    expect(result.attempts.map(attempt => [attempt.provider, attempt.outcome])).toEqual([
      ['tavily_extract', 'skipped'],
      ['firecrawl_scrape', 'skipped'],
      ['smart_direct', 'failed'],
      ['direct', 'success'],
    ])
  })

  it.each(['smartDirect', 'direct'] as const)(
    'keeps the other local route direct when only webExtract.%s has proxyUrl',
    async proxiedRoute => {
      let requests = 0
      const page = await fixture((_request, response) => {
        requests += 1
        response.writeHead(200, { 'content-type': requests === 1 ? 'text/html' : 'text/plain' })
        response.end(requests === 1
          ? '<html><head><title>Empty</title></head><body><nav>Only noise</nav></body></html>'
          : 'mixed direct and proxied routes')
      })
      const proxy = await createHttpProxyFixture()
      fixtures.push(proxy)
      const value = Config({
        webExtract: { [proxiedRoute]: { proxyUrl: proxy.origin } },
      } as never)
      const result = await orchestrator({ config: value }).extract({
        format: 'text',
        signal: new AbortController().signal,
        url: `${page.origin}/mixed`,
      })

      expect(result.retrievalRoute).toBe('direct')
      expect(requests).toBe(2)
      expect(proxy.requests).toHaveLength(1)
    },
  )

  it('records safe fallback attempts when both local proxies reject authentication', async () => {
    const smartProxy = await createHttpProxyFixture({ rejectHttp: true })
    const directProxy = await createHttpProxyFixture({ rejectHttp: true })
    fixtures.push(smartProxy, directProxy)
    const target = 'http://proxy-auth-rejected.invalid/article'
    const value = Config({
      webExtract: {
        smartDirect: { maxRetries: 0, proxyUrl: smartProxy.origin },
        direct: { maxRetries: 0, proxyUrl: directProxy.origin },
      },
    } as never)
    let caught: unknown
    try {
      await orchestrator({ config: value }).extract({
        format: 'text',
        signal: new AbortController().signal,
        url: target,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(WebExtractInfrastructureError)
    const attempts = (caught as WebExtractInfrastructureError).routeStatuses
    expect(attempts.slice(-2)).toEqual([
      expect.objectContaining({
        attempts: 1,
        errorKind: 'http',
        httpStatus: 407,
        outcome: 'failed',
        provider: 'smart_direct',
      }),
      expect.objectContaining({
        attempts: 1,
        errorKind: 'http',
        httpStatus: 407,
        outcome: 'failed',
        provider: 'direct',
      }),
    ])
    expect(smartProxy.proxyAuthorizations).toEqual([])
    expect(directProxy.proxyAuthorizations).toEqual([])
    const visible = JSON.stringify(caught)
    expect(visible).not.toContain(PROXY_REJECTION_SECRET)
    expect(visible).not.toMatch(/proxy-authorization|proxy-authenticate|userinfo/i)
  })

  it('records a SmartDirect proxy connection failure before succeeding through the Direct proxy', async () => {
    const closedProxy = await createHttpProxyFixture()
    const closedProxyUrl = closedProxy.origin
    await closedProxy.close()
    const page = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct after smart proxy connection failure')
    })
    const directProxy = await createHttpProxyFixture()
    fixtures.push(directProxy)
    const target = `http://connection-failure-origin.invalid:${new URL(page.origin).port}/article`
    const value = Config({
      webExtract: {
        smartDirect: { maxRetries: 0, proxyUrl: closedProxyUrl },
        direct: { proxyUrl: directProxy.origin },
      },
    } as never)

    const result = await orchestrator({ config: value }).extract({
      format: 'text',
      signal: new AbortController().signal,
      url: target,
    })

    expect(result.retrievalRoute).toBe('direct')
    expect(result.attempts.slice(-2)).toEqual([
      expect.objectContaining({
        attempts: 1,
        errorKind: 'network',
        outcome: 'failed',
        provider: 'smart_direct',
      }),
      expect.objectContaining({ attempts: 1, outcome: 'success', provider: 'direct' }),
    ])
    expect(directProxy.requests).toEqual([target])
  })

  it('records a SmartDirect proxy timeout before succeeding through the Direct proxy', async () => {
    const timedOutProxy = await createHttpProxyFixture({ hangHttp: true })
    const directProxy = await createHttpProxyFixture()
    fixtures.push(timedOutProxy, directProxy)
    const page = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct after smart proxy timeout')
    })
    const target = `http://timeout-origin.invalid:${new URL(page.origin).port}/article`
    const value = Config({
      webExtract: {
        smartDirect: {
          connectTimeoutMs: 100,
          maxRetries: 0,
          proxyUrl: timedOutProxy.origin,
          readTimeoutMs: 200,
          timeoutMs: 40,
        },
        direct: { proxyUrl: directProxy.origin },
      },
    } as never)

    const result = await orchestrator({ config: value }).extract({
      format: 'text',
      signal: new AbortController().signal,
      url: target,
    })

    expect(result.retrievalRoute).toBe('direct')
    expect(result.attempts.slice(-2)).toEqual([
      expect.objectContaining({
        attempts: 1,
        errorKind: 'timeout',
        outcome: 'failed',
        provider: 'smart_direct',
      }),
      expect.objectContaining({ attempts: 1, outcome: 'success', provider: 'direct' }),
    ])
    await vi.waitFor(() => expect(timedOutProxy.sockets.size).toBe(0))
  })

  it('continues from unavailable smart extraction to production direct', async () => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<html><head><title>Empty</title></head><body><nav>Only noise</nav></body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('direct fallback after empty Defuddle content')
    })

    const result = await orchestrator({}).extract({
      format: 'text',
      signal: new AbortController().signal,
      url: `${page.origin}/empty`,
    })

    expect(result).toMatchObject({
      content: 'direct fallback after empty Defuddle content',
      evidenceLevel: 'direct_http_content',
      retrievalRoute: 'direct',
    })
    expect(result.attempts.map(attempt => [attempt.provider, attempt.outcome])).toEqual([
      ['tavily_extract', 'skipped'],
      ['firecrawl_scrape', 'skipped'],
      ['smart_direct', 'failed'],
      ['direct', 'success'],
    ])
    expect(requests).toBe(2)
  })

  it.each(['json', 'raw'] as const)('skips smart_direct for %s and enters direct', async format => {
    const page = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    const smart = new SmartDirectProvider()
    const smartExtract = vi.spyOn(smart, 'extract')

    const result = await orchestrator({ smart }).extract({
      format,
      signal: new AbortController().signal,
      url: `${page.origin}/${format}`,
    })

    expect(result.retrievalRoute).toBe('direct')
    expect(result.evidenceLevel).toBe('direct_http_content')
    expect(result.attempts.find(attempt => attempt.provider === 'smart_direct')).toMatchObject({
      attempts: 0,
      outcome: 'skipped',
      skipReason: 'format_unsupported',
    })
    expect(smartExtract).not.toHaveBeenCalled()
  })

  it('does not start either local route after Tavily succeeds', async () => {
    const smart = new SmartDirectProvider()
    const direct = new DirectFetchProvider()
    const smartExtract = vi.spyOn(smart, 'extract')
    const directExtract = vi.spyOn(direct, 'extract')
    const result = await orchestrator({
      tavily: stub('tavily_extract', {
        state: 'complete',
        result: { content: 'remote body', truncated: false },
      }),
      smart,
      direct,
    }).extract({
      signal: new AbortController().signal,
      url: 'https://not-dispatched.example/article',
    })

    expect(result).toMatchObject({
      evidenceLevel: 'extracted_content',
      retrievalRoute: 'tavily_extract',
    })
    expect(smartExtract).not.toHaveBeenCalled()
    expect(directExtract).not.toHaveBeenCalled()
  })

  it('redacts a Defuddle failure before continuing to direct', async () => {
    const secret = 'extractor-secret-message'
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': requests === 1 ? 'text/html' : 'text/plain' })
      response.end(requests === 1 ? articleHtml() : 'safe direct content')
    })
    const smart = new SmartDirectProvider({
      extract: async () => { throw new Error(secret) },
    })
    const result = await orchestrator({ smart }).extract({
      format: 'text',
      signal: new AbortController().signal,
      url: `${page.origin}/redacted`,
    })

    expect(result.retrievalRoute).toBe('direct')
    expect(result.attempts.find(attempt => attempt.provider === 'smart_direct')).toMatchObject({
      errorKind: 'invalid_response',
      outcome: 'failed',
    })
    expect(JSON.stringify(result.attempts)).not.toContain(secret)
    expect(requests).toBe(2)
  })

  it('continues from a smart_direct challenge to production direct', async () => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.writeHead(200, {
          'cf-mitigated': 'challenge',
          'content-type': 'text/html; charset=utf-8',
        })
        response.end('<html><body>smart challenge body</body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('direct content after smart challenge')
    })

    const result = await orchestrator({}).extract({
      format: 'text',
      signal: new AbortController().signal,
      url: `${page.origin}/challenge-fallback`,
    })

    expect(result).toMatchObject({
      content: 'direct content after smart challenge',
      retrievalRoute: 'direct',
    })
    expect(result.attempts.slice(-2)).toEqual([
      expect.objectContaining({
        errorKind: 'unavailable',
        outcome: 'failed',
        provider: 'smart_direct',
      }),
      expect.objectContaining({ outcome: 'success', provider: 'direct' }),
    ])
    expect(requests).toBe(2)
  })

  it('returns a safe final failure when both local routes receive a challenge header', async () => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      response.writeHead(200, {
        'cf-mitigated': 'challenge',
        'content-length': String(6 * 1024 * 1024),
        'content-type': 'text/html; charset=utf-8',
      })
      response.end('<html><body>anti-bot-response-secret</body></html>')
    })

    let caught: unknown
    try {
      await orchestrator({}).extract({
        format: 'markdown',
        signal: new AbortController().signal,
        url: `${page.origin}/challenge?token=anti-bot-url-secret`,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(WebExtractInfrastructureError)
    expect(caught).toMatchObject({
      code: 'SEARCH_WEB_EXTRACT_FAILED',
      kind: 'unavailable',
    })
    expect((caught as WebExtractInfrastructureError).routeStatuses.slice(-2)).toEqual([
      expect.objectContaining({
        errorKind: 'unavailable',
        outcome: 'failed',
        provider: 'smart_direct',
      }),
      expect.objectContaining({
        errorKind: 'unavailable',
        outcome: 'failed',
        provider: 'direct',
      }),
    ])
    const safe = JSON.parse(JSON.stringify(caught)) as unknown
    expect(safe).toMatchSnapshot()
    const visible = `${String(caught)}\n${JSON.stringify(caught)}`
    expect(visible).not.toMatch(/anti-bot-(?:response|url)-secret/)
    expect(visible).not.toContain(page.origin)
    expect(requests).toBe(2)
    await vi.waitFor(() => expect(page.sockets.size).toBe(0))
  })

  it('pins the production smart_direct canonical route and evidence keylessly', async () => {
    const page = await fixture((_request, response) => {
      const body = articleHtml()
      response.writeHead(200, {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(body)
    })
    const result = await orchestrator({}).extract({
      format: 'markdown',
      signal: new AbortController().signal,
      url: `${page.origin}/snapshot`,
    })
    const stable = JSON.parse(
      JSON.stringify(result).replaceAll(page.origin, 'http://smart.fixture.test'),
    ) as unknown

    expect(stable).toMatchSnapshot()
  })
})

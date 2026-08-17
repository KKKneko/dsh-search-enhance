import { createServer, type RequestListener, type Server } from 'node:http'
import type { Socket } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import { DirectFetchProvider } from '../src/providers/direct-fetch.js'
import {
  WebExtractInfrastructureError,
  WebExtractOrchestrator,
  type WebExtractAdapter,
  type WebExtractAdapterInput,
  type WebExtractAdapterOutcome,
  type WebExtractAdapterResult,
  type WebExtractFormat,
  type WebExtractRoute,
} from '../src/web-extract/index.js'

type DirectOverrides = Partial<SearchEnhanceConfig['webExtract']['direct']>
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function testConfig(input: {
  readonly direct?: DirectOverrides
  readonly retry?: Partial<SearchEnhanceConfig['retry']>
  readonly webExtract?: Partial<Omit<
    SearchEnhanceConfig['webExtract'],
    'tavily' | 'firecrawl' | 'smartDirect' | 'direct'
  >>
} = {}): SearchEnhanceConfig {
  const base = Config({
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
    retry: { ...base.retry, ...input.retry },
    webExtract: {
      ...base.webExtract,
      ...input.webExtract,
      direct: { ...base.webExtract.direct, maxRetries: 0, ...input.direct },
      firecrawl: { ...base.webExtract.firecrawl },
      smartDirect: { ...base.webExtract.smartDirect },
      tavily: { ...base.webExtract.tavily },
    },
  }
}

interface HttpFixture {
  readonly origin: string
  readonly requests: string[]
  readonly sockets: ReadonlySet<Socket>
}

async function httpFixture(listener: RequestListener): Promise<HttpFixture> {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    listener(request, response)
  })
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
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  cleanups.push(() => closeServer(server, sockets))
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    sockets,
  }
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

function adapterInput(
  url: string,
  config: SearchEnhanceConfig,
  format: WebExtractFormat = 'markdown',
  signal = new AbortController().signal,
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

async function directResult(
  url: string,
  format: WebExtractFormat = 'markdown',
  config = testConfig(),
): Promise<WebExtractAdapterResult> {
  const outcome = await new DirectFetchProvider().extract(adapterInput(url, config, format))
  expect(outcome.state).toBe('complete')
  if (outcome.state !== 'complete') throw new Error('direct fixture unavailable')
  return outcome.result
}

function stubAdapter(
  route: WebExtractRoute,
  outcome: WebExtractAdapterOutcome | (() => Promise<WebExtractAdapterOutcome>),
): WebExtractAdapter {
  return {
    route,
    enabled: () => true,
    supports: () => true,
    extract: vi.fn(async input => {
      input.onDispatch?.()
      return typeof outcome === 'function' ? outcome() : outcome
    }),
  }
}

function unavailable(route: WebExtractRoute): WebExtractAdapter {
  return stubAdapter(route, { state: 'unavailable' })
}

describe('DirectFetchProvider redirects, formats, and adapter integration', () => {
  it.each([301, 302, 303, 307, 308])('manually follows relative HTTP %s and reports only the final response', async status => {
    const fixture = await httpFixture((request, response) => {
      if (request.url === `/start-${status}`) {
        response.writeHead(status, {
          'content-type': 'text/intermediate',
          location: `./final?from=${status}`,
        })
        response.end('intermediate body')
        return
      }
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ final: status }))
    })

    const result = await directResult(`${fixture.origin}/start-${status}`, 'json')

    expect(result).toMatchObject({
      content: `{
  "final": ${status}
}`,
      contentType: 'application/json',
      finalUrl: `${fixture.origin}/final?from=${status}`,
      statusCode: 201,
      truncated: false,
    })
    expect(result.content).not.toContain('intermediate body')
    expect(fixture.requests).toEqual([`/start-${status}`, `/final?from=${status}`])
  })

  it('does not add a network-class check when an HTTP redirect targets localhost', async () => {
    let fixture: HttpFixture
    fixture = await httpFixture((request, response) => {
      if (request.url === '/redirect') {
        const port = new URL(fixture.origin).port
        response.writeHead(302, { location: `http://localhost:${port}/local-final` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('localhost redirect body')
    })

    const result = await directResult(`${fixture.origin}/redirect`, 'text')

    expect(result).toMatchObject({
      content: 'localhost redirect body',
      finalUrl: `http://localhost:${new URL(fixture.origin).port}/local-final`,
      statusCode: 200,
    })
    expect(fixture.requests).toEqual(['/redirect', '/local-final'])
  })

  it('detects HTTP navigation loops with one bounded, safe failure', async () => {
    const fixture = await httpFixture((request, response) => {
      response.writeHead(302, { location: request.url === '/a' ? '/b' : '/a' })
      response.end()
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/a`,
      testConfig({ direct: { maxRedirects: 10 } }),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'direct' })
    expect(fixture.requests).toEqual(['/a', '/b'])
  })

  it('treats fragment-only redirect variants as the same HTTP loop target', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(302, { location: '/fragment-loop#next' })
      response.end()
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/fragment-loop#initial`,
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'direct' })
    expect(fixture.requests).toEqual(['/fragment-loop'])
  })

  it('enforces one shared redirect count and validates userinfo on every target', async () => {
    const fixture = await httpFixture((request, response) => {
      if (request.url === '/one') response.writeHead(302, { location: '/two' })
      else if (request.url === '/two') response.writeHead(302, { location: '/three' })
      else response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('body')
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/one`,
      testConfig({ direct: { maxRedirects: 1 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded', provider: 'direct' })
    expect(fixture.requests).toEqual(['/one', '/two'])

    const userinfo = await httpFixture((_request, response) => {
      response.writeHead(302, { location: 'http://user:pass@localhost/forbidden' })
      response.end()
    })
    await expect(new DirectFetchProvider().extract(adapterInput(
      `${userinfo.origin}/userinfo`,
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(userinfo.requests).toEqual(['/userinfo'])
  })

  it('follows bounded relative meta refresh and exposes only final metadata', async () => {
    const fixture = await httpFixture((request, response) => {
      if (request.url === '/meta') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html><head><title>Old</title><meta http-equiv="refresh" content="0; url=./final"></head><body>old</body></html>')
        return
      }
      response.writeHead(202, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head><title>Final title</title></head><body><p>final body</p></body></html>')
    })

    const result = await directResult(`${fixture.origin}/meta`, 'text')

    expect(result).toMatchObject({
      content: 'Final title\nfinal body',
      finalUrl: `${fixture.origin}/final`,
      statusCode: 202,
      title: 'Final title',
    })
    expect(result.content).not.toContain('old')
    expect(fixture.requests).toEqual(['/meta', '/final'])
  })

  it('follows a suitable alternate only for a sparse HTML response', async () => {
    const fixture = await httpFixture((request, response) => {
      if (request.url === '/sparse') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html><head><link rel="alternate stylesheet" type="text/plain; charset=utf-8" href="/plain"></head><body>x</body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('alternate body')
    })

    const result = await directResult(`${fixture.origin}/sparse`, 'text')

    expect(result).toMatchObject({
      content: 'alternate body',
      finalUrl: `${fixture.origin}/plain`,
    })
    expect(fixture.requests).toEqual(['/sparse', '/plain'])
  })

  it('shares one budget and loop set across meta refresh and alternate navigation', async () => {
    const fixture = await httpFixture((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      if (request.url === '/meta') {
        response.end('<meta http-equiv="refresh" content="0;url=/sparse">')
      } else if (request.url === '/sparse') {
        response.end('<link rel="alternate" type="text/plain" href="/plain">')
      } else {
        response.end('must not run')
      }
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/meta`,
      testConfig({ direct: { maxRedirects: 1 } }),
      'text',
    ))).rejects.toMatchObject({ kind: 'budget_exceeded', provider: 'direct' })
    expect(fixture.requests).toEqual(['/meta', '/sparse'])

    const loop = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<meta http-equiv="refresh" content="0;url=/loop">')
    })
    await expect(new DirectFetchProvider().extract(adapterInput(
      `${loop.origin}/loop`,
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'direct' })
    expect(loop.requests).toEqual(['/loop'])
  })

  it('does not follow delayed meta refresh or a format-incompatible alternate', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><head><meta http-equiv="refresh" content="6;url=/late"><link rel="alternate" type="application/json" href="/json"></head><body>local body</body></html>')
    })

    const result = await directResult(`${fixture.origin}/stay`, 'text')

    expect(result.finalUrl).toBe(`${fixture.origin}/stay`)
    expect(result.content).toContain('local body')
    expect(fixture.requests).toEqual(['/stay'])
  })

  it('extracts only explicit HTML metadata and converts all five formats deterministically', async () => {
    const html = '<!doctype html><html lang="en"><head><title>Example &amp; Test</title><meta name="author" content="Ada Lovelace"><meta property="article:published_time" content="2026-08-15"><link rel="canonical" href="/canonical"></head><body><h1>Heading</h1><p>Hello <strong>world</strong>.</p><script>script-secret</script></body></html>'
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })

    const results = new Map<WebExtractFormat, WebExtractAdapterResult>()
    for (const format of ['markdown', 'text', 'html', 'json', 'raw'] as const) {
      results.set(format, await directResult(`${fixture.origin}/${format}`, format))
    }

    for (const result of results.values()) {
      expect(result).toMatchObject({
        author: 'Ada Lovelace',
        canonicalUrl: `${fixture.origin}/canonical`,
        contentType: 'text/html; charset=utf-8',
        publishedAt: '2026-08-15',
        statusCode: 200,
        title: 'Example & Test',
      })
    }
    expect(results.get('markdown')?.contentTransform).toBe('html_to_markdown')
    expect(results.get('markdown')?.content).toContain('# Example & Test')
    expect(results.get('markdown')?.content).toContain('# Heading')
    expect(results.get('markdown')?.content).not.toContain('script-secret')
    expect(results.get('text')?.contentTransform).toBe('html_to_text')
    expect(results.get('text')?.content).toBe('Example & Test\nHeading\nHello world.')
    expect(results.get('html')?.contentTransform).toBeUndefined()
    expect(results.get('html')?.content).toBe(html)
    expect(results.get('json')?.contentTransform).toBeUndefined()
    expect(results.get('json')?.content).toBe(html)
    expect(results.get('raw')?.contentTransform).toBeUndefined()
    expect(results.get('raw')?.content).toBe(html)
  })

  it('pretty-prints bounded JSON and keeps malformed JSON conservatively unchanged', async () => {
    const fixture = await httpFixture((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(request.url === '/valid' ? '{"emoji":"🙂","n":1}' : '{not-json')
    })

    const valid = await directResult(`${fixture.origin}/valid`, 'json')
    const invalid = await directResult(`${fixture.origin}/invalid`, 'json')

    expect(valid.contentTransform).toBe('json_pretty')
    expect(valid.content).toBe(`{
  "emoji": "🙂",
  "n": 1
}`)
    expect(invalid.contentTransform).toBeUndefined()
    expect(invalid.content).toBe('{not-json')
  })

  it('bounds Unicode metadata, HTML scan/conversion input, and final preview independently', async () => {
    const html = '<html><head><title>A界🙂Z</title></head><body><p>A界🙂Z tail tail</p></body></html>'
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    const exactBytes = Buffer.byteLength(html, 'utf8')
    const exact = await directResult(
      `${fixture.origin}/exact`,
      'html',
      testConfig({
        direct: {
          maxHtmlConversionBytes: exactBytes,
          maxHtmlScanBytes: exactBytes,
          maxMetadataCharacters: 100,
          maxPreviewBytes: exactBytes,
        },
      }),
    )
    expect(exact.title).toBe('A界🙂Z')
    expect(exact.content).toBe(html)
    expect(exact.truncated).toBe(false)

    const over = await directResult(
      `${fixture.origin}/over`,
      'html',
      testConfig({
        direct: {
          maxHtmlConversionBytes: exactBytes - 1,
          maxHtmlScanBytes: exactBytes - 1,
          maxMetadataCharacters: 3,
          maxPreviewBytes: exactBytes,
        },
      }),
    )
    expect(over.title).toBe('A界🙂')
    expect(over.metadataTruncated).toBe(true)
    expect(over.outputTruncated).toBe(true)
    expect(over.truncated).toBe(true)
    expect(Buffer.byteLength(over.content, 'utf8')).toBeLessThan(exactBytes)

    const unicode = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('A界🙂Z')
    })
    const preview = await directResult(
      `${unicode.origin}/preview`,
      'text',
      testConfig({ direct: { maxPreviewBytes: 7 } }),
    )
    expect(preview.content).toBe('A界')
    expect(preview.outputTruncated).toBe(true)
    expect(preview.truncated).toBe(true)
  })

  it('pins the production direct canonical evidence and metadata contract keylessly', async () => {
    const fixture = await httpFixture((_request, response) => {
      const body = '<html><head><title>Snapshot title</title><meta name="author" content="Ada"><link rel="canonical" href="/canonical"></head><body><p>Snapshot body</p></body></html>'
      response.writeHead(200, {
        'content-length': String(Buffer.byteLength(body, 'utf8')),
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(body)
    })
    const config = testConfig()
    const orchestrator = new WebExtractOrchestrator({
      tavilyExtract: stubAdapter('tavily_extract', { state: 'not_configured' }),
      firecrawlScrape: stubAdapter('firecrawl_scrape', { state: 'not_configured' }),
      smartDirect: stubAdapter('smart_direct', { state: 'not_configured' }),
      direct: new DirectFetchProvider(),
      getConfig: () => config,
      now: () => 100,
    })
    const result = await orchestrator.extract({
      format: 'markdown',
      signal: new AbortController().signal,
      url: `${fixture.origin}/snapshot`,
    })
    const stable = JSON.parse(
      JSON.stringify(result).replaceAll(fixture.origin, 'http://direct.fixture.test'),
    ) as unknown

    expect(stable).toMatchSnapshot()
  })

  it('uses the production direct adapter after the first three routes skip/fail', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('production direct fallback')
    })
    const config = testConfig()
    const orchestrator = new WebExtractOrchestrator({
      tavilyExtract: stubAdapter('tavily_extract', { state: 'not_configured' }),
      firecrawlScrape: stubAdapter('firecrawl_scrape', async () => {
        throw new ProviderError({
          capability: 'web_extract',
          kind: 'http',
          provider: 'firecrawl_scrape',
          status: 503,
        })
      }),
      smartDirect: unavailable('smart_direct'),
      direct: new DirectFetchProvider(),
      getConfig: () => config,
      now: () => 100,
    })

    const result = await orchestrator.extract({
      format: 'text',
      signal: new AbortController().signal,
      url: `${fixture.origin}/fallback`,
    })

    expect(result).toMatchObject({
      content: 'production direct fallback',
      evidenceLevel: 'direct_http_content',
      finalUrl: `${fixture.origin}/fallback`,
      retrievalRoute: 'direct',
      statusCode: 200,
    })
    expect(result.attempts.map(attempt => [attempt.provider, attempt.outcome])).toEqual([
      ['tavily_extract', 'skipped'],
      ['firecrawl_scrape', 'failed'],
      ['smart_direct', 'failed'],
      ['direct', 'success'],
    ])
  })

  it('returns one redacted all-route error when production direct also fails', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.destroy(new Error('fixture-secret-response-body'))
    })
    const secret = 'Bearer route-secret'
    const fail = (route: WebExtractRoute): WebExtractAdapter => stubAdapter(route, async () => {
      throw new Error(`${secret} at ${route}`)
    })
    const config = testConfig()
    const orchestrator = new WebExtractOrchestrator({
      tavilyExtract: fail('tavily_extract'),
      firecrawlScrape: fail('firecrawl_scrape'),
      smartDirect: fail('smart_direct'),
      direct: new DirectFetchProvider(),
      getConfig: () => config,
      now: () => 100,
    })
    const operation = orchestrator.extract({
      format: 'text',
      signal: new AbortController().signal,
      url: `${fixture.origin}/failure?secret=query-secret`,
    })

    await expect(operation).rejects.toBeInstanceOf(WebExtractInfrastructureError)
    try {
      await operation
    } catch (error) {
      const failure = error as WebExtractInfrastructureError
      expect(failure.routeStatuses.map(status => status.provider)).toEqual([
        'tavily_extract',
        'firecrawl_scrape',
        'smart_direct',
        'direct',
      ])
      expect(failure.routeStatuses.at(-1)).toMatchObject({
        errorKind: 'network',
        outcome: 'failed',
        provider: 'direct',
      })
      const safe = JSON.stringify(failure)
      expect(safe).not.toContain(secret)
      expect(safe).not.toContain('fixture-secret')
      expect(safe).not.toContain('query-secret')
      expect(safe).not.toContain(fixture.origin)
    }
  })

  it('never calls production direct after an earlier route succeeds', async () => {
    const direct = new DirectFetchProvider()
    const extract = vi.spyOn(direct, 'extract')
    const config = testConfig()
    const orchestrator = new WebExtractOrchestrator({
      tavilyExtract: stubAdapter('tavily_extract', {
        result: { content: 'remote success', truncated: false },
        state: 'complete',
      }),
      firecrawlScrape: unavailable('firecrawl_scrape'),
      smartDirect: unavailable('smart_direct'),
      direct,
      getConfig: () => config,
      now: () => 100,
    })

    const result = await orchestrator.extract({
      format: 'markdown',
      signal: new AbortController().signal,
      url: 'https://example.test/not-dispatched',
    })

    expect(result).toMatchObject({
      evidenceLevel: 'extracted_content',
      retrievalRoute: 'tavily_extract',
    })
    expect(extract).not.toHaveBeenCalled()
  })
})

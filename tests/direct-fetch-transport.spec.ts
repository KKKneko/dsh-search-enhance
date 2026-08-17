import {
  createServer,
  request as httpRequest,
  type RequestListener,
  type Server,
} from 'node:http'
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from 'node:https'
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import type { LookupFunction } from 'node:net'
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
} from 'node:zlib'

import { Context, type Context as CordisContext } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  DirectFetchProvider,
  type DirectFetchProviderDependencies,
} from '../src/providers/direct-fetch.js'
import type {
  WebExtractAdapterInput,
  WebExtractAdapterResult,
  WebExtractFormat,
} from '../src/web-extract/index.js'
import {
  createHttpProxyFixture,
  PROXY_REJECTION_SECRET,
} from './proxy-fixture.js'

type DirectOverrides = Partial<SearchEnhanceConfig['webExtract']['direct']>
type WebExtractOverrides = Partial<Omit<
  SearchEnhanceConfig['webExtract'],
  'tavily' | 'firecrawl' | 'smartDirect' | 'direct'
>>

const cleanups: Array<() => Promise<void>> = []

/**
 * Public test-only TLS identity for the loopback HTTPS fixture below.
 * It protects no deployment or private data and must never be reused outside tests.
 */
const PUBLIC_TEST_TLS_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDyeT4PJrmQerEs
1HOrjN3Qrdv7dbUn8GnnGqfYc5ZZ4V8iZemju/Hij86ubWRgdeFZkZu2ZgQlyXl9
Rp4HiUZi6r3LWuGNyoiOouimjQBAR/QLD6PAqLRbt1wU3QoSnOfszEVMaIlEOXMx
eJdeBfh/7Sy71SyacwIg9l6PpMRMozB55amsrKmLt4kqcCTOiprHMLSBW8AR5X2+
u3Aoy8Np/3eSFPKKCxfmFIYSpA/grcrlErv3uOBPfQRLaJd3Z4SGW+YX3W38oG/s
JGW+/MkYT1R7w+/ZsFjnDUXizlkOrlrHkmZ7mYp6ZJNEBhNGmrNDbmB22PzR2QVu
e4vCWBCtAgMBAAECggEASNs9VnggUdVL31iG2QkerVFQRCJ+KF4ItDRCMruodaFO
YJuWtGgIqjbjt22PN5yz9aHW09uba286XfYWDdWlnJtEJBJOq7griBBTL5g2dxon
rhso7P7EErrppCs2l5kl5vUJ7YeLl0Bb6IV/lfTdUjMFufq3yEC+ZwEgMLElepEI
f9F+nzA6VvmPovS9htpbERslpz/ZRXfXrFVeuaTVSSqC5ZWGCzjaqtZ+jH3HzyE7
yEnATskI2gdqhX0AJWRA79tvPe5n96FRZv3P22L1ZlrwbX0ywbxI6a+ALjEFuLUK
dQVy8rbhffGiQPHezKmdu53qE+tUubfmtg6k0Us90QKBgQD/FGZOjDsdCJ2Fz4cz
aLIx/vP/YNMZh7H38n1MbTd+dguTf5SPpAZPw4nmD5VJPE4HagSxUa6nhLiB7pnG
FMPTIQQb/4zUMqxrSqlAQHHPkhj9lXg6YHNaIRb80k93aOilkiJpsmprGsdLqpgF
6rDFpIESkThfwlbt/PVMpSKAjwKBgQDzWTMJ/yBAcf6gcV6QAW7tPDjgJxD9aoSu
Wy3tdOpy1/qZI0rUkAYOpuuj+ilK3koX6QRB+HGaq3WrOTGL1EGJgoKzqjUr78sH
LL/awOlLQKF6GTxC7f4XgAP9RvoSjs3UscXKB+ze7wtCQwC/8usydC/X4iAB0xM4
YvJRoJABAwKBgQDJs+jebdcEs15UhHElvsFB9ZgdtgPXqUyagz5/Y9HBBzlKLlVc
bFitVDNEH8htu+j7xeLmEHAqeTGpVPJ2Bs9+sRndxesnlNZwlP5XF16nw6BNTZdf
mgs9FvNlgixigSuOWYsqx3GNNgSoGcLS0u1rrBSAiSLp3fP9hsy2CdLJkwKBgQCy
etK/WzqJadJqVJwZnKOCJjBE3wJMC4sC4mceCSlHT/dByCvDGVsH9g9QNlOA0Oah
AMuZoyGXYngsPAeF2gizVWCNa6IR9o7/VSflxqWVBvMoPUgAgtNg4wiKBDu3zrtS
a4x4sDVgEQ097Syom/87AxJwES6OiARJz/CQQ+Y6hwKBgQDbnt7Yzk7mIniv7+bv
dzodHBtnLwJUGmtj1SBZskrQCkpdHCfiFB5DpfndDYwDrzI8xUYCOtauoMVF4Aof
WjD4/2NfFzgtB76VErpOlPBf36wAQV7l6uxZwWA0ph923+jzxVaV0ripUyh0r7+5
SK0oXILUwj3GU4NqQG5E9+rF7Q==
-----END PRIVATE KEY-----
`

const PUBLIC_TEST_TLS_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUP6wkak7bhCjQsyt6sd4NSPjRh/AwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSdGxzLW9yaWdpbi5pbnZhbGlkMB4XDTI2MDgxNjIzMDUy
N1oXDTM2MDgxMzIzMDUyN1owHTEbMBkGA1UEAwwSdGxzLW9yaWdpbi5pbnZhbGlk
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8nk+Dya5kHqxLNRzq4zd
0K3b+3W1J/Bp5xqn2HOWWeFfImXpo7vx4o/Orm1kYHXhWZGbtmYEJcl5fUaeB4lG
Yuq9y1rhjcqIjqLopo0AQEf0Cw+jwKi0W7dcFN0KEpzn7MxFTGiJRDlzMXiXXgX4
f+0su9UsmnMCIPZej6TETKMweeWprKypi7eJKnAkzoqaxzC0gVvAEeV9vrtwKMvD
af93khTyigsX5hSGEqQP4K3K5RK797jgT30ES2iXd2eEhlvmF91t/KBv7CRlvvzJ
GE9Ue8Pv2bBY5w1F4s5ZDq5ax5Jme5mKemSTRAYTRpqzQ25gdtj80dkFbnuLwlgQ
rQIDAQABo3IwcDAdBgNVHQ4EFgQUJI/Jlz6/fhyEoRm4GfTDGkTDCFgwHwYDVR0j
BBgwFoAUJI/Jlz6/fhyEoRm4GfTDGkTDCFgwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HREEFjAUghJ0bHMtb3JpZ2luLmludmFsaWQwDQYJKoZIhvcNAQELBQADggEBAIue
xMTN27a+hTG7vAONUvLzoAmccw7Q6EpPNSkJ6iVeKGbekUtRztG2rh/Q7Z2tS6iu
vRJqX5S6T6KPaq0hcEq5hTfYovsE4LfbEpa9ejbNtUzbz07XYU+dhUfr0QShQa2C
L48708ln4yqXvzTy4h+L1HI94xwm1HOYdErFxOlD3g09/DsNDw1yP8beZV7VALrH
jHKlNneFtHHOrnB049zSKzLZookLqik/hYKaO4z8+cYKZIraDNhLodOZrVv4op20
H+PfAGjrR6CnZvq1lawpaep+S6ZE3Swc1VpkS6UklH1BOd98MyLkl3YEJ7ZhKhF5
eSk424vkJAPMlI+p83I=
-----END CERTIFICATE-----
`

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function testConfig(input: {
  readonly direct?: DirectOverrides
  readonly retry?: Partial<SearchEnhanceConfig['retry']>
  readonly webExtract?: WebExtractOverrides
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
  readonly port: number
  readonly sockets: ReadonlySet<Socket>
}

async function httpFixture(listener: RequestListener): Promise<HttpFixture> {
  const sockets = new Set<Socket>()
  const server = createServer(listener)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  cleanups.push(async () => closeServer(server, sockets))
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port, sockets }
}

async function httpsFixture(listener: RequestListener): Promise<HttpFixture & {
  readonly serverNames: readonly string[]
}> {
  const sockets = new Set<Socket>()
  const serverNames: string[] = []
  const server = createHttpsServer({ cert: PUBLIC_TEST_TLS_CERTIFICATE, key: PUBLIC_TEST_TLS_PRIVATE_KEY }, listener)
  server.on('connection', socket => {
    const networkSocket = socket as Socket
    sockets.add(networkSocket)
    networkSocket.once('close', () => sockets.delete(networkSocket))
  })
  server.on('secureConnection', socket => {
    if (typeof socket.servername === 'string') serverNames.push(socket.servername)
  })
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  cleanups.push(async () => closeServer(server, sockets))
  return {
    origin: `https://127.0.0.1:${address.port}`,
    port: address.port,
    serverNames,
    sockets,
  }
}

async function tcpFixture(listener: (socket: Socket) => void): Promise<{
  readonly port: number
  readonly sockets: ReadonlySet<Socket>
}> {
  const sockets = new Set<Socket>()
  const server = createTcpServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    listener(socket)
  })
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  cleanups.push(async () => closeTcpServer(server, sockets))
  return { port: address.port, sockets }
}

function listen(server: Server | HttpsServer | TcpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: Server | HttpsServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

async function closeTcpServer(server: TcpServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

function adapterInput(
  url: string,
  config: SearchEnhanceConfig,
  format: WebExtractFormat = 'text',
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

async function extractResult(
  url: string,
  config = testConfig(),
  format: WebExtractFormat = 'text',
  dependencies: DirectFetchProviderDependencies = {},
  signal = new AbortController().signal,
  onDispatch?: () => void,
): Promise<WebExtractAdapterResult> {
  const outcome = await new DirectFetchProvider(dependencies).extract(
    adapterInput(url, config, format, signal, onDispatch),
  )
  expect(outcome.state).toBe('complete')
  if (outcome.state !== 'complete') throw new Error('direct fixture did not complete')
  return outcome.result
}

describe('DirectFetchProvider transport and resource bounds', () => {
  it('is the enabled direct adapter, supports all five formats, and reaches localhost', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('localhost body')
    })
    const provider = new DirectFetchProvider()
    const config = testConfig()

    expect(provider.route).toBe('direct')
    expect(provider.enabled(config)).toBe(true)
    for (const format of ['markdown', 'text', 'html', 'json', 'raw'] as const) {
      expect(provider.supports(format)).toBe(true)
    }
    expect(provider.supports('invalid' as WebExtractFormat)).toBe(false)
    await expect(provider.extract({
      ...adapterInput(`${fixture.origin}/invalid-format`, config),
      format: 'invalid' as WebExtractFormat,
    })).rejects.toMatchObject({ kind: 'invalid_request', provider: 'direct' })
    const result = await extractResult(
      `http://localhost:${fixture.port}/allowed`,
      config,
      'text',
    )

    expect(result).toMatchObject({
      content: 'localhost body',
      finalUrl: `http://localhost:${fixture.port}/allowed`,
      statusCode: 200,
      truncated: false,
    })
  })

  it('keeps agent:false and ignores proxy environment variables when proxyUrl is absent', async () => {
    const proxy = await createHttpProxyFixture({ rejectHttp: true })
    cleanups.push(() => proxy.close())
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('explicit config only')
    })
    const request = vi.fn<NonNullable<DirectFetchProviderDependencies['request']>>((
      url,
      options,
      callback,
    ) => httpRequest(url, options, callback))
    const previous = [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.ALL_PROXY]
    process.env.HTTP_PROXY = proxy.origin
    process.env.HTTPS_PROXY = proxy.origin
    process.env.ALL_PROXY = proxy.origin
    try {
      const result = await extractResult(fixture.origin, testConfig(), 'text', { request })
      expect(result.content).toBe('explicit config only')
    } finally {
      const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
      names.forEach((name, index) => {
        const value = previous[index]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      })
    }
    expect(request.mock.calls[0]?.[1].agent).toBe(false)
    expect(proxy.requests).toEqual([])
    expect(proxy.connects).toEqual([])
  })

  it('sends every HTTP redirect and retry through the configured proxy without target DNS', async () => {
    const paths: string[] = []
    let terminalRequests = 0
    const fixture = await httpFixture((request, response) => {
      paths.push(request.url ?? '')
      if (request.url === '/start') {
        response.writeHead(302, { location: '/terminal' })
        response.end()
        return
      }
      terminalRequests += 1
      if (terminalRequests === 1) {
        response.writeHead(503)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct HTTP proxy body')
    })
    const proxy = await createHttpProxyFixture()
    cleanups.push(() => proxy.close())
    const target = `http://direct-origin.invalid:${fixture.port}/start`
    const result = await extractResult(
      target,
      testConfig({ direct: { maxRetries: 1, proxyUrl: proxy.origin } }),
    )

    expect(result).toMatchObject({
      content: 'direct HTTP proxy body',
      finalUrl: `http://direct-origin.invalid:${fixture.port}/terminal`,
      statusCode: 200,
    })
    expect(paths).toEqual(['/start', '/terminal', '/terminal'])
    expect(proxy.requests).toEqual([
      target,
      `http://direct-origin.invalid:${fixture.port}/terminal`,
      `http://direct-origin.invalid:${fixture.port}/terminal`,
    ])
  })

  it('uses HTTP CONNECT and verified target TLS/SNI for an HTTPS target', async () => {
    const fixture = await httpsFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct HTTPS proxy body')
    })
    const proxy = await createHttpProxyFixture()
    cleanups.push(() => proxy.close())
    const target = `https://tls-origin.invalid:${fixture.port}/secure`
    const request: NonNullable<DirectFetchProviderDependencies['request']> = (
      url,
      options,
      callback,
    ) => httpsRequest(url, { ...options, ca: PUBLIC_TEST_TLS_CERTIFICATE }, callback)
    const result = await extractResult(
      target,
      testConfig({ direct: { proxyUrl: proxy.origin } }),
      'text',
      { request },
    )

    expect(result).toMatchObject({ content: 'direct HTTPS proxy body', finalUrl: target, statusCode: 200 })
    expect(proxy.requests).toEqual([])
    expect(proxy.connects).toEqual([`tls-origin.invalid:${fixture.port}`])
    expect(fixture.serverNames).toEqual(['tls-origin.invalid'])
  })

  it('maps HTTP and CONNECT proxy 407 responses to safe non-retryable Provider errors', async () => {
    for (const testCase of [
      { options: { rejectHttp: true }, target: 'http://proxy-rejected.invalid/resource' },
      { options: { rejectConnect: true }, target: 'https://proxy-rejected.invalid/resource' },
    ] as const) {
      const proxy = await createHttpProxyFixture(testCase.options)
      cleanups.push(() => proxy.close())
      let caught: unknown
      try {
        await new DirectFetchProvider().extract(adapterInput(
          testCase.target,
          testConfig({ direct: { proxyUrl: proxy.origin } }),
        ))
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({
        kind: 'http',
        provider: 'direct',
        retryable: false,
        status: 407,
      })
      expect(proxy.proxyAuthorizations).toEqual([])
      const visible = `${String(caught)}\n${JSON.stringify(caught)}`
      expect(visible).not.toContain(PROXY_REJECTION_SECRET)
      expect(visible).not.toMatch(/proxy-authorization|proxy-authenticate/i)
    }
  })

  it('settles proxy connection failure, timeout, and cancellation without open sockets', async () => {
    let bypassRequests = 0
    const bypassOrigin = await httpFixture((_request, response) => {
      bypassRequests += 1
      response.writeHead(200)
      response.end('must not bypass the configured proxy')
    })
    const closedProxy = await createHttpProxyFixture()
    const closedProxyUrl = closedProxy.origin
    await closedProxy.close()
    await expect(new DirectFetchProvider().extract(adapterInput(
      `${bypassOrigin.origin}/resource`,
      testConfig({ direct: { proxyUrl: closedProxyUrl } }),
    ))).rejects.toMatchObject({ kind: 'network', provider: 'direct' })
    expect(bypassRequests).toBe(0)

    const timedOutProxy = await createHttpProxyFixture({ hangHttp: true })
    cleanups.push(() => timedOutProxy.close())
    await expect(new DirectFetchProvider().extract(adapterInput(
      'http://direct-timeout.invalid/resource',
      testConfig({ direct: {
        connectTimeoutMs: 200,
        firstByteTimeoutMs: 20,
        proxyUrl: timedOutProxy.origin,
        totalTimeoutMs: 300,
      } }),
    ))).rejects.toMatchObject({ kind: 'timeout', provider: 'direct' })
    await vi.waitFor(() => expect(timedOutProxy.sockets.size).toBe(0))

    const cancelledProxy = await createHttpProxyFixture({ hangHttp: true })
    cleanups.push(() => cancelledProxy.close())
    const controller = new AbortController()
    const reason = new Error('cancel direct proxy request')
    const operation = new DirectFetchProvider().extract(adapterInput(
      'http://direct-cancel.invalid/resource',
      testConfig({ direct: { proxyUrl: cancelledProxy.origin, totalTimeoutMs: 2000 } }),
      'text',
      controller.signal,
    ))
    await vi.waitFor(() => expect(cancelledProxy.requests).toHaveLength(1))
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => expect(cancelledProxy.sockets.size).toBe(0))
  })

  it('enforces connect timeout while DNS is unresolved and closes the request', async () => {
    const lookup = vi.fn((
      _hostname: string,
      _options: unknown,
      _callback: unknown,
    ) => undefined) as unknown as LookupFunction
    const provider = new DirectFetchProvider({ lookup })
    const operation = provider.extract(adapterInput(
      'http://unresolved.fixture.test/resource',
      testConfig({ direct: { connectTimeoutMs: 20, totalTimeoutMs: 200 } }),
    ))

    await expect(operation).rejects.toMatchObject({ kind: 'timeout', provider: 'direct' })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('enforces first-byte timeout after a connection is established', async () => {
    let received = false
    const fixture = await httpFixture(() => { received = true })
    const operation = new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/no-headers`,
      testConfig({
        direct: {
          connectTimeoutMs: 200,
          firstByteTimeoutMs: 20,
          totalTimeoutMs: 300,
        },
      }),
    ))

    const rejection = expect(operation).rejects.toMatchObject({ kind: 'timeout', provider: 'direct' })
    await vi.waitFor(() => expect(received).toBe(true))
    await rejection
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('clears first-byte timeout on raw response data even before headers complete', async () => {
    const fixture = await tcpFixture(socket => {
      socket.once('data', () => socket.write('HTTP/1.1 '))
    })
    const startedAt = Date.now()
    const operation = new DirectFetchProvider().extract(adapterInput(
      `http://127.0.0.1:${fixture.port}/partial-headers`,
      testConfig({
        direct: {
          connectTimeoutMs: 200,
          firstByteTimeoutMs: 20,
          totalTimeoutMs: 80,
        },
      }),
    ))

    await expect(operation).rejects.toMatchObject({ kind: 'timeout', provider: 'direct' })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50)
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('enforces the independent total timeout while a body is streaming', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('started')
    })
    const operation = new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/never-finishes`,
      testConfig({
        direct: {
          connectTimeoutMs: 200,
          firstByteTimeoutMs: 200,
          totalTimeoutMs: 30,
        },
      }),
    ))

    await expect(operation).rejects.toMatchObject({ kind: 'timeout', provider: 'direct' })
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('checks Content-Length before reading and returns truthful bounded metadata', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-length': '1000',
        'content-type': 'text/plain',
      })
      response.write('must not be injected')
    })
    const result = await extractResult(
      `${fixture.origin}/declared-large`,
      testConfig({ direct: { maxContentLengthBytes: 20, maxInputBytes: 20 } }),
    )

    expect(result).toMatchObject({
      contentLength: 1000,
      decompressedBytes: 0,
      encodedBodyTruncated: true,
      encodedBytes: 0,
      metadataOnlyReason: 'declared_too_large',
      statusCode: 200,
      truncated: true,
    })
    expect(result.content).toContain('Content-Length exceeds')
    expect(result.content).not.toContain('must not be injected')
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('rejects malformed Content-Length before treating a response as content', async () => {
    const fixture = await tcpFixture(socket => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: invalid\r\nConnection: close\r\n\r\nbody')
      })
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `http://127.0.0.1:${fixture.port}/malformed-length`,
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'direct' })
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('accepts an exact response-header and Content-Length boundary, then rejects one byte less', async () => {
    const header = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\n'
    const fixture = await tcpFixture(socket => {
      socket.once('data', () => socket.end(`${header}body`))
    })
    const headerBytes = Buffer.byteLength(header, 'latin1')
    const exact = await extractResult(
      `http://127.0.0.1:${fixture.port}/exact-header`,
      testConfig({ direct: { maxHeaderBytes: headerBytes } }),
    )
    expect(exact).toMatchObject({
      content: 'body',
      contentLength: 4,
      encodedBytes: 4,
      truncated: false,
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `http://127.0.0.1:${fixture.port}/over-header`,
      testConfig({ direct: { maxHeaderBytes: headerBytes - 1 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded', provider: 'direct' })
  })

  it('distinguishes exact and over-limit chunked encoded bytes without splitting Unicode output', async () => {
    const exactBody = Buffer.from('A界🙂')
    const fixture = await httpFixture((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.write(exactBody)
      if (request.url === '/over') response.write('Z')
      response.end()
    })
    const config = testConfig({
      direct: {
        maxContentLengthBytes: 100,
        maxDecompressedBytes: 100,
        maxInputBytes: exactBody.byteLength,
      },
    })

    const exact = await extractResult(`${fixture.origin}/exact`, config)
    expect(exact).toMatchObject({
      content: 'A界🙂',
      decompressedBytes: exactBody.byteLength,
      encodedBytes: exactBody.byteLength,
      truncated: false,
    })
    expect(exact.encodedBodyTruncated).toBeUndefined()

    const over = await extractResult(`${fixture.origin}/over`, config)
    expect(over.content).toBe('A界🙂')
    expect(over.encodedBodyTruncated).toBe(true)
    expect(over.truncated).toBe(true)
    expect(over.encodedBytes).toBeGreaterThan(exactBody.byteLength)
    expect(Buffer.byteLength(over.content, 'utf8')).toBe(exactBody.byteLength)
  })

  it('drops an incomplete trailing UTF-8 sequence at a byte limit instead of fabricating replacement text', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.write('A🙂Z')
      response.end()
    })
    const result = await extractResult(
      `${fixture.origin}/unicode-split`,
      testConfig({
        direct: {
          maxContentLengthBytes: 100,
          maxDecompressedBytes: 100,
          maxInputBytes: 3,
        },
      }),
    )

    expect(result.content).toBe('A')
    expect(result.content).not.toContain('�')
    expect(result.encodedBodyTruncated).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it.each([
    ['gzip', gzipSync] as const,
    ['deflate', deflateSync] as const,
    ['br', brotliCompressSync] as const,
  ])('counts %s encoded and decompressed boundaries independently', async (encoding, compress) => {
    const plain = Buffer.from('abcdefgh')
    const compressed = compress(plain)
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-encoding': encoding,
        'content-type': 'text/plain',
      })
      response.end(compressed)
    })
    const exactConfig = testConfig({
      direct: {
        maxContentLengthBytes: compressed.byteLength + 10,
        maxDecompressedBytes: plain.byteLength,
        maxInputBytes: compressed.byteLength,
      },
    })

    const exact = await extractResult(`${fixture.origin}/${encoding}`, exactConfig)
    expect(exact).toMatchObject({
      content: plain.toString(),
      contentEncoding: encoding,
      decompressedBytes: plain.byteLength,
      encodedBytes: compressed.byteLength,
      truncated: false,
    })

    const over = await extractResult(
      `${fixture.origin}/${encoding}`,
      testConfig({
        direct: {
          maxContentLengthBytes: compressed.byteLength + 10,
          maxDecompressedBytes: plain.byteLength - 1,
          maxInputBytes: compressed.byteLength,
        },
      }),
    )
    expect(over.content).toBe('abcdefg')
    expect(over.decompressedBodyTruncated).toBe(true)
    expect(over.encodedBodyTruncated).toBeUndefined()
    expect(over.decompressedBytes).toBe(plain.byteLength)
    expect(over.truncated).toBe(true)
  })

  it('rejects malformed compressed content instead of exposing partial text', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-type': 'text/plain',
      })
      response.end('not a gzip stream')
    })

    await expect(new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/malformed-gzip`,
      testConfig(),
    ))).rejects.toMatchObject({ kind: 'invalid_response', provider: 'direct' })
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('stops an encoded gzip stream over its independent input limit', async () => {
    const plain = Buffer.from('a'.repeat(32 * 1024))
    const compressed = gzipSync(plain)
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-type': 'text/plain',
      })
      response.end(compressed)
    })
    const result = await extractResult(
      `${fixture.origin}/encoded-over`,
      testConfig({
        direct: {
          maxContentLengthBytes: compressed.byteLength + 10,
          maxDecompressedBytes: plain.byteLength,
          maxInputBytes: compressed.byteLength - 1,
          maxPreviewBytes: 1024,
        },
      }),
    )

    expect(result.encodedBodyTruncated).toBe(true)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(1024)
    expect(result.content.length).toBeLessThan(plain.length)
  })

  it.each([
    {
      headers: { 'content-type': 'application/octet-stream' },
      reason: 'binary_content_type',
      path: 'binary',
    },
    {
      headers: {
        'content-disposition': 'attachment; filename="secret.txt"',
        'content-type': 'text/plain',
      },
      reason: 'attachment',
      path: 'attachment',
    },
  ])('returns metadata only for $path bodies', async ({ headers, path, reason }) => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, headers)
      response.end('body-secret-must-not-appear')
    })
    const result = await extractResult(`${fixture.origin}/${path}`)

    expect(result.metadataOnlyReason).toBe(reason)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('Direct fetch metadata only')
    expect(result.content).not.toContain('body-secret')
    expect(result.encodedBytes).toBe(0)
  })

  it('does not confuse an inline filename containing attachment with an attachment disposition', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-disposition': 'inline; filename="attachment-notice.txt"',
        'content-type': 'text/plain',
      })
      response.end('inline body')
    })
    const result = await extractResult(`${fixture.origin}/inline`)

    expect(result.content).toBe('inline body')
    expect(result.contentDisposition).toBe('inline; filename="attachment-notice.txt"')
    expect(result.metadataOnlyReason).toBeUndefined()
    expect(result.truncated).toBe(false)
  })

  it('detects an actually binary prefix despite a text Content-Type', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(Buffer.from([0, 1, 2, 3, 65, 66]))
    })
    const result = await extractResult(`${fixture.origin}/sniffed-binary`)

    expect(result).toMatchObject({
      metadataOnlyReason: 'binary_body',
      truncated: true,
    })
    expect(result.content).not.toContain('\u0000')
  })

  it('bounds response headers before exposing metadata', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'x-oversized': 'x'.repeat(4096),
      })
      response.end('body')
    })
    await expect(new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/headers`,
      testConfig({ direct: { maxHeaderBytes: 256 } }),
    ))).rejects.toMatchObject({ kind: 'budget_exceeded', provider: 'direct' })
  })

  it('returns a fixed non-empty metadata notice for a genuinely empty response', async () => {
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(204, { 'content-type': 'text/plain' })
      response.end()
    })
    const result = await extractResult(`${fixture.origin}/empty`)

    expect(result).toMatchObject({
      decompressedBytes: 0,
      encodedBytes: 0,
      metadataOnlyReason: 'empty_body',
      statusCode: 204,
      truncated: false,
    })
    expect(result.contentLength).toBeUndefined()
    expect(result.content).toContain('contains no textual body')
  })

  it('returns 404 body/status without retrying, but retries 429 using bounded Retry-After', async () => {
    let notFoundCalls = 0
    let rateLimitCalls = 0
    const fixture = await httpFixture((request, response) => {
      if (request.url === '/missing') {
        notFoundCalls += 1
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found body')
        return
      }
      rateLimitCalls += 1
      if (rateLimitCalls === 1) {
        response.writeHead(429, { 'retry-after': '0' })
        response.end('retry me')
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('recovered')
      }
    })
    const sleep = vi.fn(async () => undefined)
    const dispatch = vi.fn()
    const config = testConfig({
      direct: { maxRetries: 1 },
      retry: { maxDelayMs: 10, maxTotalDelayMs: 10 },
    })

    const missing = await extractResult(
      `${fixture.origin}/missing`,
      config,
      'text',
      { sleep },
      new AbortController().signal,
      dispatch,
    )
    expect(missing).toMatchObject({ content: 'not found body', statusCode: 404 })
    expect(notFoundCalls).toBe(1)

    const recovered = await extractResult(
      `${fixture.origin}/limited`,
      config,
      'text',
      { sleep },
      new AbortController().signal,
      dispatch,
    )
    expect(recovered).toMatchObject({ content: 'recovered', statusCode: 200 })
    expect(rateLimitCalls).toBe(2)
    expect(sleep).toHaveBeenCalledWith(0, expect.any(AbortSignal))
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('caps total retries and both Retry-After and cumulative backoff', async () => {
    let alwaysFailCalls = 0
    let retryAfterCalls = 0
    const fixture = await httpFixture((request, response) => {
      if (request.url === '/always-fail') {
        alwaysFailCalls += 1
        response.writeHead(503)
        response.end()
        return
      }
      retryAfterCalls += 1
      if (retryAfterCalls === 1) {
        response.writeHead(429, { 'retry-after': '999' })
        response.end()
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('recovered after capped wait')
      }
    })
    const sleeps: number[] = []
    const sleep = async (milliseconds: number): Promise<void> => { sleeps.push(milliseconds) }
    const retryConfig = testConfig({
      direct: { maxRetries: 2 },
      retry: {
        baseDelayMs: 100,
        maxDelayMs: 100,
        maxTotalDelayMs: 150,
        multiplier: 2,
      },
    })

    await expect(new DirectFetchProvider({ sleep }).extract(adapterInput(
      `${fixture.origin}/always-fail`,
      retryConfig,
    ))).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(alwaysFailCalls).toBe(3)
    expect(sleeps).toEqual([100, 50])

    sleeps.length = 0
    const recovered = await extractResult(
      `${fixture.origin}/retry-after`,
      testConfig({
        direct: { maxRetries: 1 },
        retry: { maxDelayMs: 70, maxTotalDelayMs: 50 },
      }),
      'text',
      { sleep },
    )
    expect(recovered.content).toBe('recovered after capped wait')
    expect(retryAfterCalls).toBe(2)
    expect(sleeps).toEqual([50])
  })

  it('closes the check-to-listener cancellation race before dispatch', async () => {
    let requests = 0
    const fixture = await httpFixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('must not dispatch')
    })
    const controller = new AbortController()
    const reason = new Error('abort while request is being created')
    const request = vi.fn<NonNullable<DirectFetchProviderDependencies['request']>>((
      url,
      options,
      callback,
    ) => {
      controller.abort(reason)
      return httpRequest(url, options, callback)
    })
    const operation = new DirectFetchProvider({ request }).extract(adapterInput(
      `${fixture.origin}/race`,
      testConfig(),
      'text',
      controller.signal,
    ))

    await expect(operation).rejects.toBe(reason)
    expect(request).toHaveBeenCalledTimes(1)
    expect(requests).toBe(0)
    expect(fixture.sockets.size).toBe(0)
  })

  it('cancels unresolved DNS immediately with the exact caller reason', async () => {
    const controller = new AbortController()
    const reason = new Error('dispose during DNS')
    const lookup = vi.fn((
      _hostname: string,
      _options: unknown,
      _callback: unknown,
    ) => undefined) as unknown as LookupFunction
    const operation = new DirectFetchProvider({ lookup }).extract(adapterInput(
      'http://dns-cancel.fixture.test/',
      testConfig({ direct: { connectTimeoutMs: 500, totalTimeoutMs: 1000 } }),
      'text',
      controller.signal,
    ))
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

    controller.abort(reason)

    await expect(operation).rejects.toBe(reason)
  })

  it('cancels a TLS connection handshake and closes its socket', async () => {
    const connected = vi.fn()
    const fixture = await tcpFixture(socket => {
      socket.resume()
      connected()
    })
    const controller = new AbortController()
    const reason = new Error('dispose during connect')
    const operation = new DirectFetchProvider().extract(adapterInput(
      `https://127.0.0.1:${fixture.port}/`,
      testConfig({ direct: { connectTimeoutMs: 1000, totalTimeoutMs: 2000 } }),
      'text',
      controller.signal,
    ))
    const rejection = expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1))

    controller.abort(reason)

    await rejection
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('cancels response reading and decompression without leaving a socket open', async () => {
    const compressed = gzipSync(Buffer.from('streaming decompressed content '.repeat(1000)))
    const fixture = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-type': 'text/plain',
      })
      response.write(compressed.subarray(0, Math.ceil(compressed.byteLength / 2)))
    })
    const controller = new AbortController()
    const reason = new Error('dispose during decompression')
    const operation = new DirectFetchProvider().extract(adapterInput(
      `${fixture.origin}/gzip-stream`,
      testConfig({ direct: { totalTimeoutMs: 2000 } }),
      'text',
      controller.signal,
    ))
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(1))

    controller.abort(reason)

    await expect(operation).rejects.toBe(reason)
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })

  it('quiesces direct requests when an owning Fiber reloads and disposes', async () => {
    let requests = 0
    const fixture = await httpFixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write(`generation ${requests}`)
    })
    const context = new Context()
    const provider = new DirectFetchProvider()
    const controllers: AbortController[] = []
    const settled: Promise<void>[] = []
    const reasons: unknown[] = []
    const plugin = (ctx: CordisContext): void => {
      ctx.effect(() => {
        const controller = new AbortController()
        controllers.push(controller)
        const operation = provider.extract(adapterInput(
          `${fixture.origin}/fiber-${controllers.length}`,
          testConfig({ direct: { totalTimeoutMs: 2000 } }),
          'text',
          controller.signal,
        )).then(
          () => undefined,
          error => { reasons.push(error) },
        )
        settled.push(operation)
        return async () => {
          controller.abort(new Error(`fiber generation ${controllers.length} disposed`))
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
    expect(reasons).toHaveLength(2)
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
    await context.fiber.dispose()
  })

  it('cancels retry backoff and starts no later request', async () => {
    let requests = 0
    const fixture = await httpFixture((_request, response) => {
      requests += 1
      response.writeHead(503)
      response.end()
    })
    const controller = new AbortController()
    const reason = new Error('dispose during retry delay')
    let sleeping = false
    const sleep = vi.fn((_milliseconds: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      sleeping = true
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const operation = new DirectFetchProvider({ sleep }).extract(adapterInput(
      `${fixture.origin}/retry`,
      testConfig({
        direct: { maxRetries: 2, totalTimeoutMs: 2000 },
        retry: {
          baseDelayMs: 1000,
          maxDelayMs: 1000,
          maxTotalDelayMs: 2000,
          multiplier: 1,
        },
      }),
      'text',
      controller.signal,
    ))
    await vi.waitFor(() => expect(sleeping).toBe(true))

    controller.abort(reason)

    await expect(operation).rejects.toBe(reason)
    expect(requests).toBe(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0))
  })
})

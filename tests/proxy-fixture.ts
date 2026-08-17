import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'

export const PROXY_REJECTION_SECRET = 'private-proxy-response-must-not-escape'

export interface HttpProxyFixtureOptions {
  readonly hangConnect?: boolean
  readonly hangHttp?: boolean
  readonly rejectConnect?: boolean
  readonly rejectHttp?: boolean
  readonly resolveHostname?: (hostname: string) => string
}

export interface HttpProxyFixture {
  readonly origin: string
  readonly requests: readonly string[]
  readonly connects: readonly string[]
  readonly proxyAuthorizations: readonly string[]
  readonly sockets: ReadonlySet<Socket>
  close(): Promise<void>
}

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded['proxy-authorization']
  delete forwarded['proxy-connection']
  return forwarded
}

export async function createHttpProxyFixture(
  options: HttpProxyFixtureOptions = {},
): Promise<HttpProxyFixture> {
  const requests: string[] = []
  const connects: string[] = []
  const proxyAuthorizations: string[] = []
  const sockets = new Set<Socket>()
  const resolveHostname = options.resolveHostname ?? (() => '127.0.0.1')
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const absoluteUrl = request.url ?? ''
    requests.push(absoluteUrl)
    const proxyAuthorization = request.headers['proxy-authorization']
    if (typeof proxyAuthorization === 'string') proxyAuthorizations.push(proxyAuthorization)
    if (options.rejectHttp) {
      response.writeHead(407, {
        'content-type': 'text/plain',
        'proxy-authenticate': `Basic realm="${PROXY_REJECTION_SECRET}"`,
      })
      response.end(PROXY_REJECTION_SECRET)
      return
    }
    if (options.hangHttp) return

    let target: URL
    try {
      target = new URL(absoluteUrl)
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    const upstream = httpRequest({
      headers: { ...forwardHeaders(request.headers), host: target.host },
      host: resolveHostname(target.hostname),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      port: target.port.length > 0 ? Number(target.port) : 80,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.once('socket', track)
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.once('aborted', () => upstream.destroy())
    request.pipe(upstream)
  })

  server.on('connection', track)
  server.on('connect', (request, client, head) => {
    const authority = request.url ?? ''
    connects.push(authority)
    const proxyAuthorization = request.headers['proxy-authorization']
    if (typeof proxyAuthorization === 'string') proxyAuthorizations.push(proxyAuthorization)
    if (options.rejectConnect) {
      client.end([
        'HTTP/1.1 407 Proxy Authentication Required',
        `Proxy-Authenticate: Basic realm="${PROXY_REJECTION_SECRET}"`,
        'Content-Type: text/plain',
        `Content-Length: ${Buffer.byteLength(PROXY_REJECTION_SECRET)}`,
        '',
        PROXY_REJECTION_SECRET,
      ].join('\r\n'))
      return
    }
    if (options.hangConnect) return

    let target: URL
    try {
      target = new URL(`http://${authority}`)
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const upstream = connect(
      Number(target.port || 443),
      resolveHostname(target.hostname),
      () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.byteLength > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      },
    )
    track(upstream)
    upstream.once('error', () => {
      client.destroy()
    })
    client.once('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    connects,
    origin: `http://127.0.0.1:${address.port}`,
    proxyAuthorizations,
    requests,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
}

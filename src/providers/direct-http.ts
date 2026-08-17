import * as http from 'node:http'
import * as https from 'node:https'
import type { LookupFunction, Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import {
  PassThrough,
  Transform,
  Writable,
  type TransformCallback,
} from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from 'node:zlib'

import type { DirectFetchConfig } from '../config.js'
import {
  isProviderError,
  parseRetryAfterMs,
  ProviderError,
  providerHttpError,
  RETRYABLE_HTTP_STATUSES,
  throwIfAborted,
} from '../provider-runtime/index.js'
import {
  isDirectTextLikeContentType,
  type DirectBodyOmissionReason,
} from './direct-content.js'

const PROVIDER = 'direct' as const
const CAPABILITY = 'web_extract' as const
const HTTP_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Public Node request seam used only by deterministic transport tests. */
export type DirectRequestFactory = (
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest

/** Optional public-API substitutions; production defaults use node:http/node:https. */
export interface DirectHttpDependencies {
  readonly request?: DirectRequestFactory
  readonly lookup?: LookupFunction
  readonly retryNow?: () => number
}

interface DirectHttpBaseResponse {
  readonly url: string
  readonly statusCode: number
  readonly contentType?: string
  readonly contentLength?: number
  readonly contentDisposition?: string
  readonly contentEncoding?: string
}

export interface DirectHttpRedirectResponse extends DirectHttpBaseResponse {
  readonly kind: 'redirect'
  readonly location: string
}

export interface DirectHttpTerminalResponse extends DirectHttpBaseResponse {
  readonly kind: 'response'
  readonly body: Buffer
  readonly encodedBytes: number
  readonly decompressedBytes: number
  readonly encodedBodyTruncated: boolean
  readonly decompressedBodyTruncated: boolean
  readonly omittedReason?: DirectBodyOmissionReason
}

export type DirectHttpHopResponse = DirectHttpRedirectResponse | DirectHttpTerminalResponse

export interface DirectHttpHopInput {
  readonly url: string
  readonly signal: AbortSignal
  readonly config: DirectFetchConfig
  readonly onDispatch?: () => void
}

class DirectPhaseTimeoutError extends Error {
  readonly phase: 'connect' | 'first_byte'

  constructor(phase: 'connect' | 'first_byte') {
    super(`direct ${phase} timeout`)
    this.name = 'DirectPhaseTimeoutError'
    this.phase = phase
  }
}

class DirectStreamLimitError extends Error {
  readonly boundary: 'encoded' | 'decompressed'

  constructor(boundary: 'encoded' | 'decompressed') {
    super(`direct ${boundary} stream limit`)
    this.name = 'DirectStreamLimitError'
    this.boundary = boundary
  }
}

function requestFactory(
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  return url.protocol === 'https:'
    ? https.request(url, options, callback)
    : http.request(url, options, callback)
}

function supportsNodeProxyEnv(): boolean {
  const [major = 0, minor = 0] = process.versions.node
    .split('.', 2)
    .map(value => Number.parseInt(value, 10))
  return major > 24 || (major === 24 && minor >= 5)
}

/** One request-owned Agent; an explicit empty bypass list prevents silent direct routing. */
function directProxyAgent(target: URL, proxyUrl: string | undefined): http.Agent | undefined {
  if (proxyUrl === undefined) return undefined
  if (!supportsNodeProxyEnv()) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'configuration', provider: PROVIDER })
  }
  const options: http.AgentOptions = {
    keepAlive: false,
    maxSockets: 1,
    proxyEnv: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: '',
    },
  }
  return target.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

function observeDispatch(observer: (() => void) | undefined): void {
  if (observer === undefined) return
  try {
    observer()
  } catch {
    // Diagnostics never alter transport execution.
  }
}

function timeoutTimer(callback: () => void, milliseconds: number): NodeJS.Timeout {
  const timer = setTimeout(callback, milliseconds)
  timer.unref()
  return timer
}

/** Own one ClientRequest from creation until its close event has settled. */
class DirectRequestOwner {
  readonly response: Promise<http.IncomingMessage>
  private readonly request: http.ClientRequest
  private readonly signal: AbortSignal
  private readonly secure: boolean
  private readonly agent: http.Agent | undefined
  private readonly closed: Promise<void>
  private resolveResponse!: (response: http.IncomingMessage) => void
  private rejectResponse!: (error: unknown) => void
  private socket: Socket | undefined
  private incoming: http.IncomingMessage | undefined
  private connectTimer: NodeJS.Timeout | undefined
  private firstByteTimer: NodeJS.Timeout | undefined
  private responseSettled = false
  private requestClosed = false
  private closing = false

  private readonly onAbort = (): void => {
    const reason = abortReason(this.signal)
    this.incoming?.destroy(reason)
    this.request.destroy(reason)
    this.socket?.destroy(reason)
  }

  private readonly onRequestClose = (): void => {
    this.requestClosed = true
  }

  private readonly onRequestError = (error: Error): void => {
    if (!this.responseSettled) {
      this.responseSettled = true
      this.rejectResponse(error)
      return
    }
    this.incoming?.destroy(error)
  }

  private readonly onSocket = (socket: Socket): void => {
    this.socket = socket
    if (this.closing) {
      socket.destroy()
      return
    }
    if (this.secure) {
      const tlsSocket = socket as TLSSocket
      if (tlsSocket.getProtocol() === null) tlsSocket.once('secureConnect', this.markConnected)
      else this.markConnected()
    } else if (socket.connecting) {
      socket.once('connect', this.markConnected)
    } else {
      this.markConnected()
    }
  }

  private readonly markFirstByte = (): void => {
    if (this.firstByteTimer !== undefined) {
      clearTimeout(this.firstByteTimer)
      this.firstByteTimer = undefined
    }
  }

  private readonly markConnected = (): void => {
    if (this.closing || this.incoming !== undefined) return
    this.clearConnectTimer()
    if (this.firstByteTimer === undefined) {
      this.socket?.once('data', this.markFirstByte)
      this.firstByteTimer = timeoutTimer(() => {
        const error = new DirectPhaseTimeoutError('first_byte')
        this.request.destroy(error)
        this.socket?.destroy(error)
      }, this.firstByteTimeoutMs)
    }
  }

  constructor(
    target: URL,
    config: DirectFetchConfig,
    signal: AbortSignal,
    dependencies: DirectHttpDependencies,
  ) {
    this.signal = signal
    this.secure = target.protocol === 'https:'
    this.agent = directProxyAgent(target, config.proxyUrl)
    this.firstByteTimeoutMs = config.firstByteTimeoutMs
    this.response = new Promise<http.IncomingMessage>((resolve, reject) => {
      this.resolveResponse = resolve
      this.rejectResponse = reject
    })
    const makeRequest = dependencies.request ?? requestFactory
    this.request = makeRequest(target, {
      agent: this.agent ?? false,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        'Cache-Control': 'no-cache',
        Connection: 'close',
        Pragma: 'no-cache',
        'User-Agent': 'dsh-search-enhance-direct/0.1 (bounded Node HTTP; no JavaScript)',
      },
      ...(dependencies.lookup === undefined ? {} : { lookup: dependencies.lookup }),
      maxHeaderSize: config.maxHeaderBytes,
      method: 'GET',
    }, response => {
      this.incoming = response
      this.clearTimers()
      if (this.signal.aborted) {
        const reason = abortReason(this.signal)
        response.destroy(reason)
        this.request.destroy(reason)
        if (!this.responseSettled) {
          this.responseSettled = true
          this.rejectResponse(reason)
        }
        return
      }
      if (!this.responseSettled) {
        this.responseSettled = true
        this.resolveResponse(response)
      }
    })
    this.closed = new Promise(resolve => {
      this.request.once('close', () => {
        this.onRequestClose()
        resolve()
      })
    })
    this.request.on('error', this.onRequestError)
    this.request.once('socket', this.onSocket)
    this.signal.addEventListener('abort', this.onAbort, { once: true })
    if (this.signal.aborted) {
      // Close the check→listener-registration race without dispatching bytes.
      this.onAbort()
    } else {
      this.connectTimer = timeoutTimer(() => {
        const error = new DirectPhaseTimeoutError('connect')
        this.request.destroy(error)
        this.socket?.destroy(error)
      }, config.connectTimeoutMs)
      this.request.end()
    }
  }

  private readonly firstByteTimeoutMs: number

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    if (this.firstByteTimer !== undefined) {
      clearTimeout(this.firstByteTimer)
      this.firstByteTimer = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      if (!this.requestClosed) await this.closed
      return
    }
    this.closing = true
    this.clearTimers()
    this.signal.removeEventListener('abort', this.onAbort)
    this.socket?.removeListener('connect', this.markConnected)
    this.socket?.removeListener('data', this.markFirstByte)
    ;(this.socket as TLSSocket | undefined)?.removeListener('secureConnect', this.markConnected)
    this.incoming?.destroy()
    this.request.destroy()
    this.socket?.destroy()
    this.agent?.destroy()
    if (!this.requestClosed) await this.closed
    this.request.removeListener('error', this.onRequestError)
    this.request.removeListener('socket', this.onSocket)
  }
}

function headerBytes(response: http.IncomingMessage): number {
  let bytes = Buffer.byteLength(`HTTP/1.1 ${response.statusCode ?? 0} ${response.statusMessage ?? ''}\r\n`, 'latin1')
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index] ?? ''
    const value = response.rawHeaders[index + 1] ?? ''
    bytes += Buffer.byteLength(`${name}: ${value}\r\n`, 'latin1')
  }
  return bytes + 2
}

function scalarHeader(response: http.IncomingMessage, name: string): string | undefined {
  const value = response.headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  return length
}

function normalizedContentEncoding(value: string | undefined):
  | 'identity'
  | 'gzip'
  | 'deflate'
  | 'br'
  | 'unsupported' {
  if (value === undefined || value.trim().length === 0) return 'identity'
  const encodings = value.toLowerCase().split(',').map(item => item.trim()).filter(Boolean)
  if (encodings.length !== 1) return 'unsupported'
  switch (encodings[0]) {
    case 'identity': return 'identity'
    case 'gzip':
    case 'x-gzip': return 'gzip'
    case 'deflate': return 'deflate'
    case 'br': return 'br'
    default: return 'unsupported'
  }
}

function decoderFor(encoding: 'identity' | 'gzip' | 'deflate' | 'br'): NodeJS.ReadWriteStream {
  switch (encoding) {
    case 'identity': return new PassThrough()
    case 'gzip': return createGunzip()
    case 'deflate': return createInflate()
    case 'br': return createBrotliDecompress()
  }
}

class EncodedLimitTransform extends Transform {
  observedBytes = 0
  exceeded = false

  constructor(private readonly maximumBytes: number) {
    super()
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    const remaining = this.maximumBytes - Math.min(this.observedBytes, this.maximumBytes)
    this.observedBytes = Math.min(this.maximumBytes + 1, this.observedBytes + bytes.byteLength)
    if (bytes.byteLength <= remaining) {
      this.push(bytes)
      callback()
      return
    }
    if (remaining > 0) this.push(bytes.subarray(0, remaining))
    this.exceeded = true
    callback(new DirectStreamLimitError('encoded'))
  }
}

class DecompressedCollector extends Writable {
  observedBytes = 0
  exceeded = false
  readonly chunks: Buffer[] = []
  private retainedBytes = 0

  constructor(private readonly maximumBytes: number) {
    super()
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    const remaining = this.maximumBytes - this.retainedBytes
    this.observedBytes = Math.min(this.maximumBytes + 1, this.observedBytes + bytes.byteLength)
    if (bytes.byteLength <= remaining) {
      this.chunks.push(Buffer.from(bytes))
      this.retainedBytes += bytes.byteLength
      callback()
      return
    }
    if (remaining > 0) {
      this.chunks.push(Buffer.from(bytes.subarray(0, remaining)))
      this.retainedBytes += remaining
    }
    this.exceeded = true
    callback(new DirectStreamLimitError('decompressed'))
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

async function readBoundedBody(
  response: http.IncomingMessage,
  signal: AbortSignal,
  config: DirectFetchConfig,
  encoding: 'identity' | 'gzip' | 'deflate' | 'br',
): Promise<Pick<
  DirectHttpTerminalResponse,
  | 'body'
  | 'encodedBytes'
  | 'decompressedBytes'
  | 'encodedBodyTruncated'
  | 'decompressedBodyTruncated'
>> {
  const encoded = new EncodedLimitTransform(config.maxInputBytes)
  const decompressed = new DecompressedCollector(config.maxDecompressedBytes)
  try {
    await pipeline(response, encoded, decoderFor(encoding), decompressed, { signal })
  } catch (error) {
    throwIfAborted(signal)
    if (!(error instanceof DirectStreamLimitError)) throw error
  }
  return {
    body: decompressed.body(),
    encodedBytes: encoded.observedBytes,
    decompressedBytes: decompressed.observedBytes,
    encodedBodyTruncated: encoded.exceeded,
    decompressedBodyTruncated: decompressed.exceeded,
  }
}

function omissionReason(input: {
  readonly contentDisposition?: string
  readonly contentType?: string
  readonly contentLength?: number
  readonly encoding: 'identity' | 'gzip' | 'deflate' | 'br' | 'unsupported'
  readonly config: DirectFetchConfig
}): DirectBodyOmissionReason | undefined {
  const disposition = input.contentDisposition?.split(';', 1)[0]?.trim().toLowerCase()
  if (disposition === 'attachment') return 'attachment'
  if (!isDirectTextLikeContentType(input.contentType)) return 'binary_content_type'
  if (
    input.contentLength !== undefined
    && (
      input.contentLength > input.config.maxContentLengthBytes
      || input.contentLength > input.config.maxInputBytes
    )
  ) return 'declared_too_large'
  if (input.encoding === 'unsupported') return 'unsupported_content_encoding'
  return undefined
}

function safeHopError(error: unknown, signal: AbortSignal): never {
  throwIfAborted(signal)
  if (isProviderError(error)) throw error
  if (error instanceof DirectPhaseTimeoutError) {
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'timeout',
      provider: PROVIDER,
    })
  }
  const code = error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
  if (code === 'ERR_PROXY_TUNNEL') {
    const status = error instanceof Error && 'statusCode' in error
      ? Number((error as Error & { readonly statusCode?: unknown }).statusCode)
      : Number.NaN
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      throw providerHttpError({ capability: CAPABILITY, provider: PROVIDER, status })
    }
    throw new ProviderError({ capability: CAPABILITY, kind: 'network', provider: PROVIDER })
  }
  if (
    code === 'HPE_INVALID_CONTENT_LENGTH'
    || code === 'HPE_UNEXPECTED_CONTENT_LENGTH'
    || code === 'HPE_INVALID_HEADER_TOKEN'
  ) {
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  if (code === 'HPE_HEADER_OVERFLOW') {
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'budget_exceeded',
      provider: PROVIDER,
    })
  }
  if (code?.startsWith('Z_') === true || code === 'ERR_PADDING_2') {
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
  throw new ProviderError({
    capability: CAPABILITY,
    cause: error,
    kind: 'network',
    provider: PROVIDER,
  })
}

/**
 * Dispatch one manual HTTP(S) hop and settle all owned Node resources before
 * returning. It never classifies destination networks and never follows a URL.
 */
export async function fetchDirectHttpHop(
  input: DirectHttpHopInput,
  dependencies: DirectHttpDependencies = {},
): Promise<DirectHttpHopResponse> {
  throwIfAborted(input.signal)
  const target = new URL(input.url)
  observeDispatch(input.onDispatch)
  const owner = new DirectRequestOwner(target, input.config, input.signal, dependencies)
  try {
    const response = await owner.response
    throwIfAborted(input.signal)
    if (headerBytes(response) > input.config.maxHeaderBytes) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'budget_exceeded',
        provider: PROVIDER,
      })
    }
    const statusCode = response.statusCode
    if (statusCode === undefined || statusCode < 100 || statusCode > 599) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'invalid_response',
        provider: PROVIDER,
      })
    }
    if (input.config.proxyUrl !== undefined && statusCode === 407) {
      throw providerHttpError({ capability: CAPABILITY, provider: PROVIDER, status: statusCode })
    }
    const contentType = scalarHeader(response, 'content-type')
    const contentLength = parseContentLength(scalarHeader(response, 'content-length'))
    const contentDisposition = scalarHeader(response, 'content-disposition')
    const contentEncoding = scalarHeader(response, 'content-encoding')
    const base = {
      url: target.href,
      statusCode,
      ...(contentType === undefined ? {} : { contentType }),
      ...(contentLength === undefined ? {} : { contentLength }),
      ...(contentDisposition === undefined ? {} : { contentDisposition }),
      ...(contentEncoding === undefined ? {} : { contentEncoding }),
    }

    const location = scalarHeader(response, 'location')
    if (HTTP_REDIRECT_STATUSES.has(statusCode) && location !== undefined && location.trim().length > 0) {
      return { ...base, kind: 'redirect', location: location.trim() }
    }
    if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
      const retryAfterMs = parseRetryAfterMs(
        scalarHeader(response, 'retry-after'),
        dependencies.retryNow?.() ?? Date.now(),
      )
      throw providerHttpError({
        capability: CAPABILITY,
        provider: PROVIDER,
        status: statusCode,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
    }

    const encoding = normalizedContentEncoding(contentEncoding)
    const omittedReason = omissionReason({
      ...(contentDisposition === undefined ? {} : { contentDisposition }),
      ...(contentType === undefined ? {} : { contentType }),
      ...(contentLength === undefined ? {} : { contentLength }),
      config: input.config,
      encoding,
    })
    if (omittedReason !== undefined) {
      return {
        ...base,
        body: Buffer.alloc(0),
        decompressedBodyTruncated: false,
        decompressedBytes: 0,
        encodedBodyTruncated: omittedReason === 'declared_too_large',
        encodedBytes: 0,
        kind: 'response',
        omittedReason,
      }
    }

    const body = await readBoundedBody(
      response,
      input.signal,
      input.config,
      encoding as 'identity' | 'gzip' | 'deflate' | 'br',
    )
    return { ...base, ...body, kind: 'response' }
  } catch (error) {
    return safeHopError(error, input.signal)
  } finally {
    await owner.close()
  }
}

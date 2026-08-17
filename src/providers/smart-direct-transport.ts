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

import type {
  CreateTransportOptions,
} from 'wreq-js'

import type { SmartDirectConfig } from '../config.js'
import {
  isProviderError,
  parseRetryAfterMs,
  ProviderError,
  providerHttpError,
  RETRYABLE_HTTP_STATUSES,
  throwIfAborted,
} from '../provider-runtime/index.js'

const PROVIDER = 'smart_direct' as const
const CAPABILITY = 'web_extract' as const
const HTTP_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Fixed request negotiation; callers cannot add arbitrary model-supplied headers. */
export const SMART_DIRECT_ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.8,text/markdown;q=0.8,*/*;q=0.1'
export const SMART_DIRECT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
export const SMART_DIRECT_ACCEPT_ENCODING = 'gzip, deflate, br'

export type SmartDirectMediaKind = 'html' | 'plain' | 'markdown'

/** Structural public seam used by local deterministic tests. */
export interface SmartDirectTransportHandle {
  close(): Promise<void>
}

export interface SmartDirectResponseHeaders extends Iterable<[string, string]> {
  get(name: string): string | null
}

export interface SmartDirectResponseBody {
  cancel(reason?: unknown): Promise<void>
}

export interface SmartDirectWreqResponse {
  readonly status: number
  readonly url: string
  readonly headers: SmartDirectResponseHeaders
  readonly body: SmartDirectResponseBody | null
  readable(): NodeJS.ReadableStream
}

export interface SmartDirectWreqOptions {
  readonly transport: SmartDirectTransportHandle
  readonly method: 'GET'
  readonly headers: Readonly<Record<string, string>>
  readonly redirect: 'manual'
  readonly compress: false
  readonly timeout: number
  readonly signal: AbortSignal
}

export type SmartDirectWreqFetch = (
  url: string,
  options: SmartDirectWreqOptions,
) => Promise<SmartDirectWreqResponse>

export type SmartDirectTransportFactory = (
  options: CreateTransportOptions,
) => Promise<SmartDirectTransportHandle>

/** Public wreq substitutions plus a clock for deterministic Retry-After tests. */
export interface SmartDirectTransportDependencies {
  readonly fetch?: SmartDirectWreqFetch
  readonly createTransport?: SmartDirectTransportFactory
  readonly retryNow?: () => number
}

interface SmartDirectHttpBaseResponse {
  readonly url: string
  readonly statusCode: number
  readonly contentType?: string
  readonly contentLength?: number
  readonly contentDisposition?: string
  readonly contentEncoding?: string
}

export interface SmartDirectHttpRedirectResponse extends SmartDirectHttpBaseResponse {
  readonly kind: 'redirect'
  readonly location: string
}

export interface SmartDirectHttpUnavailableResponse extends SmartDirectHttpBaseResponse {
  readonly kind: 'unavailable'
}

export interface SmartDirectHttpTerminalResponse extends SmartDirectHttpBaseResponse {
  readonly kind: 'response'
  readonly mediaKind: SmartDirectMediaKind
  readonly body: Buffer
  readonly encodedBytes: number
  readonly decompressedBytes: number
}

export type SmartDirectHttpHopResponse =
  | SmartDirectHttpRedirectResponse
  | SmartDirectHttpUnavailableResponse
  | SmartDirectHttpTerminalResponse

export interface SmartDirectHttpHopInput {
  readonly url: string
  readonly signal: AbortSignal
  readonly config: SmartDirectConfig
  readonly transport: SmartDirectTransportHandle
  readonly onDispatch?: () => void
}

/** Response-settlement input shared by direct injection and the isolated production child. */
export interface SmartDirectResponseInput {
  readonly signal: AbortSignal
  readonly config: SmartDirectConfig
}

class SmartDirectStreamLimitError extends Error {
  readonly boundary: 'encoded' | 'decompressed'

  constructor(boundary: 'encoded' | 'decompressed') {
    super(`smart_direct ${boundary} stream limit`)
    this.name = 'SmartDirectStreamLimitError'
    this.boundary = boundary
  }
}

class EncodedLimitTransform extends Transform {
  observedBytes = 0

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
    callback(new SmartDirectStreamLimitError('encoded'))
  }
}

class DecompressedCollector extends Writable {
  observedBytes = 0
  private readonly chunks: Buffer[] = []
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
    callback(new SmartDirectStreamLimitError('decompressed'))
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function observeDispatch(observer: (() => void) | undefined): void {
  if (observer === undefined) return
  try {
    observer()
  } catch {
    // Diagnostics never alter request execution.
  }
}

function headerBytes(response: SmartDirectWreqResponse, maximumBytes: number): void {
  let bytes = Buffer.byteLength(`HTTP/2 ${response.status}\r\n`, 'utf8')
  for (const entry of response.headers) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
    }
    const [name, value] = entry
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
    }
    bytes += Buffer.byteLength(`${name}: ${value}\r\n`, 'utf8')
    if (bytes + 2 > maximumBytes) {
      throw new ProviderError({ capability: CAPABILITY, kind: 'budget_exceeded', provider: PROVIDER })
    }
  }
}

function scalarHeader(response: SmartDirectWreqResponse, name: string): string | undefined {
  const value = response.headers.get(name)
  return value === null || value.trim().length === 0 ? undefined : value.trim()
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

function charsetSupported(contentType: string): boolean {
  const match = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)
  if (match === null) return true
  const charset = match[1]?.toLowerCase()
  return charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii'
}

/** Only explicit MIME values with a verified deterministic path are accepted. */
export function smartDirectMediaKind(contentType: string | undefined): SmartDirectMediaKind | undefined {
  if (contentType === undefined || !charsetSupported(contentType)) return undefined
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase()
  switch (mime) {
    case 'text/html':
    case 'application/xhtml+xml': return 'html'
    case 'text/plain': return 'plain'
    case 'text/markdown':
    case 'text/x-markdown':
    case 'application/markdown': return 'markdown'
    default: return undefined
  }
}

async function discardBody(response: SmartDirectWreqResponse, signal: AbortSignal): Promise<void> {
  if (response.body === null) return
  try {
    await response.body.cancel()
  } catch (error) {
    throwIfAborted(signal)
    throw error
  }
}

async function readBoundedBody(
  response: SmartDirectWreqResponse,
  signal: AbortSignal,
  config: SmartDirectConfig,
  encoding: 'identity' | 'gzip' | 'deflate' | 'br',
): Promise<Pick<SmartDirectHttpTerminalResponse, 'body' | 'encodedBytes' | 'decompressedBytes'>> {
  const encoded = new EncodedLimitTransform(config.maxInputBytes)
  const decompressed = new DecompressedCollector(config.maxDecompressedBytes)
  try {
    await pipeline(response.readable(), encoded, decoderFor(encoding), decompressed, { signal })
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof SmartDirectStreamLimitError) {
      throw new ProviderError({
        capability: CAPABILITY,
        cause: error,
        kind: 'budget_exceeded',
        provider: PROVIDER,
      })
    }
    throw error
  }
  return {
    body: decompressed.body(),
    encodedBytes: encoded.observedBytes,
    decompressedBytes: decompressed.observedBytes,
  }
}

function safeTransportError(error: unknown, signal: AbortSignal): never {
  throwIfAborted(signal)
  if (isProviderError(error)) throw error
  const code = error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
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
 * Validate and consume one public wreq Response. The child-process production
 * path feeds the same settlement function after transferring a bounded encoded
 * body, so injected and isolated transport obey one response policy.
 */
export async function settleSmartDirectWreqResponse(
  response: SmartDirectWreqResponse,
  input: SmartDirectResponseInput,
  dependencies: SmartDirectTransportDependencies = {},
): Promise<SmartDirectHttpHopResponse> {
  throwIfAborted(input.signal)
  headerBytes(response, input.config.maxHeaderBytes)
  const statusCode = response.status
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const contentType = scalarHeader(response, 'content-type')
  const contentLength = parseContentLength(scalarHeader(response, 'content-length'))
  const contentDisposition = scalarHeader(response, 'content-disposition')
  const contentEncoding = scalarHeader(response, 'content-encoding')
  const base = {
    url: response.url,
    statusCode,
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(contentDisposition === undefined ? {} : { contentDisposition }),
    ...(contentEncoding === undefined ? {} : { contentEncoding }),
  }

  const location = scalarHeader(response, 'location')
  if (HTTP_REDIRECT_STATUSES.has(statusCode) && location !== undefined) {
    await discardBody(response, input.signal)
    return { ...base, kind: 'redirect', location }
  }
  if (RETRYABLE_HTTP_STATUSES.has(statusCode)) {
    const retryAfterMs = parseRetryAfterMs(
      scalarHeader(response, 'retry-after'),
      dependencies.retryNow?.() ?? Date.now(),
    )
    await discardBody(response, input.signal)
    throw providerHttpError({
      capability: CAPABILITY,
      provider: PROVIDER,
      status: statusCode,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }
  if (statusCode < 200 || statusCode > 299) {
    await discardBody(response, input.signal)
    throw providerHttpError({ capability: CAPABILITY, provider: PROVIDER, status: statusCode })
  }

  const disposition = contentDisposition?.split(';', 1)[0]?.trim().toLowerCase()
  const mediaKind = smartDirectMediaKind(contentType)
  const encoding = normalizedContentEncoding(contentEncoding)
  if (disposition === 'attachment' || mediaKind === undefined || encoding === 'unsupported') {
    await discardBody(response, input.signal)
    return { ...base, kind: 'unavailable' }
  }
  if (
    contentLength !== undefined
    && (
      contentLength > input.config.maxContentLengthBytes
      || contentLength > input.config.maxInputBytes
    )
  ) {
    await discardBody(response, input.signal)
    throw new ProviderError({ capability: CAPABILITY, kind: 'budget_exceeded', provider: PROVIDER })
  }

  const body = await readBoundedBody(
    response,
    input.signal,
    input.config,
    encoding as 'identity' | 'gzip' | 'deflate' | 'br',
  )
  return { ...base, ...body, kind: 'response', mediaKind }
}

/** Create one operation-owned public wreq transport with fixed fingerprint settings. */
export async function createSmartDirectOperationTransport(
  config: SmartDirectConfig,
  signal: AbortSignal,
  dependencies: SmartDirectTransportDependencies = {},
): Promise<SmartDirectTransportHandle> {
  throwIfAborted(signal)
  const factory = dependencies.createTransport
  if (factory === undefined) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'configuration', provider: PROVIDER })
  }
  const transport = await factory({
    browser: config.browser,
    os: config.os,
    connectTimeout: config.connectTimeoutMs,
    readTimeout: config.readTimeoutMs,
    ...(config.proxyUrl === undefined ? {} : { proxy: config.proxyUrl }),
  })
  try {
    throwIfAborted(signal)
    return transport
  } catch (error) {
    await transport.close()
    throw error
  }
}

/**
 * Dispatch one manual wreq hop with automatic decompression disabled. The
 * Content-Length/header check therefore refers to the encoded representation;
 * actual encoded stream bytes and post-zlib bytes are counted independently.
 */
export async function fetchSmartDirectHttpHop(
  input: SmartDirectHttpHopInput,
  dependencies: SmartDirectTransportDependencies = {},
): Promise<SmartDirectHttpHopResponse> {
  throwIfAborted(input.signal)
  observeDispatch(input.onDispatch)
  let response: SmartDirectWreqResponse | undefined
  try {
    const fetch = dependencies.fetch
    if (fetch === undefined) {
      throw new ProviderError({ capability: CAPABILITY, kind: 'configuration', provider: PROVIDER })
    }
    response = await fetch(input.url, {
      compress: false,
      headers: {
        Accept: SMART_DIRECT_ACCEPT,
        'Accept-Encoding': SMART_DIRECT_ACCEPT_ENCODING,
        'Accept-Language': SMART_DIRECT_ACCEPT_LANGUAGE,
        Connection: 'close',
      },
      method: 'GET',
      redirect: 'manual',
      signal: input.signal,
      timeout: input.config.timeoutMs,
      transport: input.transport,
    })
    return await settleSmartDirectWreqResponse(response, input, dependencies)
  } catch (error) {
    if (response?.body !== null && response?.body !== undefined) {
      try {
        await response.body.cancel()
      } catch {
        // A body already locked by readable() is closed by that stream's error path.
      }
    }
    return safeTransportError(error, input.signal)
  }
}

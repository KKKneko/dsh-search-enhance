import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import {
  ProviderError,
  throwIfAborted,
} from '../provider-runtime/index.js'
import {
  SMART_DIRECT_ACCEPT,
  SMART_DIRECT_ACCEPT_ENCODING,
  SMART_DIRECT_ACCEPT_LANGUAGE,
  settleSmartDirectWreqResponse,
  type SmartDirectHttpHopResponse,
  type SmartDirectResponseBody,
  type SmartDirectResponseHeaders,
  type SmartDirectResponseInput,
  type SmartDirectTransportDependencies,
  type SmartDirectWreqResponse,
} from './smart-direct-transport.js'

const PROVIDER = 'smart_direct' as const
const CAPABILITY = 'web_extract' as const

interface ChildRequest {
  readonly url: string
  readonly accept: string
  readonly acceptEncoding: string
  readonly acceptLanguage: string
  readonly browser: string
  readonly os: string
  readonly proxyUrl?: string
  readonly timeoutMs: number
  readonly connectTimeoutMs: number
  readonly readTimeoutMs: number
  readonly maxHeaderBytes: number
  readonly maxContentLengthBytes: number
  readonly maxInputBytes: number
}

interface ChildResponse {
  readonly status?: number
  readonly url?: string
  readonly headers?: Record<string, string>
  readonly encodedBytes?: number
  readonly bodyBase64?: string
  readonly error?: 'timeout' | 'network' | 'invalid_response' | 'budget_exceeded'
}

/**
 * This function is stringified after TypeScript compilation and run by a
 * short-lived Node child. Keeping wreq in that process is deliberate: public
 * Response.cancel()/Transport.close() release the body handle but wreq 2.3.1
 * can retain the native pooled socket. Process exit is the only public-API
 * boundary that guarantees cancellation/disposal reaches socket quiescence.
 */
async function smartDirectChildMain(): Promise<void> {
  let finished = false
  let timedOut = false
  const controller = new AbortController()
  const finish = (value: unknown, code = 0): void => {
    if (finished) return
    finished = true
    process.stdout.end(JSON.stringify(value), () => process.exit(code))
  }
  process.once('SIGTERM', () => {
    controller.abort(new DOMException('The operation was aborted', 'AbortError'))
    process.exit(143)
  })

  try {
    const inputChunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      inputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    const request = JSON.parse(Buffer.concat(inputChunks).toString('utf8')) as ChildRequest
    if (request.proxyUrl !== undefined) {
      let proxy: URL
      try {
        if (typeof request.proxyUrl !== 'string' || request.proxyUrl.length > 2048) {
          finish({ error: 'invalid_response' }, 1)
          return
        }
        proxy = new URL(request.proxyUrl)
      } catch {
        finish({ error: 'invalid_response' }, 1)
        return
      }
      const hasAuthority = /^http:\/\//i.test(request.proxyUrl)
      const remainder = hasAuthority ? request.proxyUrl.slice('http://'.length) : ''
      const slashIndex = remainder.indexOf('/')
      const rawPath = slashIndex === -1 ? '' : remainder.slice(slashIndex)
      if ([
        !hasAuthority,
        request.proxyUrl.trim() !== request.proxyUrl,
        proxy.protocol !== 'http:',
        proxy.hostname.length === 0,
        proxy.username.length > 0,
        proxy.password.length > 0,
        proxy.pathname !== '/',
        !['', '/'].includes(rawPath),
        proxy.search.length > 0,
        proxy.hash.length > 0,
      ].some(Boolean)) {
        finish({ error: 'invalid_response' }, 1)
        return
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
      finish({ error: 'timeout' }, 1)
    }, request.timeoutMs)
    timer.unref()

    let transport: { close(): Promise<void> } | undefined
    try {
      const moduleUrl = process.env.DSH_SMART_WREQ_MODULE
      if (moduleUrl === undefined) throw new Error('missing wreq module URL')
      const importModule = Function('specifier', 'return import(specifier)') as (
        specifier: string
      ) => Promise<typeof import('wreq-js')>
      const wreq = await importModule(moduleUrl)
      transport = await wreq.createTransport({
        browser: request.browser as import('wreq-js').BrowserProfile,
        os: request.os as import('wreq-js').EmulationOS,
        connectTimeout: request.connectTimeoutMs,
        readTimeout: request.readTimeoutMs,
        ...(request.proxyUrl === undefined ? {} : { proxy: request.proxyUrl }),
      })
      if (typeof process.send === 'function') process.send({ kind: 'dispatch' })
      const response = await wreq.fetch(request.url, {
        compress: false,
        headers: {
          Accept: request.accept,
          'Accept-Encoding': request.acceptEncoding,
          'Accept-Language': request.acceptLanguage,
          Connection: 'close',
        },
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        timeout: request.timeoutMs,
        transport: transport as import('wreq-js').Transport,
      })

      let headerBytes = Buffer.byteLength(`HTTP/2 ${response.status}\r\n`, 'utf8')
      const selected: Record<string, string> = {}
      const selectedNames = new Set([
        'content-type',
        'content-length',
        'content-disposition',
        'content-encoding',
        'cf-mitigated',
        'location',
        'retry-after',
      ])
      for (const [name, value] of response.headers) {
        headerBytes += Buffer.byteLength(`${name}: ${value}\r\n`, 'utf8')
        if (headerBytes + 2 > request.maxHeaderBytes) {
          await response.body?.cancel()
          finish({ error: 'budget_exceeded' }, 1)
          return
        }
        const lower = name.toLowerCase()
        if (selectedNames.has(lower)) selected[lower] = value
      }
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        await response.body?.cancel()
        finish({ error: 'invalid_response' }, 1)
        return
      }

      const challengeMitigated = selected['cf-mitigated']?.trim().toLowerCase() === 'challenge'
      const contentLengthHeader = selected['content-length']
      if (!challengeMitigated && contentLengthHeader !== undefined) {
        if (!/^\d+$/.test(contentLengthHeader)) {
          await response.body?.cancel()
          finish({ error: 'invalid_response' }, 1)
          return
        }
        const contentLength = Number(contentLengthHeader)
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          await response.body?.cancel()
          finish({ error: 'invalid_response' }, 1)
          return
        }
        if (contentLength > request.maxContentLengthBytes || contentLength > request.maxInputBytes) {
          await response.body?.cancel()
          finish({ error: 'budget_exceeded' }, 1)
          return
        }
      }

      const status = response.status
      const mime = selected['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      const disposition = selected['content-disposition']?.split(';', 1)[0]?.trim().toLowerCase()
      const encodings = (selected['content-encoding'] ?? 'identity')
        .toLowerCase()
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
      const encodingSupported = encodings.length === 1
        && ['identity', 'gzip', 'x-gzip', 'deflate', 'br'].includes(encodings[0] ?? '')
      const mimeSupported = [
        'text/html',
        'application/xhtml+xml',
        'text/plain',
        'text/markdown',
        'text/x-markdown',
        'application/markdown',
      ].includes(mime ?? '')
      const shouldRead = !challengeMitigated
        && status >= 200
        && status <= 299
        && disposition !== 'attachment'
        && mimeSupported
        && encodingSupported

      if (!shouldRead || response.body === null) {
        await response.body?.cancel()
        clearTimeout(timer)
        await transport.close()
        finish({ headers: selected, status, url: response.url })
        return
      }

      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let encodedBytes = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          const bytes = Buffer.from(item.value)
          encodedBytes += bytes.byteLength
          if (encodedBytes > request.maxInputBytes) {
            await reader.cancel()
            clearTimeout(timer)
            await transport.close()
            finish({ error: 'budget_exceeded' }, 1)
            return
          }
          chunks.push(bytes)
        }
      } finally {
        reader.releaseLock()
      }
      clearTimeout(timer)
      await transport.close()
      const body = Buffer.concat(chunks)
      finish({
        bodyBase64: body.toString('base64'),
        encodedBytes,
        headers: selected,
        status,
        url: response.url,
      })
    } catch {
      clearTimeout(timer)
      try {
        await transport?.close()
      } catch {
        // Process exit below is the final resource boundary.
      }
      finish({ error: timedOut ? 'timeout' : 'network' }, 1)
    }
  } catch {
    finish({ error: 'invalid_response' }, 1)
  }
}

const SMART_DIRECT_CHILD_SOURCE = `(${smartDirectChildMain.toString()})()`

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR'] as const
  const wreqEntry = createRequire(import.meta.url).resolve('wreq-js')
  const environment: NodeJS.ProcessEnv = {
    DSH_SMART_WREQ_MODULE: pathToFileURL(wreqEntry).href,
  }
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

class IsolatedHeaders implements SmartDirectResponseHeaders {
  private readonly entriesValue: readonly [string, string][]

  constructor(values: Record<string, string>) {
    this.entriesValue = Object.entries(values)
  }

  get(name: string): string | null {
    const lower = name.toLowerCase()
    return this.entriesValue.find(([candidate]) => candidate.toLowerCase() === lower)?.[1] ?? null
  }

  [Symbol.iterator](): Iterator<[string, string]> {
    return this.entriesValue[Symbol.iterator]()
  }
}

class IsolatedBody implements SmartDirectResponseBody {
  async cancel(): Promise<void> {
    // The child has already completed or discarded its native body.
  }
}

function childOutputLimit(request: ChildRequest): number {
  const base64Bytes = Math.ceil(request.maxInputBytes / 3) * 4
  const urlBytes = Buffer.byteLength(request.url, 'utf8') * 6
  return base64Bytes + request.maxHeaderBytes + urlBytes + 4096
}

function childError(kind: NonNullable<ChildResponse['error']>): ProviderError {
  return new ProviderError({
    capability: CAPABILITY,
    kind,
    provider: PROVIDER,
  })
}

function parseChildResponse(value: Buffer, maximumBytes: number): ChildResponse {
  if (value.byteLength > maximumBytes) throw childError('budget_exceeded')
  try {
    const parsed = JSON.parse(value.toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError('invalid child response')
    }
    return parsed as ChildResponse
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw childError('invalid_response')
  }
}

export interface IsolatedSmartDirectHopInput extends SmartDirectResponseInput {
  readonly url: string
  readonly onDispatch?: () => void
}

/**
 * Run one production wreq hop in an operation-owned process. Cancellation sends
 * SIGTERM, the child aborts its wreq signal, then exits; this function waits for
 * `close` before returning or rethrowing the caller's exact abort reason.
 */
export async function fetchIsolatedSmartDirectHttpHop(
  input: IsolatedSmartDirectHopInput,
  dependencies: SmartDirectTransportDependencies = {},
): Promise<SmartDirectHttpHopResponse> {
  throwIfAborted(input.signal)
  const request: ChildRequest = {
    accept: SMART_DIRECT_ACCEPT,
    acceptEncoding: SMART_DIRECT_ACCEPT_ENCODING,
    acceptLanguage: SMART_DIRECT_ACCEPT_LANGUAGE,
    browser: input.config.browser,
    connectTimeoutMs: input.config.connectTimeoutMs,
    maxContentLengthBytes: input.config.maxContentLengthBytes,
    maxHeaderBytes: input.config.maxHeaderBytes,
    maxInputBytes: input.config.maxInputBytes,
    os: input.config.os,
    ...(input.config.proxyUrl === undefined ? {} : { proxyUrl: input.config.proxyUrl }),
    readTimeoutMs: input.config.readTimeoutMs,
    timeoutMs: input.config.timeoutMs,
    url: input.url,
  }
  const maximumOutputBytes = childOutputLimit(request)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', SMART_DIRECT_CHILD_SOURCE], {
    env: sanitizedChildEnvironment(),
    stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
    windowsHide: true,
  })
  const chunks: Buffer[] = []
  let outputBytes = 0
  let outputExceeded = false
  let spawnError: unknown
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdout!.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    outputBytes += bytes.byteLength
    if (outputBytes > maximumOutputBytes) {
      outputExceeded = true
      child.kill('SIGTERM')
      return
    }
    chunks.push(bytes)
  })
  child.once('error', error => { spawnError = error })
  child.on('message', message => {
    if (
      typeof message !== 'object'
      || message === null
      || !('kind' in message)
      || message.kind !== 'dispatch'
    ) return
    try {
      input.onDispatch?.()
    } catch {
      // Diagnostics never alter request execution.
    }
  })
  child.stdin!.on('error', error => {
    if (!input.signal.aborted && spawnError === undefined) spawnError = error
  })
  const onAbort = (): void => { child.kill('SIGTERM') }
  input.signal.addEventListener('abort', onAbort, { once: true })
  if (input.signal.aborted) onAbort()
  child.stdin!.end(JSON.stringify(request))

  const closed = await closePromise
  input.signal.removeEventListener('abort', onAbort)
  throwIfAborted(input.signal)
  if (spawnError !== undefined) throw childError('network')
  if (outputExceeded) throw childError('budget_exceeded')
  const parsed = parseChildResponse(Buffer.concat(chunks), maximumOutputBytes)
  if (parsed.error !== undefined) throw childError(parsed.error)
  if (
    typeof parsed.status !== 'number'
    || typeof parsed.url !== 'string'
    || typeof parsed.headers !== 'object'
    || parsed.headers === null
    || Array.isArray(parsed.headers)
    || (closed.code !== 0 && closed.code !== null)
  ) {
    throw childError('invalid_response')
  }
  for (const [name, value] of Object.entries(parsed.headers)) {
    if (typeof name !== 'string' || typeof value !== 'string') throw childError('invalid_response')
  }
  const bodyBase64 = parsed.bodyBase64 ?? ''
  if (typeof bodyBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bodyBase64)) {
    throw childError('invalid_response')
  }
  const encoded = Buffer.from(bodyBase64, 'base64')
  if (
    !Number.isSafeInteger(parsed.encodedBytes ?? 0)
    || (parsed.encodedBytes ?? 0) !== encoded.byteLength
    || encoded.byteLength > input.config.maxInputBytes
  ) {
    throw childError('invalid_response')
  }
  const response: SmartDirectWreqResponse = {
    body: new IsolatedBody(),
    headers: new IsolatedHeaders(parsed.headers),
    readable: () => Readable.from([encoded]),
    status: parsed.status,
    url: parsed.url,
  }
  try {
    return await settleSmartDirectWreqResponse(response, input, dependencies)
  } catch (error) {
    throwIfAborted(input.signal)
    throw error
  }
}

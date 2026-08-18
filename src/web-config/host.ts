import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

import {
  Config as SearchEnhanceConfig,
  EXTRA_DISCOVERY_SOURCES_MAX,
  SEARCH_API_PROTOCOLS,
  SEARCH_DEPTHS,
  SEARCH_ENHANCE_SETTINGS_NAMESPACE,
  SEARCH_PROFILES,
  THINKING_LEVELS,
  TOOL_DISCOVERY_MODES,
  WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS,
  validateWebExtractProxyUrl,
  type Config as SearchEnhanceConfigValue,
} from '../config.js'
import { inspectDiagnosticStatus } from '../diagnostics/status.js'
import {
  WEB_BASE_URL_MAX_CHARACTERS,
  WEB_CONFIG_PATH,
  WEB_CREDENTIAL_REF_MAX_CHARACTERS,
  WEB_CREDENTIAL_SLOTS,
  WEB_CREDENTIAL_VALUE_MAX_CHARACTERS,
  WEB_CREDENTIALS_PATH,
  WEB_EDITABLE_PATHS,
  WEB_MODEL_MAX_CHARACTERS,
  type WebBridgeErrorBody,
  type WebConfigLayer,
  type WebConfigSnapshot,
  type WebCredentialSlot,
  type WebCredentialState,
  type WebCredentialWriteResult,
  type WebEditableConfig,
  type WebSettingsMutation,
  type WebSettingsMutationRequest,
} from './contracts.js'

export const WEB_CONFIG_REQUEST_MAX_BYTES = 64 * 1024
export const WEB_CONFIG_RESPONSE_MAX_BYTES = 128 * 1024

const MAX_CREDENTIAL_SOURCE_CHARACTERS = 128
/** One save may touch each editable field at most once. */
const MAX_MUTATIONS = WEB_EDITABLE_PATHS.length
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
] as const

const EDITABLE_PATH_BY_KEY = new Map(WEB_EDITABLE_PATHS.map(path => [path.join('.'), path]))

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly actualRevision?: number,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settingsConflictActual(error: unknown): number | undefined {
  if (!isRecord(error) || error['code'] !== 'SETTINGS_CONFLICT') return undefined
  const actual = error['actual']
  return Number.isSafeInteger(actual) && (actual as number) >= 0 ? actual as number : undefined
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected)
  return Object.keys(record).every(key => allowed.has(key))
}

function boundedString(value: string, maximum: number, label: string): string {
  if ([...value].length > maximum) {
    throw new BridgeHttpError(422, 'configuration-too-large', `${label} exceeds the Web configuration limit.`)
  }
  return value
}

function projectProvider(
  provider: SearchEnhanceConfigValue['providers']['context7'],
): WebEditableConfig['providers']['context7'] {
  return {
    baseUrl: boundedString(provider.baseUrl, WEB_BASE_URL_MAX_CHARACTERS, 'Provider base URL'),
    credentialRef: boundedString(
      String(provider.credentialRef),
      WEB_CREDENTIAL_REF_MAX_CHARACTERS,
      'Credential reference',
    ),
    timeoutMs: provider.timeoutMs,
  }
}

function projectProxyUrl(proxyUrl: string | undefined, label: string): string {
  return proxyUrl === undefined
    ? ''
    : boundedString(proxyUrl, WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS, label)
}

function projectConfig(config: SearchEnhanceConfigValue): WebEditableConfig {
  return {
    defaultProfile: config.defaultProfile,
    defaultDepth: config.defaultDepth,
    toolTimeoutMs: config.toolTimeoutMs,
    toolDiscovery: { mode: config.toolDiscovery.mode },
    extraDiscoverySources: { ...config.extraDiscoverySources },
    searchApi: {
      baseUrl: boundedString(config.searchApi.baseUrl, WEB_BASE_URL_MAX_CHARACTERS, 'Grok base URL'),
      protocol: config.searchApi.protocol,
      model: boundedString(config.searchApi.model, WEB_MODEL_MAX_CHARACTERS, 'Grok model'),
      thinkingLevel: config.searchApi.thinkingLevel,
      credentialRef: boundedString(
        String(config.searchApi.credentialRef),
        WEB_CREDENTIAL_REF_MAX_CHARACTERS,
        'Grok credential reference',
      ),
      timeoutMs: config.searchApi.timeoutMs,
    },
    providers: {
      context7: projectProvider(config.providers.context7),
      exa: projectProvider(config.providers.exa),
      tavily: projectProvider(config.providers.tavily),
      firecrawl: projectProvider(config.providers.firecrawl),
    },
    webExtract: {
      smartDirect: {
        proxyUrl: projectProxyUrl(config.webExtract.smartDirect.proxyUrl, 'smart_direct proxy URL'),
      },
      direct: {
        proxyUrl: projectProxyUrl(config.webExtract.direct.proxyUrl, 'direct proxy URL'),
      },
    },
  }
}

function maxCharactersForPath(path: readonly string[]): number {
  const leaf = path.at(-1)
  if (leaf === 'baseUrl') return WEB_BASE_URL_MAX_CHARACTERS
  if (leaf === 'proxyUrl') return WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS
  if (leaf === 'credentialRef') return WEB_CREDENTIAL_REF_MAX_CHARACTERS
  return WEB_MODEL_MAX_CHARACTERS
}

function readPath(value: unknown, path: readonly string[]): { present: boolean; value?: unknown } {
  let current: unknown = value
  for (const part of path) {
    if (!isRecord(current) || !own(current, part)) return { present: false }
    current = current[part]
  }
  return { present: true, value: current }
}

function writePath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target
  for (const part of path.slice(0, -1)) {
    const existing = current[part]
    const child = isRecord(existing) ? existing : {}
    current[part] = child
    current = child
  }
  const leaf = path.at(-1)
  if (leaf !== undefined) current[leaf] = value
}

function projectLayer(value: unknown): WebConfigLayer | undefined {
  if (!isRecord(value)) return undefined
  const projected: Record<string, unknown> = {}
  for (const path of WEB_EDITABLE_PATHS) {
    const candidate = readPath(value, path)
    if (!candidate.present) continue
    const leaf = candidate.value
    if (typeof leaf !== 'string' && typeof leaf !== 'number') continue
    if (typeof leaf === 'string') boundedString(leaf, maxCharactersForPath(path), path.join('.'))
    writePath(projected, path, leaf)
  }
  return projected as WebConfigLayer
}

function credentialRefFor(config: SearchEnhanceConfigValue, slot: WebCredentialSlot) {
  return slot === 'searchApi' ? config.searchApi.credentialRef : config.providers[slot].credentialRef
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The Web configuration request was aborted.', 'AbortError')
}

async function describeCredential(
  ctx: Context,
  config: SearchEnhanceConfigValue,
  slot: WebCredentialSlot,
  signal: AbortSignal,
): Promise<WebCredentialState> {
  throwIfAborted(signal)
  const ref = credentialRefFor(config, slot)
  const refText = boundedString(String(ref), WEB_CREDENTIAL_REF_MAX_CHARACTERS, 'Credential reference')
  try {
    const info = await ctx.credentials.describe(ref)
    throwIfAborted(signal)
    const source = info.source === undefined || [...info.source].length > MAX_CREDENTIAL_SOURCE_CHARACTERS
      ? undefined
      : info.source
    return {
      ref: refText,
      configured: info.configured,
      writable: info.writable,
      available: true,
      ...(source === undefined ? {} : { source }),
    }
  } catch (error) {
    throwIfAborted(signal)
    void error
    return {
      ref: refText,
      configured: false,
      writable: false,
      available: false,
    }
  }
}

function findDescriptor(ctx: Context): SettingsDescriptor {
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(
    candidate => String(candidate.ns) === String(SEARCH_ENHANCE_SETTINGS_NAMESPACE),
  )
  if (descriptor === undefined) {
    throw new BridgeHttpError(503, 'settings-unavailable', 'Search Enhance settings are not available.')
  }
  if (descriptor.applies !== 'restart') {
    throw new BridgeHttpError(500, 'settings-contract-error', 'Search Enhance settings have an invalid apply mode.')
  }
  return descriptor
}

export async function readWebConfigSnapshot(
  ctx: Context,
  signal: AbortSignal,
): Promise<WebConfigSnapshot> {
  throwIfAborted(signal)
  const descriptor = findDescriptor(ctx)
  const config = SearchEnhanceConfig(descriptor.value as never)
  const credentialEntries = await Promise.all(WEB_CREDENTIAL_SLOTS.map(async slot => [
    slot,
    await describeCredential(ctx, config, slot, signal),
  ] as const))
  const diagnostics = await inspectDiagnosticStatus(ctx.credentials, config, signal)
  throwIfAborted(signal)
  const base = projectLayer(descriptor.base)
  const user = projectLayer(descriptor.user)
  return {
    namespace: 'search-enhance',
    revision: descriptor.revision,
    applies: 'restart',
    writable: ctx.settings.writable,
    value: projectConfig(config),
    ...(base === undefined ? {} : { base }),
    ...(user === undefined ? {} : { user }),
    options: {
      profiles: [...SEARCH_PROFILES],
      depths: [...SEARCH_DEPTHS],
      protocols: [...SEARCH_API_PROTOCOLS],
      thinkingLevels: [...THINKING_LEVELS],
      toolDiscoveryModes: [...TOOL_DISCOVERY_MODES],
      proxyUrlMaxCharacters: WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS,
      extraDiscoveryMaxSources: EXTRA_DISCOVERY_SOURCES_MAX,
    },
    credentials: Object.fromEntries(credentialEntries) as Record<WebCredentialSlot, WebCredentialState>,
    diagnostics: {
      capabilities: diagnostics.capabilityStatus.map(status => ({
        capability: status.capability,
        available: status.available,
        required: status.required,
        providers: status.providers.map(provider => ({ ...provider })),
      })),
      minimumProfile: { ...diagnostics.minimumProfile },
      missingProviders: diagnostics.missingProviders,
      unavailableProviders: diagnostics.unavailableProviders,
    },
  }
}

function parseHost(rawHost: string): URL | undefined {
  if (/[\\/@?#]/u.test(rawHost)) return undefined
  try {
    const parsed = new URL(`http://${rawHost}`)
    if (
      parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function isLoopbackHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .toLowerCase()
    .replace(/\.$/u, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true
  const mapped = hostname.startsWith('::ffff:') ? hostname.slice('::ffff:'.length) : hostname
  const octets = mapped.split('.')
  return octets.length === 4
    && octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

function isLoopbackAddress(rawAddress: string | undefined): boolean {
  if (rawAddress === undefined) return false
  const address = rawAddress.toLowerCase().split('%', 1)[0] ?? ''
  if (address === '::1') return true
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return isLoopbackHostname(mapped)
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

function exactOrigin(request: Pick<IncomingMessage, 'headers' | 'socket'>, rawHost: string, rawOrigin: string): boolean {
  try {
    const encrypted = (request.socket as IncomingMessage['socket'] & { encrypted?: boolean }).encrypted === true
    const effective = new URL(`${encrypted ? 'https' : 'http'}://${rawHost}`)
    const origin = new URL(rawOrigin)
    return (
      (origin.protocol === 'http:' || origin.protocol === 'https:')
      && origin.username === ''
      && origin.password === ''
      && origin.pathname === '/'
      && origin.search === ''
      && origin.hash === ''
      && origin.origin === effective.origin
    )
  } catch {
    return false
  }
}

export function isTrustedWebConfigRequest(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  requireOrigin: boolean,
): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  if (FORWARDING_HEADERS.some(name => request.headers[name] !== undefined)) return false
  const host = firstHeader(request.headers, 'host')
  if (host === undefined) return false
  const parsedHost = parseHost(host)
  if (parsedHost === undefined || !isLoopbackHostname(parsedHost.hostname)) return false
  const fetchSite = firstHeader(request.headers, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite.trim().toLowerCase() !== 'same-origin') return false
  const origin = firstHeader(request.headers, 'origin')
  if (origin === undefined) return !requireOrigin
  return exactOrigin(request, host, origin)
}

function requestHasBody(request: IncomingMessage): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return true
  const rawLength = firstHeader(request.headers, 'content-length')
  if (rawLength === undefined) return false
  return Number(rawLength) > 0
}

function assertJsonContentType(request: IncomingMessage): void {
  const raw = firstHeader(request.headers, 'content-type')
  if (raw === undefined) {
    throw new BridgeHttpError(415, 'unsupported-media-type', 'Content-Type must be application/json.')
  }
  const [mediaType, ...parameters] = raw.split(';').map(part => part.trim().toLowerCase())
  const validParameters = parameters.every(parameter => parameter === '' || parameter === 'charset=utf-8')
  if (mediaType !== 'application/json' || !validParameters) {
    throw new BridgeHttpError(415, 'unsupported-media-type', 'Content-Type must be application/json.')
  }
}

async function readJsonBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  assertJsonContentType(request)
  const rawLength = firstHeader(request.headers, 'content-length')
  if (rawLength !== undefined) {
    const length = Number(rawLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new BridgeHttpError(400, 'invalid-content-length', 'Content-Length is invalid.')
    }
    if (length > WEB_CONFIG_REQUEST_MAX_BYTES) {
      throw new BridgeHttpError(413, 'request-too-large', 'The request body is too large.')
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  const abort = () => request.destroy(new DOMException('Request aborted.', 'AbortError'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    throwIfAborted(signal)
    for await (const chunk of request) {
      throwIfAborted(signal)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > WEB_CONFIG_REQUEST_MAX_BYTES) {
        throw new BridgeHttpError(413, 'request-too-large', 'The request body is too large.')
      }
      chunks.push(buffer)
    }
  } finally {
    signal.removeEventListener('abort', abort)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new BridgeHttpError(400, 'invalid-json', 'The request body is not valid UTF-8 JSON.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BridgeHttpError(400, 'invalid-json', 'The request body is not valid JSON.')
  }
}

function parseMutation(value: unknown): WebSettingsMutationRequest {
  if (!isRecord(value) || !exactKeys(value, ['expectedRevision', 'mutations'])) {
    throw new BridgeHttpError(400, 'invalid-request', 'The settings request shape is invalid.')
  }
  const expectedRevision = value['expectedRevision']
  const mutations = value['mutations']
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0 || !Array.isArray(mutations)) {
    throw new BridgeHttpError(400, 'invalid-request', 'The settings request shape is invalid.')
  }
  if (mutations.length > MAX_MUTATIONS) {
    throw new BridgeHttpError(400, 'too-many-mutations', 'Too many settings fields were submitted.')
  }
  const seen = new Set<string>()
  const parsed: WebSettingsMutation[] = mutations.map(candidate => {
    if (!isRecord(candidate)) {
      throw new BridgeHttpError(400, 'invalid-mutation', 'A settings mutation is invalid.')
    }
    const op = candidate['op']
    const path = candidate['path']
    if ((op !== 'set' && op !== 'unset') || !Array.isArray(path) || path.some(part => typeof part !== 'string')) {
      throw new BridgeHttpError(400, 'invalid-mutation', 'A settings mutation is invalid.')
    }
    const key = path.join('.')
    const canonical = EDITABLE_PATH_BY_KEY.get(key)
    if (canonical === undefined || seen.has(key)) {
      throw new BridgeHttpError(400, 'invalid-mutation-path', 'A settings mutation path is invalid or duplicated.')
    }
    seen.add(key)
    if (op === 'unset') {
      if (!exactKeys(candidate, ['op', 'path'])) {
        throw new BridgeHttpError(400, 'invalid-mutation', 'An unset mutation contains unsupported fields.')
      }
      return { op, path: [...canonical] }
    }
    if (!exactKeys(candidate, ['op', 'path', 'value'])) {
      throw new BridgeHttpError(400, 'invalid-mutation', 'A set mutation contains unsupported fields.')
    }
    const mutationValue = candidate['value']
    if (typeof mutationValue !== 'string' && typeof mutationValue !== 'number') {
      throw new BridgeHttpError(400, 'invalid-mutation-value', 'A settings value must be a string or number.')
    }
    if (typeof mutationValue === 'string') {
      boundedString(mutationValue, maxCharactersForPath(canonical), canonical.join('.'))
      if (canonical.at(-1) === 'proxyUrl') {
        try {
          validateWebExtractProxyUrl(mutationValue)
        } catch {
          throw new BridgeHttpError(422, 'settings-rejected', 'The configuration was rejected by the plugin schema.')
        }
      }
    }
    return { op, path: [...canonical], value: mutationValue }
  })
  return { expectedRevision: expectedRevision as number, mutations: parsed }
}

function parseCredentialRequest(
  value: unknown,
  includeValue: boolean,
): { credential: WebCredentialSlot; value?: string } {
  const keys = includeValue ? ['credential', 'value'] : ['credential']
  if (!isRecord(value) || !exactKeys(value, keys)) {
    throw new BridgeHttpError(400, 'invalid-request', 'The credential request shape is invalid.')
  }
  const credential = value['credential']
  if (typeof credential !== 'string' || !WEB_CREDENTIAL_SLOTS.includes(credential as WebCredentialSlot)) {
    throw new BridgeHttpError(400, 'invalid-credential', 'The credential identifier is invalid.')
  }
  if (!includeValue) return { credential: credential as WebCredentialSlot }
  const credentialValue = value['value']
  if (typeof credentialValue !== 'string') {
    throw new BridgeHttpError(400, 'invalid-credential-value', 'The credential value must be a string.')
  }
  if ([...credentialValue].length > WEB_CREDENTIAL_VALUE_MAX_CHARACTERS) {
    throw new BridgeHttpError(413, 'credential-too-large', 'The credential value is too large.')
  }
  return { credential: credential as WebCredentialSlot, value: credentialValue }
}

function errorBody(error: BridgeHttpError): WebBridgeErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
    },
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body, 'utf8') > WEB_CONFIG_RESPONSE_MAX_BYTES) {
    throw new BridgeHttpError(500, 'response-too-large', 'The Web configuration response exceeded its limit.')
  }
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  sendJson(response, 405, errorBody(new BridgeHttpError(405, 'method-not-allowed', 'Method not allowed.')), {
    allow,
  })
}

function authorize(request: IncomingMessage, requireOrigin: boolean): void {
  if (!isTrustedWebConfigRequest(request, requireOrigin)) {
    throw new BridgeHttpError(403, 'forbidden', 'This endpoint accepts only same-origin loopback requests.')
  }
}

function settingsOps(mutations: readonly WebSettingsMutation[]): SettingsPathOp[] {
  return mutations.map(mutation => mutation.op === 'set'
    ? { op: 'set', path: mutation.path, value: mutation.value }
    : { op: 'unset', path: mutation.path })
}

async function mutateSettings(
  ctx: Context,
  request: WebSettingsMutationRequest,
): Promise<void> {
  if (!ctx.settings.writable) {
    throw new BridgeHttpError(409, 'settings-read-only', 'The Settings document is read-only.')
  }
  try {
    await ctx.settings.mutate(
      SEARCH_ENHANCE_SETTINGS_NAMESPACE,
      settingsOps(request.mutations),
      request.expectedRevision,
    )
  } catch (error) {
    const conflictActual = settingsConflictActual(error)
    if (conflictActual !== undefined) {
      throw new BridgeHttpError(
        409,
        'settings-conflict',
        'The Settings document changed after this form was loaded.',
        conflictActual,
      )
    }
    if (Schema.ValidationError.is(error)) {
      throw new BridgeHttpError(422, 'settings-rejected', 'The configuration was rejected by the plugin schema.')
    }
    throw new BridgeHttpError(500, 'settings-write-failed', 'The Settings document could not be updated.')
  }
}

async function handleConfigRoute(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (request.method === 'GET') {
    authorize(request, false)
    if (requestHasBody(request)) {
      throw new BridgeHttpError(400, 'unexpected-request-body', 'GET does not accept a request body.')
    }
    sendJson(response, 200, await readWebConfigSnapshot(ctx, signal))
    return
  }
  if (request.method !== 'PATCH') {
    sendMethodNotAllowed(response, 'GET, PATCH')
    return
  }
  authorize(request, true)
  const mutation = parseMutation(await readJsonBody(request, signal))
  if (mutation.mutations.length > 0) await mutateSettings(ctx, mutation)
  sendJson(response, 200, await readWebConfigSnapshot(ctx, signal))
}

async function currentConfig(ctx: Context): Promise<SearchEnhanceConfigValue> {
  const current = ctx.settings.get(SEARCH_ENHANCE_SETTINGS_NAMESPACE) as SearchEnhanceConfigValue | undefined
  if (current === undefined) {
    throw new BridgeHttpError(503, 'settings-unavailable', 'Search Enhance settings are not available.')
  }
  // The configuration surface reads Settings live on purpose: it must write a
  // credential to the reference the user just saved, while the search plane keeps
  // using the restart-scoped value its plugin instance loaded.
  // Settings owns schema validation and returns a deeply frozen resolved snapshot.
  // Re-running Schemastery here mutates optional fields and fails on that snapshot.
  return current
}

async function handleCredentialRoute(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (request.method !== 'PUT' && request.method !== 'DELETE') {
    sendMethodNotAllowed(response, 'PUT, DELETE')
    return
  }
  authorize(request, true)
  const parsed = parseCredentialRequest(await readJsonBody(request, signal), request.method === 'PUT')
  const config = await currentConfig(ctx)
  const ref = credentialRefFor(config, parsed.credential)
  const before = await describeCredential(ctx, config, parsed.credential, signal)
  if (!before.available) {
    throw new BridgeHttpError(503, 'credential-unavailable', 'Credential status is unavailable.')
  }
  if (request.method === 'PUT' && parsed.value === '') {
    const result: WebCredentialWriteResult = { credential: parsed.credential, state: before, changed: false }
    sendJson(response, 200, result)
    return
  }
  if (!before.writable) {
    throw new BridgeHttpError(409, 'credential-read-only', 'This credential is supplied by a read-only source.')
  }
  try {
    if (request.method === 'PUT') {
      await ctx.credentials.set(ref, parsed.value ?? '')
    } else {
      await ctx.credentials.unset(ref)
    }
  } catch {
    throw new BridgeHttpError(500, 'credential-write-failed', 'The credential could not be updated.')
  }
  const state = await describeCredential(ctx, config, parsed.credential, signal)
  const result: WebCredentialWriteResult = { credential: parsed.credential, state, changed: true }
  sendJson(response, 200, result)
}

interface ActiveRequest {
  readonly controller: AbortController
  task: Promise<void>
}

function routeHandler(
  active: Set<ActiveRequest>,
  handler: (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => Promise<void>,
) {
  return (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    const record: ActiveRequest = { controller, task: Promise.resolve() }
    const abort = () => controller.abort(new DOMException('Client disconnected.', 'AbortError'))
    request.once('aborted', abort)
    const task = handler(request, response, controller.signal).catch(error => {
      if (controller.signal.aborted) {
        response.destroy()
        return
      }
      const safe = error instanceof BridgeHttpError
        ? error
        : new BridgeHttpError(500, 'internal-error', 'The Web configuration request failed.')
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendJson(response, safe.status, errorBody(safe))
    }).finally(() => {
      request.off('aborted', abort)
      active.delete(record)
    })
    record.task = task
    active.add(record)
    return task
  }
}

/** Register the plugin-owned Web configuration routes and return a quiescent disposer. */
export function mountWebConfigBridge(ctx: Context): () => Promise<void> {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return async () => undefined
  const active = new Set<ActiveRequest>()
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: WEB_CONFIG_PATH,
      handler: routeHandler(active, (request, response, signal) => (
        handleConfigRoute(ctx, request, response, signal)
      )),
    }),
    webServer.register({
      kind: 'exact',
      path: WEB_CREDENTIALS_PATH,
      handler: routeHandler(active, (request, response, signal) => (
        handleCredentialRoute(ctx, request, response, signal)
      )),
    }),
  ]
  return async () => {
    for (const dispose of disposers.reverse()) dispose()
    for (const request of active) request.controller.abort(new DOMException('Plugin disposed.', 'AbortError'))
    await Promise.allSettled([...active].map(request => request.task))
  }
}

/** Attach the optional Web bridge whenever the public webServer service is present. */
export function installWebConfigBridge(ctx: Context): void {
  ctx.inject(['webServer'], webCtx => {
    if (webCtx.get('webServer') === undefined) return
    webCtx.effect(() => mountWebConfigBridge(webCtx), 'search-enhance: Web configuration routes')
  })
}

import type { DefuddleOptions, DefuddleResponse } from 'defuddle/node'
import { parseHTML } from 'linkedom'

import type { Config, RetryConfig } from '../config.js'
import {
  abortableDelay,
  exponentialBackoffMs,
  isProviderError,
  OutputLimitError,
  ProviderError,
  runWithTimeout,
  throwIfAborted,
  truncateCharacters,
  truncateUtf8,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import { normalizeWebExtractUrl } from '../web-extract/url.js'
import { isLikelyAntiBotChallenge } from './web-extract-common.js'
import type {
  WebExtractAdapter,
  WebExtractAdapterInput,
  WebExtractAdapterOutcome,
  WebExtractAdapterResult,
  WebExtractFormat,
} from '../web-extract/types.js'
import {
  fetchIsolatedSmartDirectHttpHop,
} from './smart-direct-child.js'
import {
  createSmartDirectOperationTransport,
  fetchSmartDirectHttpHop,
  type SmartDirectHttpTerminalResponse,
  type SmartDirectTransportDependencies,
  type SmartDirectTransportHandle,
} from './smart-direct-transport.js'

const PROVIDER = 'smart_direct' as const
const CAPABILITY = 'web_extract' as const
const SMART_DIRECT_FORMATS: ReadonlySet<WebExtractFormat> = new Set(['markdown', 'html', 'text'])

export type SmartDirectExtract = (
  input: Document | string | {
    window: {
      document: Document
      location: { href: string }
    }
  },
  url?: string,
  options?: DefuddleOptions,
) => Promise<DefuddleResponse>

let productionDefuddleExtractPromise: Promise<SmartDirectExtract> | undefined

function loadProductionDefuddleExtract(): Promise<SmartDirectExtract> {
  productionDefuddleExtractPromise ??= import('defuddle/node').then(module => {
    if (typeof module.Defuddle !== 'function') {
      throw new TypeError('defuddle/node did not export Defuddle')
    }
    return module.Defuddle
  })
  return productionDefuddleExtractPromise
}

async function extractWithProductionDefuddle(
  signal: AbortSignal,
  document: Document,
  url: string,
  options: DefuddleOptions,
  loadExtract: () => Promise<SmartDirectExtract> = loadProductionDefuddleExtract,
): Promise<DefuddleResponse> {
  throwIfAborted(signal)
  const extract = await loadExtract()
  throwIfAborted(signal)
  return extract(document, url, options)
}

export type SmartDirectHtmlParser = (html: string) => Document

/** Injectable public transport/parser/extractor/loader seams for deterministic tests. */
export interface SmartDirectProviderDependencies extends SmartDirectTransportDependencies {
  readonly extract?: SmartDirectExtract
  /** Test seam for the otherwise cached production defuddle/node import. */
  readonly loadDefuddle?: () => Promise<SmartDirectExtract>
  readonly parseHtml?: SmartDirectHtmlParser
  readonly now?: () => number
  readonly random?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

interface SmartDirectOperationBudget {
  redirects: number
  retries: number
  totalDelayMs: number
}

interface ExplicitMetadata {
  readonly title?: string
  readonly author?: string
  readonly publishedAt?: string
  readonly canonicalUrl?: string
  readonly truncated: boolean
}

function productionParseHtml(html: string): Document {
  return parseHTML(html).document as unknown as Document
}

function canonicalTarget(
  value: string,
  baseUrl: string | undefined,
  maximumUrlCharacters: number,
): string {
  try {
    const resolved = baseUrl === undefined ? value : new URL(value, baseUrl).href
    const normalized = normalizeWebExtractUrl(resolved, maximumUrlCharacters)
    const target = new URL(normalized)
    target.hash = ''
    return target.href
  } catch (error) {
    if (isProviderError(error)) throw error
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'invalid_request',
      provider: PROVIDER,
    })
  }
}

function clockValue(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('smart_direct clock must return a finite non-negative value')
  }
  return value
}

function processingCheckpoint(startedAt: number, maximumMs: number, now: () => number): void {
  if (clockValue(now) - startedAt <= maximumMs) return
  throw new ProviderError({
    capability: CAPABILITY,
    kind: 'timeout',
    provider: PROVIDER,
  })
}

function defineLocalValue(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: false,
  })
}

/** Patch only this linkedom document/window with the public DOM properties Defuddle reads. */
export function patchSmartDirectDocument(document: Document, url: string): void {
  const local = document as unknown as {
    URL?: string
    location?: { href?: string }
    styleSheets?: unknown
    defaultView?: {
      location?: { href?: string }
      getComputedStyle?: (element: Element) => CSSStyleDeclaration
    }
  }
  if (local.URL !== url) defineLocalValue(document, 'URL', url)
  if (local.location?.href !== url) defineLocalValue(document, 'location', { href: url })
  if (local.styleSheets === undefined) defineLocalValue(document, 'styleSheets', [])
  const window = local.defaultView
  if (window !== undefined) {
    if (window.location?.href !== url) defineLocalValue(window, 'location', { href: url })
    if (typeof window.getComputedStyle !== 'function') {
      defineLocalValue(window, 'getComputedStyle', () => ({
        display: '',
        visibility: '',
        getPropertyValue: () => '',
      }) as unknown as CSSStyleDeclaration)
    }
  }
}

/** Iterative bounded scan; linkedom collections are snapshotted before traversal. */
export function assertSmartDirectDomWithinLimit(document: Document, maximumNodes: number): void {
  const stack: Node[] = [document]
  let observed = 0
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    observed += 1
    if (observed > maximumNodes) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'budget_exceeded',
        provider: PROVIDER,
      })
    }
    const children = Array.from(node.childNodes)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) stack.push(child)
    }
  }
}

function firstAttribute(
  document: Document,
  candidates: readonly { readonly selector: string; readonly attribute: string }[],
): string | undefined {
  for (const candidate of candidates) {
    const value = document.querySelector(candidate.selector)?.getAttribute(candidate.attribute)?.trim()
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

function boundedMetadataText(
  value: string | undefined,
  maximumCharacters: number,
): { readonly value?: string; readonly truncated: boolean } {
  if (value === undefined) return { truncated: false }
  const limited = truncateCharacters(value.trim(), maximumCharacters)
  const retained = limited.text.trim()
  return {
    truncated: limited.truncated,
    ...(retained.length === 0 ? {} : { value: retained }),
  }
}

/** Read only explicit terminal-document metadata, never inferred Defuddle site/domain fields. */
export function explicitSmartDirectMetadata(
  document: Document,
  finalUrl: string,
  maximumCharacters: number,
  maximumUrlCharacters: number,
): ExplicitMetadata {
  const title = boundedMetadataText(firstAttribute(document, [
    { selector: 'meta[property="og:title"]', attribute: 'content' },
    { selector: 'meta[name="twitter:title"]', attribute: 'content' },
  ]) ?? document.querySelector('title')?.textContent?.trim(), maximumCharacters)
  const author = boundedMetadataText(firstAttribute(document, [
    { selector: 'meta[name="author"]', attribute: 'content' },
    { selector: 'meta[property="author"]', attribute: 'content' },
    { selector: 'meta[name="citation_author"]', attribute: 'content' },
  ]), maximumCharacters)
  const published = boundedMetadataText(firstAttribute(document, [
    { selector: 'meta[property="article:published_time"]', attribute: 'content' },
    { selector: 'meta[name="date"]', attribute: 'content' },
    { selector: 'meta[name="pubdate"]', attribute: 'content' },
    { selector: 'meta[name="citation_publication_date"]', attribute: 'content' },
  ]), maximumCharacters)

  const canonicalHref = firstAttribute(document, [
    { selector: 'link[rel~="canonical"]', attribute: 'href' },
  ])
  let canonicalUrl: string | undefined
  let canonicalTruncated = false
  if (canonicalHref !== undefined) {
    try {
      canonicalUrl = canonicalTarget(canonicalHref, finalUrl, maximumUrlCharacters)
    } catch {
      canonicalTruncated = Array.from(canonicalHref).length > maximumUrlCharacters
    }
  }

  return {
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(author.value === undefined ? {} : { author: author.value }),
    ...(published.value === undefined ? {} : { publishedAt: published.value }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    truncated: title.truncated || author.truncated || published.truncated || canonicalTruncated,
  }
}

/** Deterministic Markdown-to-text projection; no rendered page or script execution is involved. */
export function smartDirectMarkdownToText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\*_~]+/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]?.length !== 0))
    .join('\n')
    .trim()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function boundedPreformattedHtml(
  value: string,
  maximumCharacters: number,
  maximumBytes: number,
): { readonly content: string; readonly truncated: boolean } {
  const source = truncateCharacters(value.trim(), maximumCharacters)
  const codePoints = Array.from(source.text)
  const project = (count: number): string => `<pre>${escapeHtml(codePoints.slice(0, count).join(''))}</pre>`
  const complete = project(codePoints.length)
  if (utf8ByteLength(complete) <= maximumBytes) {
    return { content: complete, truncated: source.truncated }
  }
  let low = 1
  let high = codePoints.length
  let best: string | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = project(middle)
    if (utf8ByteLength(candidate) <= maximumBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === undefined) {
    throw new OutputLimitError('smart_direct HTML content', maximumBytes, utf8ByteLength(complete))
  }
  return { content: best, truncated: true }
}

function strictUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error) {
    throw new ProviderError({
      capability: CAPABILITY,
      cause: error,
      kind: 'invalid_response',
      provider: PROVIDER,
    })
  }
}

function outputPrefix(
  value: string,
  maximumCharacters: number,
  maximumBytes: number,
): { readonly content: string; readonly truncated: boolean } {
  const characters = truncateCharacters(value.trim(), maximumCharacters)
  const bytes = truncateUtf8(characters.text, maximumBytes)
  const content = bytes.text.trim()
  if (content.length === 0) {
    throw new OutputLimitError('smart_direct content', maximumBytes, utf8ByteLength(value))
  }
  return { content, truncated: characters.truncated || bytes.truncated }
}

function adapterEnvelopeBytes(result: WebExtractAdapterResult): number {
  return utf8ByteLength(JSON.stringify(result))
}

function boundAdapterEnvelope(
  result: WebExtractAdapterResult,
  maximumBytes: number,
  allowContentTruncation: boolean,
): WebExtractAdapterResult {
  const initialBytes = adapterEnvelopeBytes(result)
  if (initialBytes <= maximumBytes) return result
  if (!allowContentTruncation) {
    throw new OutputLimitError('smart_direct adapter envelope', maximumBytes, initialBytes)
  }

  const codePoints = Array.from(result.content)
  let low = 1
  let high = codePoints.length
  let best: WebExtractAdapterResult | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const content = codePoints.slice(0, middle).join('').trim()
    const candidate: WebExtractAdapterResult = {
      ...result,
      content,
      outputTruncated: true,
      truncated: true,
    }
    if (content.length > 0 && adapterEnvelopeBytes(candidate) <= maximumBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === undefined) {
    throw new OutputLimitError('smart_direct adapter envelope', maximumBytes, initialBytes)
  }
  return best
}

function baseResult(
  response: SmartDirectHttpTerminalResponse,
  metadata: ExplicitMetadata,
  content: string,
  outputTruncated: boolean,
): WebExtractAdapterResult {
  return {
    content,
    decompressedBytes: response.decompressedBytes,
    encodedBytes: response.encodedBytes,
    finalUrl: response.url,
    statusCode: response.statusCode,
    truncated: outputTruncated || metadata.truncated,
    ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
    ...(response.contentLength === undefined ? {} : { contentLength: response.contentLength }),
    ...(response.contentDisposition === undefined ? {} : { contentDisposition: response.contentDisposition }),
    ...(response.contentEncoding === undefined ? {} : { contentEncoding: response.contentEncoding }),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
    ...(metadata.canonicalUrl === undefined ? {} : { canonicalUrl: metadata.canonicalUrl }),
    ...(outputTruncated ? { outputTruncated: true } : {}),
    ...(metadata.truncated ? { metadataTruncated: true } : {}),
  }
}

function safeProcessingError(error: unknown, signal: AbortSignal): never {
  throwIfAborted(signal)
  if (isProviderError(error) || error instanceof OutputLimitError) throw error
  throw new ProviderError({
    capability: CAPABILITY,
    cause: error,
    kind: 'invalid_response',
    provider: PROVIDER,
  })
}

function delayForRetry(
  failedRetryNumber: number,
  error: unknown,
  policy: RetryConfig,
  random: (() => number) | undefined,
): number {
  if (isProviderError(error) && error.retryAfterMs !== undefined) {
    return Math.min(Math.ceil(error.retryAfterMs), policy.maxDelayMs)
  }
  return exponentialBackoffMs(failedRetryNumber, policy, random ?? Math.random)
}

/**
 * Production smart_direct route: wreq browser TLS/HTTP fingerprint transport,
 * bounded linkedom DOM construction, and Defuddle readable-content cleaning.
 * Recognizable anti-bot interstitials are unavailable rather than extracted as
 * evidence. This is not browser automation and executes no page JavaScript.
 */
export class SmartDirectProvider implements WebExtractAdapter {
  readonly route = PROVIDER
  private readonly dependencies: SmartDirectProviderDependencies

  constructor(dependencies: SmartDirectProviderDependencies = {}) {
    this.dependencies = dependencies
  }

  supports(format: WebExtractFormat): boolean {
    return SMART_DIRECT_FORMATS.has(format)
  }

  enabled(config: Config): boolean {
    return config.webExtract.smartDirect.enabled
  }

  async extract(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    throwIfAborted(input.signal)
    if (!this.supports(input.format)) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'invalid_request',
        provider: PROVIDER,
      })
    }
    return runWithTimeout(
      signal => this.execute({ ...input, signal }),
      {
        capability: CAPABILITY,
        provider: PROVIDER,
        signal: input.signal,
        timeoutMs: input.config.webExtract.smartDirect.timeoutMs,
      },
    )
  }

  private async execute(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    const config = input.config.webExtract.smartDirect
    const budget: SmartDirectOperationBudget = { redirects: 0, retries: 0, totalDelayMs: 0 }
    const seen = new Set<string>()
    let target = canonicalTarget(input.url, undefined, input.config.webExtract.maxUrlCharacters)
    let transport: SmartDirectTransportHandle | undefined
    const hasInjectedFetch = this.dependencies.fetch !== undefined
    const hasInjectedTransport = this.dependencies.createTransport !== undefined
    if (hasInjectedFetch !== hasInjectedTransport) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'configuration',
        provider: PROVIDER,
      })
    }
    const isolatedTransport = !hasInjectedFetch
    try {
      if (!isolatedTransport) {
        transport = await createSmartDirectOperationTransport(config, input.signal, this.dependencies)
      }
      while (true) {
        throwIfAborted(input.signal)
        if (seen.has(target)) {
          throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
        }
        seen.add(target)
        const response = await this.requestWithRetry(target, transport, input, budget)
        throwIfAborted(input.signal)
        if (response.kind === 'redirect') {
          if (budget.redirects >= config.maxRedirects) {
            throw new ProviderError({ capability: CAPABILITY, kind: 'budget_exceeded', provider: PROVIDER })
          }
          const next = canonicalTarget(
            response.location,
            response.url || target,
            input.config.webExtract.maxUrlCharacters,
          )
          if (seen.has(next)) {
            throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
          }
          budget.redirects += 1
          target = next
          continue
        }
        if (response.kind === 'unavailable' || response.body.byteLength === 0) {
          return { state: 'unavailable' }
        }
        const finalUrl = canonicalTarget(
          response.url || target,
          undefined,
          input.config.webExtract.maxUrlCharacters,
        )
        const normalizedResponse = { ...response, url: finalUrl }
        const result = await this.project(normalizedResponse, input)
        return result === undefined
          ? { state: 'unavailable' }
          : { result, state: 'complete' }
      }
    } finally {
      if (transport !== undefined) {
        try {
          await transport.close()
        } catch (error) {
          throwIfAborted(input.signal)
          throw new ProviderError({
            capability: CAPABILITY,
            cause: error,
            kind: 'network',
            provider: PROVIDER,
          })
        }
      }
    }
  }

  private async requestWithRetry(
    target: string,
    transport: SmartDirectTransportHandle | undefined,
    input: WebExtractAdapterInput,
    budget: SmartDirectOperationBudget,
  ) {
    const smart = input.config.webExtract.smartDirect
    const maximumRetries = Math.min(smart.maxRetries, Math.max(0, input.config.retry.maxAttempts - 1))
    while (true) {
      throwIfAborted(input.signal)
      try {
        if (transport === undefined) {
          return await fetchIsolatedSmartDirectHttpHop({
            config: smart,
            ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
            signal: input.signal,
            url: target,
          }, this.dependencies)
        }
        return await fetchSmartDirectHttpHop({
          config: smart,
          ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
          signal: input.signal,
          transport,
          url: target,
        }, this.dependencies)
      } catch (error) {
        throwIfAborted(input.signal)
        if (!isProviderError(error) || !error.retryable || budget.retries >= maximumRetries) {
          throw error
        }
        const failedRetryNumber = budget.retries + 1
        const requestedDelay = delayForRetry(
          failedRetryNumber,
          error,
          input.config.retry,
          this.dependencies.random,
        )
        const remainingDelay = input.config.retry.maxTotalDelayMs - budget.totalDelayMs
        if (requestedDelay > 0 && remainingDelay <= 0) throw error
        const delayMs = Math.min(requestedDelay, Math.max(0, remainingDelay))
        budget.retries += 1
        await (this.dependencies.sleep ?? abortableDelay)(delayMs, input.signal)
        budget.totalDelayMs += delayMs
      }
    }
  }

  private async project(
    response: SmartDirectHttpTerminalResponse,
    input: WebExtractAdapterInput,
  ): Promise<WebExtractAdapterResult | undefined> {
    const config = input.config.webExtract.smartDirect
    const now = this.dependencies.now ?? Date.now
    try {
      return await runWithTimeout(async signal => {
        const startedAt = clockValue(now)
        throwIfAborted(signal)
        const source = strictUtf8(response.body)
        if (isLikelyAntiBotChallenge(source, response.statusCode)) return undefined
        processingCheckpoint(startedAt, config.processingTimeoutMs, now)

        if (response.mediaKind === 'plain' || response.mediaKind === 'markdown') {
          if (response.mediaKind === 'markdown' && input.format === 'html') return undefined
          const projected = input.format === 'text'
            ? (response.mediaKind === 'markdown' ? smartDirectMarkdownToText(source) : source.trim())
            : input.format === 'html'
              ? `<pre>${escapeHtml(source.trim())}</pre>`
              : source.trim()
          const bounded = input.format === 'html'
            ? boundedPreformattedHtml(
                source,
                config.maxExtractedCharacters,
                config.maxOutputBytes,
              )
            : outputPrefix(projected, config.maxExtractedCharacters, config.maxOutputBytes)
          processingCheckpoint(startedAt, config.processingTimeoutMs, now)
          const result = baseResult(response, { truncated: false }, bounded.content, bounded.truncated)
          return boundAdapterEnvelope(result, config.maxAdapterBytes, input.format !== 'html')
        }

        const document = (this.dependencies.parseHtml ?? productionParseHtml)(source)
        patchSmartDirectDocument(document, response.url)
        assertSmartDirectDomWithinLimit(document, config.maxDomNodes)
        const metadata = explicitSmartDirectMetadata(
          document,
          response.url,
          config.maxMetadataCharacters,
          input.config.webExtract.maxUrlCharacters,
        )
        processingCheckpoint(startedAt, config.processingTimeoutMs, now)
        const markdown = input.format !== 'html'
        const extractorOptions: DefuddleOptions = {
          includeReplies: config.includeReplies,
          markdown,
          removeImages: config.removeImages,
          useAsync: false,
        }
        const extracted = this.dependencies.extract === undefined
          ? await extractWithProductionDefuddle(
              signal,
              document,
              response.url,
              extractorOptions,
              this.dependencies.loadDefuddle ?? loadProductionDefuddleExtract,
            )
          : await this.dependencies.extract(document, response.url, extractorOptions)
        throwIfAborted(signal)
        processingCheckpoint(startedAt, config.processingTimeoutMs, now)
        if (
          typeof extracted.wordCount !== 'number'
          || !Number.isFinite(extracted.wordCount)
          || extracted.wordCount < 0
          || typeof extracted.content !== 'string'
        ) {
          throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
        }
        if (extracted.wordCount === 0 || extracted.content.trim().length === 0) return undefined

        const projected = input.format === 'text'
          ? smartDirectMarkdownToText(extracted.content)
          : extracted.content.trim()
        let bounded: { readonly content: string; readonly truncated: boolean }
        if (input.format === 'html') {
          const characters = Array.from(projected).length
          const bytes = utf8ByteLength(projected)
          if (characters > config.maxExtractedCharacters || bytes > config.maxOutputBytes) {
            throw new OutputLimitError(
              'smart_direct HTML content',
              Math.min(config.maxExtractedCharacters, config.maxOutputBytes),
              Math.max(characters, bytes),
            )
          }
          bounded = { content: projected, truncated: false }
        } else {
          bounded = outputPrefix(projected, config.maxExtractedCharacters, config.maxOutputBytes)
        }
        processingCheckpoint(startedAt, config.processingTimeoutMs, now)
        const result = baseResult(response, metadata, bounded.content, bounded.truncated)
        return boundAdapterEnvelope(result, config.maxAdapterBytes, input.format !== 'html')
      }, {
        capability: CAPABILITY,
        provider: PROVIDER,
        signal: input.signal,
        timeoutMs: config.processingTimeoutMs,
      })
    } catch (error) {
      return safeProcessingError(error, input.signal)
    }
  }
}

/** Adapter spelling used by callers that call every route an adapter. */
export { SmartDirectProvider as SmartDirectAdapter }

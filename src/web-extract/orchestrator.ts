import type { Config } from '../config.js'
import {
  createProviderAttemptRecord,
  isAbortError,
  isProviderError,
  OutputLimitError,
  ProviderError,
  runWithTimeout,
  throwIfAborted,
  type ProviderAttemptRecord,
} from '../provider-runtime/index.js'
import { boundWebExtractResult } from './bounds.js'
import { normalizeWebExtractUrl } from './url.js'
import {
  DIRECT_CONTENT_TRANSFORMS,
  DIRECT_METADATA_ONLY_REASONS,
  evidenceLevelForRoute,
  isWebExtractFormat,
  WebExtractInfrastructureError,
  type WebExtractAdapter,
  type WebExtractAdapterResult,
  type WebExtractFormat,
  type WebExtractInput,
  type WebExtractOrchestratorDependencies,
  type WebExtractResult,
  type WebExtractRoute,
  type WebExtractRouteAttempt,
} from './types.js'

const ORCHESTRATOR_PROVIDER = 'web-extract-orchestrator'

function clockValue(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('web_extract clock must return a finite non-negative value')
  }
  return value
}

function duration(startedAt: number, now: () => number): number {
  return Math.max(0, clockValue(now) - startedAt)
}

function safeProviderError(error: unknown, route: WebExtractRoute): ProviderError {
  if (isProviderError(error)) return error
  return new ProviderError({
    capability: 'web_extract',
    cause: error,
    kind: 'unknown',
    provider: route,
  })
}

function routeAttempt(
  route: WebExtractRoute,
  input: {
    readonly outcome: ProviderAttemptRecord['outcome']
    readonly durationMs: number
    readonly attempts: number
    readonly participatedInFallback: boolean
    readonly error?: unknown
    readonly skipReason?: Parameters<typeof createProviderAttemptRecord>[0]['skipReason']
  },
): WebExtractRouteAttempt {
  const record = createProviderAttemptRecord({
    attempts: input.attempts,
    capability: 'web_extract',
    durationMs: input.durationMs,
    ...(input.error === undefined ? {} : { error: input.error }),
    outcome: input.outcome,
    participatedInFallback: input.participatedInFallback,
    provider: route,
    ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason }),
  })
  return Object.freeze({ ...record, capability: 'web_extract', provider: route })
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function boundedRemoteUrl(value: unknown, maximumCharacters: number): string | undefined {
  const candidate = nonEmptyString(value)
  if (candidate === undefined) return undefined
  try {
    const parsed = new URL(candidate)
    const authority = /^https?:\/\/([^/?#]*)/i.exec(candidate)?.[1]
    if (
      authority === undefined
      || authority.includes('@')
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
      || Array.from(candidate).length > maximumCharacters
    ) return undefined
    return candidate
  } catch {
    return undefined
  }
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 100
    && value <= 599
    ? value
    : undefined
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined
}

function trueFlag(value: unknown): true | undefined {
  return value === true ? true : undefined
}

/** Keep only explicit, scalar metadata from an adapter response. */
function sanitizeAdapterResult(
  result: WebExtractAdapterResult,
  maximumUrlCharacters: number,
  route: WebExtractRoute,
): WebExtractAdapterResult {
  if (typeof result.content !== 'string' || result.content.trim().length === 0) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'unavailable',
      provider: ORCHESTRATOR_PROVIDER,
    })
  }
  if (typeof result.truncated !== 'boolean') {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'invalid_response',
      provider: ORCHESTRATOR_PROVIDER,
    })
  }
  const finalUrl = boundedRemoteUrl(result.finalUrl, maximumUrlCharacters)
  const canonicalUrl = boundedRemoteUrl(result.canonicalUrl, maximumUrlCharacters)
  const contentType = nonEmptyString(result.contentType)
  const contentDisposition = nonEmptyString(result.contentDisposition)
  const contentEncoding = nonEmptyString(result.contentEncoding)
  const title = nonEmptyString(result.title)
  const author = nonEmptyString(result.author)
  const publishedAt = nonEmptyString(result.publishedAt)
  const statusCode = safeStatusCode(result.statusCode)
  const direct = route === 'direct'
  const local = route === 'smart_direct' || direct
  const contentLength = local ? safeNonNegativeInteger(result.contentLength) : undefined
  const encodedBytes = local ? safeNonNegativeInteger(result.encodedBytes) : undefined
  const decompressedBytes = local ? safeNonNegativeInteger(result.decompressedBytes) : undefined
  const metadataOnlyReason = direct && DIRECT_METADATA_ONLY_REASONS.includes(
    result.metadataOnlyReason as (typeof DIRECT_METADATA_ONLY_REASONS)[number],
  ) ? result.metadataOnlyReason : undefined
  const contentTransform = direct && DIRECT_CONTENT_TRANSFORMS.includes(
    result.contentTransform as (typeof DIRECT_CONTENT_TRANSFORMS)[number],
  ) ? result.contentTransform : undefined
  const encodedBodyTruncated = direct ? trueFlag(result.encodedBodyTruncated) : undefined
  const decompressedBodyTruncated = direct ? trueFlag(result.decompressedBodyTruncated) : undefined
  const outputTruncated = local ? trueFlag(result.outputTruncated) : undefined
  const metadataTruncated = local ? trueFlag(result.metadataTruncated) : undefined
  return {
    content: result.content.trim(),
    truncated: result.truncated,
    ...(finalUrl === undefined ? {} : { finalUrl }),
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(local && contentDisposition !== undefined ? { contentDisposition } : {}),
    ...(local && contentEncoding !== undefined ? { contentEncoding } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(encodedBytes === undefined ? {} : { encodedBytes }),
    ...(decompressedBytes === undefined ? {} : { decompressedBytes }),
    ...(metadataOnlyReason === undefined ? {} : { metadataOnlyReason }),
    ...(contentTransform === undefined ? {} : { contentTransform }),
    ...(encodedBodyTruncated === undefined ? {} : { encodedBodyTruncated }),
    ...(decompressedBodyTruncated === undefined ? {} : { decompressedBodyTruncated }),
    ...(outputTruncated === undefined ? {} : { outputTruncated }),
    ...(metadataTruncated === undefined ? {} : { metadataTruncated }),
  }
}

function freezeAttempts(attempts: readonly WebExtractRouteAttempt[]): readonly WebExtractRouteAttempt[] {
  return Object.freeze(attempts.map(attempt => Object.freeze({ ...attempt })))
}

/**
 * Registration-free four-level web extraction orchestrator. It always visits
 * routes in Tavily Extract → Firecrawl Scrape → smart_direct → direct order,
 * skips disabled/unsupported/unconfigured routes, continues after safe route
 * failures, and stops at the first usable non-empty result.
 *
 * It never imports or queries DSH's `web_fetch`/`ctx.web`; all four capabilities
 * arrive through the injected adapter seam. The outer deadline waits for each
 * started adapter to quiesce through the shared cooperative runtime.
 */
export class WebExtractOrchestrator {
  private readonly adapters: readonly WebExtractAdapter[]
  private readonly getConfig: (() => Config) | undefined
  private readonly now: () => number

  constructor(dependencies: WebExtractOrchestratorDependencies) {
    this.adapters = Object.freeze([
      dependencies.tavilyExtract,
      dependencies.firecrawlScrape,
      dependencies.smartDirect,
      dependencies.direct,
    ])
    this.getConfig = dependencies.getConfig
    this.now = dependencies.now ?? Date.now
    const expected: readonly WebExtractRoute[] = [
      'tavily_extract',
      'firecrawl_scrape',
      'smart_direct',
      'direct',
    ]
    for (let index = 0; index < expected.length; index += 1) {
      if (this.adapters[index]?.route !== expected[index]) {
        throw new TypeError('web_extract adapters must use the fixed route order')
      }
    }
  }

  /** Execute one bounded extraction operation under the configured total deadline. */
  async extract(input: WebExtractInput): Promise<Readonly<WebExtractResult>> {
    const config = input.config ?? this.getConfig?.()
    if (config === undefined) {
      throw new ProviderError({
        capability: 'web_extract',
        kind: 'configuration',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }
    const format = input.format ?? 'markdown'
    if (!isWebExtractFormat(format)) {
      throw new ProviderError({
        capability: 'web_extract',
        kind: 'invalid_request',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }

    let requestedUrl: string
    try {
      requestedUrl = normalizeWebExtractUrl(input.url, config.webExtract.maxUrlCharacters)
    } catch (error) {
      if (isProviderError(error)) throw error
      throw new ProviderError({
        capability: 'web_extract',
        cause: error,
        kind: 'invalid_request',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }

    return runWithTimeout(
      signal => this.execute({ config, format, requestedUrl, signal }),
      {
        capability: 'web_extract',
        provider: ORCHESTRATOR_PROVIDER,
        signal: input.signal,
        timeoutMs: config.webExtract.timeoutMs,
      },
    )
  }

  private async execute(input: {
    readonly config: Config
    readonly format: WebExtractFormat
    readonly requestedUrl: string
    readonly signal: AbortSignal
  }): Promise<Readonly<WebExtractResult>> {
    const statuses: WebExtractRouteAttempt[] = []
    let fallbackStarted = false

    for (const adapter of this.adapters) {
      throwIfAborted(input.signal)
      const route = adapter.route
      const startedAt = clockValue(this.now)
      let dispatches = 0
      const onDispatch = (): void => { dispatches += 1 }

      let enabled: boolean
      try {
        enabled = adapter.enabled(input.config)
      } catch (error) {
        const safeError = safeProviderError(error, route)
        statuses.push(routeAttempt(route, {
          attempts: Math.max(1, dispatches),
          durationMs: duration(startedAt, this.now),
          error: safeError,
          outcome: 'failed',
          participatedInFallback: fallbackStarted,
        }))
        fallbackStarted = true
        continue
      }
      if (!enabled) {
        statuses.push(routeAttempt(route, {
          attempts: 0,
          durationMs: duration(startedAt, this.now),
          outcome: 'skipped',
          participatedInFallback: false,
          skipReason: 'disabled',
        }))
        continue
      }
      if (!adapter.supports(input.format)) {
        statuses.push(routeAttempt(route, {
          attempts: 0,
          durationMs: duration(startedAt, this.now),
          outcome: 'skipped',
          participatedInFallback: false,
          skipReason: 'format_unsupported',
        }))
        continue
      }

      try {
        const outcome = await adapter.extract({
          config: input.config,
          format: input.format,
          onDispatch,
          signal: input.signal,
          url: input.requestedUrl,
        })
        throwIfAborted(input.signal)
        if (outcome.state === 'not_configured') {
          statuses.push(routeAttempt(route, {
            attempts: 0,
            durationMs: duration(startedAt, this.now),
            outcome: 'skipped',
            participatedInFallback: false,
            skipReason: 'not_configured',
          }))
          continue
        }
        if (outcome.state === 'unavailable') {
          const unavailable = new ProviderError({
            capability: 'web_extract',
            kind: 'unavailable',
            provider: route,
          })
          statuses.push(routeAttempt(route, {
            attempts: Math.max(1, dispatches),
            durationMs: duration(startedAt, this.now),
            error: unavailable,
            outcome: 'failed',
            participatedInFallback: fallbackStarted,
          }))
          fallbackStarted = true
          continue
        }
        if (outcome.state !== 'complete') {
          throw new ProviderError({
            capability: 'web_extract',
            kind: 'invalid_response',
            provider: route,
          })
        }

        const adapterResult = sanitizeAdapterResult(
          outcome.result,
          input.config.webExtract.maxUrlCharacters,
          route,
        )
        const successAttempt = routeAttempt(route, {
          attempts: Math.max(1, dispatches),
          durationMs: duration(startedAt, this.now),
          outcome: 'success',
          participatedInFallback: fallbackStarted,
        })
        statuses.push(successAttempt)
        const candidate: WebExtractResult = {
          requestedUrl: input.requestedUrl,
          ...(adapterResult.finalUrl === undefined ? {} : { finalUrl: adapterResult.finalUrl }),
          content: adapterResult.content,
          format: input.format,
          ...(adapterResult.title === undefined ? {} : { title: adapterResult.title }),
          ...(adapterResult.author === undefined ? {} : { author: adapterResult.author }),
          ...(adapterResult.publishedAt === undefined ? {} : { publishedAt: adapterResult.publishedAt }),
          ...(adapterResult.canonicalUrl === undefined ? {} : { canonicalUrl: adapterResult.canonicalUrl }),
          ...(adapterResult.contentType === undefined ? {} : { contentType: adapterResult.contentType }),
          ...(adapterResult.contentLength === undefined ? {} : { contentLength: adapterResult.contentLength }),
          ...(adapterResult.contentDisposition === undefined ? {} : { contentDisposition: adapterResult.contentDisposition }),
          ...(adapterResult.contentEncoding === undefined ? {} : { contentEncoding: adapterResult.contentEncoding }),
          ...(adapterResult.statusCode === undefined ? {} : { statusCode: adapterResult.statusCode }),
          ...(adapterResult.encodedBytes === undefined ? {} : { encodedBytes: adapterResult.encodedBytes }),
          ...(adapterResult.decompressedBytes === undefined ? {} : { decompressedBytes: adapterResult.decompressedBytes }),
          ...(adapterResult.metadataOnlyReason === undefined ? {} : { metadataOnlyReason: adapterResult.metadataOnlyReason }),
          ...(adapterResult.contentTransform === undefined ? {} : { contentTransform: adapterResult.contentTransform }),
          ...(adapterResult.encodedBodyTruncated === undefined ? {} : { encodedBodyTruncated: adapterResult.encodedBodyTruncated }),
          ...(adapterResult.decompressedBodyTruncated === undefined ? {} : { decompressedBodyTruncated: adapterResult.decompressedBodyTruncated }),
          ...(adapterResult.outputTruncated === undefined ? {} : { outputTruncated: adapterResult.outputTruncated }),
          ...(adapterResult.metadataTruncated === undefined ? {} : { metadataTruncated: adapterResult.metadataTruncated }),
          retrievalRoute: route,
          evidenceLevel: evidenceLevelForRoute(route),
          truncated: adapterResult.truncated,
          attempts: freezeAttempts(statuses),
        }
        try {
          return boundWebExtractResult(
            candidate,
            input.config.webExtract.maxContentCharacters,
            input.config.webExtract.maxOutputBytes,
          )
        } catch (error) {
          // A route whose truthful envelope cannot fit is a failure, not an
          // empty success. Remove its provisional status before the common
          // catch records one safe failure and tries the next route.
          statuses.pop()
          throw error
        }
      } catch (error) {
        // A caller/deadline cancellation is never a fallback candidate. The
        // shared timeout wrapper waits for this owned adapter promise first.
        throwIfAborted(input.signal)
        if (isAbortError(error)) throw error
        const safeError = error instanceof OutputLimitError
          ? webExtractBudgetError(error)
          : safeProviderError(error, route)
        statuses.push(routeAttempt(route, {
          attempts: Math.max(1, dispatches),
          durationMs: duration(startedAt, this.now),
          error: safeError,
          outcome: 'failed',
          participatedInFallback: fallbackStarted,
        }))
        fallbackStarted = true
      }
    }

    throw new WebExtractInfrastructureError(freezeAttempts(statuses))
  }
}

/** Compatibility alias emphasizing that this is the internal web-extract seam. */
export const WebExtractAutoOrchestrator = WebExtractOrchestrator

/** Convert an output-boundary failure to the common safe Provider category. */
export function webExtractBudgetError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  return new ProviderError({
    capability: 'web_extract',
    cause: error instanceof OutputLimitError ? error : undefined,
    kind: 'budget_exceeded',
    provider: ORCHESTRATOR_PROVIDER,
  })
}

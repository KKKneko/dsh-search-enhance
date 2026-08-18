import type { Config, RetryConfig } from '../config.js'
import {
  abortableDelay,
  exponentialBackoffMs,
  isProviderError,
  ProviderError,
  runWithTimeout,
  throwIfAborted,
} from '../provider-runtime/index.js'
import { normalizeWebExtractUrl } from '../web-extract/url.js'
import { isLikelyAntiBotChallenge } from './web-extract-common.js'
import { isWebExtractFormat } from '../web-extract/types.js'
import type {
  WebExtractAdapter,
  WebExtractAdapterInput,
  WebExtractAdapterOutcome,
  WebExtractFormat,
} from '../web-extract/types.js'
import {
  inspectDirectHtml,
  projectDirectContent,
  type DirectContentInput,
} from './direct-content.js'
import {
  fetchDirectHttpHop,
  type DirectHttpDependencies,
  type DirectHttpHopResponse,
} from './direct-http.js'

const PROVIDER = 'direct' as const
const CAPABILITY = 'web_extract' as const

/** Injectable retry/time seams in addition to the public Node HTTP seams. */
export interface DirectFetchProviderDependencies extends DirectHttpDependencies {
  readonly random?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

interface DirectOperationBudget {
  retries: number
  totalDelayMs: number
  redirects: number
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
    // Fragments are never sent in an HTTP request and therefore do not create a
    // distinct navigation target or a different truthful final response URL.
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
 * Production `direct` route. It performs bounded Node HTTP(S) requests without
 * JavaScript, cookies, login flows, CAPTCHA handling, browser emulation, or any
 * destination-network classification. Recognizable anti-bot interstitials are
 * unavailable rather than returned as direct page evidence. Localhost, private,
 * metadata, reserved, and DNS-rebinding targets are deliberately not blocked
 * by this adapter.
 */
export class DirectFetchProvider implements WebExtractAdapter {
  readonly route = PROVIDER
  private readonly dependencies: DirectFetchProviderDependencies

  constructor(dependencies: DirectFetchProviderDependencies = {}) {
    this.dependencies = dependencies
  }

  supports(format: WebExtractFormat): boolean {
    return isWebExtractFormat(format)
  }

  enabled(config: Config): boolean {
    return config.webExtract.direct.enabled
  }

  async extract(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    throwIfAborted(input.signal)
    if (!isWebExtractFormat(input.format)) {
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
        timeoutMs: input.config.webExtract.direct.totalTimeoutMs,
      },
    )
  }

  private async execute(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    const directConfig = input.config.webExtract.direct
    const budget: DirectOperationBudget = { redirects: 0, retries: 0, totalDelayMs: 0 }
    const seen = new Set<string>()
    let target = canonicalTarget(
      input.url,
      undefined,
      input.config.webExtract.maxUrlCharacters,
    )

    while (true) {
      throwIfAborted(input.signal)
      if (seen.has(target)) {
        throw new ProviderError({
          capability: CAPABILITY,
          kind: 'invalid_response',
          provider: PROVIDER,
        })
      }
      seen.add(target)
      const response = await this.requestWithRetry(target, input, budget)
      throwIfAborted(input.signal)

      if (response.kind === 'redirect') {
        target = this.nextTarget(
          response.location,
          response.url,
          input.config.webExtract.maxUrlCharacters,
          directConfig.maxRedirects,
          seen,
          budget,
        )
        continue
      }

      const contentInput = this.contentInput(response, input)
      const inspection = inspectDirectHtml(contentInput)
      if (isLikelyAntiBotChallenge(inspection.scanText, response.statusCode)) {
        throw new ProviderError({ capability: CAPABILITY, kind: 'unavailable', provider: PROVIDER })
      }
      const navigationTarget = inspection.metaRefreshUrl ?? inspection.alternateUrl
      if (navigationTarget !== undefined) {
        target = this.nextTarget(
          navigationTarget,
          response.url,
          input.config.webExtract.maxUrlCharacters,
          directConfig.maxRedirects,
          seen,
          budget,
        )
        continue
      }

      return {
        result: projectDirectContent(contentInput, inspection),
        state: 'complete',
      }
    }
  }

  private contentInput(
    response: Extract<DirectHttpHopResponse, { readonly kind: 'response' }>,
    input: WebExtractAdapterInput,
  ): DirectContentInput {
    return {
      body: response.body,
      decompressedBodyTruncated: response.decompressedBodyTruncated,
      decompressedBytes: response.decompressedBytes,
      directConfig: input.config.webExtract.direct,
      encodedBodyTruncated: response.encodedBodyTruncated,
      encodedBytes: response.encodedBytes,
      format: input.format,
      maximumContentCharacters: input.config.webExtract.maxContentCharacters,
      maximumUrlCharacters: input.config.webExtract.maxUrlCharacters,
      statusCode: response.statusCode,
      url: response.url,
      ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
      ...(response.contentLength === undefined ? {} : { contentLength: response.contentLength }),
      ...(response.contentDisposition === undefined ? {} : { contentDisposition: response.contentDisposition }),
      ...(response.contentEncoding === undefined ? {} : { contentEncoding: response.contentEncoding }),
      ...(response.omittedReason === undefined ? {} : { omittedReason: response.omittedReason }),
    }
  }

  private nextTarget(
    value: string,
    baseUrl: string,
    maximumUrlCharacters: number,
    maximumRedirects: number,
    seen: ReadonlySet<string>,
    budget: DirectOperationBudget,
  ): string {
    if (budget.redirects >= maximumRedirects) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'budget_exceeded',
        provider: PROVIDER,
      })
    }
    const target = canonicalTarget(value, baseUrl, maximumUrlCharacters)
    if (seen.has(target)) {
      throw new ProviderError({
        capability: CAPABILITY,
        kind: 'invalid_response',
        provider: PROVIDER,
      })
    }
    budget.redirects += 1
    return target
  }

  private async requestWithRetry(
    target: string,
    input: WebExtractAdapterInput,
    budget: DirectOperationBudget,
  ): Promise<DirectHttpHopResponse> {
    while (true) {
      throwIfAborted(input.signal)
      try {
        return await fetchDirectHttpHop({
          config: input.config.webExtract.direct,
          ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
          signal: input.signal,
          url: target,
        }, this.dependencies)
      } catch (error) {
        throwIfAborted(input.signal)
        if (!isProviderError(error) || !error.retryable) throw error
        if (budget.retries >= input.config.webExtract.direct.maxRetries) throw error

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
}

/** Adapter spelling used by callers that call every route an adapter. */
export { DirectFetchProvider as DirectFetchAdapter }

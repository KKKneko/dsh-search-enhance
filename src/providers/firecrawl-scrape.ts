import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type { Config } from '../config.js'
import {
  boundedExtractedContent,
  isLikelyAntiBotChallenge,
  remoteMetadata,
  responseRecord,
} from './web-extract-common.js'
import {
  parseProviderJson,
  providerEndpoint,
  resolveOptionalCredential,
} from './helpers.js'
import {
  ProviderError,
  throwIfAborted,
} from '../provider-runtime/index.js'
import {
  ProviderHttpClient,
  type ProviderHttpDependencies,
} from './http.js'
import type {
  WebExtractAdapter,
  WebExtractAdapterInput,
  WebExtractAdapterOutcome,
  WebExtractAdapterResult,
  WebExtractFormat,
} from '../web-extract/types.js'

const PROVIDER = 'firecrawl_scrape' as const
const CAPABILITY = 'web_extract' as const
const FIRECRAWL_FORMATS = ['markdown', 'html', 'raw'] as const

type FirecrawlFormat = 'markdown' | 'html' | 'rawHtml'

/** Dependencies for the registration-free Firecrawl Scrape adapter. */
export interface FirecrawlScrapeProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'resolve'>
}

/** Pi-compatible Firecrawl request format mapping. */
export function firecrawlFormatForWebExtract(
  format: WebExtractFormat,
): FirecrawlFormat | undefined {
  if (format === 'markdown' || format === 'html') return format
  if (format === 'raw') return 'rawHtml'
  return undefined
}

/**
 * Parse one Firecrawl v2 scrape envelope. The requested format is selected from
 * `data[format]`; recognizable anti-bot challenge content throws a fixed
 * unavailable error instead of consuming empty-content retries, and `metadata`
 * is projected only for explicit scalar fields.
 */
export function parseFirecrawlScrapeResponse(
  body: string,
  format: Extract<WebExtractFormat, 'markdown' | 'html' | 'raw'>,
  maximumUrlCharacters: number,
  maximumContentCharacters: number,
): WebExtractAdapterResult | undefined {
  const root = responseRecord(parseProviderJson(body, PROVIDER, CAPABILITY), PROVIDER)
  if (root.success === false) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  if (!('data' in root)) return undefined
  if (!isRecord(root.data)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const firecrawlFormat = firecrawlFormatForWebExtract(format)
  if (firecrawlFormat === undefined) return undefined
  const data = root.data
  const metadata = remoteMetadata(
    isRecord(data.metadata) ? data.metadata : undefined,
    maximumUrlCharacters,
  )
  const extracted = data[firecrawlFormat]
  if (
    typeof extracted === 'string'
    && isLikelyAntiBotChallenge(extracted, metadata.statusCode)
  ) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'unavailable', provider: PROVIDER })
  }
  const content = boundedExtractedContent(extracted, maximumContentCharacters)
  if (content === undefined) return undefined
  return {
    content: content.content,
    truncated: content.truncated,
    ...metadata,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Registration-free Firecrawl v2 `POST /scrape` adapter. */
export class FirecrawlScrapeProvider implements WebExtractAdapter {
  readonly route = PROVIDER
  private readonly credentials: Pick<CredentialProvider, 'resolve'>
  private readonly http: ProviderHttpClient

  constructor(dependencies: FirecrawlScrapeProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  supports(format: WebExtractFormat): boolean {
    return FIRECRAWL_FORMATS.includes(format as (typeof FIRECRAWL_FORMATS)[number])
  }

  enabled(config: Config): boolean {
    return config.webExtract.firecrawl.enabled
  }

  async extract(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    throwIfAborted(input.signal)
    const firecrawlFormat = firecrawlFormatForWebExtract(input.format)
    if (firecrawlFormat === undefined) return { state: 'unavailable' }

    const providerConfig = input.config.providers.firecrawl
    const routeConfig = input.config.webExtract.firecrawl
    const credential = await resolveOptionalCredential(
      this.credentials,
      providerConfig.credentialRef,
      input.signal,
      PROVIDER,
      CAPABILITY,
    )
    if (credential === undefined) return { state: 'not_configured' }

    for (let pass = 1; pass <= routeConfig.maxEmptyAttempts; pass += 1) {
      throwIfAborted(input.signal)
      const response = await this.http.requestText({
        capability: CAPABILITY,
        endpoint: providerEndpoint(providerConfig.baseUrl, '/scrape'),
        init: {
          body: JSON.stringify({
            formats: [firecrawlFormat],
            timeout: routeConfig.scrapeTimeoutMs,
            url: input.url,
            waitFor: routeConfig.waitForBaseMs * pass,
          }),
          headers: {
            Authorization: `Bearer ${credential.value}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        },
        maximumResponseBytes: routeConfig.maxResponseBytes,
        ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
        provider: PROVIDER,
        retry: input.config.retry,
        signal: input.signal,
        timeoutMs: routeConfig.timeoutMs,
      })
      throwIfAborted(input.signal)
      const result = parseFirecrawlScrapeResponse(
        response.body,
        input.format as Extract<WebExtractFormat, 'markdown' | 'html' | 'raw'>,
        input.config.webExtract.maxUrlCharacters,
        routeConfig.maxContentCharacters,
      )
      if (result !== undefined) return { result, state: 'complete' }
    }
    return { state: 'unavailable' }
  }
}

/** Adapter spelling used by callers that call every route an adapter. */
export { FirecrawlScrapeProvider as FirecrawlScrapeAdapter }

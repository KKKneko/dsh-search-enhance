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
  type ProviderHttpDependencies as HttpDependencies,
} from './http.js'
import type {
  WebExtractAdapter,
  WebExtractAdapterInput,
  WebExtractAdapterResult,
  WebExtractAdapterOutcome,
  WebExtractFormat,
} from '../web-extract/types.js'

const PROVIDER = 'tavily_extract' as const
const CAPABILITY = 'web_extract' as const
const SUPPORTED_FORMATS = ['markdown', 'text'] as const

/** Dependencies for the registration-free Tavily Extract adapter. */
export interface TavilyExtractProviderDependencies extends HttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'resolve'>
}

/**
 * Parse the Pi-compatible Tavily Extract response. Tavily's first result is
 * authoritative; absent, blank, or recognizable anti-bot challenge content is
 * unavailable, not a successful page body; a recognized challenge throws a
 * fixed unavailable error so callers do not retry it as an empty result.
 * Metadata is retained only from explicit fields.
 */
export function parseTavilyExtractResponse(
  body: string,
  format: Extract<WebExtractFormat, 'markdown' | 'text'>,
  maximumUrlCharacters: number,
  maximumContentCharacters: number,
): WebExtractAdapterResult | undefined {
  const data = responseRecord(parseProviderJson(body, PROVIDER, CAPABILITY), PROVIDER)
  if (!('results' in data)) return undefined
  if (!Array.isArray(data.results)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const item = data.results[0]
  if (!responseRecordSafe(item)) return undefined
  const metadata = remoteMetadata(item, maximumUrlCharacters)
  if (
    typeof item.raw_content === 'string'
    && isLikelyAntiBotChallenge(item.raw_content, metadata.statusCode)
  ) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'unavailable', provider: PROVIDER })
  }
  const content = boundedExtractedContent(item.raw_content, maximumContentCharacters)
  if (content === undefined) return undefined
  return {
    content: content.content,
    truncated: content.truncated,
    ...metadata,
  }
}

function responseRecordSafe(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Registration-free Tavily `POST /extract` adapter. */
export class TavilyExtractProvider implements WebExtractAdapter {
  readonly route = PROVIDER
  private readonly credentials: Pick<CredentialProvider, 'resolve'>
  private readonly http: ProviderHttpClient

  constructor(dependencies: TavilyExtractProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  supports(format: WebExtractFormat): boolean {
    return SUPPORTED_FORMATS.includes(format as (typeof SUPPORTED_FORMATS)[number])
  }

  enabled(config: Config): boolean {
    return config.webExtract.tavily.enabled
  }

  async extract(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    throwIfAborted(input.signal)
    if (input.format !== 'markdown' && input.format !== 'text') return { state: 'unavailable' }
    const providerConfig = input.config.providers.tavily
    const routeConfig = input.config.webExtract.tavily
    const credential = await resolveOptionalCredential(
      this.credentials,
      providerConfig.credentialRef,
      input.signal,
      PROVIDER,
      CAPABILITY,
    )
    if (credential === undefined) return { state: 'not_configured' }

    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: providerEndpoint(providerConfig.baseUrl, '/extract'),
      init: {
        body: JSON.stringify({ format: input.format, urls: [input.url] }),
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
    const result = parseTavilyExtractResponse(
      response.body,
      input.format,
      input.config.webExtract.maxUrlCharacters,
      routeConfig.maxContentCharacters,
    )
    return result === undefined
      ? { state: 'unavailable' }
      : { result, state: 'complete' }
  }
}

/** Adapter spelling used by callers that call every route an adapter. */
export { TavilyExtractProvider as TavilyExtractAdapter }

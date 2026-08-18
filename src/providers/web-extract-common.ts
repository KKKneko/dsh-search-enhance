import type { WebExtractAdapterResult } from '../web-extract/types.js'
import {
  canonicalHttpUrl,
  firstString,
  isRecord,
} from './helpers.js'
import { ProviderError, truncateCharacters } from '../provider-runtime/index.js'

const ANTI_BOT_SCAN_BYTES = 32 * 1024
const KNOWN_CHALLENGE_MARKERS = [
  /\/cdn-cgi\/challenge-platform\//iu,
  /\b_cf_chl_opt\b/iu,
  /<(?:div|iframe)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\bpx-captcha\b/iu,
  /\/_Incapsula_Resource(?:[/?])/iu,
  /(?:https?:)?\/\/geo\.captcha-delivery\.com\/captcha\//iu,
  /request unsuccessful\.?\s+incapsula incident id/iu,
] as const
const CHALLENGE_TITLE = /<title\b[^>]*>\s*(?:just a moment(?:\s*(?:\.{3}|…))?|attention required!?\s*\|\s*cloudflare|checking your browser(?:\s*(?:\.{3}|…))?)\s*<\/title>/iu
const CLOUDFLARE_COPY = {
  checking: /checking your browser before accessing/iu,
  continue: /enable javascript and cookies to continue/iu,
  identity: /(?:cloudflare ray id|ddos protection by cloudflare)/iu,
  wait: /\bjust a moment(?:\s*(?:\.{3}|…))?/iu,
} as const
const BLOCKED_CHALLENGE_COPY = /(?:verify (?:that )?you are (?:a )?human|performing (?:a )?security verification|complete (?:the )?(?:security check|verification) to continue|unusual traffic from (?:your|this) (?:computer|network)|automated (?:requests|queries))/iu
const BLOCKED_CHALLENGE_WIDGET = /(?:\bcf-turnstile\b|\bdatadome\b|\bpx-captcha\b)/iu

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0
  let codeUnits = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number
    const characterBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4
    if (bytes + characterBytes > maximumBytes) break
    bytes += characterBytes
    codeUnits += character.length
  }
  return value.slice(0, codeUnits)
}

/**
 * Identify a likely anti-bot interstitial before it is presented as page text.
 * Only the first 32 KiB of decoded UTF-8 content is inspected. Exact vendor
 * markers and combined challenge signals are preferred over generic words, so
 * ordinary discussion of access denial or challenges remains usable content.
 */
export function isLikelyAntiBotChallenge(
  content: string,
  statusCode?: number,
  cfMitigated?: string,
): boolean {
  if (cfMitigated?.trim().toLowerCase() === 'challenge') return true
  const prefix = utf8Prefix(content, ANTI_BOT_SCAN_BYTES)
  if (KNOWN_CHALLENGE_MARKERS.some(marker => marker.test(prefix))) return true
  if (CHALLENGE_TITLE.test(prefix)) return true
  if (
    (CLOUDFLARE_COPY.wait.test(prefix) && CLOUDFLARE_COPY.continue.test(prefix))
    || (CLOUDFLARE_COPY.checking.test(prefix) && CLOUDFLARE_COPY.identity.test(prefix))
  ) return true
  if (statusCode !== 403 && statusCode !== 429 && statusCode !== 503) return false
  return BLOCKED_CHALLENGE_COPY.test(prefix) || BLOCKED_CHALLENGE_WIDGET.test(prefix)
}

/** Return a non-empty trimmed scalar only when the response supplied one. */
export function explicitString(
  record: Record<string, unknown> | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (record === undefined) return undefined
  return firstString(record, keys)
}

/** Preserve an explicit remote URL only when it is bounded and credential-free. */
export function explicitRemoteUrl(
  record: Record<string, unknown> | undefined,
  maximumUrlCharacters: number,
  ...keys: readonly string[]
): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const value = canonicalHttpUrl(
      explicitString(record, key),
      maximumUrlCharacters,
    )
    if (value !== undefined) return value
  }
  return undefined
}

/** Keep only metadata fields with an explicit upstream spelling. */
export function remoteMetadata(
  record: Record<string, unknown> | undefined,
  maximumUrlCharacters: number,
): Omit<WebExtractAdapterResult, 'content' | 'truncated'> {
  const finalUrl = explicitRemoteUrl(record, maximumUrlCharacters, 'sourceURL', 'url')
  const canonicalUrl = explicitRemoteUrl(record, maximumUrlCharacters, 'canonicalUrl', 'canonicalURL')
  const title = explicitString(record, 'title')
  const author = explicitString(record, 'author')
  const publishedAt = explicitString(record, 'publishedAt', 'publishedTime', 'published')
  const contentType = explicitString(record, 'contentType')
  const statusCode = record?.statusCode ?? record?.status
  const safeStatusCode = typeof statusCode === 'number'
    && Number.isInteger(statusCode)
    && statusCode >= 100
    && statusCode <= 599
    ? statusCode
    : undefined
  return {
    ...(finalUrl === undefined ? {} : { finalUrl }),
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(safeStatusCode === undefined ? {} : { statusCode: safeStatusCode }),
  }
}

/** Bound provider-extracted content by Unicode code points without splitting a character. */
export function boundedExtractedContent(
  value: unknown,
  maximumCharacters: number,
): { readonly content: string; readonly truncated: boolean } | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const limited = truncateCharacters(trimmed, maximumCharacters)
  const content = limited.text.trim()
  if (content.length === 0) return undefined
  return Object.freeze({ content, truncated: limited.truncated })
}

/** Require an object response without retaining its unknown fields. */
export function responseRecord(value: unknown, provider: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'invalid_response',
      provider,
    })
  }
  return value
}

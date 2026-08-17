import type { WebExtractAdapterResult } from '../web-extract/types.js'
import {
  canonicalHttpUrl,
  firstString,
  isRecord,
} from './helpers.js'
import { ProviderError, truncateCharacters } from '../provider-runtime/index.js'

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

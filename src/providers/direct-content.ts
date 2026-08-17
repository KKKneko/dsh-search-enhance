import type { DirectFetchConfig } from '../config.js'
import {
  ProviderError,
  truncateCharacters,
  truncateUtf8,
} from '../provider-runtime/index.js'
import { normalizeWebExtractUrl } from '../web-extract/url.js'
import type {
  DirectContentTransform,
  DirectMetadataOnlyReason,
  WebExtractAdapterResult,
  WebExtractFormat,
} from '../web-extract/types.js'

/** Reasons known before a response body is read. */
export type DirectBodyOmissionReason = Extract<
  DirectMetadataOnlyReason,
  | 'attachment'
  | 'binary_content_type'
  | 'declared_too_large'
  | 'unsupported_content_encoding'
>

/** Bounded facts returned by one terminal HTTP response. */
export interface DirectContentInput {
  readonly url: string
  readonly format: WebExtractFormat
  readonly statusCode: number
  readonly contentType?: string
  readonly contentLength?: number
  readonly contentDisposition?: string
  readonly contentEncoding?: string
  readonly body: Buffer
  readonly encodedBytes: number
  readonly decompressedBytes: number
  readonly encodedBodyTruncated: boolean
  readonly decompressedBodyTruncated: boolean
  readonly omittedReason?: DirectBodyOmissionReason
  readonly directConfig: DirectFetchConfig
  readonly maximumUrlCharacters: number
  readonly maximumContentCharacters: number
}

/** HTML facts reused by navigation and final projection. */
export interface DirectHtmlInspection {
  readonly html: boolean
  readonly scanText: string
  readonly title?: string
  readonly author?: string
  readonly publishedAt?: string
  readonly canonicalUrl?: string
  readonly metaRefreshUrl?: string
  readonly alternateUrl?: string
  readonly metadataTruncated: boolean
}

/** MIME types that can be decoded as bounded textual content. */
export function isDirectTextLikeContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return true
  const type = contentType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return type.startsWith('text/')
    || type.includes('json')
    || type.includes('xml')
    || type.includes('javascript')
    || type.includes('typescript')
    || type.includes('markdown')
    || type.includes('yaml')
    || type === 'application/x-www-form-urlencoded'
    || type === 'image/svg+xml'
}

/** Conservative binary sniff for missing or incorrect text MIME declarations. */
export function isProbablyBinaryBody(body: Uint8Array): boolean {
  const length = Math.min(body.byteLength, 8192)
  if (length === 0) return false
  let controls = 0
  for (let index = 0; index < length; index += 1) {
    const byte = body[index]
    if (byte === undefined) continue
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controls += 1
    }
  }
  return controls / length > 0.1
}

function charsetFromContentType(contentType: string | undefined): string {
  const match = contentType?.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i)
  return match?.[1]?.trim() || match?.[2]?.trim() || match?.[3]?.trim() || 'utf-8'
}

function decodeText(
  body: Uint8Array,
  contentType: string | undefined,
  omitIncompleteTail = false,
): string {
  const charset = charsetFromContentType(contentType)
  try {
    const decoder = new TextDecoder(charset)
    return omitIncompleteTail
      ? decoder.decode(body, { stream: true })
      : decoder.decode(body)
  } catch {
    const decoder = new TextDecoder('utf-8')
    return omitIncompleteTail
      ? decoder.decode(body, { stream: true })
      : decoder.decode(body)
  }
}

function boundedPrefix(body: Buffer, maximumBytes: number): {
  readonly bytes: Buffer
  readonly truncated: boolean
} {
  if (body.byteLength <= maximumBytes) return { bytes: body, truncated: false }
  return { bytes: body.subarray(0, maximumBytes), truncated: true }
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
    const name = match[1]?.toLowerCase()
    if (name === undefined) continue
    const raw = match[2] ?? ''
    attributes[name] = decodeHtmlEntities(raw.replace(/^['"]|['"]$/g, ''))
  }
  return attributes
}

function decodeHtmlEntities(text: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (!lower.startsWith('#')) return named[lower] ?? match
    const radix = lower.startsWith('#x') ? 16 : 10
    const digits = lower.slice(radix === 16 ? 2 : 1)
    const codePoint = Number.parseInt(digits, radix)
    if (
      !Number.isFinite(codePoint)
      || codePoint < 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) return match
    return String.fromCodePoint(codePoint)
  })
}

function cleanMetadataText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function firstMetaContent(html: string, names: readonly string[]): string | undefined {
  const accepted = new Set(names.map(name => name.toLowerCase()))
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(tag[0])
    const key = (attributes.name ?? attributes.property ?? attributes.itemprop ?? '').toLowerCase()
    const content = attributes.content?.trim()
    if (accepted.has(key) && content !== undefined && content.length > 0) {
      return cleanMetadataText(content)
    }
  }
  return undefined
}

function firstTitle(html: string): string | undefined {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const cleaned = title === undefined ? undefined : cleanMetadataText(title)
  return cleaned && cleaned.length > 0
    ? cleaned
    : firstMetaContent(html, ['og:title', 'twitter:title'])
}

function firstCanonicalUrl(
  html: string,
  baseUrl: string,
  maximumUrlCharacters: number,
): string | undefined {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(tag[0])
    const relationships = (attributes.rel ?? '').toLowerCase().split(/\s+/)
    if (!relationships.includes('canonical') || !attributes.href?.trim()) continue
    const resolved = boundedNavigationUrl(attributes.href, baseUrl, maximumUrlCharacters)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function boundedMetadata(value: string | undefined, maximumCharacters: number): {
  readonly value?: string
  readonly truncated: boolean
} {
  if (value === undefined) return { truncated: false }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { truncated: false }
  const limited = truncateCharacters(trimmed, maximumCharacters)
  const bounded = limited.text.trim()
  return bounded.length === 0
    ? { truncated: limited.truncated }
    : { truncated: limited.truncated, value: bounded }
}

function boundedNavigationUrl(
  value: string,
  baseUrl: string,
  maximumUrlCharacters: number,
): string | undefined {
  try {
    const resolved = new URL(value.trim(), baseUrl).href
    return normalizeWebExtractUrl(resolved, maximumUrlCharacters)
  } catch {
    return undefined
  }
}

function findMetaRefreshUrl(
  html: string,
  baseUrl: string,
  maximumUrlCharacters: number,
  maximumDelaySeconds: number,
): string | undefined {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(tag[0])
    if ((attributes['http-equiv'] ?? '').toLowerCase() !== 'refresh') continue
    const content = attributes.content ?? ''
    const [delayPart] = content.split(';', 1)
    const delay = Number(delayPart?.trim() || '0')
    if (!Number.isFinite(delay) || delay < 0 || delay > maximumDelaySeconds) continue
    const target = content.match(/(?:^|;)\s*url\s*=\s*(.+)$/i)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
    if (!target) continue
    const resolved = boundedNavigationUrl(target, baseUrl, maximumUrlCharacters)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function acceptedAlternateTypes(format: WebExtractFormat): readonly string[] {
  switch (format) {
    case 'markdown': return ['text/markdown', 'text/x-markdown', 'text/plain']
    case 'text': return ['text/plain']
    case 'html': return ['text/html', 'application/xhtml+xml']
    case 'json': return ['application/json', 'application/ld+json']
    case 'raw': return []
  }
}

function findAlternateUrl(
  html: string,
  baseUrl: string,
  format: WebExtractFormat,
  maximumUrlCharacters: number,
): string | undefined {
  const accepted = acceptedAlternateTypes(format)
  if (accepted.length === 0) return undefined
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(tag[0])
    const relationships = (attributes.rel ?? '').toLowerCase().split(/\s+/)
    const type = (attributes.type ?? '').toLowerCase().split(';', 1)[0]?.trim() ?? ''
    if (
      !relationships.includes('alternate')
      || !accepted.includes(type)
      || !attributes.href?.trim()
    ) continue
    const resolved = boundedNavigationUrl(
      attributes.href,
      baseUrl,
      maximumUrlCharacters,
    )
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function htmlToReadableText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '\n')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '\n')
      .replace(/<template\b[\s\S]*?<\/template>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '\n')
      .replace(/<\/?(?:span|strong|b|em|i|code|a)\b[^>]*>/gi, '')
      .replace(/<(?:title|p|div|section|article|header|footer|main|nav|aside|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
      .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(?:title|p|div|section|article|header|footer|main|nav|aside|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function htmlToMarkdown(html: string, title: string | undefined): string {
  const withBlocks = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, '\n')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '\n')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/(?:strong|b)>/gi, '**')
    .replace(/<(?:em|i)\b[^>]*>/gi, '*')
    .replace(/<\/(?:em|i)>/gi, '*')
    .replace(/<code\b[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|nav|aside|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  let markdown = decodeHtmlEntities(withBlocks)
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
    .filter((line, index, lines) => line.trim().length > 0 || lines[index - 1]?.trim().length !== 0)
    .join('\n')
    .trim()
  if (
    title !== undefined
    && markdown !== `# ${title}`
    && !markdown.startsWith(`# ${title}\n`)
  ) {
    markdown = `# ${title}\n\n${markdown}`.trim()
  }
  return markdown
}

function isHtml(contentType: string | undefined, decodedPrefix: string): boolean {
  return contentType?.toLowerCase().includes('html') === true
    || /^\s*<!doctype\s+html/i.test(decodedPrefix)
    || /^\s*<html(?:\s|>)/i.test(decodedPrefix)
}

/** Inspect only the configured HTML prefix; no DOM, script, or browser execution occurs. */
export function inspectDirectHtml(input: DirectContentInput): DirectHtmlInspection {
  if (input.body.byteLength === 0 || input.omittedReason !== undefined) {
    return { html: false, metadataTruncated: false, scanText: '' }
  }
  const scan = boundedPrefix(input.body, input.directConfig.maxHtmlScanBytes)
  const scanText = decodeText(
    scan.bytes,
    input.contentType,
    scan.truncated || input.encodedBodyTruncated || input.decompressedBodyTruncated,
  )
  if (!isHtml(input.contentType, scanText)) {
    return { html: false, metadataTruncated: false, scanText }
  }

  const title = boundedMetadata(
    firstTitle(scanText),
    input.directConfig.maxMetadataCharacters,
  )
  const author = boundedMetadata(
    firstMetaContent(scanText, ['author', 'article:author', 'byl']),
    input.directConfig.maxMetadataCharacters,
  )
  const publishedAt = boundedMetadata(
    firstMetaContent(scanText, [
      'article:published_time',
      'date',
      'datepublished',
      'datepublishedtime',
      'publication_date',
      'pubdate',
    ]),
    input.directConfig.maxMetadataCharacters,
  )
  const canonicalUrl = firstCanonicalUrl(
    scanText,
    input.url,
    input.maximumUrlCharacters,
  )
  const metaRefreshUrl = findMetaRefreshUrl(
    scanText,
    input.url,
    input.maximumUrlCharacters,
    input.directConfig.maxMetaRefreshDelaySeconds,
  )
  const readableCharacters = Array.from(htmlToReadableText(scanText)).length
  const alternateUrl = readableCharacters < input.directConfig.alternateContentThresholdCharacters
    ? findAlternateUrl(scanText, input.url, input.format, input.maximumUrlCharacters)
    : undefined

  return {
    html: true,
    scanText,
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(author.value === undefined ? {} : { author: author.value }),
    ...(publishedAt.value === undefined ? {} : { publishedAt: publishedAt.value }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(metaRefreshUrl === undefined ? {} : { metaRefreshUrl }),
    ...(alternateUrl === undefined ? {} : { alternateUrl }),
    metadataTruncated: scan.truncated || title.truncated || author.truncated || publishedAt.truncated,
  }
}

const METADATA_ONLY_NOTICES: Readonly<Record<DirectMetadataOnlyReason, string>> = {
  attachment: '[Direct fetch metadata only: the response declares an attachment, so its body was not injected.]',
  binary_content_type: '[Direct fetch metadata only: the response Content-Type is binary, so its body was not injected.]',
  binary_body: '[Direct fetch metadata only: the bounded response prefix appears binary, so its body was not injected.]',
  declared_too_large: '[Direct fetch metadata only: Content-Length exceeds the configured direct-response limit.]',
  unsupported_content_encoding: '[Direct fetch metadata only: Content-Encoding is unsupported, so its body was not decoded.]',
  empty_body: '[Direct fetch metadata only: the final HTTP response contains no textual body.]',
  encoded_limit: '[Direct fetch metadata only: the encoded input limit was reached before textual content became available.]',
  decompressed_limit: '[Direct fetch metadata only: the decompressed input limit was reached before textual content became available.]',
}

function prettyJsonOrOriginal(content: string, completeInput: boolean): {
  readonly content: string
  readonly transformed: boolean
} {
  if (!completeInput) return { content, transformed: false }
  try {
    return { content: JSON.stringify(JSON.parse(content), null, 2), transformed: true }
  } catch {
    return { content, transformed: false }
  }
}

function boundedHeaderMetadata(
  value: string | undefined,
  maximumCharacters: number,
): { readonly value?: string; readonly truncated: boolean } {
  return boundedMetadata(value, maximumCharacters)
}

function metadataOnlyResult(
  input: DirectContentInput,
  inspection: DirectHtmlInspection,
  reason: DirectMetadataOnlyReason,
): WebExtractAdapterResult {
  const notice = METADATA_ONLY_NOTICES[reason]
  const bounded = truncateUtf8(notice, input.directConfig.maxPreviewBytes)
  if (bounded.truncated || bounded.text.trim().length === 0) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'budget_exceeded',
      provider: 'direct',
    })
  }
  return projectResult(input, inspection, bounded.text, {
    metadataOnlyReason: reason,
    outputTruncated: false,
    truncated: reason !== 'empty_body',
  })
}

function projectResult(
  input: DirectContentInput,
  inspection: DirectHtmlInspection,
  content: string,
  state: {
    readonly metadataOnlyReason?: DirectMetadataOnlyReason
    readonly contentTransform?: DirectContentTransform
    readonly outputTruncated: boolean
    readonly truncated: boolean
  },
): WebExtractAdapterResult {
  const contentType = boundedHeaderMetadata(
    input.contentType,
    input.directConfig.maxMetadataCharacters,
  )
  const contentDisposition = boundedHeaderMetadata(
    input.contentDisposition,
    input.directConfig.maxMetadataCharacters,
  )
  const contentEncoding = boundedHeaderMetadata(
    input.contentEncoding,
    input.directConfig.maxMetadataCharacters,
  )
  const metadataTruncated = inspection.metadataTruncated
    || contentType.truncated
    || contentDisposition.truncated
    || contentEncoding.truncated
  const truncated = state.truncated || metadataTruncated
  return {
    content,
    finalUrl: input.url,
    truncated,
    statusCode: input.statusCode,
    encodedBytes: input.encodedBytes,
    decompressedBytes: input.decompressedBytes,
    ...(inspection.title === undefined ? {} : { title: inspection.title }),
    ...(inspection.author === undefined ? {} : { author: inspection.author }),
    ...(inspection.publishedAt === undefined ? {} : { publishedAt: inspection.publishedAt }),
    ...(inspection.canonicalUrl === undefined ? {} : { canonicalUrl: inspection.canonicalUrl }),
    ...(contentType.value === undefined ? {} : { contentType: contentType.value }),
    ...(input.contentLength === undefined ? {} : { contentLength: input.contentLength }),
    ...(contentDisposition.value === undefined ? {} : { contentDisposition: contentDisposition.value }),
    ...(contentEncoding.value === undefined ? {} : { contentEncoding: contentEncoding.value }),
    ...(state.metadataOnlyReason === undefined ? {} : { metadataOnlyReason: state.metadataOnlyReason }),
    ...(state.contentTransform === undefined ? {} : { contentTransform: state.contentTransform }),
    ...(input.encodedBodyTruncated ? { encodedBodyTruncated: true as const } : {}),
    ...(input.decompressedBodyTruncated ? { decompressedBodyTruncated: true as const } : {}),
    ...(state.outputTruncated ? { outputTruncated: true as const } : {}),
    ...(metadataTruncated ? { metadataTruncated: true as const } : {}),
  }
}

/**
 * Deterministically project one bounded terminal response into the adapter seam.
 * HTML conversion is a preview transform, not article extraction or browser rendering.
 */
export function projectDirectContent(
  input: DirectContentInput,
  inspection = inspectDirectHtml(input),
): WebExtractAdapterResult {
  if (input.omittedReason !== undefined) {
    return metadataOnlyResult(input, inspection, input.omittedReason)
  }
  if (input.body.byteLength === 0) {
    const reason: DirectMetadataOnlyReason = input.encodedBodyTruncated
      ? 'encoded_limit'
      : input.decompressedBodyTruncated
        ? 'decompressed_limit'
        : 'empty_body'
    return metadataOnlyResult(input, inspection, reason)
  }
  if (isProbablyBinaryBody(input.body)) {
    return metadataOnlyResult(input, inspection, 'binary_body')
  }

  const processing = inspection.html
    ? boundedPrefix(input.body, input.directConfig.maxHtmlConversionBytes)
    : { bytes: input.body, truncated: false }
  const decoded = decodeText(
    processing.bytes,
    input.contentType,
    processing.truncated || input.encodedBodyTruncated || input.decompressedBodyTruncated,
  ).trim()
  if (decoded.length === 0) {
    return metadataOnlyResult(input, inspection, 'empty_body')
  }

  let rendered: string
  let contentTransform: DirectContentTransform | undefined
  switch (input.format) {
    case 'markdown':
      rendered = inspection.html ? htmlToMarkdown(decoded, inspection.title) : decoded
      if (inspection.html) contentTransform = 'html_to_markdown'
      break
    case 'text':
      rendered = inspection.html ? htmlToReadableText(decoded) : decoded
      if (inspection.html) contentTransform = 'html_to_text'
      break
    case 'json': {
      const json = prettyJsonOrOriginal(
        decoded,
        !processing.truncated
          && !input.encodedBodyTruncated
          && !input.decompressedBodyTruncated,
      )
      rendered = json.content
      if (json.transformed) contentTransform = 'json_pretty'
      break
    }
    case 'html':
    case 'raw':
      rendered = decoded
      break
  }

  const characters = truncateCharacters(rendered.trim(), input.maximumContentCharacters)
  const bytes = truncateUtf8(characters.text, input.directConfig.maxPreviewBytes)
  const content = bytes.text.trim()
  if (content.length === 0) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'budget_exceeded',
      provider: 'direct',
    })
  }
  const outputTruncated = processing.truncated || characters.truncated || bytes.truncated
  return projectResult(input, inspection, content, {
    ...(contentTransform === undefined ? {} : { contentTransform }),
    outputTruncated,
    truncated: input.encodedBodyTruncated
      || input.decompressedBodyTruncated
      || outputTruncated,
  })
}

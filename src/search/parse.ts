import { SEARCH_API_PROTOCOLS, type SearchApiProtocol } from '../config.js'
import type { CanonicalSource } from '../contracts/index.js'
import { utf8ByteLength } from '../provider-runtime/index.js'

export const SEARCH_RESPONSE_PARSE_ERROR_KINDS = ['malformed', 'limit'] as const
export type SearchResponseParseErrorKind = (typeof SEARCH_RESPONSE_PARSE_ERROR_KINDS)[number]

/** Fixed-vocabulary parse failure; response text is never retained in the error. */
export class SearchResponseParseError extends Error {
  readonly code: 'SEARCH_RESPONSE_MALFORMED' | 'SEARCH_RESPONSE_LIMIT'
  readonly kind: SearchResponseParseErrorKind
  readonly maximum: number | undefined
  readonly actual: number | undefined

  constructor(kind: SearchResponseParseErrorKind, options: { maximum?: number; actual?: number } = {}) {
    super(kind === 'limit'
      ? 'Search API response exceeded a parsing limit'
      : 'Search API response is malformed')
    this.name = 'SearchResponseParseError'
    this.code = kind === 'limit' ? 'SEARCH_RESPONSE_LIMIT' : 'SEARCH_RESPONSE_MALFORMED'
    this.kind = kind
    this.maximum = options.maximum
    this.actual = options.actual
  }
}

export interface SearchResponseParseLimits {
  readonly maxResponseBytes: number
  readonly maxSources: number
  readonly maxUrlCharacters: number
  readonly maxTitleCharacters: number
  readonly maxSnippetCharacters: number
  readonly maxPublishedAtCharacters: number
  readonly maxSseEvents: number
  readonly maxSourceNesting: number
}

export const DEFAULT_SEARCH_RESPONSE_PARSE_LIMITS: Readonly<SearchResponseParseLimits> = Object.freeze({
  maxPublishedAtCharacters: 128,
  maxResponseBytes: 2 * 1024 * 1024,
  maxSnippetCharacters: 8000,
  maxSourceNesting: 6,
  maxSources: 100,
  maxSseEvents: 10_000,
  maxTitleCharacters: 1000,
  maxUrlCharacters: 8192,
})

export interface ParsedSearchApiResponse {
  readonly answer: string
  readonly sources: readonly CanonicalSource[]
  readonly sourcesTruncated: boolean
}

type UnknownRecord = Record<string, unknown>

interface MutableSourceState {
  readonly sources: CanonicalSource[]
  readonly seen: Set<string>
  truncated: boolean
}

interface TextExtraction {
  readonly kind: 'delta' | 'final' | 'none'
  readonly recognized: boolean
  readonly text: string
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`，。、；：！？》）】)]+/g
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g
const MARKDOWN_LINK_LINE_PATTERN = /\[[^\]]+]\(https?:\/\/[^)]+\)/
const SOURCES_HEADING_PATTERN =
  /(?:^|\n)(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)(?:\s*[（(][^)\n]*[)）])?\s*(?:(?:\*\*|__)\s*)?[:：]?\s*(?:(?:\*\*|__)\s*)?$/gim
const SOURCES_FUNCTION_PATTERN =
  /(^|\n)\s*(sources|source|citations|citation|references|reference|citation_card|source_cards|source_card)\s*\(/gim

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertSafeInteger(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`)
  }
}

function validateLimits(limits: SearchResponseParseLimits): void {
  assertSafeInteger(limits.maxResponseBytes, 'maxResponseBytes', false)
  assertSafeInteger(limits.maxSources, 'maxSources', true)
  assertSafeInteger(limits.maxUrlCharacters, 'maxUrlCharacters', false)
  assertSafeInteger(limits.maxTitleCharacters, 'maxTitleCharacters', true)
  assertSafeInteger(limits.maxSnippetCharacters, 'maxSnippetCharacters', true)
  assertSafeInteger(limits.maxPublishedAtCharacters, 'maxPublishedAtCharacters', true)
  assertSafeInteger(limits.maxSseEvents, 'maxSseEvents', false)
  assertSafeInteger(limits.maxSourceNesting, 'maxSourceNesting', false)
}

function characterLength(value: string): number {
  return Array.from(value).length
}

function boundedOptionalString(
  value: unknown,
  maximum: number,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const actual = characterLength(trimmed)
  if (actual > maximum) throw new SearchResponseParseError('limit', { actual, maximum })
  return trimmed
}

function firstBoundedString(
  record: UnknownRecord,
  keys: readonly string[],
  maximum: number,
): string | undefined {
  for (const key of keys) {
    if (!(key in record)) continue
    const value = boundedOptionalString(record[key], maximum)
    if (value !== undefined) return value
  }
  return undefined
}

function validatedHttpUrl(raw: string, limits: SearchResponseParseLimits): string | undefined {
  const url = raw.trim().replace(/[.,;:!?]+$/, '')
  const actual = characterLength(url)
  if (actual > limits.maxUrlCharacters) {
    throw new SearchResponseParseError('limit', { actual, maximum: limits.maxUrlCharacters })
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return url
  } catch {
    return undefined
  }
}

function addSource(
  state: MutableSourceState,
  candidate: Omit<CanonicalSource, 'provider'>,
  limits: SearchResponseParseLimits,
): void {
  const url = validatedHttpUrl(candidate.url, limits)
  if (url === undefined || state.seen.has(url)) return
  state.seen.add(url)
  if (state.sources.length >= limits.maxSources) {
    state.truncated = true
    return
  }
  state.sources.push(Object.freeze({
    provider: 'search-api',
    url,
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    ...(candidate.snippet === undefined ? {} : { snippet: candidate.snippet }),
    ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
  }))
}

function extractUrls(text: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0]
    if (raw === undefined) continue
    const url = raw.replace(/[.,;:!?]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function addMarkdownSources(
  text: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): void {
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const rawTitle = match[1]
    const rawUrl = match[2]
    if (rawTitle === undefined || rawUrl === undefined) continue
    const title = boundedOptionalString(rawTitle, limits.maxTitleCharacters)
    addSource(state, {
      url: rawUrl,
      ...(title === undefined ? {} : { title }),
    }, limits)
  }
}

/** Extract URL-validated inline Markdown citations in answer order for internal orchestration. */
export function extractMarkdownCitationUrls(
  text: string,
  maximumUrlCharacters = DEFAULT_SEARCH_RESPONSE_PARSE_LIMITS.maxUrlCharacters,
): readonly string[] {
  assertSafeInteger(maximumUrlCharacters, 'maximumUrlCharacters', false)
  const state: MutableSourceState = { seen: new Set(), sources: [], truncated: false }
  addMarkdownSources(text, state, {
    ...DEFAULT_SEARCH_RESPONSE_PARSE_LIMITS,
    maxSources: Number.MAX_SAFE_INTEGER,
    maxUrlCharacters: maximumUrlCharacters,
  })
  return Object.freeze(state.sources.map(source => source.url))
}

function addTextSources(
  text: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): void {
  addMarkdownSources(text, state, limits)
  const bareText = text.replace(MARKDOWN_LINK_PATTERN, ' ')
  for (const url of extractUrls(bareText)) addSource(state, { url }, limits)
}

function normalizeSourceItem(
  item: unknown,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): void {
  if (typeof item === 'string') {
    for (const url of extractUrls(item)) addSource(state, { url }, limits)
    return
  }

  if (Array.isArray(item) && item.length >= 2) {
    const title = boundedOptionalString(item[0], limits.maxTitleCharacters)
    const url = item[1]
    if (typeof url === 'string') {
      addSource(state, {
        url,
        ...(title === undefined ? {} : { title }),
      }, limits)
    }
    return
  }

  if (!isRecord(item)) return
  const url = firstBoundedString(item, ['url', 'href', 'link'], limits.maxUrlCharacters)
  if (url === undefined) return
  const title = firstBoundedString(item, ['title', 'name', 'label'], limits.maxTitleCharacters)
  const snippet = firstBoundedString(
    item,
    ['description', 'snippet', 'content'],
    limits.maxSnippetCharacters,
  )
  const publishedAt = firstBoundedString(
    item,
    ['publishedAt', 'published_at', 'publishedDate', 'date'],
    limits.maxPublishedAtCharacters,
  )
  addSource(state, {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  }, limits)
}

function normalizeSources(
  data: unknown,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
  depth = 0,
): void {
  if (depth > limits.maxSourceNesting) {
    throw new SearchResponseParseError('limit', {
      actual: depth,
      maximum: limits.maxSourceNesting,
    })
  }
  if (Array.isArray(data)) {
    for (const item of data) normalizeSourceItem(item, state, limits)
    return
  }
  if (isRecord(data)) {
    for (const key of ['sources', 'citations', 'references', 'urls'] as const) {
      if (key in data) {
        normalizeSources(data[key], state, limits, depth + 1)
        return
      }
    }
  }
  normalizeSourceItem(data, state, limits)
}

function jsonCandidates(payload: string): string[] {
  const candidates = [payload]
  const pythonish = payload
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner: string) =>
      JSON.stringify(inner.replace(/\\'/g, "'")))
  if (pythonish !== payload) candidates.push(pythonish)
  return candidates
}

function addSourcesPayload(
  payload: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): void {
  const trimmed = payload.trim().replace(/;\s*$/, '')
  if (trimmed.length === 0) return
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      const data: unknown = JSON.parse(candidate)
      const previousCount = state.sources.length
      normalizeSources(data, state, limits)
      if (state.sources.length > previousCount || state.truncated) return
    } catch (error) {
      if (error instanceof SearchResponseParseError) throw error
    }
  }
  addTextSources(trimmed, state, limits)
}

function extractBalancedCallAtEnd(
  text: string,
  openParenIndex: number,
  maxDepth: number,
): { readonly argsText: string } | undefined {
  if (text[openParenIndex] !== '(') return undefined
  let depth = 1
  let inString: string | undefined
  let escaped = false

  for (let index = openParenIndex + 1; index < text.length; index += 1) {
    const character = text[index]
    if (character === undefined) break
    if (inString !== undefined) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === inString) {
        inString = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      inString = character
    } else if (character === '(') {
      depth += 1
      if (depth > maxDepth) {
        throw new SearchResponseParseError('limit', { actual: depth, maximum: maxDepth })
      }
    } else if (character === ')') {
      depth -= 1
      if (depth === 0) {
        if (text.slice(index + 1).trim().length > 0) return undefined
        return { argsText: text.slice(openParenIndex + 1, index) }
      }
    }
  }
  return undefined
}

function splitFunctionCallSources(
  text: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): string | undefined {
  const matches = [...text.matchAll(SOURCES_FUNCTION_PATTERN)]
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]
    if (match === undefined || match.index === undefined) continue
    const openParenIndex = match.index + match[0].length - 1
    const extracted = extractBalancedCallAtEnd(text, openParenIndex, limits.maxSourceNesting)
    if (extracted === undefined) continue
    const previousCount = state.sources.length
    addSourcesPayload(extracted.argsText, state, limits)
    if (state.sources.length > previousCount || state.truncated) {
      return text.slice(0, match.index).trimEnd()
    }
  }
  return undefined
}

function splitHeadingSources(
  text: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): string | undefined {
  const matches = [...text.matchAll(SOURCES_HEADING_PATTERN)]
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]
    if (match === undefined || match.index === undefined) continue
    const previousCount = state.sources.length
    addTextSources(text.slice(match.index), state, limits)
    if (state.sources.length > previousCount || state.truncated) {
      return text.slice(0, match.index).trimEnd()
    }
  }
  return undefined
}

function splitDetailsBlockSources(
  text: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): string | undefined {
  const lower = text.toLowerCase()
  const closeIndex = lower.lastIndexOf('</details>')
  if (closeIndex === -1 || text.slice(closeIndex + '</details>'.length).trim().length > 0) {
    return undefined
  }
  const openIndex = lower.lastIndexOf('<details', closeIndex)
  if (openIndex === -1) return undefined
  const temporary: MutableSourceState = { seen: new Set(), sources: [], truncated: false }
  addTextSources(text.slice(openIndex, closeIndex + '</details>'.length), temporary, limits)
  if (temporary.sources.length < 2 && !temporary.truncated) return undefined
  for (const source of temporary.sources) addSource(state, source, limits)
  if (temporary.truncated) state.truncated = true
  return text.slice(0, openIndex).trimEnd()
}

function isLinkOnlyLine(line: string): boolean {
  const stripped = line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim()
  return stripped.length > 0 && (
    stripped.startsWith('http://')
    || stripped.startsWith('https://')
    || MARKDOWN_LINK_LINE_PATTERN.test(stripped)
  )
}

function splitTailLinkBlock(
  text: string,
  state: MutableSourceState,
  limits: SearchResponseParseLimits,
): string | undefined {
  const lines = text.split(/\r?\n/)
  let index = lines.length - 1
  while (index >= 0 && lines[index]?.trim().length === 0) index -= 1
  if (index < 0) return undefined
  const tailEnd = index
  let linkCount = 0
  while (index >= 0) {
    const line = lines[index]?.trim() ?? ''
    if (line.length === 0) {
      index -= 1
      continue
    }
    if (!isLinkOnlyLine(line)) break
    linkCount += 1
    index -= 1
  }
  if (linkCount < 2) return undefined
  const tailStart = index + 1
  const previousCount = state.sources.length
  addTextSources(lines.slice(tailStart, tailEnd + 1).join('\n'), state, limits)
  if (state.sources.length === previousCount && !state.truncated) return undefined
  return lines.slice(0, tailStart).join('\n').trimEnd()
}

/** Convert Search API prose/source conventions immediately into provider-neutral records. */
export function parseSearchAnswerText(
  text: string,
  limitOverrides: Partial<SearchResponseParseLimits> = {},
): ParsedSearchApiResponse {
  const limits = { ...DEFAULT_SEARCH_RESPONSE_PARSE_LIMITS, ...limitOverrides }
  validateLimits(limits)
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return Object.freeze({ answer: '', sources: Object.freeze([]), sourcesTruncated: false })
  }

  const trailingState: MutableSourceState = { seen: new Set(), sources: [], truncated: false }
  const answer = splitFunctionCallSources(trimmed, trailingState, limits)
    ?? splitHeadingSources(trimmed, trailingState, limits)
    ?? splitDetailsBlockSources(trimmed, trailingState, limits)
    ?? splitTailLinkBlock(trimmed, trailingState, limits)
    ?? trimmed

  const state: MutableSourceState = { seen: new Set(), sources: [], truncated: false }
  addMarkdownSources(answer, state, limits)
  for (const source of trailingState.sources) addSource(state, source, limits)
  state.truncated ||= trailingState.truncated
  return Object.freeze({
    answer,
    sources: Object.freeze(state.sources),
    sourcesTruncated: state.truncated,
  })
}

function malformed(): never {
  throw new SearchResponseParseError('malformed')
}

function optionalText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return malformed()
  return value
}

function extractCompletionsText(data: UnknownRecord): TextExtraction {
  if (!('choices' in data)) return { kind: 'none', recognized: false, text: '' }
  if (!Array.isArray(data.choices)) return malformed()
  const choice = data.choices[0]
  if (choice === undefined) return { kind: 'none', recognized: true, text: '' }
  if (!isRecord(choice)) return malformed()
  if ('delta' in choice) {
    if (!isRecord(choice.delta)) return malformed()
    return {
      kind: 'delta',
      recognized: true,
      text: optionalText(choice.delta.content),
    }
  }
  if ('message' in choice) {
    if (!isRecord(choice.message)) return malformed()
    return {
      kind: 'final',
      recognized: true,
      text: optionalText(choice.message.content),
    }
  }
  return { kind: 'none', recognized: true, text: '' }
}

function extractResponsesOutput(data: UnknownRecord, envelopeDepth = 0): TextExtraction {
  if ('output_text' in data) {
    return { kind: 'final', recognized: true, text: optionalText(data.output_text) }
  }
  if ('output' in data) {
    if (!Array.isArray(data.output)) return malformed()
    const parts: string[] = []
    for (const item of data.output) {
      if (!isRecord(item)) return malformed()
      if ('text' in item) parts.push(optionalText(item.text))
      if (!('content' in item)) continue
      if (!Array.isArray(item.content)) return malformed()
      for (const contentPart of item.content) {
        if (!isRecord(contentPart)) return malformed()
        if ('text' in contentPart) parts.push(optionalText(contentPart.text))
        else if ('refusal' in contentPart) parts.push(optionalText(contentPart.refusal))
      }
    }
    return { kind: 'final', recognized: true, text: parts.join('') }
  }
  if ('response' in data) {
    if (!isRecord(data.response) || envelopeDepth >= 1) return malformed()
    const nested = extractResponsesOutput(data.response, envelopeDepth + 1)
    if (nested.recognized) return nested
  }

  const type = data.type
  if (type !== undefined && typeof type !== 'string') return malformed()
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    return { kind: 'delta', recognized: true, text: optionalText(data.delta) }
  }
  if (type === 'response.content_part.delta') {
    const delta = data.delta
    if (typeof delta === 'string') return { kind: 'delta', recognized: true, text: delta }
    if (!isRecord(delta)) return malformed()
    return { kind: 'delta', recognized: true, text: optionalText(delta.text) }
  }
  if (typeof type === 'string' && type.startsWith('response.')) {
    return { kind: 'none', recognized: true, text: '' }
  }
  return { kind: 'none', recognized: false, text: '' }
}

function extractProtocolText(data: UnknownRecord, protocol: SearchApiProtocol): TextExtraction {
  const primary = protocol === 'responses'
    ? extractResponsesOutput(data)
    : extractCompletionsText(data)
  if (primary.recognized) return primary
  return protocol === 'responses'
    ? extractCompletionsText(data)
    : extractResponsesOutput(data)
}

function parseObjectJson(value: string): UnknownRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return malformed()
  }
  if (!isRecord(parsed)) return malformed()
  return parsed
}

function extractSseText(body: string, protocol: SearchApiProtocol, maxEvents: number): string {
  let deltaText = ''
  let finalText = ''
  let recognized = false
  let eventCount = 0

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    eventCount += 1
    if (eventCount > maxEvents) {
      throw new SearchResponseParseError('limit', { actual: eventCount, maximum: maxEvents })
    }
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      recognized = true
      continue
    }
    const extracted = extractProtocolText(parseObjectJson(payload), protocol)
    recognized ||= extracted.recognized
    if (extracted.kind === 'delta') deltaText += extracted.text
    else if (extracted.kind === 'final') finalText = extracted.text
  }

  if (!recognized) return malformed()
  return deltaText || finalText
}

function extractJsonText(body: string, protocol: SearchApiProtocol): string {
  const extracted = extractProtocolText(parseObjectJson(body), protocol)
  if (!extracted.recognized) return malformed()
  return extracted.text
}

/**
 * Parse a complete, already-bounded Search API body (SSE or non-streaming JSON).
 * Unknown fields are ignored only inside the global byte/event/nesting bounds;
 * malformed known protocol fields fail instead of becoming an empty success.
 */
export function parseSearchApiResponse(
  body: string,
  protocol: SearchApiProtocol,
  limitOverrides: Partial<SearchResponseParseLimits> = {},
): ParsedSearchApiResponse {
  if (!(SEARCH_API_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new TypeError(`protocol must be one of: ${SEARCH_API_PROTOCOLS.join(', ')}`)
  }
  const limits = { ...DEFAULT_SEARCH_RESPONSE_PARSE_LIMITS, ...limitOverrides }
  validateLimits(limits)
  const actualBytes = utf8ByteLength(body)
  if (actualBytes > limits.maxResponseBytes) {
    throw new SearchResponseParseError('limit', {
      actual: actualBytes,
      maximum: limits.maxResponseBytes,
    })
  }
  if (body.trim().length === 0) return malformed()

  const text = /(?:^|\n)\s*data:/.test(body)
    ? extractSseText(body, protocol, limits.maxSseEvents)
    : extractJsonText(body, protocol)
  return parseSearchAnswerText(text, limits)
}

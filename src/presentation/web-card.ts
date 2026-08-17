import type {
  JsonValue,
  ToolCallView,
  ToolResult,
  ToolResultView,
  WebSource,
} from '@deepseek-ai/dsh-tools'

import {
  DOCUMENTATION_CACHE_PATH_STATES,
  DOCUMENTATION_CACHE_SKIP_REASONS,
} from '../documentation/index.js'
import {
  isWebExtractModelTextTruncated,
  isWebMapModelTextTruncated,
} from './render.js'
import type {
  DocsSearchArgs,
  DocsSearchOutput,
  WebSearchArgs,
  WebSearchOutput,
  SearchSourcesArgs,
  SearchSourcesOutput,
  WebExtractArgs,
  WebExtractOutput,
  WebMapArgs,
  WebMapOutput,
} from '../tools/schemas.js'
import {
  WEB_EXTRACT_EVIDENCE_LEVELS,
  WEB_EXTRACT_ROUTES,
} from '../web-extract/types.js'

interface WebSearchCardMeta {
  readonly version: 1
  readonly type: 'web_search'
  readonly answer?: string
  readonly sources: readonly WebSource[]
  readonly truncated: boolean
}

interface DocsSearchCardSnippet {
  readonly content: string
  readonly title?: string
  readonly library_id?: string
}

interface DocsSearchCardCachePath {
  readonly state: DocsSearchOutput['cache']['resolve']['state']
  readonly evicted_entries: number
  readonly reason?: DocsSearchOutput['cache']['resolve']['reason']
}

interface DocsSearchCardMeta {
  readonly version: 1
  readonly type: 'docs_search'
  readonly sources: readonly WebSource[]
  readonly snippets: readonly DocsSearchCardSnippet[]
  readonly cache: {
    readonly resolve: DocsSearchCardCachePath
    readonly docs: DocsSearchCardCachePath
  }
  readonly truncated: boolean
}

interface SearchSourcesFoundCardMeta {
  readonly version: 1
  readonly type: 'search_sources'
  readonly state: 'found'
  readonly offset: number
  readonly returned: number
  readonly total: number
  readonly sources: readonly WebSource[]
  readonly truncated: boolean
}

interface SearchSourcesNotFoundCardMeta {
  readonly version: 1
  readonly type: 'search_sources'
  readonly state: 'not_found'
  readonly code: 'SOURCE_REF_NOT_FOUND'
}

type SearchSourcesCardMeta = SearchSourcesFoundCardMeta | SearchSourcesNotFoundCardMeta

interface WebExtractCardMeta {
  readonly version: 1
  readonly type: 'web_extract'
  readonly retrieval_route: WebExtractOutput['retrieval_route']
  readonly evidence_level: WebExtractOutput['evidence_level']
  readonly final_url?: string
  readonly status_code?: number
  readonly truncated: boolean
}

interface WebMapCardMeta {
  readonly version: 1
  readonly type: 'web_map'
  readonly sources: readonly WebSource[]
  readonly truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function webSource(value: unknown): WebSource | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined
  if (
    !isOptionalString(value.title)
    || !isOptionalString(value.snippet)
    || !isOptionalString(value.publishedAt)
  ) return undefined
  return {
    url: value.url,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.snippet === undefined ? {} : { snippet: value.snippet }),
    ...(value.publishedAt === undefined ? {} : { publishedAt: value.publishedAt }),
  }
}

function webSources(value: unknown): readonly WebSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sources: WebSource[] = []
  for (const item of value) {
    const source = webSource(item)
    if (source === undefined) return undefined
    sources.push(source)
  }
  return sources
}

/**
 * Pure visible metadata plus a reference-free source publication fact used by
 * durable disclosure recovery. The opaque source_ref remains in canonical/model
 * output and private storage, not presentation metadata.
 */
export function webSearchPresentationMeta(
  _args: WebSearchArgs,
  value: WebSearchOutput,
): JsonValue {
  return {
    version: 1,
    type: 'web_search',
    source_produced: value.source_ref !== undefined,
    ...(value.answer === undefined ? {} : { answer: value.answer }),
    sources: value.sources.map(source => ({ ...source })),
    truncated: value.truncated,
  }
}

/** Generic pending web-search intent whose title is exactly the query. */
export function presentWebSearchCall(args: WebSearchArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: args.query,
  }
}

function parseWebSearchMeta(value: unknown): WebSearchCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'web_search'
    || typeof value.truncated !== 'boolean'
    || !isOptionalString(value.answer)
  ) return undefined
  const sources = webSources(value.sources)
  if (sources === undefined) return undefined
  return {
    version: 1,
    type: 'web_search',
    ...(value.answer === undefined ? {} : { answer: value.answer }),
    sources,
    truncated: value.truncated,
  }
}

/** Rebuild the native Web search card solely from call args and durable metadata. */
export function presentWebSearchResult(
  args: WebSearchArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Search failed' }
  const meta = parseWebSearchMeta(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.query,
    sources: [...meta.sources],
    ...(meta.answer === undefined ? {} : { answer: meta.answer }),
    truncated: meta.truncated,
  }
}

/**
 * Pure docs metadata plus a reference-free source publication fact used by
 * durable disclosure recovery; cache paths, credentials, and source_ref stay out.
 */
export function docsSearchPresentationMeta(
  _args: DocsSearchArgs,
  value: DocsSearchOutput,
): JsonValue {
  return {
    version: 1,
    type: 'docs_search',
    source_produced: value.source_ref !== undefined,
    sources: value.sources.map(source => ({ ...source })),
    snippets: value.snippets.map(snippet => ({ ...snippet })),
    cache: {
      resolve: { ...value.cache.resolve },
      docs: { ...value.cache.docs },
    },
    truncated: value.truncated,
  }
}

/** Pending documentation discovery intent; snippets are not presented as fetched pages. */
export function presentDocsSearchCall(args: DocsSearchArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `Docs: ${args.query}`,
  }
}

function docsCardSnippet(value: unknown): DocsSearchCardSnippet | undefined {
  if (!isRecord(value) || typeof value.content !== 'string') return undefined
  if (!isOptionalString(value.title) || !isOptionalString(value.library_id)) return undefined
  return {
    content: value.content,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.library_id === undefined ? {} : { library_id: value.library_id }),
  }
}

function docsCardCachePath(value: unknown): DocsSearchCardCachePath | undefined {
  if (
    !isRecord(value)
    || typeof value.state !== 'string'
    || !DOCUMENTATION_CACHE_PATH_STATES.includes(value.state as never)
    || !Number.isSafeInteger(value.evicted_entries)
    || (value.evicted_entries as number) < 0
  ) return undefined
  if (
    value.reason !== undefined
    && (
      typeof value.reason !== 'string'
      || !DOCUMENTATION_CACHE_SKIP_REASONS.includes(value.reason as never)
    )
  ) return undefined
  return {
    state: value.state as DocsSearchCardCachePath['state'],
    evicted_entries: value.evicted_entries as number,
    ...(value.reason === undefined
      ? {}
      : { reason: value.reason as NonNullable<DocsSearchCardCachePath['reason']> }),
  }
}

function parseDocsSearchMeta(value: unknown): DocsSearchCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'docs_search'
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.snippets)
    || !isRecord(value.cache)
  ) return undefined
  const sources = webSources(value.sources)
  const resolve = docsCardCachePath(value.cache.resolve)
  const docs = docsCardCachePath(value.cache.docs)
  if (sources === undefined || resolve === undefined || docs === undefined) return undefined
  const snippets: DocsSearchCardSnippet[] = []
  for (const item of value.snippets) {
    const snippet = docsCardSnippet(item)
    if (snippet === undefined) return undefined
    snippets.push(snippet)
  }
  return {
    version: 1,
    type: 'docs_search',
    sources,
    snippets,
    cache: { resolve, docs },
    truncated: value.truncated,
  }
}

function docsCacheLabel(meta: DocsSearchCardMeta): string | undefined {
  const states = [meta.cache.resolve.state, meta.cache.docs.state]
  if (states.includes('stale')) return 'stale cache'
  if (states.includes('refresh')) return 'refreshed'
  if (states.includes('miss')) return 'retrieved'
  if (states.includes('hit')) return 'cache hit'
  return undefined
}

function docsCardAnswer(meta: DocsSearchCardMeta): string | undefined {
  if (meta.snippets.length === 0) return undefined
  const lines = ['Documentation snippets (discovery metadata; not fetched page bodies):']
  for (let index = 0; index < meta.snippets.length; index += 1) {
    const snippet = meta.snippets[index]
    if (snippet === undefined) continue
    lines.push(`${index + 1}. ${snippet.title ?? 'Context7 documentation snippet'}`)
    if (snippet.library_id !== undefined) lines.push(`Library: ${snippet.library_id}`)
    lines.push(snippet.content)
  }
  return lines.join('\n')
}

/** Rebuild a provider-neutral Web search card without treating snippets as fetched bodies. */
export function presentDocsSearchResult(
  args: DocsSearchArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Documentation search failed' }
  const meta = parseDocsSearchMeta(result.meta)
  if (meta === undefined) return undefined
  const label = docsCacheLabel(meta)
  const title = `Docs${label === undefined ? '' : ` (${label})`}: ${args.query}`
  if (meta.sources.length === 0 && meta.snippets.length === 0) {
    return { card: 'generic', title: `No documentation results: ${args.query}` }
  }
  const answer = docsCardAnswer(meta)
  return {
    card: 'web',
    kind: 'search',
    title,
    sources: [...meta.sources],
    ...(answer === undefined ? {} : { answer }),
    truncated: meta.truncated,
  }
}

/** Pure, visible-page-only metadata projection for search_sources. */
export function searchSourcesPresentationMeta(
  _args: SearchSourcesArgs,
  value: SearchSourcesOutput,
): JsonValue {
  if (value.state === 'not_found') {
    return {
      version: 1,
      type: 'search_sources',
      state: 'not_found',
      code: value.code,
    }
  }
  return {
    version: 1,
    type: 'search_sources',
    state: 'found',
    offset: value.offset,
    returned: value.returned,
    total: value.total,
    sources: value.sources.map(source => ({
      url: source.url,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
      ...(source.date === undefined ? {} : { publishedAt: source.date }),
    })),
    truncated: value.truncated || value.has_more || value.page_byte_limited,
  }
}

/** Pending pagination intent; it never claims a fetched webpage body. */
export function presentSearchSourcesCall(args: SearchSourcesArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `Sources ${args.source_ref}`,
  }
}

function parseSearchSourcesMeta(value: unknown): SearchSourcesCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'search_sources'
  ) return undefined
  if (value.state === 'not_found' && value.code === 'SOURCE_REF_NOT_FOUND') {
    return {
      version: 1,
      type: 'search_sources',
      state: 'not_found',
      code: 'SOURCE_REF_NOT_FOUND',
    }
  }
  if (
    value.state !== 'found'
    || !Number.isSafeInteger(value.offset)
    || !Number.isSafeInteger(value.returned)
    || !Number.isSafeInteger(value.total)
    || typeof value.truncated !== 'boolean'
  ) return undefined
  const sources = webSources(value.sources)
  if (sources === undefined) return undefined
  return {
    version: 1,
    type: 'search_sources',
    state: 'found',
    offset: value.offset as number,
    returned: value.returned as number,
    total: value.total as number,
    sources,
    truncated: value.truncated,
  }
}

/** Build a page card from durable metadata without inventing page-body evidence. */
export function presentSearchSourcesResult(
  _args: SearchSourcesArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Source page failed' }
  const meta = parseSearchSourcesMeta(result.meta)
  if (meta === undefined) return undefined
  if (meta.state === 'not_found') {
    return { card: 'generic', title: `Source reference not found (${meta.code})` }
  }
  const end = meta.returned === 0 ? meta.offset : meta.offset + meta.returned - 1
  return {
    card: 'web',
    kind: 'search',
    title: `Sources ${meta.offset}-${end} of ${meta.total}`,
    sources: [...meta.sources],
    truncated: meta.truncated,
  }
}

/** Persist only the facts needed to replay an accurate fetch/generic result card, including effective model-text truncation. */
export function webExtractPresentationMeta(
  _args: WebExtractArgs,
  value: WebExtractOutput,
): JsonValue {
  return {
    version: 1,
    type: 'web_extract',
    retrieval_route: value.retrieval_route,
    evidence_level: value.evidence_level,
    ...(value.final_url === undefined ? {} : { final_url: value.final_url }),
    ...(value.status_code === undefined ? {} : { status_code: value.status_code }),
    truncated: value.truncated || isWebExtractModelTextTruncated(value),
  }
}

/** Pending webpage retrieval stays generic while using the neutral fetch kind. */
export function presentWebExtractCall(args: WebExtractArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'fetch',
    title: `Read ${args.url}`,
  }
}

function parseWebExtractMeta(value: unknown): WebExtractCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'web_extract'
    || typeof value.retrieval_route !== 'string'
    || !WEB_EXTRACT_ROUTES.includes(value.retrieval_route as never)
    || typeof value.evidence_level !== 'string'
    || !WEB_EXTRACT_EVIDENCE_LEVELS.includes(value.evidence_level as never)
    || !isOptionalString(value.final_url)
    || typeof value.truncated !== 'boolean'
  ) return undefined
  if (
    value.status_code !== undefined
    && (
      !Number.isInteger(value.status_code)
      || (value.status_code as number) < 100
      || (value.status_code as number) > 599
    )
  ) return undefined
  return {
    version: 1,
    type: 'web_extract',
    retrieval_route: value.retrieval_route as WebExtractCardMeta['retrieval_route'],
    evidence_level: value.evidence_level as WebExtractCardMeta['evidence_level'],
    ...(value.final_url === undefined ? {} : { final_url: value.final_url }),
    ...(value.status_code === undefined ? {} : { status_code: value.status_code as number }),
    truncated: value.truncated,
  }
}

/**
 * Use the official Web fetch card only for locally observed target HTTP facts.
 * Remote extraction without that pair remains an accurate generic result.
 */
export function presentWebExtractResult(
  _args: WebExtractArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Web extraction failed' }
  const meta = parseWebExtractMeta(result.meta)
  if (meta === undefined) return undefined
  const localHttp = meta.retrieval_route === 'smart_direct' || meta.retrieval_route === 'direct'
  if (localHttp && meta.final_url !== undefined && meta.status_code !== undefined) {
    return {
      card: 'web',
      kind: 'fetch',
      url: meta.final_url,
      statusCode: meta.status_code,
      truncated: meta.truncated,
    }
  }
  return {
    card: 'generic',
    title: `Extracted via ${meta.retrieval_route} (${meta.evidence_level})`,
  }
}

/** Persist only accepted URL candidates and the effective truncation fact. */
export function webMapPresentationMeta(
  _args: WebMapArgs,
  value: WebMapOutput,
): JsonValue {
  return {
    version: 1,
    type: 'web_map',
    sources: value.results.map(url => ({ url })),
    truncated: value.truncated || isWebMapModelTextTruncated(value),
  }
}

/** Pending mapping stays a generic search intent because links do not exist yet. */
export function presentWebMapCall(args: WebMapArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `Map ${args.url}`,
  }
}

function parseWebMapMeta(value: unknown): WebMapCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'web_map'
    || typeof value.truncated !== 'boolean'
  ) return undefined
  const sources = webSources(value.sources)
  if (sources === undefined) return undefined
  return {
    version: 1,
    type: 'web_map',
    sources,
    truncated: value.truncated,
  }
}

/** Rebuild the official Web search card solely from args and durable metadata. */
export function presentWebMapResult(
  args: WebMapArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Website mapping failed' }
  const meta = parseWebMapMeta(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: `Site map: ${args.url}`,
    sources: [...meta.sources],
    truncated: meta.truncated,
  }
}

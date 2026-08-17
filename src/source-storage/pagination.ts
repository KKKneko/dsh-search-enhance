import type {
  CanonicalSource,
  SourceCategory,
  SourceRef,
  StoredSourceRecord,
} from '../contracts/index.js'
import {
  OutputLimitError,
  retainJsonPrefix,
  truncateCharacters,
} from '../provider-runtime/index.js'

export const SOURCE_PAGE_FORMATS = ['compact', 'full'] as const
export type SourcePageFormat = (typeof SOURCE_PAGE_FORMATS)[number]

export interface SourcePageRequest {
  readonly source_ref: unknown
  readonly offset?: unknown
  readonly limit?: unknown
  readonly format?: unknown
}

export interface ParsedSourcePageRequest {
  readonly sourceRef: unknown
  readonly offset: number
  readonly limit: number
  readonly format: SourcePageFormat
}

export interface CompactPageSource {
  readonly url: string
  readonly title?: string
  readonly date?: string
  readonly category: SourceCategory
}

export interface FullPageSource extends CompactPageSource {
  readonly snippet?: string
  readonly snippetTruncated?: true
}

export type SourcePageSource = CompactPageSource | FullPageSource

export interface SourcePageFound {
  readonly state: 'found'
  readonly source_ref: SourceRef
  readonly offset: number
  readonly limit: number
  readonly format: SourcePageFormat
  /** Number retained in private storage. */
  readonly total: number
  readonly returned: number
  readonly sources: readonly SourcePageSource[]
  readonly hasMore: boolean
  readonly nextOffset?: number
  readonly totalBeforeRetention: number
  readonly truncated: boolean
  /** True only when the page byte cap retained fewer than this request's item slice. */
  readonly pageByteLimited: boolean
}

export type SourcePageErrorCode = 'SOURCE_PAGE_INVALID_REQUEST' | 'SOURCE_PAGE_BUDGET'

export class SourcePageError extends Error {
  override readonly name = 'SourcePageError'

  constructor(
    readonly code: SourcePageErrorCode,
    options: ErrorOptions = {},
  ) {
    super(code, options)
  }
}

export interface SourcePaginationLimits {
  readonly maxPageSize: number
  readonly maxPageBytes: number
  readonly maxSnippetCharacters: number
}

function safeInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`)
  }
  return value
}

export function parseSourcePageRequest(
  request: SourcePageRequest,
  maximumPageSize: number,
): Readonly<ParsedSourcePageRequest> {
  safeInteger(maximumPageSize, 'maximumPageSize', 1)
  const offset = request.offset ?? 0
  const limit = request.limit ?? 20
  const format = request.format ?? 'compact'
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    throw new SourcePageError('SOURCE_PAGE_INVALID_REQUEST')
  }
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > maximumPageSize) {
    throw new SourcePageError('SOURCE_PAGE_INVALID_REQUEST')
  }
  if (format !== 'compact' && format !== 'full') {
    throw new SourcePageError('SOURCE_PAGE_INVALID_REQUEST')
  }
  return Object.freeze({
    format,
    limit: limit as number,
    offset: offset as number,
    sourceRef: request.source_ref,
  })
}

function compactSource(source: CanonicalSource): CompactPageSource {
  return Object.freeze({
    category: source.category ?? 'unknown',
    ...(source.publishedAt === undefined ? {} : { date: source.publishedAt }),
    ...(source.title === undefined ? {} : { title: source.title }),
    url: source.url,
  })
}

function fullSource(source: CanonicalSource, maxSnippetCharacters: number): FullPageSource {
  const compact = compactSource(source)
  if (source.snippet === undefined) return compact
  const snippet = truncateCharacters(source.snippet, maxSnippetCharacters)
  return Object.freeze({
    ...compact,
    ...(snippet.text.length === 0 ? {} : { snippet: snippet.text }),
    ...(snippet.truncated ? { snippetTruncated: true as const } : {}),
  })
}

function projectPage(
  record: StoredSourceRecord,
  request: ParsedSourcePageRequest,
  sources: readonly SourcePageSource[],
  requestedItems: number,
): SourcePageFound {
  const total = record.sources.length
  const nextOffset = request.offset + sources.length
  const hasMore = nextOffset < total
  return {
    state: 'found',
    source_ref: record.sourceRef,
    offset: request.offset,
    limit: request.limit,
    format: request.format,
    total,
    returned: sources.length,
    sources,
    hasMore,
    ...(hasMore && sources.length > 0 ? { nextOffset } : {}),
    totalBeforeRetention: record.totalBeforeRetention,
    truncated: record.truncated,
    pageByteLimited: sources.length < requestedItems,
  }
}

function freezePage(page: SourcePageFound): Readonly<SourcePageFound> {
  return Object.freeze({
    ...page,
    sources: Object.freeze(page.sources.map(source => Object.freeze({ ...source }))),
  })
}

/** Project one authorized record page and bound its complete canonical JSON envelope. */
export function paginateSourceRecord(
  record: StoredSourceRecord,
  request: ParsedSourcePageRequest,
  limits: Pick<SourcePaginationLimits, 'maxPageBytes' | 'maxSnippetCharacters'>,
): Readonly<SourcePageFound> {
  safeInteger(limits.maxPageBytes, 'maxPageBytes', 1)
  safeInteger(limits.maxSnippetCharacters, 'maxSnippetCharacters', 0)
  const selected = record.sources
    .slice(request.offset, request.offset + request.limit)
    .map(source => request.format === 'compact'
      ? compactSource(source)
      : fullSource(source, limits.maxSnippetCharacters))
  try {
    const bounded = retainJsonPrefix(selected, {
      label: 'source page',
      maxBytes: limits.maxPageBytes,
      maxItems: selected.length,
      project: sources => projectPage(record, request, sources, selected.length),
    })
    if (selected.length > 0 && bounded.retained.length === 0) {
      throw new SourcePageError('SOURCE_PAGE_BUDGET')
    }
    return freezePage(projectPage(record, request, bounded.retained, selected.length))
  } catch (error) {
    if (error instanceof SourcePageError) throw error
    if (error instanceof OutputLimitError) {
      throw new SourcePageError('SOURCE_PAGE_BUDGET', { cause: error })
    }
    throw error
  }
}

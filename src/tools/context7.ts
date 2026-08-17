import {
  ToolArgsError,
  defineTool,
  parameterSchemaSpecToJsonSchema,
  type InferArgs,
  type JsonValue,
  type ParameterSchemaSpec,
  type ToolCallView,
  type ToolDefinition,
  type ToolResult,
  type ToolResultView,
  type ToolRunContext,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

import type { Config } from '../config.js'
import {
  CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS,
  Context7CacheError,
  Context7DocsCacheEntrySchema,
  DOCUMENTATION_CACHE_PATH_STATES,
  DOCUMENTATION_CACHE_SKIP_REASONS,
  DOCUMENTATION_WARNING_CODES,
  isContext7DocRef,
  isContext7LibraryId,
  type Context7DocsCacheEntry,
  type Context7DocsResult,
  type Context7ResolveResult,
  type DocumentationCachePath,
  type DocumentationSearchService,
  type DocumentationWarning,
} from '../documentation/index.js'
import {
  OutputLimitError,
  PROVIDER_ATTEMPT_OUTCOMES,
  PROVIDER_ERROR_KINDS,
  PROVIDER_SKIP_REASONS,
  ProviderError,
  retainJsonPrefix,
  throwIfAborted,
  truncateUtf8,
  utf8ByteLength,
  type ProviderAttemptRecord,
} from '../provider-runtime/index.js'
import type { Context7Library } from '../providers/context7.js'
import type { DocumentationSnippet } from '../providers/types.js'
import type { ForegroundOperationScope } from './operations.js'

export const CONTEXT7_TOOL_MAX_RESULTS = 20
export const CONTEXT7_RESOLVE_DEFAULT_MAX_RESULTS = 8
export const CONTEXT7_QUERY_DEFAULT_MAX_SNIPPETS = 5
export const CONTEXT7_GET_DOCS_DEFAULT_MAX_SNIPPETS = 8
export const CONTEXT7_TOOL_MAX_VERSIONS = 20

const RESULT_LIMIT_VALUES = Object.freeze(
  Array.from({ length: CONTEXT7_TOOL_MAX_RESULTS }, (_value, index) => index + 1),
)

export const CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETER_SPEC = {
  library_name: {
    type: 'string',
    required: true,
    description: 'Non-empty package or product name. If an exact /org/project[/version] id is already known, call context7_query_docs instead.',
  },
  query: {
    type: 'string',
    description: 'Optional non-empty task context used only to rank the bounded candidates.',
  },
  max_results: {
    type: 'integer',
    enum: RESULT_LIMIT_VALUES,
    default: CONTEXT7_RESOLVE_DEFAULT_MAX_RESULTS,
    description: 'Maximum candidates from 1 through 20; defaults to 8.',
  },
  force_refresh: {
    type: 'boolean',
    default: false,
    description: 'Bypass a fresh resolve cache entry; expired transient failures may still use stale cache.',
  },
} as const satisfies ParameterSchemaSpec

export const CONTEXT7_QUERY_DOCS_PARAMETER_SPEC = {
  library_id: {
    type: 'string',
    required: true,
    description: 'Exact Context7 /org/project or /org/project/version id.',
  },
  query: {
    type: 'string',
    required: true,
    description: 'Non-empty documentation task or question.',
  },
  max_snippets: {
    type: 'integer',
    enum: RESULT_LIMIT_VALUES,
    default: CONTEXT7_QUERY_DEFAULT_MAX_SNIPPETS,
    description: 'Maximum snippets from 1 through 20; defaults to 5.',
  },
  raw: {
    type: 'boolean',
    default: false,
    description: 'Return the validated bounded cache envelope, never an unparsed Provider body or backend file.',
  },
  force_refresh: {
    type: 'boolean',
    default: false,
    description: 'Bypass a fresh docs cache entry; expired transient failures may still use stale cache.',
  },
} as const satisfies ParameterSchemaSpec

export const CONTEXT7_GET_LIBRARY_DOCS_PARAMETER_SPEC = {
  query: {
    type: 'string',
    required: true,
    description: 'Non-empty documentation task or question.',
  },
  library_name: {
    type: 'string',
    description: 'Package or product name to resolve when library_id is absent.',
  },
  library_id: {
    type: 'string',
    description: 'Exact Context7 id. When supplied, resolve is skipped even if library_name is also present.',
  },
  max_results: {
    type: 'integer',
    enum: RESULT_LIMIT_VALUES,
    default: CONTEXT7_RESOLVE_DEFAULT_MAX_RESULTS,
    description: 'Maximum resolve candidates from 1 through 20; defaults to 8.',
  },
  max_snippets: {
    type: 'integer',
    enum: RESULT_LIMIT_VALUES,
    default: CONTEXT7_GET_DOCS_DEFAULT_MAX_SNIPPETS,
    description: 'Maximum snippets from 1 through 20; defaults to 8.',
  },
  raw: {
    type: 'boolean',
    default: false,
    description: 'Return the validated bounded cache envelope instead of the ordinary snippet projection.',
  },
  force_refresh: {
    type: 'boolean',
    default: false,
    description: 'Bypass fresh Context7 resolve/docs cache entries.',
  },
} as const satisfies ParameterSchemaSpec

export const CONTEXT7_GET_CACHED_DOC_RAW_PARAMETER_SPEC = {
  doc_ref: {
    type: 'string',
    description: 'Exact opaque ctx7d_ reference returned by a Context7 docs tool.',
  },
  query: {
    type: 'string',
    description: 'Non-empty deterministic cache-match query used only when doc_ref is absent.',
  },
  library_id: {
    type: 'string',
    description: 'Optional exact Context7 id used only as a cache-record filter.',
  },
} as const satisfies ParameterSchemaSpec

function closedParameters(spec: ParameterSchemaSpec) {
  return Object.freeze({
    ...parameterSchemaSpecToJsonSchema(spec),
    additionalProperties: false,
  })
}

export const CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETERS = closedParameters(
  CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETER_SPEC,
)
export const CONTEXT7_QUERY_DOCS_PARAMETERS = closedParameters(
  CONTEXT7_QUERY_DOCS_PARAMETER_SPEC,
)
export const CONTEXT7_GET_LIBRARY_DOCS_PARAMETERS = closedParameters(
  CONTEXT7_GET_LIBRARY_DOCS_PARAMETER_SPEC,
)
export const CONTEXT7_GET_CACHED_DOC_RAW_PARAMETERS = closedParameters(
  CONTEXT7_GET_CACHED_DOC_RAW_PARAMETER_SPEC,
)

export type Context7ResolveLibraryIdArgs = InferArgs<
  typeof CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETER_SPEC
>
export type Context7QueryDocsArgs = InferArgs<typeof CONTEXT7_QUERY_DOCS_PARAMETER_SPEC>
export type Context7GetLibraryDocsArgs = InferArgs<
  typeof CONTEXT7_GET_LIBRARY_DOCS_PARAMETER_SPEC
>
export type Context7GetCachedDocRawArgs = InferArgs<
  typeof CONTEXT7_GET_CACHED_DOC_RAW_PARAMETER_SPEC
>

export interface Context7ToolLibrary {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly trust_score?: number
  readonly benchmark_score?: number
  readonly total_snippets?: number
  readonly stars?: number
  readonly versions: string[]
  readonly versions_truncated: boolean
}

export interface Context7ToolSnippet {
  readonly content: string
  readonly title?: string
  readonly library_id?: string
}

export interface Context7ToolAttempt {
  readonly provider: string
  readonly outcome: (typeof PROVIDER_ATTEMPT_OUTCOMES)[number]
  readonly count: number
  readonly duration_ms: number
  readonly fallback: boolean
  readonly error_kind?: (typeof PROVIDER_ERROR_KINDS)[number]
  readonly retryable?: boolean
  readonly http_status?: number
  readonly skip_reason?: (typeof PROVIDER_SKIP_REASONS)[number]
}

export const CONTEXT7_TOOL_WARNING_CODES = Object.freeze([
  ...DOCUMENTATION_WARNING_CODES,
  'canonical_output_truncated',
] as const)

export type Context7ToolWarningCode = (typeof CONTEXT7_TOOL_WARNING_CODES)[number]

export interface Context7ToolWarning {
  readonly code: Context7ToolWarningCode
  readonly provider?: string
  readonly path?: 'resolve' | 'docs'
  readonly error_kind?: (typeof PROVIDER_ERROR_KINDS)[number]
  readonly count?: number
}

export interface Context7ToolCachePath {
  readonly state: (typeof DOCUMENTATION_CACHE_PATH_STATES)[number]
  readonly evicted_entries: number
  readonly reason?: (typeof DOCUMENTATION_CACHE_SKIP_REASONS)[number]
}

export interface Context7RawEnvelope {
  readonly version: number
  readonly kind: 'docs'
  readonly cache_key: string
  readonly doc_ref: string
  readonly library_id: string
  readonly created_at_ms: number
  readonly expires_at_ms: number
  readonly max_results: number
  readonly response_bytes: number
  readonly total_items: number
  readonly returned_items: number
  readonly truncated: boolean
  readonly snippets: Context7ToolSnippet[]
}

interface Context7OutputBounds {
  readonly canonical_output_truncated: boolean
  readonly model_text_truncated: boolean
  readonly model_text_max_bytes: number
  readonly evidence_level: 'discovery'
}

export interface Context7ResolveLibraryIdOutput extends Context7OutputBounds {
  readonly state: 'found' | 'not_found'
  readonly library_name: string
  readonly query: string
  readonly selected_library?: Context7ToolLibrary
  readonly candidates: Context7ToolLibrary[]
  readonly cache: Context7ToolCachePath
  readonly attempts: Context7ToolAttempt[]
  readonly warnings: Context7ToolWarning[]
  readonly total_candidates: number
  readonly returned_candidates: number
  readonly response_bytes: number
  readonly cache_entry_truncated: boolean
}

export interface Context7QueryDocsOutput extends Context7OutputBounds {
  readonly state: 'found' | 'not_found'
  readonly library_id: string
  readonly query: string
  readonly raw: boolean
  readonly snippets: Context7ToolSnippet[]
  readonly raw_envelope?: Context7RawEnvelope
  readonly doc_ref: string
  readonly cache: Context7ToolCachePath
  readonly attempts: Context7ToolAttempt[]
  readonly warnings: Context7ToolWarning[]
  readonly total_snippets: number
  readonly returned_snippets: number
  readonly response_bytes: number
  readonly cache_entry_truncated: boolean
}

export interface Context7GetLibraryDocsOutput extends Context7OutputBounds {
  readonly state: 'found' | 'not_found'
  readonly query: string
  readonly library_name?: string
  readonly library_id?: string
  readonly selected_library?: Context7ToolLibrary
  readonly raw: boolean
  readonly snippets: Context7ToolSnippet[]
  readonly raw_envelope?: Context7RawEnvelope
  readonly doc_ref?: string
  readonly cache: {
    readonly resolve: Context7ToolCachePath
    readonly docs: Context7ToolCachePath
  }
  readonly attempts: Context7ToolAttempt[]
  readonly warnings: Context7ToolWarning[]
  readonly resolve_total_candidates: number
  readonly resolve_returned_candidates: number
  readonly total_snippets: number
  readonly returned_snippets: number
  readonly response_bytes: number
  readonly resolve_cache_entry_truncated: boolean
  readonly docs_cache_entry_truncated: boolean
}

export interface Context7GetCachedDocRawOutput extends Context7OutputBounds {
  readonly state: 'found' | 'not_found'
  readonly code?: 'CONTEXT7_CACHE_NOT_FOUND'
  readonly lookup: 'doc_ref' | 'query'
  readonly cache: 'hit' | 'miss'
  readonly requested_doc_ref?: string
  readonly query?: string
  readonly library_id?: string
  readonly doc_ref?: string
  readonly raw_envelope?: Context7RawEnvelope
  readonly scan_limit: number
  readonly scanned_records: number
  readonly matched_records: number
  readonly warnings: Context7ToolWarning[]
}

const LIBRARY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    trust_score: { type: 'number' },
    benchmark_score: { type: 'number' },
    total_snippets: { type: 'number' },
    stars: { type: 'number' },
    versions: { type: 'array', items: { type: 'string' }, required: true },
    versions_truncated: { type: 'boolean', required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const SNIPPET_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', required: true },
    title: { type: 'string' },
    library_id: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const ATTEMPT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string', required: true },
    outcome: { type: 'string', enum: PROVIDER_ATTEMPT_OUTCOMES, required: true },
    count: { type: 'integer', required: true },
    duration_ms: { type: 'integer', required: true },
    fallback: { type: 'boolean', required: true },
    error_kind: { type: 'string', enum: PROVIDER_ERROR_KINDS },
    retryable: { type: 'boolean' },
    http_status: { type: 'integer' },
    skip_reason: { type: 'string', enum: PROVIDER_SKIP_REASONS },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const WARNING_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: CONTEXT7_TOOL_WARNING_CODES, required: true },
    provider: { type: 'string' },
    path: { type: 'string', enum: ['resolve', 'docs'] },
    error_kind: { type: 'string', enum: PROVIDER_ERROR_KINDS },
    count: { type: 'integer' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const CACHE_PATH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: DOCUMENTATION_CACHE_PATH_STATES, required: true },
    evicted_entries: { type: 'integer', required: true },
    reason: { type: 'string', enum: DOCUMENTATION_CACHE_SKIP_REASONS },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const RAW_ENVELOPE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'integer', required: true },
    kind: { type: 'string', const: 'docs', required: true },
    cache_key: { type: 'string', required: true },
    doc_ref: { type: 'string', required: true },
    library_id: { type: 'string', required: true },
    created_at_ms: { type: 'integer', required: true },
    expires_at_ms: { type: 'integer', required: true },
    max_results: { type: 'integer', required: true },
    response_bytes: { type: 'integer', required: true },
    total_items: { type: 'integer', required: true },
    returned_items: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    snippets: { type: 'array', items: SNIPPET_OUTPUT_SCHEMA, required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const COMMON_BOUND_PROPERTIES = {
  canonical_output_truncated: { type: 'boolean', required: true },
  model_text_truncated: { type: 'boolean', required: true },
  model_text_max_bytes: { type: 'integer', required: true },
  evidence_level: { type: 'string', const: 'discovery', required: true },
} as const

export const CONTEXT7_RESOLVE_LIBRARY_ID_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['found', 'not_found'], required: true },
    library_name: { type: 'string', required: true },
    query: { type: 'string', required: true },
    selected_library: LIBRARY_OUTPUT_SCHEMA,
    candidates: { type: 'array', items: LIBRARY_OUTPUT_SCHEMA, required: true },
    cache: { ...CACHE_PATH_OUTPUT_SCHEMA, required: true },
    attempts: { type: 'array', items: ATTEMPT_OUTPUT_SCHEMA, required: true },
    warnings: { type: 'array', items: WARNING_OUTPUT_SCHEMA, required: true },
    total_candidates: { type: 'integer', required: true },
    returned_candidates: { type: 'integer', required: true },
    response_bytes: { type: 'integer', required: true },
    cache_entry_truncated: { type: 'boolean', required: true },
    ...COMMON_BOUND_PROPERTIES,
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export const CONTEXT7_QUERY_DOCS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['found', 'not_found'], required: true },
    library_id: { type: 'string', required: true },
    query: { type: 'string', required: true },
    raw: { type: 'boolean', required: true },
    snippets: { type: 'array', items: SNIPPET_OUTPUT_SCHEMA, required: true },
    raw_envelope: RAW_ENVELOPE_OUTPUT_SCHEMA,
    doc_ref: { type: 'string', required: true },
    cache: { ...CACHE_PATH_OUTPUT_SCHEMA, required: true },
    attempts: { type: 'array', items: ATTEMPT_OUTPUT_SCHEMA, required: true },
    warnings: { type: 'array', items: WARNING_OUTPUT_SCHEMA, required: true },
    total_snippets: { type: 'integer', required: true },
    returned_snippets: { type: 'integer', required: true },
    response_bytes: { type: 'integer', required: true },
    cache_entry_truncated: { type: 'boolean', required: true },
    ...COMMON_BOUND_PROPERTIES,
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export const CONTEXT7_GET_LIBRARY_DOCS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['found', 'not_found'], required: true },
    query: { type: 'string', required: true },
    library_name: { type: 'string' },
    library_id: { type: 'string' },
    selected_library: LIBRARY_OUTPUT_SCHEMA,
    raw: { type: 'boolean', required: true },
    snippets: { type: 'array', items: SNIPPET_OUTPUT_SCHEMA, required: true },
    raw_envelope: RAW_ENVELOPE_OUTPUT_SCHEMA,
    doc_ref: { type: 'string' },
    cache: {
      type: 'object',
      properties: {
        resolve: { ...CACHE_PATH_OUTPUT_SCHEMA, required: true },
        docs: { ...CACHE_PATH_OUTPUT_SCHEMA, required: true },
      },
      additionalProperties: false,
      required: true,
    },
    attempts: { type: 'array', items: ATTEMPT_OUTPUT_SCHEMA, required: true },
    warnings: { type: 'array', items: WARNING_OUTPUT_SCHEMA, required: true },
    resolve_total_candidates: { type: 'integer', required: true },
    resolve_returned_candidates: { type: 'integer', required: true },
    total_snippets: { type: 'integer', required: true },
    returned_snippets: { type: 'integer', required: true },
    response_bytes: { type: 'integer', required: true },
    resolve_cache_entry_truncated: { type: 'boolean', required: true },
    docs_cache_entry_truncated: { type: 'boolean', required: true },
    ...COMMON_BOUND_PROPERTIES,
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export const CONTEXT7_GET_CACHED_DOC_RAW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['found', 'not_found'], required: true },
    code: { type: 'string', const: 'CONTEXT7_CACHE_NOT_FOUND' },
    lookup: { type: 'string', enum: ['doc_ref', 'query'], required: true },
    cache: { type: 'string', enum: ['hit', 'miss'], required: true },
    requested_doc_ref: { type: 'string' },
    query: { type: 'string' },
    library_id: { type: 'string' },
    doc_ref: { type: 'string' },
    raw_envelope: RAW_ENVELOPE_OUTPUT_SCHEMA,
    scan_limit: { type: 'integer', required: true },
    scanned_records: { type: 'integer', required: true },
    matched_records: { type: 'integer', required: true },
    warnings: { type: 'array', items: WARNING_OUTPUT_SCHEMA, required: true },
    ...COMMON_BOUND_PROPERTIES,
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export interface Context7ToolsDependencies {
  /** Read and snapshot the current resolved Settings value once per operation. */
  readonly getConfig: () => Config
  readonly documentation: Pick<
    DocumentationSearchService,
    'resolveContext7' | 'queryContext7Docs' | 'lookupDoc' | 'findContext7Doc'
  >
  readonly operations: ForegroundOperationScope
}

function onlyDeclaredArguments(args: object, allowed: readonly string[]): void {
  const names = new Set(allowed)
  const unexpected = Object.keys(args).filter(key => !names.has(key))
  if (unexpected.length > 0) {
    throw new ToolArgsError(unexpected.map(key => `"${key}" is not allowed`))
  }
}

function nonEmptyText(value: string, label: string, maximumCharacters: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || Array.from(normalized).length > maximumCharacters) {
    throw new ToolArgsError([
      `"${label}" must be non-empty and contain at most ${maximumCharacters} Unicode characters`,
    ])
  }
  return normalized
}

function resultLimit(value: number | undefined, fallback: number, label: string): number {
  const applied = value ?? fallback
  if (!Number.isSafeInteger(applied) || applied < 1 || applied > CONTEXT7_TOOL_MAX_RESULTS) {
    throw new ToolArgsError([`"${label}" must be an integer from 1 through 20`])
  }
  return applied
}

function libraryId(value: string, label = 'library_id'): string {
  if (!isContext7LibraryId(value)) {
    throw new ToolArgsError([`"${label}" must be an exact /org/project or /org/project/version Context7 id`])
  }
  return value.trim()
}

function docRef(value: string): string {
  if (!isContext7DocRef(value)) {
    throw new ToolArgsError(['"doc_ref" must be an exact ctx7d_ reference'])
  }
  return value
}

function projectLibrary(value: Readonly<Context7Library>): Context7ToolLibrary {
  const allVersions = value.versions ?? []
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.trustScore === undefined ? {} : { trust_score: value.trustScore }),
    ...(value.benchmarkScore === undefined ? {} : { benchmark_score: value.benchmarkScore }),
    ...(value.totalSnippets === undefined ? {} : { total_snippets: value.totalSnippets }),
    ...(value.stars === undefined ? {} : { stars: value.stars }),
    versions: [...allVersions.slice(0, CONTEXT7_TOOL_MAX_VERSIONS)],
    versions_truncated: allVersions.length > CONTEXT7_TOOL_MAX_VERSIONS,
  }
}

function projectSnippet(
  value: Readonly<DocumentationSnippet>,
  fallbackLibraryId?: string,
): Context7ToolSnippet {
  const selectedLibraryId = value.libraryId ?? fallbackLibraryId
  return {
    content: value.content,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(selectedLibraryId === undefined ? {} : { library_id: selectedLibraryId }),
  }
}

function projectAttempt(value: Readonly<ProviderAttemptRecord>): Context7ToolAttempt {
  return {
    provider: value.provider,
    outcome: value.outcome,
    count: value.attempts,
    duration_ms: value.durationMs,
    fallback: value.participatedInFallback,
    ...(value.errorKind === undefined ? {} : { error_kind: value.errorKind }),
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
    ...(value.httpStatus === undefined ? {} : { http_status: value.httpStatus }),
    ...(value.skipReason === undefined ? {} : { skip_reason: value.skipReason }),
  }
}

function projectWarning(value: Readonly<DocumentationWarning>): Context7ToolWarning {
  return {
    code: value.code,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.errorKind === undefined ? {} : { error_kind: value.errorKind }),
    ...(value.count === undefined ? {} : { count: value.count }),
  }
}

function projectCachePath(value: Readonly<DocumentationCachePath>): Context7ToolCachePath {
  return {
    state: value.state,
    evicted_entries: value.evictedEntries,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
}

function skippedCachePath(
  reason: NonNullable<Context7ToolCachePath['reason']>,
): Context7ToolCachePath {
  return { state: 'skipped', evicted_entries: 0, reason }
}

function withWarning(
  warnings: readonly Context7ToolWarning[],
  code: Context7ToolWarningCode,
): Context7ToolWarning[] {
  return warnings.some(item => item.code === code)
    ? [...warnings]
    : [...warnings, { code }]
}

/** Strictly revalidate the cache-domain value before any raw projection. */
export function projectContext7RawEnvelope(
  value: Readonly<Context7DocsCacheEntry>,
): Context7RawEnvelope {
  const parsed = Context7DocsCacheEntrySchema.safeParse(value)
  if (!parsed.success) {
    throw new Context7CacheError('CONTEXT7_CACHE_CORRUPT', { cause: parsed.error })
  }
  return {
    version: parsed.data.version,
    kind: 'docs',
    cache_key: String(parsed.data.cacheKey),
    doc_ref: String(parsed.data.docRef),
    library_id: parsed.data.libraryId,
    created_at_ms: parsed.data.createdAtMs,
    expires_at_ms: parsed.data.expiresAtMs,
    max_results: parsed.data.maxResults,
    response_bytes: parsed.data.responseBytes,
    total_items: parsed.data.totalItems,
    returned_items: parsed.data.snippets.length,
    truncated: parsed.data.truncated,
    snippets: parsed.data.snippets.map(snippet => projectSnippet(snippet)),
  }
}

function canonicalFailure(error: unknown): never {
  if (!(error instanceof OutputLimitError)) throw error
  throw new ProviderError({
    capability: 'docs_search',
    kind: 'budget_exceeded',
    provider: 'context7-consumer',
  })
}

function boundPrimaryItems<T, O>(
  items: readonly T[],
  maximumBytes: number,
  project: (retained: readonly T[], truncated: boolean) => O,
): O {
  try {
    const result = retainJsonPrefix(items, {
      label: 'Context7 canonical output',
      maxBytes: maximumBytes,
      maxItems: items.length,
      project: retained => project(retained, retained.length < items.length),
    })
    return project(result.retained, result.truncated)
  } catch (error) {
    return canonicalFailure(error)
  }
}

export function boundContext7ResolveOutput(
  value: Context7ResolveLibraryIdOutput,
  maximumBytes: number,
): Context7ResolveLibraryIdOutput {
  return boundPrimaryItems(value.candidates, maximumBytes, (candidates, truncated) => {
    const canonicalTruncated = value.canonical_output_truncated || truncated
    return {
      ...value,
      candidates: [...candidates],
      returned_candidates: candidates.length,
      canonical_output_truncated: canonicalTruncated,
      warnings: canonicalTruncated
        ? withWarning(value.warnings, 'canonical_output_truncated')
        : value.warnings.filter(item => item.code !== 'canonical_output_truncated'),
    }
  })
}

function rawEnvelopeWithSnippets(
  value: Context7RawEnvelope,
  snippets: readonly Context7ToolSnippet[],
): Context7RawEnvelope {
  return {
    ...value,
    snippets: [...snippets],
    returned_items: snippets.length,
    truncated: value.truncated || snippets.length < value.snippets.length,
  }
}

export function boundContext7QueryDocsOutput(
  value: Context7QueryDocsOutput,
  maximumBytes: number,
): Context7QueryDocsOutput {
  const primary = value.raw_envelope?.snippets ?? value.snippets
  return boundPrimaryItems(primary, maximumBytes, (snippets, truncated) => {
    const canonicalTruncated = value.canonical_output_truncated || truncated
    return {
      ...value,
      snippets: value.raw ? [] : [...snippets],
      ...(value.raw_envelope === undefined
        ? {}
        : { raw_envelope: rawEnvelopeWithSnippets(value.raw_envelope, snippets) }),
      returned_snippets: snippets.length,
      canonical_output_truncated: canonicalTruncated,
      warnings: canonicalTruncated
        ? withWarning(value.warnings, 'canonical_output_truncated')
        : value.warnings.filter(item => item.code !== 'canonical_output_truncated'),
    }
  })
}

export function boundContext7GetLibraryDocsOutput(
  value: Context7GetLibraryDocsOutput,
  maximumBytes: number,
): Context7GetLibraryDocsOutput {
  const primary = value.raw_envelope?.snippets ?? value.snippets
  return boundPrimaryItems(primary, maximumBytes, (snippets, truncated) => {
    const canonicalTruncated = value.canonical_output_truncated || truncated
    return {
      ...value,
      snippets: value.raw ? [] : [...snippets],
      ...(value.raw_envelope === undefined
        ? {}
        : { raw_envelope: rawEnvelopeWithSnippets(value.raw_envelope, snippets) }),
      returned_snippets: snippets.length,
      canonical_output_truncated: canonicalTruncated,
      warnings: canonicalTruncated
        ? withWarning(value.warnings, 'canonical_output_truncated')
        : value.warnings.filter(item => item.code !== 'canonical_output_truncated'),
    }
  })
}

export function boundContext7CachedRawOutput(
  value: Context7GetCachedDocRawOutput,
  maximumBytes: number,
): Context7GetCachedDocRawOutput {
  const primary = value.raw_envelope?.snippets ?? []
  return boundPrimaryItems(primary, maximumBytes, (snippets, truncated) => {
    const canonicalTruncated = value.canonical_output_truncated || truncated
    return {
      ...value,
      ...(value.raw_envelope === undefined
        ? {}
        : { raw_envelope: rawEnvelopeWithSnippets(value.raw_envelope, snippets) }),
      canonical_output_truncated: canonicalTruncated,
      warnings: canonicalTruncated
        ? withWarning(value.warnings, 'canonical_output_truncated')
        : value.warnings.filter(item => item.code !== 'canonical_output_truncated'),
    }
  })
}

type Context7RenderableOutput =
  | Context7ResolveLibraryIdOutput
  | Context7QueryDocsOutput
  | Context7GetLibraryDocsOutput
  | Context7GetCachedDocRawOutput

function completeContext7Text(value: Context7RenderableOutput): string {
  const { model_text_truncated: _modelTextTruncated, ...visible } = value
  void _modelTextTruncated
  return [
    JSON.stringify(visible, null, 2),
    `Model text truncated: ${value.model_text_truncated ? 'TRUE ' : 'FALSE'}`,
    'Evidence level: discovery. Context7 snippets are validated discovery metadata, not fetched page-body evidence; use web_extract for claim-level verification.',
  ].join('\n\n')
}

export function isContext7ModelTextTruncated(value: Context7RenderableOutput): boolean {
  return utf8ByteLength(completeContext7Text(value)) > value.model_text_max_bytes
}

function withModelTextFact<T extends Context7RenderableOutput>(value: T): T {
  const candidate = { ...value, model_text_truncated: false } as T
  return {
    ...candidate,
    model_text_truncated: isContext7ModelTextTruncated(candidate),
  }
}

/** Pure UTF-8-bounded Native projection shared by all four granular tools. */
export function renderContext7Text(value: Context7RenderableOutput): string {
  const complete = completeContext7Text(value)
  if (utf8ByteLength(complete) <= value.model_text_max_bytes) return complete
  const marker = '[Context7 model text truncated by model_text_max_bytes.]'
  const suffix = `\n\n${marker}`
  if (utf8ByteLength(suffix) <= value.model_text_max_bytes) {
    return `${truncateUtf8(complete, value.model_text_max_bytes - utf8ByteLength(suffix)).text}${suffix}`
  }
  return truncateUtf8(marker, value.model_text_max_bytes).text
}

function resolveOutput(
  result: Readonly<Context7ResolveResult>,
  config: Config,
): Context7ResolveLibraryIdOutput {
  const selected = result.selectedLibrary === undefined
    ? undefined
    : projectLibrary(result.selectedLibrary)
  const warnings = result.warnings.map(projectWarning)
  if (selected === undefined) warnings.push({ code: 'no_results' })
  return withModelTextFact(boundContext7ResolveOutput({
    state: selected === undefined ? 'not_found' : 'found',
    library_name: result.libraryName,
    query: result.query,
    ...(selected === undefined ? {} : { selected_library: selected }),
    candidates: result.candidates.map(projectLibrary),
    cache: projectCachePath(result.cache),
    attempts: result.attempts.map(projectAttempt),
    warnings,
    total_candidates: result.totalCandidates,
    returned_candidates: result.returnedCandidates,
    response_bytes: result.responseBytes,
    cache_entry_truncated: result.truncated,
    canonical_output_truncated: false,
    model_text_truncated: false,
    model_text_max_bytes: config.budgets.coding_docs.compact.maxModelTextBytes,
    evidence_level: 'discovery',
  }, config.retention.canonicalOutputMaxBytes))
}

function docsOutput(
  result: Readonly<Context7DocsResult>,
  raw: boolean,
  config: Config,
): Context7QueryDocsOutput {
  const snippets = result.entry.snippets.map(snippet => projectSnippet(snippet, result.libraryId))
  const warnings = result.warnings.map(projectWarning)
  if (result.entry.totalItems === 0) warnings.push({ code: 'no_results' })
  return withModelTextFact(boundContext7QueryDocsOutput({
    state: result.entry.totalItems === 0 ? 'not_found' : 'found',
    library_id: result.libraryId,
    query: result.query,
    raw,
    snippets: raw ? [] : snippets,
    ...(raw ? { raw_envelope: projectContext7RawEnvelope(result.entry) } : {}),
    doc_ref: String(result.entry.docRef),
    cache: projectCachePath(result.cache),
    attempts: result.attempts.map(projectAttempt),
    warnings,
    total_snippets: result.entry.totalItems,
    returned_snippets: snippets.length,
    response_bytes: result.entry.responseBytes,
    cache_entry_truncated: result.entry.truncated,
    canonical_output_truncated: false,
    model_text_truncated: false,
    model_text_max_bytes: config.budgets.coding_docs.compact.maxModelTextBytes,
    evidence_level: 'discovery',
  }, config.retention.canonicalOutputMaxBytes))
}

async function executeResolve(
  args: Context7ResolveLibraryIdArgs,
  dependencies: Context7ToolsDependencies,
  signal: AbortSignal,
): Promise<Context7ResolveLibraryIdOutput> {
  onlyDeclaredArguments(args, ['library_name', 'query', 'max_results', 'force_refresh'])
  const config = dependencies.getConfig()
  const name = nonEmptyText(
    args.library_name,
    'library_name',
    config.retention.searchQueryMaxCharacters,
  )
  const query = args.query === undefined
    ? undefined
    : nonEmptyText(args.query, 'query', config.retention.searchQueryMaxCharacters)
  const result = await dependencies.documentation.resolveContext7({
    libraryName: name,
    ...(query === undefined ? {} : { query }),
    maxResults: resultLimit(
      args.max_results,
      CONTEXT7_RESOLVE_DEFAULT_MAX_RESULTS,
      'max_results',
    ),
    forceRefresh: args.force_refresh ?? false,
    config,
    signal,
  })
  throwIfAborted(signal)
  return resolveOutput(result, config)
}

async function executeQueryDocs(
  args: Context7QueryDocsArgs,
  dependencies: Context7ToolsDependencies,
  signal: AbortSignal,
): Promise<Context7QueryDocsOutput> {
  onlyDeclaredArguments(args, ['library_id', 'query', 'max_snippets', 'raw', 'force_refresh'])
  const config = dependencies.getConfig()
  const result = await dependencies.documentation.queryContext7Docs({
    libraryId: libraryId(args.library_id),
    query: nonEmptyText(args.query, 'query', config.retention.searchQueryMaxCharacters),
    maxResults: resultLimit(
      args.max_snippets,
      CONTEXT7_QUERY_DEFAULT_MAX_SNIPPETS,
      'max_snippets',
    ),
    forceRefresh: args.force_refresh ?? false,
    config,
    signal,
  })
  throwIfAborted(signal)
  return docsOutput(result, args.raw ?? false, config)
}

async function executeGetLibraryDocs(
  args: Context7GetLibraryDocsArgs,
  dependencies: Context7ToolsDependencies,
  signal: AbortSignal,
): Promise<Context7GetLibraryDocsOutput> {
  onlyDeclaredArguments(args, [
    'query',
    'library_name',
    'library_id',
    'max_results',
    'max_snippets',
    'raw',
    'force_refresh',
  ])
  const config = dependencies.getConfig()
  const query = nonEmptyText(args.query, 'query', config.retention.searchQueryMaxCharacters)
  const name = args.library_name === undefined
    ? undefined
    : nonEmptyText(
        args.library_name,
        'library_name',
        config.retention.searchQueryMaxCharacters,
      )
  const exactId = args.library_id === undefined ? undefined : libraryId(args.library_id)
  if (name === undefined && exactId === undefined) {
    throw new ToolArgsError(['at least one of "library_name" or "library_id" is required'])
  }
  const forceRefresh = args.force_refresh ?? false
  const raw = args.raw ?? false
  const maxResults = resultLimit(
    args.max_results,
    CONTEXT7_RESOLVE_DEFAULT_MAX_RESULTS,
    'max_results',
  )
  const maxSnippets = resultLimit(
    args.max_snippets,
    CONTEXT7_GET_DOCS_DEFAULT_MAX_SNIPPETS,
    'max_snippets',
  )

  let resolve: Readonly<Context7ResolveResult> | undefined
  let selected: Context7ToolLibrary | undefined
  let selectedId = exactId
  if (exactId === undefined && name !== undefined) {
    resolve = await dependencies.documentation.resolveContext7({
      libraryName: name,
      query,
      maxResults,
      forceRefresh,
      config,
      signal,
    })
    selectedId = resolve.selectedLibrary?.id === undefined
      ? undefined
      : libraryId(resolve.selectedLibrary.id, 'selected_library.id')
    selected = resolve.selectedLibrary === undefined
      ? undefined
      : projectLibrary(resolve.selectedLibrary)
  } else if (exactId !== undefined) {
    selected = projectLibrary({ id: exactId })
  }
  throwIfAborted(signal)

  const resolveCache = resolve === undefined
    ? skippedCachePath('known_library_id')
    : projectCachePath(resolve.cache)
  const baseWarnings = resolve?.warnings.map(projectWarning) ?? []
  const baseAttempts = resolve?.attempts.map(projectAttempt) ?? []
  if (selectedId === undefined) {
    const value: Context7GetLibraryDocsOutput = {
      state: 'not_found',
      query,
      ...(name === undefined ? {} : { library_name: name }),
      raw,
      snippets: [],
      cache: {
        resolve: resolveCache,
        docs: skippedCachePath('library_not_found'),
      },
      attempts: baseAttempts,
      warnings: withWarning(baseWarnings, 'no_results'),
      resolve_total_candidates: resolve?.totalCandidates ?? 0,
      resolve_returned_candidates: resolve?.returnedCandidates ?? 0,
      total_snippets: 0,
      returned_snippets: 0,
      response_bytes: resolve?.responseBytes ?? 0,
      resolve_cache_entry_truncated: resolve?.truncated ?? false,
      docs_cache_entry_truncated: false,
      canonical_output_truncated: false,
      model_text_truncated: false,
      model_text_max_bytes: config.budgets.coding_docs.compact.maxModelTextBytes,
      evidence_level: 'discovery',
    }
    return withModelTextFact(boundContext7GetLibraryDocsOutput(
      value,
      config.retention.canonicalOutputMaxBytes,
    ))
  }

  const docs = await dependencies.documentation.queryContext7Docs({
    libraryId: selectedId,
    query,
    maxResults: maxSnippets,
    forceRefresh,
    config,
    signal,
  })
  throwIfAborted(signal)
  const snippets = docs.entry.snippets.map(snippet => projectSnippet(snippet, selectedId))
  const warnings = [...baseWarnings, ...docs.warnings.map(projectWarning)]
  if (docs.entry.totalItems === 0) warnings.push({ code: 'no_results' })
  return withModelTextFact(boundContext7GetLibraryDocsOutput({
    state: docs.entry.totalItems === 0 ? 'not_found' : 'found',
    query,
    ...(name === undefined ? {} : { library_name: name }),
    library_id: selectedId,
    ...(selected === undefined ? {} : { selected_library: selected }),
    raw,
    snippets: raw ? [] : snippets,
    ...(raw ? { raw_envelope: projectContext7RawEnvelope(docs.entry) } : {}),
    doc_ref: String(docs.entry.docRef),
    cache: {
      resolve: resolveCache,
      docs: projectCachePath(docs.cache),
    },
    attempts: [...baseAttempts, ...docs.attempts.map(projectAttempt)],
    warnings,
    resolve_total_candidates: resolve?.totalCandidates ?? 0,
    resolve_returned_candidates: resolve?.returnedCandidates ?? 0,
    total_snippets: docs.entry.totalItems,
    returned_snippets: snippets.length,
    response_bytes: (resolve?.responseBytes ?? 0) + docs.entry.responseBytes,
    resolve_cache_entry_truncated: resolve?.truncated ?? false,
    docs_cache_entry_truncated: docs.entry.truncated,
    canonical_output_truncated: false,
    model_text_truncated: false,
    model_text_max_bytes: config.budgets.coding_docs.compact.maxModelTextBytes,
    evidence_level: 'discovery',
  }, config.retention.canonicalOutputMaxBytes))
}

async function executeCachedRaw(
  args: Context7GetCachedDocRawArgs,
  dependencies: Context7ToolsDependencies,
  signal: AbortSignal,
): Promise<Context7GetCachedDocRawOutput> {
  onlyDeclaredArguments(args, ['doc_ref', 'query', 'library_id'])
  const config = dependencies.getConfig()
  if (args.doc_ref === undefined && args.query === undefined) {
    throw new ToolArgsError(['at least one of "doc_ref" or "query" is required'])
  }
  const requestedRef = args.doc_ref === undefined ? undefined : docRef(args.doc_ref)
  const query = args.query === undefined
    ? undefined
    : nonEmptyText(args.query, 'query', config.retention.searchQueryMaxCharacters)
  const filterId = args.library_id === undefined ? undefined : libraryId(args.library_id)
  throwIfAborted(signal)

  let entry: Readonly<Context7DocsCacheEntry> | undefined
  let scannedRecords = 0
  let matchedRecords = 0
  if (requestedRef !== undefined) {
    const lookup = await dependencies.documentation.lookupDoc(requestedRef, signal)
    if (lookup.state === 'found' && (filterId === undefined || lookup.entry.libraryId === filterId)) {
      entry = lookup.entry
      matchedRecords = 1
    }
  } else if (query !== undefined) {
    const match = await dependencies.documentation.findContext7Doc({
      query,
      ...(filterId === undefined ? {} : { libraryId: filterId }),
      maxScanRecords: CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS,
      config,
      signal,
    })
    scannedRecords = match.scannedRecords
    matchedRecords = match.matchedRecords
    if (match.state === 'found') entry = match.entry
  }
  throwIfAborted(signal)

  const common = {
    lookup: requestedRef === undefined ? 'query' as const : 'doc_ref' as const,
    ...(requestedRef === undefined ? {} : { requested_doc_ref: requestedRef }),
    ...(query === undefined ? {} : { query }),
    ...(filterId === undefined ? {} : { library_id: filterId }),
    scan_limit: CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS,
    scanned_records: scannedRecords,
    matched_records: matchedRecords,
    canonical_output_truncated: false,
    model_text_truncated: false,
    model_text_max_bytes: config.budgets.coding_docs.compact.maxModelTextBytes,
    evidence_level: 'discovery' as const,
  }
  const value: Context7GetCachedDocRawOutput = entry === undefined
    ? {
        ...common,
        state: 'not_found',
        code: 'CONTEXT7_CACHE_NOT_FOUND',
        cache: 'miss',
        warnings: [{ code: 'no_results' }],
      }
    : {
        ...common,
        state: 'found',
        cache: 'hit',
        library_id: entry.libraryId,
        doc_ref: String(entry.docRef),
        raw_envelope: projectContext7RawEnvelope(entry),
        warnings: [],
      }
  return withModelTextFact(boundContext7CachedRawOutput(
    value,
    config.retention.canonicalOutputMaxBytes,
  ))
}

const CONTEXT7_CARD_TYPES = Object.freeze([
  'context7_resolve_library_id',
  'context7_query_docs',
  'context7_get_library_docs',
  'context7_get_cached_doc_raw',
] as const)

type Context7CardType = (typeof CONTEXT7_CARD_TYPES)[number]

interface Context7CardMeta {
  readonly version: 1
  readonly type: Context7CardType
  readonly state: 'found' | 'not_found'
  readonly returned: number
  readonly canonical_output_truncated: boolean
  readonly model_text_truncated: boolean
}

function cardMeta(
  type: Context7CardType,
  value: Context7RenderableOutput,
  returned: number,
): JsonValue {
  return {
    version: 1,
    type,
    state: value.state,
    returned,
    canonical_output_truncated: value.canonical_output_truncated,
    model_text_truncated: value.model_text_truncated,
  }
}

function parseCardMeta(value: unknown): Context7CardMeta | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const meta = value as Record<string, unknown>
  if (meta.version !== 1) return undefined
  if (
    typeof meta.type !== 'string'
    || !CONTEXT7_CARD_TYPES.includes(meta.type as Context7CardType)
  ) return undefined
  if (meta.state !== 'found' && meta.state !== 'not_found') return undefined
  if (!Number.isSafeInteger(meta.returned) || (meta.returned as number) < 0) return undefined
  if (typeof meta.canonical_output_truncated !== 'boolean') return undefined
  if (typeof meta.model_text_truncated !== 'boolean') return undefined
  return {
    version: 1,
    type: meta.type as Context7CardType,
    state: meta.state,
    returned: meta.returned as number,
    canonical_output_truncated: meta.canonical_output_truncated,
    model_text_truncated: meta.model_text_truncated,
  }
}

function presentContext7Result(result: ToolResult): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Context7 operation failed' }
  const meta = parseCardMeta(result.meta)
  if (meta === undefined) return undefined
  const label = meta.type === 'context7_resolve_library_id'
    ? 'Context7 library resolution'
    : meta.type === 'context7_get_cached_doc_raw'
      ? 'Context7 cached document'
      : 'Context7 documentation lookup'
  return {
    card: 'generic',
    title: meta.state === 'found'
      ? `${label} (${meta.returned} returned)`
      : `${label} (not found)`,
  }
}

function closeDefinition(
  definition: ToolDefinition,
  parameters: ToolDefinition['parameters'],
): ToolDefinition {
  return Object.freeze({ ...definition, parameters })
}

/** Build the four internal definitions hidden behind the context7 capability group. */
export function createContext7Tools(
  dependencies: Context7ToolsDependencies,
): readonly ToolDefinition[] {
  const resolve = defineTool({
    name: 'context7_resolve_library_id',
    description: 'Resolve a package/product name to an exact Context7 library id. Skip this tool when /org/project[/version] is already known. Returns bounded safe candidates and cache/Provider facts; discovery only.',
    parameters: CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETER_SPEC,
    output: {
      schema: CONTEXT7_RESOLVE_LIBRARY_ID_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderContext7Text(value) }],
      presentationMeta: (_args, value) => cardMeta(
        'context7_resolve_library_id',
        value,
        value.returned_candidates,
      ),
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeResolve(args, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      kind: 'search',
      title: `Resolve Context7 library: ${args.library_name}`,
    }),
    presentResult: (_args, result) => presentContext7Result(result),
  })

  const query = defineTool({
    name: 'context7_query_docs',
    description: 'Query documentation for an exact Context7 /org/project[/version] id. raw=false returns structured snippets; raw=true returns only a validated bounded cache envelope, never a Provider body, path, endpoint, or credential. Discovery only; verify claims with web_extract.',
    parameters: CONTEXT7_QUERY_DOCS_PARAMETER_SPEC,
    output: {
      schema: CONTEXT7_QUERY_DOCS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderContext7Text(value) }],
      presentationMeta: (_args, value) => cardMeta(
        'context7_query_docs',
        value,
        value.returned_snippets,
      ),
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeQueryDocs(args, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      kind: 'search',
      title: `Query Context7 docs: ${args.library_id}`,
    }),
    presentResult: (_args, result) => presentContext7Result(result),
  })

  const getDocs = defineTool({
    name: 'context7_get_library_docs',
    description: 'Resolve a library name when needed, then query Context7 through the same persistent TTL cache and Provider client. An exact library_id strictly skips resolve. raw is a validated cache envelope; all results are discovery evidence.',
    parameters: CONTEXT7_GET_LIBRARY_DOCS_PARAMETER_SPEC,
    output: {
      schema: CONTEXT7_GET_LIBRARY_DOCS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderContext7Text(value) }],
      presentationMeta: (_args, value) => cardMeta(
        'context7_get_library_docs',
        value,
        value.returned_snippets,
      ),
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeGetLibraryDocs(args, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      kind: 'search',
      title: `Get Context7 docs: ${args.library_id ?? args.library_name ?? args.query}`,
    }),
    presentResult: (_args, result) => presentContext7Result(result),
  })

  const cachedRaw = defineTool({
    name: 'context7_get_cached_doc_raw',
    description: 'Read this plugin\'s validated Context7 docs cache by exact doc_ref, or deterministically match at most 500 ordered records by query with an optional exact library_id filter. It performs no network request and never exposes storage paths, endpoints, credentials, raw errors, or unparsed bodies.',
    parameters: CONTEXT7_GET_CACHED_DOC_RAW_PARAMETER_SPEC,
    output: {
      schema: CONTEXT7_GET_CACHED_DOC_RAW_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderContext7Text(value) }],
      presentationMeta: (_args, value) => cardMeta(
        'context7_get_cached_doc_raw',
        value,
        value.state === 'found' ? 1 : 0,
      ),
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeCachedRaw(args, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      kind: 'search',
      title: args.doc_ref === undefined
        ? `Match Context7 cache: ${args.query ?? ''}`
        : `Read Context7 cache: ${args.doc_ref}`,
    }),
    presentResult: (_args, result) => presentContext7Result(result),
  })

  return Object.freeze([
    closeDefinition(resolve, CONTEXT7_RESOLVE_LIBRARY_ID_PARAMETERS),
    closeDefinition(query, CONTEXT7_QUERY_DOCS_PARAMETERS),
    closeDefinition(getDocs, CONTEXT7_GET_LIBRARY_DOCS_PARAMETERS),
    closeDefinition(cachedRaw, CONTEXT7_GET_CACHED_DOC_RAW_PARAMETERS),
  ])
}

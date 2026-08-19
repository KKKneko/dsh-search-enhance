import { truncateUtf8, utf8ByteLength } from '../provider-runtime/index.js'
import type {
  DocsSearchOutput,
  DocsSearchWarning,
  WebSearchOutput,
  WebSearchWarning,
  SearchDiagnosticsOutput,
  SearchDiagnosticsWarning,
  SearchSourcesFound,
  SearchSourcesOutput,
  WebExtractOutput,
  WebExtractOutputAttempt,
  WebMapOutput,
  WebMapWarning,
} from '../tools/schemas.js'

const DISCOVERY_NOTICE = 'Evidence level: discovery. Snippets are discovery metadata, not verified page-body evidence.'

function inline(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function sourceDisplayLabel(source: { readonly title?: string; readonly url: string }): string {
  if (source.title !== undefined && source.title.trim().length > 0) return source.title
  return new URL(source.url).hostname
}
function renderWithBoundedNotice(
  text: string,
  notice: string | undefined,
  maximumBytes: number,
  fallbackNotice?: string,
): string {
  if (notice === undefined || notice.length === 0) {
    return truncateUtf8(text, maximumBytes).text
  }
  const separator = '\n\n'
  const complete = `${text}${separator}${notice}`
  if (utf8ByteLength(complete) <= maximumBytes) return complete
  const noticeBytes = utf8ByteLength(notice)
  if (noticeBytes > maximumBytes) {
    // Never expose a partial JSON capability manifest. A short plain-text
    // fallback can still point the model at the durable source reference.
    return truncateUtf8(fallbackNotice ?? notice, maximumBytes).text
  }
  const prefixBudget = maximumBytes - noticeBytes - utf8ByteLength(separator)
  if (prefixBudget <= 0) return notice
  const prefix = truncateUtf8(text, prefixBudget).text
  return prefix.length === 0 ? notice : `${prefix}${separator}${notice}`
}

function sourceDisclosureTail(
  sourceRef: string | undefined,
  operationNotice: string | undefined,
): string | undefined {
  if (sourceRef === undefined) return undefined
  return [
    `Source reference: ${sourceRef}`,
    operationNotice,
  ].filter((line): line is string => line !== undefined && line.length > 0).join('\n\n')
}

function sourceDisclosureFallback(sourceRef: string): string {
  return `Source reference: ${sourceRef}\n\nCall search_tools({ capabilities: ["sources"] }) to retrieve the search_sources manifest.`
}

function warningText(warning: WebSearchWarning): string {
  const subject = [warning.provider, warning.capability].filter(Boolean).join('/')
  const suffix = [subject, warning.error_kind].filter(Boolean).join(', ')
  const detail = suffix.length === 0 ? '' : ` (${suffix})`
  switch (warning.code) {
    case 'main_search_failed':
      return `Main search failed; only supplemental discovery sources are available${detail}.`
    case 'provider_failed':
      return `A supplemental Provider failed${detail}.`
    case 'provider_result_truncated':
      return `A Provider bounded its discovery result${detail}.`
    case 'cache_stale':
      return `Expired Context7 cache data was used after a temporary Provider failure${detail}.`
    case 'cache_evicted':
      return `The bounded Context7 cache evicted an older entry${detail}.`
    case 'answer_truncated':
      return 'The generated answer was truncated.'
    case 'sources_truncated':
      return 'The source collection or retained source record was truncated.'
    case 'canonical_output_truncated':
      return 'The canonical search value was truncated to its configured limit.'
    case 'no_results':
      return 'The search completed but found no matching result.'
  }
}

function answerSection(value: WebSearchOutput): string {
  if (value.state === 'partial') {
    return `Partial search result\n\n${value.answer ?? 'The main search failed; only supplemental discovery sources are available.'}`
  }
  if (value.answer !== undefined && value.answer.length > 0) return value.answer
  if (value.sources.length === 0) return 'Search completed with no matching results.'
  return 'Search completed without a generated answer.'
}

function sourceSection(value: WebSearchOutput): string | undefined {
  if (value.sources.length === 0) return undefined
  const lines = ['Top sources']
  for (let index = 0; index < value.sources.length; index += 1) {
    const source = value.sources[index]
    if (source === undefined) continue
    lines.push(`${index + 1}. ${inline(sourceDisplayLabel(source))}`)
    lines.push(`   URL: ${source.url}`)
    if (source.publishedAt !== undefined) {
      lines.push(`   Date: ${inline(source.publishedAt)}`)
    }
    if (source.snippet !== undefined) {
      lines.push(`   Snippet: ${inline(source.snippet)}`)
    }
  }
  return lines.join('\n')
}

function sourceSummary(value: WebSearchOutput): string {
  return `Sources shown: ${value.returned_sources}/${value.total_sources}`
}

function limitationsSection(value: WebSearchOutput): string | undefined {
  const lines: string[] = []
  if (value.truncated) {
    lines.push('The answer, visible sources, Provider collection, or retained source record was bounded.')
  }
  for (const warning of value.warnings) lines.push(warningText(warning))
  if (lines.length === 0) return undefined
  return `Limitations\n${lines.map(line => `- ${line}`).join('\n')}`
}

/**
 * Pure Native projection in the product-defined order. The operation-selected
 * limit is carried in the canonical value, so replay never consults Settings,
 * a cache, the clock, or network state.
 */
export function renderWebSearchText(
  value: WebSearchOutput,
  sourceOperationNotice?: string,
): string {
  const sections = [
    answerSection(value),
    sourceSection(value),
    sourceSummary(value),
    limitationsSection(value),
    DISCOVERY_NOTICE,
  ].filter((section): section is string => section !== undefined)
  const complete = sections.join('\n\n')
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  return renderWithBoundedNotice(
    complete,
    sourceDisclosureTail(value.source_ref, sourceOperationNotice),
    maximumBytes,
    value.source_ref === undefined ? undefined : sourceDisclosureFallback(value.source_ref),
  )
}

function docsWarningText(warning: DocsSearchWarning): string {
  const subject = [warning.provider, warning.path].filter(Boolean).join('/')
  const suffix = [subject, warning.error_kind].filter(Boolean).join(', ')
  const detail = suffix.length === 0 ? '' : ` (${suffix})`
  switch (warning.code) {
    case 'provider_failed':
      return `A documentation Provider failed${detail}.`
    case 'provider_not_configured':
      return `An optional documentation Provider is not configured${detail}.`
    case 'cache_stale':
      return `Expired Context7 cache data was used after a temporary Provider failure${detail}.`
    case 'cache_evicted':
      return `The bounded Context7 cache evicted an older entry${detail}.`
    case 'provider_result_truncated':
      return `A documentation Provider bounded its discovery result${detail}.`
    case 'no_results':
      return 'Documentation search completed without matching snippets or sources.'
    case 'sources_truncated':
      return 'The durable source record retained only a bounded source prefix.'
    case 'canonical_output_truncated':
      return 'The documentation result was shortened to its configured canonical JSON limit.'
  }
}

function docsCachePathText(
  label: string,
  path: DocsSearchOutput['cache']['resolve'],
): string {
  const reason = path.reason === undefined ? '' : `, ${path.reason}`
  const evictions = path.evicted_entries === 0 ? '' : `, evicted ${path.evicted_entries}`
  return `${label}: ${path.state}${reason}${evictions}`
}

function docsProviderSection(value: DocsSearchOutput): string {
  return [
    'Providers',
    ...value.providers.map(status => `- ${status.provider}: ${status.state}`),
  ].join('\n')
}

function docsLibrarySection(value: DocsSearchOutput): string | undefined {
  if (value.selected_library === undefined) return undefined
  const library = value.selected_library
  const lines = [`Selected library: ${inline(library.title ?? library.id)}`, `Library id: ${library.id}`]
  if (library.description !== undefined) lines.push(`Library summary: ${inline(library.description)}`)
  if (value.doc_ref !== undefined) lines.push(`Documentation cache reference: ${value.doc_ref}`)
  return lines.join('\n')
}

function docsSnippetSection(value: DocsSearchOutput): string | undefined {
  if (value.snippets.length === 0) return undefined
  const lines = ['Documentation snippets']
  for (let index = 0; index < value.snippets.length; index += 1) {
    const snippet = value.snippets[index]
    if (snippet === undefined) continue
    lines.push(`${index + 1}. ${inline(snippet.title ?? 'Context7 documentation snippet')}`)
    if (snippet.library_id !== undefined) lines.push(`   Library: ${snippet.library_id}`)
    lines.push(snippet.content)
  }
  return lines.join('\n')
}

function docsSourceSection(value: DocsSearchOutput): string | undefined {
  if (value.sources.length === 0) return undefined
  const lines = ['Top sources']
  for (let index = 0; index < value.sources.length; index += 1) {
    const source = value.sources[index]
    if (source === undefined) continue
    lines.push(`${index + 1}. ${inline(sourceDisplayLabel(source))}`)
    lines.push(`   URL: ${source.url}`)
    if (source.publishedAt !== undefined) lines.push(`   Date: ${inline(source.publishedAt)}`)
    if (source.snippet !== undefined) lines.push(`   Snippet: ${inline(source.snippet)}`)
  }
  return lines.join('\n')
}

/** Pure Native projection for docs_search; it never reads Settings, cache, storage, or the network. */
export function renderDocsSearchText(
  value: DocsSearchOutput,
  sourceOperationNotice?: string,
): string {
  const status = value.state === 'partial' ? 'partial' : 'complete'
  const explanation = value.state === 'partial'
    ? 'Some documentation paths failed or stale cache data was used; available discovery results follow.'
    : value.sources.length === 0 && value.snippets.length === 0
      ? 'Documentation discovery completed without matching snippets or sources.'
      : 'Documentation discovery completed; bounded discovery results follow.'
  const sections = [
    `Documentation search (${status})\n${explanation}`,
    docsLibrarySection(value),
    docsSnippetSection(value),
    docsSourceSection(value),
    [
      `Sources shown: ${value.returned_sources}/${value.total_sources}`,
      `Snippets shown: ${value.returned_snippets}/${value.total_snippets}`,
    ].join('\n'),
    [
      docsCachePathText('Context7 resolve cache', value.cache.resolve),
      docsCachePathText('Context7 docs cache', value.cache.docs),
      docsProviderSection(value),
    ].join('\n'),
    value.truncated || value.warnings.length > 0
      ? [
          'Limitations',
          ...(value.truncated
            ? ['- Documentation snippets, visible sources, Provider collection, or retained sources were bounded.']
            : []),
          ...value.warnings.map(warning => `- ${docsWarningText(warning)}`),
        ].join('\n')
      : undefined,
    'Evidence level: discovery. Documentation snippets and source summaries are discovery metadata, not verified fetched page-body evidence; inspect an exact source page before relying on a claim.',
  ].filter((section): section is string => section !== undefined)
  const complete = sections.join('\n\n')
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  return renderWithBoundedNotice(
    complete,
    sourceDisclosureTail(value.source_ref, sourceOperationNotice),
    maximumBytes,
    value.source_ref === undefined ? undefined : sourceDisclosureFallback(value.source_ref),
  )
}

function renderPageSources(page: SearchSourcesFound): string | undefined {
  if (page.sources.length === 0) return undefined
  const lines = ['Sources']
  for (let index = 0; index < page.sources.length; index += 1) {
    const source = page.sources[index]
    if (source === undefined) continue
    lines.push(`${page.offset + index + 1}. ${inline(sourceDisplayLabel(source))}`)
    lines.push(`   URL: ${source.url}`)
    lines.push(`   Category: ${source.category}`)
    if (source.date !== undefined) lines.push(`   Date: ${inline(source.date)}`)
    if (source.snippet !== undefined) {
      lines.push(`   Snippet: ${inline(source.snippet)}${source.snippet_truncated === true ? ' [truncated]' : ''}`)
    }
  }
  return lines.join('\n')
}

/** Pure model-text projection for one private-storage source page. */
export function renderSearchSourcesText(value: SearchSourcesOutput): string {
  if (value.state === 'not_found') {
    return [
      `Source reference not found (${value.code}).`,
      'The reference is missing, malformed, unauthorized for this session/fork, or its private storage was not restored.',
    ].join('\n')
  }

  const sections = [
    renderPageSources(value),
    [
      `Page returned: ${value.returned}; retained total: ${value.total}; original total: ${value.total_before_retention}.`,
      value.has_more && value.next_offset !== undefined
        ? `More sources are available at offset ${value.next_offset}.`
        : 'No later retained source page is available.',
      value.truncated
        ? 'The retained source record is truncated.'
        : undefined,
      value.page_byte_limited
        ? 'This page was shortened by its canonical JSON byte limit.'
        : undefined,
    ].filter((line): line is string => line !== undefined).join('\n'),
    'These are retained discovery records; snippets are not fetched webpage bodies.',
  ].filter((section): section is string => section !== undefined)
  return sections.join('\n\n')
}

function webExtractAttemptText(attempt: WebExtractOutputAttempt): string {
  const details = [
    `outcome=${attempt.outcome}`,
    `count=${attempt.count}`,
    `duration_ms=${attempt.duration_ms}`,
    `fallback=${attempt.fallback}`,
    ...(attempt.error_kind === undefined ? [] : [`error_kind=${attempt.error_kind}`]),
    ...(attempt.http_status === undefined ? [] : [`http_status=${attempt.http_status}`]),
    ...(attempt.retryable === undefined ? [] : [`retryable=${attempt.retryable}`]),
    ...(attempt.skip_reason === undefined ? [] : [`skip_reason=${attempt.skip_reason}`]),
  ]
  return `- ${attempt.route}: ${details.join(', ')}`
}

function webExtractPathLimitation(value: WebExtractOutput): string {
  switch (value.retrieval_route) {
    case 'tavily_extract':
    case 'firecrawl_scrape':
      return 'Path limitation: third-party extracted content may be abridged or reordered; no target HTTP status is inferred when the Provider did not supply one.'
    case 'smart_direct':
      return 'Path limitation: the host made a fingerprinted static HTTP request, but Defuddle may select, abridge, or reorder content; no JavaScript or login session was used.'
    case 'direct':
      return 'Path limitation: direct host HTTP used no JavaScript or login session; content may be transformed or truncated, as reported below.'
  }
}

function webExtractHeader(value: WebExtractOutput): string {
  return [
    `Requested URL: ${value.requested_url}`,
    ...(value.final_url === undefined ? [] : [`Final URL: ${value.final_url}`]),
    `Retrieval route: ${value.retrieval_route}`,
    `Evidence level: ${value.evidence_level}`,
    ...(value.status_code === undefined ? [] : [`HTTP status: ${value.status_code}`]),
    ...(value.content_type === undefined ? [] : [`Content-Type: ${inline(value.content_type)}`]),
    `Format: ${value.format}`,
    `Truncated: ${value.truncated ? 'yes' : 'no'}`,
    ...(value.title === undefined ? [] : [`Title: ${inline(value.title)}`]),
    ...(value.author === undefined ? [] : [`Author: ${inline(value.author)}`]),
    ...(value.published_at === undefined ? [] : [`Published: ${inline(value.published_at)}`]),
    ...(value.canonical_url === undefined ? [] : [`Canonical URL: ${value.canonical_url}`]),
    ...(value.content_length === undefined ? [] : [`Content-Length: ${value.content_length}`]),
    ...(value.content_disposition === undefined ? [] : [`Content-Disposition: ${inline(value.content_disposition)}`]),
    ...(value.content_encoding === undefined ? [] : [`Content-Encoding: ${inline(value.content_encoding)}`]),
    ...(value.encoded_bytes === undefined ? [] : [`Encoded bytes observed: ${value.encoded_bytes}`]),
    ...(value.decompressed_bytes === undefined ? [] : [`Decompressed bytes observed: ${value.decompressed_bytes}`]),
    ...(value.content_transform === undefined ? [] : [`Content transform: ${value.content_transform}`]),
    ...(value.metadata_only_reason === undefined ? [] : [`Metadata-only reason: ${value.metadata_only_reason}`]),
    ...(value.encoded_body_truncated === true ? ['Encoded body truncated: yes'] : []),
    ...(value.decompressed_body_truncated === true ? ['Decompressed body truncated: yes'] : []),
    ...(value.output_truncated === true ? ['Route output truncated: yes'] : []),
    ...(value.metadata_truncated === true ? ['Metadata truncated: yes'] : []),
    ...(value.canonical_output_truncated === true ? ['Canonical output truncated: yes'] : []),
    webExtractPathLimitation(value),
  ].join('\n')
}

interface WebExtractRenderEnvelope {
  readonly attempts: string
  readonly complete: string
  readonly maximumBytes: number
  readonly prefix: string
}

function webExtractRenderEnvelope(value: WebExtractOutput): WebExtractRenderEnvelope {
  const header = webExtractHeader(value)
  const attempts = [
    'Route attempts',
    ...value.attempts.map(webExtractAttemptText),
  ].join('\n')
  const prefix = `${header}\n\nContent\n`
  const complete = `${prefix}${value.content}\n\n${attempts}`
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  return { attempts, complete, maximumBytes, prefix }
}

/**
 * Whether this plugin's model-text cap cuts the same complete Native render.
 * This pure projection deliberately knows nothing about later host spill, whose
 * locator can still recover the complete already-rendered text.
 */
export function isWebExtractModelTextTruncated(value: WebExtractOutput): boolean {
  const { complete, maximumBytes } = webExtractRenderEnvelope(value)
  return utf8ByteLength(complete) > maximumBytes
}

/**
 * Pure webpage-body projection. Header facts and safe attempt summaries remain
 * around the body; when the independent UTF-8 ceiling cuts content, a durable
 * marker is included without splitting a Unicode code point.
 */
export function renderWebExtractText(value: WebExtractOutput): string {
  const {
    attempts,
    complete,
    maximumBytes,
    prefix,
  } = webExtractRenderEnvelope(value)
  if (utf8ByteLength(complete) <= maximumBytes) return complete

  const marker = '[Model text truncated by model_text_max_bytes.]'
  const truncatedSuffix = `\n\n${attempts}\n\n${marker}`
  const fixedBytes = utf8ByteLength(prefix) + utf8ByteLength(truncatedSuffix)
  if (fixedBytes <= maximumBytes) {
    const retained = truncateUtf8(value.content, maximumBytes - fixedBytes).text
    return `${prefix}${retained}${truncatedSuffix}`
  }

  // A malformed replay or an exceptionally tiny historical limit may not fit
  // the normal fixed envelope. Retain facts in marker, route, evidence,
  // response, and requested-URL priority under the same Unicode-safe boundary.
  const compact = [
    marker,
    `Retrieval route: ${value.retrieval_route}`,
    `Evidence level: ${value.evidence_level}`,
    ...(value.status_code === undefined ? [] : [`HTTP status: ${value.status_code}`]),
    ...(value.content_type === undefined ? [] : [`Content-Type: ${inline(value.content_type)}`]),
    `Truncated: ${value.truncated ? 'yes' : 'no'}`,
    `Requested URL: ${value.requested_url}`,
  ].join('\n')
  return truncateUtf8(compact, maximumBytes).text
}

function webMapWarningText(warning: WebMapWarning): string {
  const count = warning.count === undefined ? '' : ` (${warning.count})`
  switch (warning.code) {
    case 'invalid_result_url_omitted':
      return `Invalid or over-length Provider URL entries were omitted${count}.`
    case 'duplicate_result_url_omitted':
      return `Duplicate Provider URL entries were de-duplicated${count}.`
    case 'results_truncated':
      return `Valid discovered links exceeded the applied link limit${count}.`
    case 'canonical_output_truncated':
      return 'The canonical site-map value retained only a stable URL prefix to fit its JSON byte limit.'
  }
}

function webMapLinks(value: WebMapOutput): string {
  if (value.results.length === 0) return 'Links\nNo matching links were discovered.'
  return [
    'Links',
    ...value.results.map((url, index) => `${index + 1}. ${url}`),
  ].join('\n')
}

function completeWebMapText(value: WebMapOutput): string {
  const limitations = value.truncated || value.warnings.length > 0
    ? [
        'Limitations',
        ...(value.truncated
          ? ['- The accepted Provider results or canonical projection were bounded.']
          : []),
        ...value.warnings.map(item => `- ${webMapWarningText(item)}`),
      ].join('\n')
    : undefined
  const attempts = [
    'Provider attempts',
    ...value.attempts.map(attempt => [
      `- ${attempt.provider}: outcome=${attempt.outcome}`,
      `count=${attempt.count}`,
      `duration_ms=${attempt.duration_ms}`,
      `fallback=${attempt.fallback}`,
    ].join(', ')),
  ].join('\n')
  return [
    [
      'Website map discovery',
      `Requested URL: ${value.requested_url}`,
      ...(value.base_url === undefined ? [] : [`Provider base URL: ${value.base_url}`]),
      `Provider: ${value.provider}`,
      ...(value.response_time === undefined ? [] : [`Provider response time: ${value.response_time} seconds`]),
    ].join('\n'),
    [
      'Applied limits',
      `Max depth: ${value.max_depth}`,
      `Max breadth: ${value.max_breadth}`,
      `Link limit: ${value.limit}`,
    ].join('\n'),
    webMapLinks(value),
    `Links shown: ${value.returned_results}/${value.total_results}\nTruncated: ${value.truncated ? 'yes' : 'no'}`,
    attempts,
    limitations,
    'Evidence level: discovery. These URLs are third-party-discovered candidates, not fetched or verified page-body evidence; inspect selected pages with web_extract before relying on claims.',
  ].filter((section): section is string => section !== undefined).join('\n\n')
}

/** Pure calculation used by both the Native renderer and replayable card metadata. */
export function isWebMapModelTextTruncated(value: WebMapOutput): boolean {
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  return utf8ByteLength(completeWebMapText(value)) > maximumBytes
}

/** Pure UTF-8-bounded Native projection with an explicit truncation marker. */
export function renderWebMapText(value: WebMapOutput): string {
  const complete = completeWebMapText(value)
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  if (utf8ByteLength(complete) <= maximumBytes) return complete

  const marker = '[Model text truncated by model_text_max_bytes.]'
  const suffix = `\n\n${marker}`
  if (utf8ByteLength(suffix) <= maximumBytes) {
    const prefix = truncateUtf8(complete, maximumBytes - utf8ByteLength(suffix)).text
    return `${prefix}${suffix}`
  }
  return truncateUtf8(marker, maximumBytes).text
}

function diagnosticsWarningText(warning: SearchDiagnosticsWarning): string {
  const count = warning.count === undefined ? '' : ` (${warning.count})`
  switch (warning.code) {
    case 'not_configured':
      return `Provider credentials are not configured${count}.`
    case 'probe_failed':
      return `Bounded Provider probes failed${count}.`
    case 'unsupported':
      return `Configured routes have no compliant network probe${count}.`
    case 'configuration_unavailable':
      return `Credential configuration status was unavailable${count}.`
    case 'bounded':
      return `The canonical diagnostics limitations list was bounded${count}.`
  }
}

function completeSearchDiagnosticsText(value: SearchDiagnosticsOutput): string {
  const capabilities = [
    'Capability availability (configuration only)',
    ...value.capability_status.map(status => [
      `- ${status.capability}: available=${status.available}, required=${status.required}`,
      `providers=${status.providers.map(provider => `${provider.provider}:${provider.state}`).join(', ')}`,
    ].join(', ')),
  ].join('\n')
  const attempts = value.tested
    ? [
        'This-test Provider outcomes',
        ...value.provider_attempts.map(attempt => [
          `- ${attempt.capability}/${attempt.provider}: outcome=${attempt.outcome}`,
          `attempts=${attempt.attempts}`,
          `duration_ms=${attempt.duration_ms}`,
          ...(attempt.error_kind === undefined ? [] : [`error_kind=${attempt.error_kind}`]),
        ].join(', ')),
      ].join('\n')
    : 'This-test Provider outcomes\nNo network probes were run by show.'
  const configuration = [
    'Safe configuration status',
    `Default profile/depth: ${value.configuration.default_profile}/${value.configuration.default_depth}`,
    `Search API protocol: ${value.configuration.search_api_protocol}`,
    `Search model configured: ${value.configuration.search_model_configured}`,
    `Thinking/fallback: ${value.configuration.thinking_level}/${value.configuration.fallback_mode}`,
    `Configured deferred operations: web_map=${value.configuration.web_map_enabled}, research_plan=${value.configuration.research_plan_enabled}, diagnostics=${value.configuration.diagnostics_enabled} (invoke active operations through search_call)`,
    `Search routes enabled: tavily=${value.configuration.tavily_search_enabled}, firecrawl=${value.configuration.firecrawl_search_enabled}`,
    `Extract routes enabled: tavily=${value.configuration.tavily_extract_enabled}, firecrawl=${value.configuration.firecrawl_scrape_enabled}, smart_direct=${value.configuration.smart_direct_enabled}, direct=${value.configuration.direct_enabled}`,
  ].join('\n')
  return [
    [
      'Search diagnostics',
      `Action: ${value.action}`,
      `Live probes run: ${value.tested ? 'yes' : 'no'}`,
      `Minimum profile: ${value.minimum_profile.profile} (satisfied=${value.minimum_profile.satisfied})`,
      `Product fallback used by diagnostics: ${value.fallback_used}`,
    ].join('\n'),
    capabilities,
    attempts,
    configuration,
    value.warnings.length === 0
      ? 'Warnings\nNone.'
      : ['Warnings', ...value.warnings.map(item => `- ${diagnosticsWarningText(item)}`)].join('\n'),
    value.limitations.length === 0
      ? 'Limitations\nNone retained.'
      : ['Limitations', ...value.limitations.map(item => `- ${inline(item)}`)].join('\n'),
    ...(value.canonical_output_truncated
      ? ['Canonical output was truncated to its configured JSON byte ceiling.']
      : []),
  ].join('\n\n')
}

/** Pure calculation shared by Native rendering and replayable diagnostics metadata. */
export function isSearchDiagnosticsModelTextTruncated(value: SearchDiagnosticsOutput): boolean {
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  return utf8ByteLength(completeSearchDiagnosticsText(value)) > maximumBytes
}

/** Pure UTF-8-bounded model text that separates configured availability from live test outcomes. */
export function renderSearchDiagnosticsText(value: SearchDiagnosticsOutput): string {
  const complete = completeSearchDiagnosticsText(value)
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  if (utf8ByteLength(complete) <= maximumBytes) return complete

  const marker = '[Model text truncated by model_text_max_bytes.]'
  const suffix = `\n\n${marker}`
  if (utf8ByteLength(suffix) <= maximumBytes) {
    const prefix = truncateUtf8(complete, maximumBytes - utf8ByteLength(suffix)).text
    return `${prefix}${suffix}`
  }
  return truncateUtf8(marker, maximumBytes).text
}

export {
  isResearchPlanModelTextTruncated,
  renderResearchPlanText,
} from '../research-plan/index.js'

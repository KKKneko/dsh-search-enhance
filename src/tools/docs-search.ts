import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

import {
  DOCS_SEARCH_DEFAULT_MAX_RESULTS,
  type Config,
} from '../config.js'
import type {
  DocumentationCachePath,
  DocumentationSearchResult,
  DocumentationSearchService,
  DocumentationWarning,
} from '../documentation/index.js'
import {
  ProviderError,
  throwIfAborted,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import {
  docsSearchPresentationMeta,
  presentDocsSearchCall,
  presentDocsSearchResult,
} from '../presentation/web-card.js'
import { renderDocsSearchText } from '../presentation/render.js'
import {
  sourceCallIdentity,
  type SearchEnhanceSourceService,
  type SourceRecordCommit,
} from '../source-storage/index.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  DOCS_SEARCH_OUTPUT_SCHEMA,
  DOCS_SEARCH_PARAMETERS,
  type DocsSearchArgs,
  type DocsSearchOutput,
  type DocsSearchSelectedLibrary,
  type DocsSearchWarning,
} from './schemas.js'

export interface DocsSearchToolDependencies {
  /** Read the restart-scoped resolved Settings value this plugin instance was loaded with. */
  readonly getConfig: () => Config
  readonly documentation: Pick<DocumentationSearchService, 'search'>
  readonly operations: ForegroundOperationScope
  /** Immutable append-only manifest text for source_ref auto-disclosure. */
  readonly sourceOperationNotice: string
  readonly sources: Pick<SearchEnhanceSourceService, 'record'>
}

function requireSession(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('docs_search requires a live Agent session')
  }
  return session
}

function outputWarning(warning: DocumentationWarning): DocsSearchWarning {
  return {
    code: warning.code,
    ...(warning.provider === undefined ? {} : { provider: warning.provider }),
    ...(warning.path === undefined ? {} : { path: warning.path }),
    ...(warning.errorKind === undefined ? {} : { error_kind: warning.errorKind }),
    ...(warning.count === undefined ? {} : { count: warning.count }),
  }
}

function cachePath(path: Readonly<DocumentationCachePath>): DocsSearchOutput['cache']['resolve'] {
  return {
    state: path.state,
    evicted_entries: path.evictedEntries,
    ...(path.reason === undefined ? {} : { reason: path.reason }),
  }
}

function overallState(result: Readonly<DocumentationSearchResult>): DocsSearchOutput['state'] {
  if (result.cache.resolve.state === 'stale' || result.cache.docs.state === 'stale') {
    return 'partial'
  }
  if (result.providers.some(status => status.state === 'partial' || status.state === 'failed')) {
    return 'partial'
  }
  if (result.provider === 'all' && result.providers.some(status => status.state === 'skipped')) {
    return 'partial'
  }
  return 'complete'
}

function selectedLibrary(
  result: Readonly<DocumentationSearchResult>,
): DocsSearchSelectedLibrary | undefined {
  const library = result.selectedLibrary
  if (library?.id === undefined) return undefined
  return {
    id: library.id,
    ...(library.title === undefined ? {} : { title: library.title }),
    ...(library.description === undefined ? {} : { description: library.description }),
  }
}

function ensureWarning(warnings: DocsSearchWarning[], code: DocsSearchWarning['code']): void {
  if (!warnings.some(warning => warning.code === code)) warnings.push({ code })
}

/** Project only bounded, model-useful documentation facts; attempts and endpoints stay internal. */
export function projectDocsSearchOutput(
  result: Readonly<DocumentationSearchResult>,
  config: Config,
  commit?: Readonly<SourceRecordCommit>,
): DocsSearchOutput {
  const warnings = result.warnings.map(outputWarning)
  const storageTruncated = commit?.record.truncated === true
  if (storageTruncated) ensureWarning(warnings, 'sources_truncated')
  const sources = result.sources.map(source => ({
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
  }))
  const snippets = result.snippets.map(snippet => ({
    content: snippet.content,
    ...(snippet.title === undefined ? {} : { title: snippet.title }),
    ...(snippet.libraryId === undefined ? {} : { library_id: snippet.libraryId }),
  }))
  const library = selectedLibrary(result)
  return boundDocsSearchOutput({
    state: overallState(result),
    provider: result.provider,
    providers: result.providers.map(status => ({ ...status })),
    ...(library === undefined ? {} : { selected_library: library }),
    snippets,
    sources,
    ...(commit === undefined ? {} : { source_ref: String(commit.sourceRef) }),
    ...(result.docRef === undefined ? {} : { doc_ref: String(result.docRef) }),
    cache: {
      resolve: cachePath(result.cache.resolve),
      docs: cachePath(result.cache.docs),
    },
    total_sources: result.totalSources,
    returned_sources: sources.length,
    total_snippets: result.totalSnippets,
    returned_snippets: snippets.length,
    truncated: result.truncated || storageTruncated,
    evidence_level: 'discovery',
    warnings,
    model_text_max_bytes: config.budgets.coding_docs.compact.maxModelTextBytes,
  }, config.retention.canonicalOutputMaxBytes)
}

function canonicalOutputBytes(value: DocsSearchOutput): number {
  return utf8ByteLength(JSON.stringify(value))
}

function boundedOutputCandidate(
  value: DocsSearchOutput,
  sources: DocsSearchOutput['sources'],
  snippets: DocsSearchOutput['snippets'],
  warnings: DocsSearchWarning[],
  library: DocsSearchSelectedLibrary | undefined,
): DocsSearchOutput {
  const { selected_library: _selectedLibrary, ...withoutSelectedLibrary } = value
  void _selectedLibrary
  return {
    ...withoutSelectedLibrary,
    ...(library === undefined ? {} : { selected_library: library }),
    sources,
    snippets,
    returned_sources: sources.length,
    returned_snippets: snippets.length,
    truncated: true,
    warnings,
  }
}

/** Bound the complete public docs_search JSON after refs and snake-case projection. */
export function boundDocsSearchOutput(
  value: DocsSearchOutput,
  maximumBytes: number,
): DocsSearchOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  if (canonicalOutputBytes(value) <= maximumBytes) return value

  const canonicalWarning: DocsSearchWarning = { code: 'canonical_output_truncated' }
  const ordinaryWarnings = value.warnings.filter(
    warning => warning.code !== canonicalWarning.code,
  )
  let warnings = [...ordinaryWarnings, canonicalWarning]
  let sources = [...value.sources]
  let snippets = [...value.snippets]
  let library = value.selected_library
  let candidate = boundedOutputCandidate(value, sources, snippets, warnings, library)

  // Full sources remain available through source_ref, so preserve the unique
  // documentation snippets before the inline source prefix when bytes are tight.
  while (sources.length > 0 && canonicalOutputBytes(candidate) > maximumBytes) {
    sources = sources.slice(0, -1)
    candidate = boundedOutputCandidate(value, sources, snippets, warnings, library)
  }

  if (canonicalOutputBytes(candidate) > maximumBytes && library?.description !== undefined) {
    const { description: _description, ...withoutDescription } = library
    void _description
    library = withoutDescription
    candidate = boundedOutputCandidate(value, sources, snippets, warnings, library)
  }
  if (canonicalOutputBytes(candidate) > maximumBytes && library?.title !== undefined) {
    const { title: _title, ...withoutTitle } = library
    void _title
    library = withoutTitle
    candidate = boundedOutputCandidate(value, sources, snippets, warnings, library)
  }

  while (snippets.length > 0 && canonicalOutputBytes(candidate) > maximumBytes) {
    snippets = snippets.slice(0, -1)
    candidate = boundedOutputCandidate(value, sources, snippets, warnings, library)
  }

  while (ordinaryWarnings.length > 0 && canonicalOutputBytes(candidate) > maximumBytes) {
    ordinaryWarnings.pop()
    warnings = [...ordinaryWarnings, canonicalWarning]
    candidate = boundedOutputCandidate(value, sources, snippets, warnings, library)
  }

  if (canonicalOutputBytes(candidate) > maximumBytes) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'budget_exceeded',
      provider: 'docs-consumer',
    })
  }
  return candidate
}

async function executeDocsSearch(
  args: DocsSearchArgs,
  exec: ToolRunContext,
  dependencies: DocsSearchToolDependencies,
  signal: AbortSignal,
): Promise<DocsSearchOutput> {
  const session = requireSession(exec)
  const config = dependencies.getConfig()
  const maxResults = args.max_results ?? DOCS_SEARCH_DEFAULT_MAX_RESULTS
  if (
    !Number.isSafeInteger(maxResults)
    || maxResults <= 0
    || maxResults > config.retention.docsSearchMaxResults
  ) {
    throw new ProviderError({
      capability: 'docs_search',
      kind: 'invalid_request',
      provider: 'documentation-search',
    })
  }

  throwIfAborted(signal)
  const result = await dependencies.documentation.search({
    query: args.query,
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.library_name === undefined ? {} : { libraryName: args.library_name }),
    ...(args.library_id === undefined ? {} : { libraryId: args.library_id }),
    maxResults,
    ...(args.force_refresh === undefined ? {} : { forceRefresh: args.force_refresh }),
    config,
    signal,
  })
  throwIfAborted(signal)

  let commit: Readonly<SourceRecordCommit> | undefined
  if (result.persistence.sources.length > 0) {
    commit = await dependencies.sources.record(
      session,
      sourceCallIdentity(exec),
      result.persistence,
      signal,
    )
    throwIfAborted(signal)
  }
  return projectDocsSearchOutput(result, config, commit)
}

/** Build the resident high-level documentation Consumer; granular Context7 tools are deferred. */
export function createDocsSearchTool(
  dependencies: DocsSearchToolDependencies,
): ToolDefinition {
  return defineTool({
    name: 'docs_search',
    description: 'High-level SDK/API/framework/README/release documentation search. Pass library_id for an exact Context7 id or library_name for a package/product; auto without either uses Exa discovery, while context7/all require one. Returns bounded discovery snippets and durable source_ref pagination.',
    parameters: DOCS_SEARCH_PARAMETERS,
    output: {
      schema: DOCS_SEARCH_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: renderDocsSearchText(value, dependencies.sourceOperationNotice),
      }],
      presentationMeta: docsSearchPresentationMeta,
    },
    async execute(args, exec) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeDocsSearch(args, exec, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: presentDocsSearchCall,
    presentResult: presentDocsSearchResult,
  })
}

import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

import {
  throwIfAborted,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import type { Config } from '../config.js'
import { renderSearchSourcesText } from '../presentation/render.js'
import {
  presentSearchSourcesCall,
  presentSearchSourcesResult,
  searchSourcesPresentationMeta,
} from '../presentation/web-card.js'
import {
  SourcePageError,
  type SearchEnhanceSourceService,
  type SourcePageResult,
} from '../source-storage/index.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  SEARCH_SOURCES_OUTPUT_SCHEMA,
  SEARCH_SOURCES_PARAMETERS,
  type SearchSourcesArgs,
  type SearchSourcesOutput,
} from './schemas.js'

export interface SearchSourcesToolDependencies {
  /** Read and snapshot the current resolved Settings value once per operation. */
  readonly getConfig: () => Config
  readonly operations: ForegroundOperationScope
  readonly sources: Pick<SearchEnhanceSourceService, 'page'>
}

function requireSession(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('search_sources requires a live Agent session')
  }
  return session
}

/** Convert the private storage service's bounded page into the public canonical spelling. */
export function projectSearchSourcesOutput(page: SourcePageResult): SearchSourcesOutput {
  if (page.state === 'not_found') return { ...page }
  return {
    state: 'found',
    source_ref: String(page.source_ref),
    offset: page.offset,
    limit: page.limit,
    format: page.format,
    total: page.total,
    returned: page.returned,
    sources: page.sources.map(source => ({
      url: source.url,
      category: source.category,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(source.date === undefined ? {} : { date: source.date }),
      ...(!('snippet' in source) || source.snippet === undefined
        ? {}
        : { snippet: source.snippet }),
      ...(!('snippetTruncated' in source) || source.snippetTruncated !== true
        ? {}
        : { snippet_truncated: true as const }),
    })),
    has_more: page.hasMore,
    ...(page.nextOffset === undefined ? {} : { next_offset: page.nextOffset }),
    total_before_retention: page.totalBeforeRetention,
    truncated: page.truncated,
    page_byte_limited: page.pageByteLimited,
  }
}

function projectedPage(
  page: Extract<SearchSourcesOutput, { state: 'found' }>,
  sources: Extract<SearchSourcesOutput, { state: 'found' }>['sources'],
): Extract<SearchSourcesOutput, { state: 'found' }> {
  const returned = sources.length
  const nextOffset = page.offset + returned
  const hasMore = nextOffset < page.total
  const { next_offset: _nextOffset, ...withoutNextOffset } = page
  void _nextOffset
  return {
    ...withoutNextOffset,
    returned,
    sources,
    has_more: hasMore,
    ...(hasMore && returned > 0 ? { next_offset: nextOffset } : {}),
    page_byte_limited: true,
  }
}

/** Recheck the complete public snake-case page envelope under the configured cap. */
export function boundSearchSourcesOutput(
  value: SearchSourcesOutput,
  maximumBytes: number,
): SearchSourcesOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  if (value.state === 'not_found') return value
  if (utf8ByteLength(JSON.stringify(value)) <= maximumBytes) return value

  if (value.sources.length === 0) {
    throw new SourcePageError('SOURCE_PAGE_BUDGET')
  }
  let sources = value.sources.slice(0, -1)
  let candidate = projectedPage(value, sources)
  while (sources.length > 0 && utf8ByteLength(JSON.stringify(candidate)) > maximumBytes) {
    sources = sources.slice(0, -1)
    candidate = projectedPage(value, sources)
  }
  if (
    utf8ByteLength(JSON.stringify(candidate)) > maximumBytes
    || sources.length === 0
  ) {
    throw new SourcePageError('SOURCE_PAGE_BUDGET')
  }
  return candidate
}

async function executeSearchSources(
  args: SearchSourcesArgs,
  exec: ToolRunContext,
  dependencies: SearchSourcesToolDependencies,
  signal: AbortSignal,
): Promise<SearchSourcesOutput> {
  const session = requireSession(exec)
  const config = dependencies.getConfig()
  throwIfAborted(signal)
  const page = dependencies.sources.page(session, {
    source_ref: args.source_ref,
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.format === undefined ? {} : { format: args.format }),
  })
  throwIfAborted(signal)
  return boundSearchSourcesOutput(
    projectSearchSourcesOutput(page),
    config.retention.searchSourcesPageMaxBytes,
  )
}

/** Build session/fork-authorized pagination over the plugin-private source store. */
export function createSearchSourcesTool(
  dependencies: SearchSourcesToolDependencies,
): ToolDefinition {
  return defineTool({
    name: 'search_sources',
    description: 'Page discovery sources retained by web_search or docs_search for the current Agent session or an inherited fork. The private search_enhance_sources storage must be backed up and restored together with the session.',
    parameters: SEARCH_SOURCES_PARAMETERS,
    output: {
      schema: SEARCH_SOURCES_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearchSourcesText(value) }],
      presentationMeta: searchSourcesPresentationMeta,
    },
    async execute(args, exec) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeSearchSources(args, exec, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: presentSearchSourcesCall,
    presentResult: presentSearchSourcesResult,
  })
}

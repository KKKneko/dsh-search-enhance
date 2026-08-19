import { throwIfAborted } from '../provider-runtime/index.js'
import type { Context7RemoteClient } from '../providers/context7.js'
import type { SearchApiProvider } from '../providers/search-api.js'
import type { BoundedSourceProvider } from '../providers/types.js'
import type {
  DiagnosticCapability,
  DiagnosticProbe,
  DiagnosticProbeInput,
  DiagnosticProbeResult,
  DiagnosticProviderName,
} from './types.js'

/** Fixed, non-user-controlled diagnostic targets. */
export const DIAGNOSTIC_SEARCH_QUERY = 'search-enhance fixed connectivity diagnostic'
export const DIAGNOSTIC_CONTEXT7_LIBRARY_NAME = 'React'
export const DIAGNOSTIC_CONTEXT7_QUERY = 'documentation connectivity diagnostic'
export const DIAGNOSTIC_RESULT_LIMIT = 1

const COMPLETE: Readonly<DiagnosticProbeResult> = Object.freeze({ state: 'complete' })
const NOT_CONFIGURED: Readonly<DiagnosticProbeResult> = Object.freeze({ state: 'not_configured' })

/** Uses the public bounded model-list GET; it never calls Search API main search. */
export class SearchApiModelListDiagnosticProbe implements DiagnosticProbe {
  readonly capability = 'main_search' as const
  readonly provider = 'search_api' as const

  constructor(private readonly searchApi: Pick<SearchApiProvider, 'listModels'>) {}

  async probe(input: DiagnosticProbeInput): Promise<Readonly<DiagnosticProbeResult>> {
    throwIfAborted(input.signal)
    await this.searchApi.listModels(input.signal, {
      cache: false,
      config: input.config,
      refresh: true,
      onDispatch: input.onDispatch,
    })
    throwIfAborted(input.signal)
    return COMPLETE
  }
}

/** Uses only Context7's public resolve operation with one fixed bounded library query. */
export class Context7ResolveDiagnosticProbe implements DiagnosticProbe {
  readonly capability = 'docs_search' as const
  readonly provider = 'context7' as const

  constructor(private readonly context7: Pick<Context7RemoteClient, 'resolve'>) {}

  async probe(input: DiagnosticProbeInput): Promise<Readonly<DiagnosticProbeResult>> {
    throwIfAborted(input.signal)
    await this.context7.resolve({
      config: input.config,
      limit: DIAGNOSTIC_RESULT_LIMIT,
      libraryName: DIAGNOSTIC_CONTEXT7_LIBRARY_NAME,
      onDispatch: input.onDispatch,
      query: DIAGNOSTIC_CONTEXT7_QUERY,
      signal: input.signal,
    })
    throwIfAborted(input.signal)
    return COMPLETE
  }
}

/**
 * Adapts an existing bounded discovery Provider to a fixed-query diagnostic.
 * The result body is deliberately discarded rather than copied into diagnostics.
 */
export class SourceSearchDiagnosticProbe implements DiagnosticProbe {
  constructor(
    readonly capability: Extract<DiagnosticCapability, 'main_search' | 'docs_search'>,
    readonly provider: Extract<
      DiagnosticProviderName,
      'exa' | 'tavily_search' | 'firecrawl_search'
    >,
    private readonly source: Pick<BoundedSourceProvider, 'search'>,
  ) {}

  async probe(input: DiagnosticProbeInput): Promise<Readonly<DiagnosticProbeResult>> {
    throwIfAborted(input.signal)
    const outcome = await this.source.search({
      config: input.config,
      limit: DIAGNOSTIC_RESULT_LIMIT,
      onDispatch: input.onDispatch,
      query: DIAGNOSTIC_SEARCH_QUERY,
      signal: input.signal,
    })
    throwIfAborted(input.signal)
    return outcome.state === 'not_configured' ? NOT_CONFIGURED : COMPLETE
  }
}

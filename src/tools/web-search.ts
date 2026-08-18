import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

import type { Config } from '../config.js'
import type { SearchOrchestrationResult } from '../orchestration/index.js'
import type { SearchOrchestrator } from '../orchestration/orchestrator.js'
import {
  ProviderError,
  throwIfAborted,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import {
  webSearchPresentationMeta,
  presentWebSearchCall,
  presentWebSearchResult,
} from '../presentation/web-card.js'
import { renderWebSearchText } from '../presentation/render.js'
import {
  sourceCallIdentity,
  type SearchEnhanceSourceService,
  type SourceRecordCommit,
} from '../source-storage/index.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  WEB_SEARCH_OUTPUT_SCHEMA,
  WEB_SEARCH_PARAMETERS,
  type WebSearchArgs,
  type WebSearchOutput,
  type WebSearchWarning,
} from './schemas.js'

export interface WebSearchToolDependencies {
  /** Read the restart-scoped resolved Settings value this plugin instance was loaded with. */
  readonly getConfig: () => Config
  readonly orchestrator: Pick<SearchOrchestrator, 'search'>
  readonly operations: ForegroundOperationScope
  /** Immutable append-only manifest text for source_ref auto-disclosure. */
  readonly sourceOperationNotice: string
  readonly sources: Pick<SearchEnhanceSourceService, 'record'>
}

function requireSession(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('web_search requires a live Agent session')
  }
  return session
}

function outputWarning(
  warning: SearchOrchestrationResult['canonical']['warnings'][number],
): WebSearchWarning {
  return {
    code: warning.code,
    ...(warning.capability === undefined ? {} : { capability: warning.capability }),
    ...(warning.provider === undefined ? {} : { provider: warning.provider }),
    ...(warning.errorKind === undefined ? {} : { error_kind: warning.errorKind }),
  }
}

function ensureSourcesTruncatedWarning(
  warnings: WebSearchWarning[],
): void {
  if (!warnings.some(warning => warning.code === 'sources_truncated')) {
    warnings.push({ code: 'sources_truncated' })
  }
}

/** Project only ordinary visible fields; Provider/category routing stays internal. */
export function projectWebSearchOutput(
  result: Readonly<SearchOrchestrationResult>,
  config: Config,
  commit?: Readonly<SourceRecordCommit>,
): WebSearchOutput {
  const warnings = result.canonical.warnings.map(outputWarning)
  const storageTruncated = commit?.record.truncated === true
  if (storageTruncated) ensureSourcesTruncatedWarning(warnings)
  const sources = result.canonical.sources.map(source => ({
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
  }))
  const modelTextMaxBytes = config.budgets[result.persistence.profile][result.persistence.depth]
    .maxModelTextBytes
  return boundWebSearchOutput({
    state: result.canonical.state,
    ...(result.canonical.answer === undefined ? {} : { answer: result.canonical.answer }),
    sources,
    ...(commit === undefined ? {} : { source_ref: String(commit.sourceRef) }),
    total_sources: result.canonical.totalSources,
    returned_sources: sources.length,
    truncated: result.canonical.truncated || storageTruncated,
    evidence_level: 'discovery',
    warnings,
    model_text_max_bytes: modelTextMaxBytes,
  }, config.retention.canonicalOutputMaxBytes)
}

function canonicalOutputBytes(value: WebSearchOutput): number {
  return utf8ByteLength(JSON.stringify(value))
}

function boundedOutputCandidate(
  value: WebSearchOutput,
  answer: string | undefined,
  sources: WebSearchOutput['sources'],
  warnings: WebSearchWarning[],
): WebSearchOutput {
  const { answer: _answer, ...withoutAnswer } = value
  void _answer
  return {
    ...withoutAnswer,
    ...(answer === undefined || answer.length === 0 ? {} : { answer }),
    sources,
    returned_sources: sources.length,
    truncated: true,
    warnings,
  }
}

/** Bound the complete public canonical value after source_ref and snake-case projection. */
export function boundWebSearchOutput(
  value: WebSearchOutput,
  maximumBytes: number,
): WebSearchOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  if (canonicalOutputBytes(value) <= maximumBytes) return value

  const canonicalWarning: WebSearchWarning = { code: 'canonical_output_truncated' }
  const ordinaryWarnings = value.warnings.filter(
    warning => warning.code !== canonicalWarning.code,
  )
  let warnings = [...ordinaryWarnings, canonicalWarning]
  let sources = [...value.sources]
  let answer = value.answer
  let candidate = boundedOutputCandidate(value, answer, sources, warnings)

  while (sources.length > 0 && canonicalOutputBytes(candidate) > maximumBytes) {
    sources = sources.slice(0, -1)
    candidate = boundedOutputCandidate(value, answer, sources, warnings)
  }

  while (ordinaryWarnings.length > 0 && canonicalOutputBytes(candidate) > maximumBytes) {
    ordinaryWarnings.pop()
    warnings = [...ordinaryWarnings, canonicalWarning]
    candidate = boundedOutputCandidate(value, answer, sources, warnings)
  }

  if (
    canonicalOutputBytes(candidate) > maximumBytes
    && value.state === 'complete'
    && answer !== undefined
  ) {
    const codePoints = Array.from(answer)
    let low = 0
    let high = codePoints.length
    let retained: string | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const prefix = codePoints.slice(0, middle).join('')
      const projected = boundedOutputCandidate(
        value,
        prefix.length === 0 ? undefined : prefix,
        sources,
        warnings,
      )
      if (canonicalOutputBytes(projected) <= maximumBytes) {
        retained = prefix.length === 0 ? undefined : prefix
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    answer = retained
    candidate = boundedOutputCandidate(value, answer, sources, warnings)
  }

  if (canonicalOutputBytes(candidate) > maximumBytes) {
    throw new ProviderError({
      capability: 'main_search',
      kind: 'budget_exceeded',
      provider: 'search-consumer',
    })
  }
  return candidate
}

async function executeWebSearch(
  args: WebSearchArgs,
  exec: ToolRunContext,
  dependencies: WebSearchToolDependencies,
  signal: AbortSignal,
): Promise<WebSearchOutput> {
  const session = requireSession(exec)
  const config = dependencies.getConfig()
  throwIfAborted(signal)
  const result = await dependencies.orchestrator.search({
    query: args.query,
    ...(args.profile === undefined ? {} : { profile: args.profile }),
    ...(args.depth === undefined ? {} : { depth: args.depth }),
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
    // `record()` checks cancellation after durable put; this second guard owns
    // the no-publication boundary if cancellation wins immediately afterward.
    throwIfAborted(signal)
  }
  return projectWebSearchOutput(result, config, commit)
}

/**
 * Build the rich ordinary-search definition installed as an Agent-scoped
 * `web_search` shadow. Native and nested Code dispatch both enter this exact
 * execution function and canonical schema.
 */
export function createWebSearchTool(
  dependencies: WebSearchToolDependencies,
): ToolDefinition {
  return defineTool({
    name: 'web_search',
    description: 'Recommended entry point for ordinary search. Returns a bounded answer and discovery-level source metadata; snippets are not verified webpage-body evidence.',
    parameters: WEB_SEARCH_PARAMETERS,
    output: {
      schema: WEB_SEARCH_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: renderWebSearchText(value, dependencies.sourceOperationNotice),
      }],
      presentationMeta: webSearchPresentationMeta,
    },
    async execute(args, exec) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeWebSearch(args, exec, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: presentWebSearchCall,
    presentResult: presentWebSearchResult,
  })
}

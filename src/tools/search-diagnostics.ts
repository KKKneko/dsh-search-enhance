import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  ToolArgsError,
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import type { Config } from '../config.js'
import type { DiagnosticReporter, SearchDiagnosticReport } from '../diagnostics/index.js'
import { throwIfAborted, utf8ByteLength } from '../provider-runtime/index.js'
import {
  presentSearchDiagnosticsCall,
  presentSearchDiagnosticsResult,
  searchDiagnosticsPresentationMeta,
} from '../presentation/diagnostics-card.js'
import { renderSearchDiagnosticsText } from '../presentation/render.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  SEARCH_DIAGNOSTICS_OUTPUT_SCHEMA,
  SEARCH_DIAGNOSTICS_PARAMETERS,
  type SearchDiagnosticsArgs,
  type SearchDiagnosticsOutput,
  type SearchDiagnosticsWarning,
} from './schemas.js'

export class SearchDiagnosticsToolError extends HarnessError {
  override readonly code = 'SEARCH_DIAGNOSTICS_FAILED'

  constructor(kind: 'budget_exceeded') {
    super(
      `SEARCH_DIAGNOSTICS_FAILED: search diagnostics failed (${kind})`,
      'SEARCH_DIAGNOSTICS_FAILED',
    )
  }
}

export interface SearchDiagnosticsToolDependencies {
  readonly getConfig: () => Config
  readonly reporter: DiagnosticReporter
  readonly operations: ForegroundOperationScope
}

function outputBytes(value: SearchDiagnosticsOutput): number {
  return utf8ByteLength(JSON.stringify(value))
}

/** Direct secret-free projection; no Provider or presentation text is parsed. */
export function projectSearchDiagnosticsOutput(
  report: Readonly<SearchDiagnosticReport>,
): SearchDiagnosticsOutput {
  return {
    tested: report.tested,
    action: report.action,
    capability_status: report.capabilityStatus.map(status => ({
      capability: status.capability,
      available: status.available,
      required: status.required,
      providers: status.providers.map(provider => ({
        provider: provider.provider,
        state: provider.state,
      })),
    })),
    provider_attempts: report.providerAttempts.map(attempt => ({
      capability: attempt.capability,
      provider: attempt.provider,
      outcome: attempt.outcome,
      duration_ms: attempt.durationMs,
      attempts: attempt.attempts,
      ...(attempt.errorKind === undefined ? {} : { error_kind: attempt.errorKind }),
    })),
    providers_used: [...report.providersUsed],
    fallback_used: false,
    minimum_profile: {
      profile: report.minimumProfile.profile,
      satisfied: report.minimumProfile.satisfied,
    },
    configuration: {
      default_profile: report.configuration.defaultProfile,
      default_depth: report.configuration.defaultDepth,
      search_api_protocol: report.configuration.searchApiProtocol,
      search_model_configured: report.configuration.searchModelConfigured,
      thinking_level: report.configuration.thinkingLevel,
      fallback_mode: report.configuration.fallbackMode,
      web_map_enabled: report.configuration.webMapEnabled,
      research_plan_enabled: report.configuration.researchPlanEnabled,
      diagnostics_enabled: report.configuration.diagnosticsEnabled,
      tavily_search_enabled: report.configuration.tavilySearchEnabled,
      firecrawl_search_enabled: report.configuration.firecrawlSearchEnabled,
      tavily_extract_enabled: report.configuration.tavilyExtractEnabled,
      firecrawl_scrape_enabled: report.configuration.firecrawlScrapeEnabled,
      smart_direct_enabled: report.configuration.smartDirectEnabled,
      direct_enabled: report.configuration.directEnabled,
    },
    warnings: report.warnings.map(item => ({
      code: item.code,
      ...(item.count === undefined ? {} : { count: item.count }),
    })),
    limitations: [...report.limitations],
    canonical_output_truncated: false,
    model_text_max_bytes: report.modelTextMaxBytes,
  }
}

function boundedWarning(
  warnings: readonly SearchDiagnosticsWarning[],
  omitted: number,
): readonly SearchDiagnosticsWarning[] {
  return [
    ...warnings.filter(item => item.code !== 'bounded'),
    { code: 'bounded', count: omitted },
  ]
}

function truncatedCandidate(
  value: SearchDiagnosticsOutput,
  limitations: readonly string[],
): SearchDiagnosticsOutput {
  return {
    ...value,
    limitations: [...limitations],
    warnings: [...boundedWarning(value.warnings, value.limitations.length - limitations.length)],
    canonical_output_truncated: true,
  }
}

/** Enforce the complete canonical JSON envelope after every stable field is known. */
export function boundSearchDiagnosticsOutput(
  value: SearchDiagnosticsOutput,
  maximumBytes: number,
): SearchDiagnosticsOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  if (outputBytes(value) <= maximumBytes) return value

  let low = 0
  let high = Math.max(0, value.limitations.length - 1)
  let best: SearchDiagnosticsOutput | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = truncatedCandidate(value, value.limitations.slice(0, middle))
    if (outputBytes(candidate) <= maximumBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === undefined) throw new SearchDiagnosticsToolError('budget_exceeded')
  return best
}

function assertArguments(args: SearchDiagnosticsArgs): void {
  const unexpected = Object.keys(args).filter(key => key !== 'action')
  if (unexpected.length > 0) {
    throw new ToolArgsError(unexpected.map(key => `"${key}" is not allowed`))
  }
  if (args.action !== 'show' && args.action !== 'test') {
    throw new ToolArgsError(['"action" must be either "show" or "test"'])
  }
}

async function executeSearchDiagnostics(
  args: SearchDiagnosticsArgs,
  dependencies: SearchDiagnosticsToolDependencies,
  signal: AbortSignal,
): Promise<SearchDiagnosticsOutput> {
  assertArguments(args)
  const config = dependencies.getConfig()
  throwIfAborted(signal)
  const report = args.action === 'show'
    ? await dependencies.reporter.show({ config, signal })
    : await dependencies.reporter.test({ config, signal })
  throwIfAborted(signal)
  return boundSearchDiagnosticsOutput(
    projectSearchDiagnosticsOutput(report),
    config.diagnostics.maxOutputBytes,
  )
}

/** Build the deferred, read-only diagnostics Consumer. */
export function createSearchDiagnosticsTool(
  dependencies: SearchDiagnosticsToolDependencies,
): ToolDefinition {
  return defineTool({
    name: 'search_diagnostics',
    description: 'Read-only masked search capability/config status. show is network-free. Use test only when the user explicitly requests connection diagnostics; test runs bounded fixed Provider health probes. API keys are never parameters or output, config writes happen only through DSH Settings/UI, and ordinary searches should not call this tool.',
    parameters: SEARCH_DIAGNOSTICS_PARAMETERS,
    output: {
      schema: SEARCH_DIAGNOSTICS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearchDiagnosticsText(value) }],
      presentationMeta: searchDiagnosticsPresentationMeta,
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeSearchDiagnostics(args, dependencies, signal),
        exec.agent,
      )
    },
    isConcurrencySafe: () => true,
    presentCall: presentSearchDiagnosticsCall,
    presentResult: presentSearchDiagnosticsResult,
  })
}

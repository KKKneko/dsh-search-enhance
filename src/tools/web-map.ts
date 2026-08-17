import {
  defineTool,
  ToolArgsError,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import {
  SITE_MAP_DEFAULT_LIMIT,
  SITE_MAP_DEFAULT_MAX_BREADTH,
  SITE_MAP_DEFAULT_MAX_DEPTH,
  SITE_MAP_MAX_DEPTH,
  SITE_MAP_MAX_LINKS,
  type Config,
} from '../config.js'
import {
  presentWebMapCall,
  presentWebMapResult,
  webMapPresentationMeta,
} from '../presentation/web-card.js'
import { renderWebMapText } from '../presentation/render.js'
import {
  isProviderError,
  ProviderError,
  throwIfAborted,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import {
  normalizeSiteMapInstructions,
  normalizeSiteMapUrl,
  type SiteMapProvider,
  type TavilyMapResult,
} from '../site-map/index.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  WEB_MAP_OUTPUT_SCHEMA,
  WEB_MAP_PARAMETERS,
  type WebMapArgs,
  type WebMapOutput,
  type WebMapWarning,
} from './schemas.js'

export interface WebMapToolDependencies {
  /** Read and snapshot the current resolved Settings value once per operation. */
  readonly getConfig: () => Config
  readonly operations: ForegroundOperationScope
  readonly provider: SiteMapProvider
  /** Monotonic-enough test seam used only for the safe operation duration. */
  readonly now?: () => number
}

interface AppliedMapRequest {
  readonly url: string
  readonly instructions?: string
  readonly maxDepth: number
  readonly maxBreadth: number
  readonly limit: number
}

function providerFailure(kind: 'budget_exceeded' | 'invalid_response'): ProviderError {
  return new ProviderError({
    capability: 'site_map',
    kind,
    provider: 'tavily',
  })
}

function nonNegativeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw providerFailure('invalid_response')
  return value
}

function positiveCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw providerFailure('invalid_response')
  return value
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  if (
    !Number.isFinite(startedAt)
    || !Number.isFinite(finishedAt)
    || startedAt < 0
    || finishedAt < startedAt
  ) throw providerFailure('invalid_response')
  const elapsed = Math.round(finishedAt - startedAt)
  if (!Number.isSafeInteger(elapsed)) throw providerFailure('invalid_response')
  return elapsed
}

function warning(code: WebMapWarning['code'], count?: number): WebMapWarning {
  return {
    code,
    ...(count === undefined ? {} : { count }),
  }
}

function outputBytes(value: WebMapOutput): number {
  return utf8ByteLength(JSON.stringify(value))
}

function canonicalCandidate(value: WebMapOutput, results: readonly string[]): WebMapOutput {
  const warnings = value.warnings.filter(item => item.code !== 'canonical_output_truncated')
  return {
    ...value,
    results: [...results],
    returned_results: results.length,
    truncated: true,
    warnings: [...warnings, warning('canonical_output_truncated')],
  }
}

/**
 * Enforce the complete public JSON envelope after all fields and warnings are
 * known. Only the stable result prefix may shrink; empty mappings remain valid.
 */
export function boundWebMapOutput(
  value: WebMapOutput,
  maximumBytes: number,
): WebMapOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  if (outputBytes(value) <= maximumBytes) return value

  let low = 0
  let high = value.results.length
  let best: WebMapOutput | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = canonicalCandidate(value, value.results.slice(0, middle))
    if (outputBytes(candidate) <= maximumBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === undefined) throw providerFailure('budget_exceeded')
  return best
}

/** Project the complete parsed Tavily result onto the stable model/Code value. */
export function projectWebMapOutput(
  result: Readonly<TavilyMapResult>,
  request: AppliedMapRequest,
  config: Config,
  durationMs: number,
): WebMapOutput {
  const invalidResultUrls = nonNegativeCount(result.invalidResultUrls)
  const duplicateResultUrls = nonNegativeCount(result.duplicateResultUrls)
  const attempts = positiveCount(result.attempts)
  const totalResults = result.results.length
  const retained = result.results.slice(0, request.limit)
  const resultsOmitted = totalResults - retained.length
  const warnings: WebMapWarning[] = [
    ...(invalidResultUrls === 0
      ? []
      : [warning('invalid_result_url_omitted', invalidResultUrls)]),
    ...(duplicateResultUrls === 0
      ? []
      : [warning('duplicate_result_url_omitted', duplicateResultUrls)]),
    ...(resultsOmitted === 0
      ? []
      : [warning('results_truncated', resultsOmitted)]),
  ]

  return boundWebMapOutput({
    requested_url: request.url,
    ...(result.baseUrl === undefined ? {} : { base_url: result.baseUrl }),
    results: [...retained],
    total_results: totalResults,
    returned_results: retained.length,
    max_depth: request.maxDepth,
    max_breadth: request.maxBreadth,
    limit: request.limit,
    ...(result.responseTime === undefined ? {} : { response_time: result.responseTime }),
    truncated: invalidResultUrls > 0 || resultsOmitted > 0,
    evidence_level: 'discovery',
    provider: 'tavily',
    attempts: [{
      provider: 'tavily',
      outcome: 'success',
      count: attempts,
      duration_ms: nonNegativeCount(durationMs),
      fallback: false,
    }],
    warnings,
    model_text_max_bytes: config.siteMap.modelTextMaxBytes,
  }, config.siteMap.maxOutputBytes)
}

function assertOnlyDeclaredArguments(args: WebMapArgs): void {
  const allowed = new Set(['url', 'instructions', 'max_depth', 'max_breadth', 'limit'])
  const unexpected = Object.keys(args).filter(key => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new ToolArgsError(unexpected.map(key => `"${key}" is not allowed`))
  }
}

function boundedIntegerArgument(
  label: 'max_depth' | 'max_breadth' | 'limit',
  value: number | undefined,
  defaultValue: number,
  hardMaximum: number,
  deploymentMaximum: number,
): number {
  if (!Number.isSafeInteger(deploymentMaximum) || deploymentMaximum <= 0) {
    throw new RangeError('siteMap.maxLinks must be a positive safe integer')
  }
  if (value === undefined) return Math.min(defaultValue, deploymentMaximum)
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new ToolArgsError([`"${label}" must be an integer from 1 through ${hardMaximum}`])
  }
  if (value > deploymentMaximum) {
    throw new ToolArgsError([`"${label}" exceeds the configured siteMap.maxLinks deployment cap`])
  }
  return value
}

function normalizeRequest(args: WebMapArgs, config: Config): AppliedMapRequest {
  let url: string
  let instructions: string | undefined
  try {
    url = normalizeSiteMapUrl(args.url, config.siteMap.maxUrlCharacters)
    instructions = normalizeSiteMapInstructions(
      args.instructions,
      config.siteMap.maxInstructionsCharacters,
    )
  } catch (error) {
    if (isProviderError(error) && error.kind === 'invalid_request') {
      throw new ToolArgsError([
        '"url" must be an absolute HTTP(S) URL without userinfo and both URL/instructions must fit their configured character limits',
      ])
    }
    throw error
  }

  const maxDepth = boundedIntegerArgument(
    'max_depth',
    args.max_depth,
    SITE_MAP_DEFAULT_MAX_DEPTH,
    SITE_MAP_MAX_DEPTH,
    SITE_MAP_MAX_DEPTH,
  )
  const maxBreadth = boundedIntegerArgument(
    'max_breadth',
    args.max_breadth,
    SITE_MAP_DEFAULT_MAX_BREADTH,
    SITE_MAP_MAX_LINKS,
    config.siteMap.maxLinks,
  )
  const limit = boundedIntegerArgument(
    'limit',
    args.limit,
    SITE_MAP_DEFAULT_LIMIT,
    SITE_MAP_MAX_LINKS,
    config.siteMap.maxLinks,
  )
  return {
    url,
    ...(instructions === undefined ? {} : { instructions }),
    maxDepth,
    maxBreadth,
    limit,
  }
}

async function executeWebMap(
  args: WebMapArgs,
  dependencies: WebMapToolDependencies,
  signal: AbortSignal,
): Promise<WebMapOutput> {
  assertOnlyDeclaredArguments(args)
  const config = dependencies.getConfig()
  const request = normalizeRequest(args, config)
  throwIfAborted(signal)
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const result = await dependencies.provider.map({
    url: request.url,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    maxDepth: request.maxDepth,
    maxBreadth: request.maxBreadth,
    limit: request.limit,
    config,
    signal,
  })
  throwIfAborted(signal)
  return projectWebMapOutput(result, request, config, elapsedMilliseconds(startedAt, now()))
}

/** Build the deferred global website-discovery Consumer. */
export function createWebMapTool(dependencies: WebMapToolDependencies): ToolDefinition {
  return defineTool({
    name: 'web_map',
    description: 'Discover a bounded set of links under a known HTTP(S) website. Results are discovery candidates, not fetched page-body evidence.',
    parameters: WEB_MAP_PARAMETERS,
    output: {
      schema: WEB_MAP_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderWebMapText(value) }],
      presentationMeta: webMapPresentationMeta,
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeWebMap(args, dependencies, signal),
        exec.agent,
      )
    },
    isConcurrencySafe: () => true,
    presentCall: presentWebMapCall,
    presentResult: presentWebMapResult,
  })
}

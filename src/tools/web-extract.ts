import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  ToolArgsError,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import type { Config } from '../config.js'
import {
  isProviderError,
  ProviderError,
  throwIfAborted,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import {
  presentWebExtractCall,
  presentWebExtractResult,
  webExtractPresentationMeta,
} from '../presentation/web-card.js'
import { renderWebExtractText } from '../presentation/render.js'
import {
  normalizeWebExtractUrl,
  WebExtractInfrastructureError,
  type WebExtractOrchestrator,
  type WebExtractResult,
  type WebExtractRouteAttempt,
} from '../web-extract/index.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  WEB_EXTRACT_OUTPUT_SCHEMA,
  WEB_EXTRACT_PARAMETERS,
  type WebExtractArgs,
  type WebExtractOutput,
  type WebExtractOutputAttempt,
} from './schemas.js'

export interface WebExtractToolDependencies {
  /** Read the restart-scoped resolved Settings value this plugin instance was loaded with. */
  readonly getConfig: () => Config
  readonly operations: ForegroundOperationScope
  readonly orchestrator: Pick<WebExtractOrchestrator, 'extract'>
}

function projectAttempt(attempt: WebExtractRouteAttempt): WebExtractOutputAttempt {
  return {
    route: attempt.provider,
    outcome: attempt.outcome,
    count: attempt.attempts,
    duration_ms: attempt.durationMs,
    fallback: attempt.participatedInFallback,
    ...(attempt.errorKind === undefined ? {} : { error_kind: attempt.errorKind }),
    ...(attempt.httpStatus === undefined ? {} : { http_status: attempt.httpStatus }),
    ...(attempt.retryable === undefined ? {} : { retryable: attempt.retryable }),
    ...(attempt.skipReason === undefined ? {} : { skip_reason: attempt.skipReason }),
  }
}

function outputBytes(value: WebExtractOutput): number {
  return utf8ByteLength(JSON.stringify(value))
}

function boundedCandidate(
  value: WebExtractOutput,
  content: string,
): WebExtractOutput {
  const { canonical_output_truncated: _canonicalOutputTruncated, ...base } = value
  void _canonicalOutputTruncated
  return {
    ...base,
    content,
    truncated: true,
    canonical_output_truncated: true,
  }
}

/**
 * Recheck the complete public snake-case value after projection. Only body text
 * may shrink: route/evidence, safe attempts, and truthful response metadata are
 * retained. A non-empty truthful value that cannot fit fails closed.
 */
export function boundWebExtractOutput(
  value: WebExtractOutput,
  maximumBytes: number,
): WebExtractOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  if (outputBytes(value) <= maximumBytes) return value

  const codePoints = Array.from(value.content)
  let low = 1
  let high = codePoints.length
  let best: WebExtractOutput | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = boundedCandidate(value, codePoints.slice(0, middle).join(''))
    if (outputBytes(candidate) <= maximumBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (best === undefined) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'budget_exceeded',
      provider: 'web-extract-consumer',
    })
  }
  return best
}

/** Project the internal camel-case result onto the stable public snake-case API. */
export function projectWebExtractOutput(
  result: Readonly<WebExtractResult>,
  config: Config,
): WebExtractOutput {
  return boundWebExtractOutput({
    requested_url: result.requestedUrl,
    ...(result.finalUrl === undefined ? {} : { final_url: result.finalUrl }),
    content: result.content,
    format: result.format,
    ...(result.title === undefined ? {} : { title: result.title }),
    ...(result.author === undefined ? {} : { author: result.author }),
    ...(result.publishedAt === undefined ? {} : { published_at: result.publishedAt }),
    ...(result.canonicalUrl === undefined ? {} : { canonical_url: result.canonicalUrl }),
    ...(result.contentType === undefined ? {} : { content_type: result.contentType }),
    ...(result.contentLength === undefined ? {} : { content_length: result.contentLength }),
    ...(result.contentDisposition === undefined ? {} : { content_disposition: result.contentDisposition }),
    ...(result.contentEncoding === undefined ? {} : { content_encoding: result.contentEncoding }),
    ...(result.statusCode === undefined ? {} : { status_code: result.statusCode }),
    ...(result.encodedBytes === undefined ? {} : { encoded_bytes: result.encodedBytes }),
    ...(result.decompressedBytes === undefined ? {} : { decompressed_bytes: result.decompressedBytes }),
    ...(result.metadataOnlyReason === undefined ? {} : { metadata_only_reason: result.metadataOnlyReason }),
    ...(result.contentTransform === undefined ? {} : { content_transform: result.contentTransform }),
    ...(result.encodedBodyTruncated === undefined ? {} : { encoded_body_truncated: result.encodedBodyTruncated }),
    ...(result.decompressedBodyTruncated === undefined ? {} : { decompressed_body_truncated: result.decompressedBodyTruncated }),
    ...(result.outputTruncated === undefined ? {} : { output_truncated: result.outputTruncated }),
    ...(result.metadataTruncated === undefined ? {} : { metadata_truncated: result.metadataTruncated }),
    retrieval_route: result.retrievalRoute,
    evidence_level: result.evidenceLevel,
    truncated: result.truncated,
    attempts: result.attempts.map(projectAttempt),
    model_text_max_bytes: config.webExtract.modelTextMaxBytes,
  }, config.webExtract.maxOutputBytes)
}

function safeAttemptSummary(attempt: WebExtractOutputAttempt): string {
  const fields = [
    `outcome=${attempt.outcome}`,
    `count=${attempt.count}`,
    `duration_ms=${attempt.duration_ms}`,
    `fallback=${attempt.fallback}`,
    ...(attempt.error_kind === undefined ? [] : [`error_kind=${attempt.error_kind}`]),
    ...(attempt.http_status === undefined ? [] : [`http_status=${attempt.http_status}`]),
    ...(attempt.retryable === undefined ? [] : [`retryable=${attempt.retryable}`]),
    ...(attempt.skip_reason === undefined ? [] : [`skip_reason=${attempt.skip_reason}`]),
  ]
  return `${attempt.route}[${fields.join(',')}]`
}

/** Safe unified tool failure with one stable code and no retained raw cause. */
export class WebExtractToolError extends HarnessError {
  readonly attempts: readonly WebExtractOutputAttempt[]

  constructor(statuses: readonly WebExtractRouteAttempt[]) {
    const attempts = statuses.map(projectAttempt)
    super(
      `SEARCH_WEB_EXTRACT_FAILED: ${attempts.map(safeAttemptSummary).join('; ')}`,
      'SEARCH_WEB_EXTRACT_FAILED',
    )
    this.name = 'WebExtractToolError'
    this.attempts = Object.freeze(attempts.map(attempt => Object.freeze({ ...attempt })))
  }
}

function assertOnlyDeclaredArguments(args: WebExtractArgs): void {
  const unexpected = Object.keys(args).filter(key => key !== 'url' && key !== 'format')
  if (unexpected.length > 0) {
    throw new ToolArgsError(unexpected.map(key => `"${key}" is not allowed`))
  }
}

function normalizedArgumentUrl(args: WebExtractArgs, config: Config): string {
  try {
    return normalizeWebExtractUrl(args.url, config.webExtract.maxUrlCharacters)
  } catch (error) {
    if (isProviderError(error) && error.kind === 'invalid_request') {
      throw new ToolArgsError([
        '"url" must be a non-empty absolute HTTP(S) URL without userinfo and within the configured length limit',
      ])
    }
    throw error
  }
}

async function executeWebExtract(
  args: WebExtractArgs,
  exec: ToolRunContext,
  dependencies: WebExtractToolDependencies,
  signal: AbortSignal,
): Promise<WebExtractOutput> {
  assertOnlyDeclaredArguments(args)
  const config = dependencies.getConfig()
  const url = normalizedArgumentUrl(args, config)
  throwIfAborted(signal)
  try {
    const result = await dependencies.orchestrator.extract({
      url,
      ...(args.format === undefined ? {} : { format: args.format }),
      config,
      signal,
    })
    throwIfAborted(signal)
    return projectWebExtractOutput(result, config)
  } catch (error) {
    if (error instanceof WebExtractInfrastructureError) {
      throw new WebExtractToolError(error.routeStatuses)
    }
    throw error
  }
}

/** Build the one global webpage-body Consumer over the fixed four-route chain. */
export function createWebExtractTool(
  dependencies: WebExtractToolDependencies,
): ToolDefinition {
  return defineTool({
    name: 'web_extract',
    description: 'Read a specific HTTP(S) URL through independent extraction/direct routes. No JavaScript or login; host-reachable addresses may be accessed, and evidence differs by route.',
    parameters: WEB_EXTRACT_PARAMETERS,
    output: {
      schema: WEB_EXTRACT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderWebExtractText(value) }],
      presentationMeta: webExtractPresentationMeta,
    },
    async execute(args, exec) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeWebExtract(args, exec, dependencies, signal),
        exec.agent,
      )
    },
    presentCall: presentWebExtractCall,
    presentResult: presentWebExtractResult,
  })
}

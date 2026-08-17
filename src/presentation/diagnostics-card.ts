import type {
  JsonValue,
  ToolCallView,
  ToolResult,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'

import { MINIMUM_CAPABILITY_PROFILES } from '../config.js'
import { DIAGNOSTIC_ACTIONS, DIAGNOSTIC_CAPABILITIES } from '../diagnostics/types.js'
import { isSearchDiagnosticsModelTextTruncated } from './render.js'
import type {
  SearchDiagnosticsArgs,
  SearchDiagnosticsOutput,
} from '../tools/schemas.js'

interface SearchDiagnosticsCardMeta {
  readonly version: 1
  readonly type: 'search_diagnostics'
  readonly action: SearchDiagnosticsOutput['action']
  readonly tested: boolean
  readonly capability_count: number
  readonly attempt_count: number
  readonly successful_count: number
  readonly warning_count: number
  readonly fallback_used: false
  readonly minimum_profile: SearchDiagnosticsOutput['minimum_profile']['profile']
  readonly minimum_satisfied: boolean
  readonly canonical_output_truncated: boolean
  readonly model_text_truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseMeta(value: unknown): SearchDiagnosticsCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'search_diagnostics'
    || typeof value.action !== 'string'
    || !DIAGNOSTIC_ACTIONS.includes(value.action as never)
    || typeof value.tested !== 'boolean'
    || value.fallback_used !== false
    || typeof value.minimum_profile !== 'string'
    || !MINIMUM_CAPABILITY_PROFILES.includes(value.minimum_profile as never)
    || typeof value.minimum_satisfied !== 'boolean'
    || typeof value.canonical_output_truncated !== 'boolean'
    || typeof value.model_text_truncated !== 'boolean'
    || !Number.isSafeInteger(value.capability_count)
    || (value.capability_count as number) < 0
    || !Number.isSafeInteger(value.attempt_count)
    || (value.attempt_count as number) < 0
    || !Number.isSafeInteger(value.successful_count)
    || (value.successful_count as number) < 0
    || !Number.isSafeInteger(value.warning_count)
    || (value.warning_count as number) < 0
  ) return undefined
  return {
    version: 1,
    type: 'search_diagnostics',
    action: value.action as SearchDiagnosticsCardMeta['action'],
    tested: value.tested,
    capability_count: value.capability_count as number,
    attempt_count: value.attempt_count as number,
    successful_count: value.successful_count as number,
    warning_count: value.warning_count as number,
    fallback_used: false,
    minimum_profile: value.minimum_profile as SearchDiagnosticsCardMeta['minimum_profile'],
    minimum_satisfied: value.minimum_satisfied,
    canonical_output_truncated: value.canonical_output_truncated,
    model_text_truncated: value.model_text_truncated,
  }
}

/** Persist only a bounded safe state summary; no Provider details or output text. */
export function searchDiagnosticsPresentationMeta(
  _args: SearchDiagnosticsArgs,
  value: SearchDiagnosticsOutput,
): JsonValue {
  const dispatchedAttempts = value.provider_attempts.filter(item => item.attempts > 0)
  return {
    version: 1,
    type: 'search_diagnostics',
    action: value.action,
    tested: value.tested,
    capability_count: Math.min(value.capability_status.length, DIAGNOSTIC_CAPABILITIES.length),
    attempt_count: dispatchedAttempts.length,
    successful_count: dispatchedAttempts.filter(item => item.outcome === 'success').length,
    warning_count: value.warnings.length,
    fallback_used: false,
    minimum_profile: value.minimum_profile.profile,
    minimum_satisfied: value.minimum_profile.satisfied,
    canonical_output_truncated: value.canonical_output_truncated,
    model_text_truncated: isSearchDiagnosticsModelTextTruncated(value),
  }
}

export function presentSearchDiagnosticsCall(args: SearchDiagnosticsArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: args.action === 'show'
      ? 'Inspect search capability status'
      : 'Test search Provider connectivity',
  }
}

export function presentSearchDiagnosticsResult(
  _args: SearchDiagnosticsArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) {
    return { card: 'generic', title: 'Search diagnostics failed' }
  }
  const meta = parseMeta(result.meta)
  if (meta === undefined) return undefined
  if (!meta.tested) {
    return {
      card: 'generic',
      title: `Search capability status (${meta.minimum_profile}, ${meta.minimum_satisfied ? 'satisfied' : 'not satisfied'})`,
    }
  }
  return {
    card: 'generic',
    title: `Search connectivity test (${meta.successful_count}/${meta.attempt_count} dispatched probes succeeded)`,
  }
}

import type {
  JsonValue,
  ToolCallView,
  ToolResult,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'

import {
  isResearchPlanModelTextTruncated,
} from '../research-plan/index.js'
import type {
  ResearchPlanArgs,
  ResearchPlanOutput,
} from '../tools/schemas.js'
import { RESEARCH_PLAN_BUDGETS, RESEARCH_PLAN_TOOLS } from '../tools/schemas.js'

interface ResearchPlanCardMeta {
  readonly version: 1
  readonly type: 'research_plan'
  readonly query_mode: ResearchPlanOutput['research_plan']['query_mode']
  readonly difficulty: ResearchPlanOutput['research_plan']['difficulty']
  readonly step_count: number
  readonly required_tools: readonly string[]
  readonly unavailable_tools: readonly string[]
  readonly canonical_output_truncated: boolean
  readonly model_text_truncated: boolean
}

const MAX_RESEARCH_PLAN_CALL_TITLE_CHARACTERS = 256

function displayQuestion(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= MAX_RESEARCH_PLAN_CALL_TITLE_CHARACTERS) return value
  return `${characters.slice(0, MAX_RESEARCH_PLAN_CALL_TITLE_CHARACTERS - 1).join('')}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every(item => typeof item === 'string')) return undefined
  return value as readonly string[]
}

function parseMeta(value: unknown): ResearchPlanCardMeta | undefined {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.type !== 'research_plan'
    || typeof value.query_mode !== 'string'
    || !RESEARCH_PLAN_BUDGETS.includes(value.query_mode as never)
    || typeof value.difficulty !== 'string'
    || !['low', 'standard', 'high'].includes(value.difficulty)
    || !Number.isSafeInteger(value.step_count)
    || (value.step_count as number) < 1
    || typeof value.canonical_output_truncated !== 'boolean'
    || typeof value.model_text_truncated !== 'boolean'
  ) return undefined
  const requiredTools = stringArray(value.required_tools)
  const unavailableTools = stringArray(value.unavailable_tools)
  if (
    requiredTools === undefined
    || unavailableTools === undefined
    || !requiredTools.every(tool => RESEARCH_PLAN_TOOLS.includes(tool as never))
    || !unavailableTools.every(tool => RESEARCH_PLAN_TOOLS.includes(tool as never))
  ) return undefined
  return {
    version: 1,
    type: 'research_plan',
    query_mode: value.query_mode as ResearchPlanCardMeta['query_mode'],
    difficulty: value.difficulty as ResearchPlanCardMeta['difficulty'],
    step_count: value.step_count as number,
    required_tools: requiredTools,
    unavailable_tools: unavailableTools,
    canonical_output_truncated: value.canonical_output_truncated,
    model_text_truncated: value.model_text_truncated,
  }
}

/** Persist only bounded planning facts needed for a generic replay card. */
export function researchPlanPresentationMeta(
  _args: ResearchPlanArgs,
  value: ResearchPlanOutput,
): JsonValue {
  const plan = value.research_plan
  return {
    version: 1,
    type: 'research_plan',
    query_mode: plan.query_mode,
    difficulty: plan.difficulty,
    step_count: plan.steps.length,
    required_tools: plan.preflight.required_tools.slice(),
    unavailable_tools: plan.preflight.unavailable_tools.slice(),
    canonical_output_truncated: plan.canonical_output_truncated,
    model_text_truncated: isResearchPlanModelTextTruncated(value),
  }
}

/** Pending planning is a generic search-intent card, never a retrieval card. */
export function presentResearchPlanCall(args: ResearchPlanArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `Plan research: ${displayQuestion(args.question)}`,
  }
}

/** Completed planning remains generic because this tool did not retrieve web data. */
export function presentResearchPlanResult(
  _args: ResearchPlanArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Offline research planning failed' }
  const meta = parseMeta(result.meta)
  if (meta === undefined) return undefined
  const availability = meta.unavailable_tools.length === 0
    ? ''
    : '; preflight required'
  return {
    card: 'generic',
    title: `Offline research plan (${meta.query_mode}, ${meta.step_count} steps${availability})`,
  }
}

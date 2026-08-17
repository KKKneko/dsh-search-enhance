import {
  ToolArgsError,
  defineTool,
  parameterSchemaSpecToJsonSchema,
  type JsonValue,
  type ToolCallView,
  type ToolDefinition,
  type ToolResult,
  type ToolResultView,
  type ToolRunContext,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

import type { ToolDiscoveryMode } from '../config.js'
import {
  CAPABILITY_GROUP_DEFINITIONS,
  CAPABILITY_GROUPS,
  SEARCH_TOOLS_MAX_CAPABILITIES,
  SEARCH_TOOLS_MIN_CAPABILITIES,
  deduplicateCapabilityGroups,
  orderCapabilityGroups,
  parseSearchToolsArguments,
  toolsForCapabilityGroups,
  type CapabilityGroup,
} from '../tool-discovery/capabilities.js'
import { foldToolDisclosureEvents } from '../tool-discovery/fold.js'
import {
  assertUtf8WithinLimit,
  throwIfAborted,
  truncateUtf8,
  utf8ByteLength,
} from '../provider-runtime/index.js'

export interface SearchToolsArgs {
  readonly capabilities: CapabilityGroup[]
}

export interface SearchToolsGroupOutput {
  readonly group: CapabilityGroup
  readonly description: string
  readonly tools: string[]
}

export interface SearchToolsOutput {
  readonly requested_groups: CapabilityGroup[]
  readonly added_groups: CapabilityGroup[]
  readonly active_groups: CapabilityGroup[]
  readonly groups: SearchToolsGroupOutput[]
  readonly added_tools: string[]
  readonly disclosed_tools: string[]
  readonly takes_effect: 'next_step'
}

export const SEARCH_TOOLS_CANONICAL_MAX_BYTES = 16 * 1024
export const SEARCH_TOOLS_MODEL_TEXT_MAX_BYTES = 16 * 1024

const CAPABILITIES_VALUE_SCHEMA = {
  type: 'array',
  items: {
    type: 'string',
    enum: CAPABILITY_GROUPS,
  },
  description: 'One to five deferred search capability groups to disclose for this Agent.',
} as const

const SEARCH_TOOLS_PARAMETER_SPEC = {
  capabilities: {
    ...CAPABILITIES_VALUE_SCHEMA,
    required: true,
  },
} as const

/** Exact model-visible closed schema; execute enforces the DSL's documented 1-5 bound. */
export const SEARCH_TOOLS_PARAMETERS = Object.freeze({
  ...parameterSchemaSpecToJsonSchema(SEARCH_TOOLS_PARAMETER_SPEC),
  additionalProperties: false,
})

const groupOutputSchema = {
  type: 'object',
  properties: {
    group: { type: 'string', enum: CAPABILITY_GROUPS, required: true },
    description: { type: 'string', required: true },
    tools: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export const SEARCH_TOOLS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    requested_groups: {
      type: 'array',
      items: { type: 'string', enum: CAPABILITY_GROUPS },
      required: true,
    },
    added_groups: {
      type: 'array',
      items: { type: 'string', enum: CAPABILITY_GROUPS },
      required: true,
    },
    active_groups: {
      type: 'array',
      items: { type: 'string', enum: CAPABILITY_GROUPS },
      required: true,
    },
    groups: {
      type: 'array',
      items: groupOutputSchema,
      required: true,
    },
    added_tools: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
    disclosed_tools: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
    takes_effect: { type: 'string', const: 'next_step', required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export interface SearchToolsDependencies {
  readonly mode: ToolDiscoveryMode
}

function assertArguments(value: unknown): readonly CapabilityGroup[] {
  const parsed = parseSearchToolsArguments(value)
  if (parsed !== undefined) return parsed
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const unexpected = Object.keys(value).filter(key => key !== 'capabilities')
    if (unexpected.length > 0) {
      throw new ToolArgsError(unexpected.map(key => `"${key}" is not allowed`))
    }
  }
  throw new ToolArgsError([
    `"capabilities" must contain ${SEARCH_TOOLS_MIN_CAPABILITIES}-${SEARCH_TOOLS_MAX_CAPABILITIES} dense values from the fixed capability enum`,
  ])
}

/** Build one deterministic canonical result without consulting mutable runtime state. */
export function projectSearchToolsOutput(
  requested: readonly CapabilityGroup[],
  activeBefore: readonly CapabilityGroup[],
): SearchToolsOutput {
  const requestedGroups = deduplicateCapabilityGroups(requested)
  const activeBeforeSet = new Set(activeBefore)
  const addedGroups = requestedGroups.filter(group => !activeBeforeSet.has(group))
  const activeGroups = orderCapabilityGroups([...activeBefore, ...requestedGroups])
  return {
    requested_groups: [...requestedGroups],
    added_groups: addedGroups,
    active_groups: [...activeGroups],
    groups: requestedGroups.map(group => ({
      group,
      description: CAPABILITY_GROUP_DEFINITIONS[group].description,
      tools: [...CAPABILITY_GROUP_DEFINITIONS[group].tools],
    })),
    added_tools: [...toolsForCapabilityGroups(addedGroups)],
    disclosed_tools: [...toolsForCapabilityGroups(activeGroups)],
    takes_effect: 'next_step',
  }
}

/** The closed, finite output must fit in full; semantic activation is never truncated. */
export function boundSearchToolsOutput(
  value: SearchToolsOutput,
  maximumBytes = SEARCH_TOOLS_CANONICAL_MAX_BYTES,
): SearchToolsOutput {
  assertUtf8WithinLimit(JSON.stringify(value), maximumBytes, 'search_tools canonical output')
  return value
}

const TRUNCATION_MARKER = '[search_tools model text truncated]'

/** Render a bounded UTF-8 projection without splitting a Unicode code point. */
export function renderSearchToolsText(
  value: SearchToolsOutput,
  maximumBytes = SEARCH_TOOLS_MODEL_TEXT_MAX_BYTES,
): string {
  const complete = JSON.stringify(value, null, 2)
  if (utf8ByteLength(complete) <= maximumBytes) return complete
  const suffix = `\n${TRUNCATION_MARKER}`
  const suffixBytes = utf8ByteLength(suffix)
  if (suffixBytes <= maximumBytes) {
    return `${truncateUtf8(complete, maximumBytes - suffixBytes).text}${suffix}`
  }
  return truncateUtf8(TRUNCATION_MARKER, maximumBytes).text
}

interface SearchToolsCardMeta {
  readonly version: 1
  readonly type: 'search_tools'
  readonly requested_count: number
  readonly added_count: number
  readonly active_count: number
  readonly takes_effect: 'next_step'
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseMeta(value: unknown): SearchToolsCardMeta | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const meta = value as Record<string, unknown>
  if (
    meta.version !== 1
    || meta.type !== 'search_tools'
    || meta.takes_effect !== 'next_step'
  ) return undefined
  if (![
    meta.requested_count,
    meta.added_count,
    meta.active_count,
  ].every(nonNegativeInteger)) return undefined
  return {
    version: 1,
    type: 'search_tools',
    requested_count: meta.requested_count as number,
    added_count: meta.added_count as number,
    active_count: meta.active_count as number,
    takes_effect: 'next_step',
  }
}

export function searchToolsPresentationMeta(
  _args: SearchToolsArgs,
  value: SearchToolsOutput,
): JsonValue {
  return {
    version: 1,
    type: 'search_tools',
    requested_count: value.requested_groups.length,
    added_count: value.added_groups.length,
    active_count: value.active_groups.length,
    takes_effect: 'next_step',
  }
}

export function presentSearchToolsCall(args: SearchToolsArgs): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `Disclose search capabilities (${deduplicateCapabilityGroups(args.capabilities).length})`,
  }
}

export function presentSearchToolsResult(
  _args: SearchToolsArgs,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return { card: 'generic', title: 'Search capability disclosure failed' }
  const meta = parseMeta(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'generic',
    title: meta.added_count === 0
      ? `Search capabilities already disclosed (${meta.active_count} active)`
      : `Search capabilities disclosed (${meta.added_count} added; next step)`,
  }
}

/** Build the resident, exclusive Agent-scoped capability disclosure tool. */
export function createSearchToolsTool(
  dependencies: SearchToolsDependencies,
): ToolDefinition {
  const definition = defineTool({
    name: 'search_tools',
    description: 'Disclose one or more deferred search capability groups for the current Agent. Use only when the resident search tools cannot complete the task; do not activate every group preemptively. A successful call takes effect on the next model step and does not bypass restrictions from other Presets.',
    parameters: SEARCH_TOOLS_PARAMETER_SPEC,
    output: {
      schema: SEARCH_TOOLS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearchToolsText(value) }],
      presentationMeta: searchToolsPresentationMeta,
    },
    async execute(args, exec: ToolRunContext) {
      throwIfAborted(exec.signal)
      if (exec.agent === undefined) throw new Error('search_tools requires a live Agent session')
      const requested = assertArguments(args)
      const activeBefore = dependencies.mode === 'all'
        ? CAPABILITY_GROUPS
        : foldToolDisclosureEvents(exec.agent.session.events).activeGroups
      const value = boundSearchToolsOutput(projectSearchToolsOutput(requested, activeBefore))
      throwIfAborted(exec.signal)
      return value
    },
    presentCall: presentSearchToolsCall,
    presentResult: presentSearchToolsResult,
  })

  // defineTool compiles an implicit open root. Keep its typed execution wrapper
  // and replace only the public projection with the supported closed-root schema;
  // the DSL has no array-cardinality keyword, so assertArguments owns that bound.
  return Object.freeze({ ...definition, parameters: SEARCH_TOOLS_PARAMETERS })
}

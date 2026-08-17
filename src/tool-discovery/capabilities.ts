export const CAPABILITY_GROUPS = Object.freeze([
  'context7',
  'sources',
  'site_map',
  'planning',
  'diagnostics',
] as const)

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number]

export interface CapabilityGroupDefinition {
  readonly description: string
  readonly tools: readonly string[]
}

const context7Tools = Object.freeze([
  'context7_resolve_library_id',
  'context7_query_docs',
  'context7_get_library_docs',
  'context7_get_cached_doc_raw',
] as const)

/** Stable public capability-to-tool mapping shared by disclosure, replay, and prompts. */
export const CAPABILITY_GROUP_DEFINITIONS: Readonly<
  Record<CapabilityGroup, CapabilityGroupDefinition>
> = Object.freeze({
  context7: Object.freeze({
    description: 'Granular Context7 library resolution, documentation lookup, and cached-document access.',
    tools: context7Tools,
  }),
  sources: Object.freeze({
    description: 'Paginate durable source records returned by source-producing search tools.',
    tools: Object.freeze(['search_sources'] as const),
  }),
  site_map: Object.freeze({
    description: 'Discover bounded candidate URLs under a known website.',
    tools: Object.freeze(['web_map'] as const),
  }),
  planning: Object.freeze({
    description: 'Create an offline research plan for explicit deep-research work.',
    tools: Object.freeze(['research_plan'] as const),
  }),
  diagnostics: Object.freeze({
    description: 'Inspect masked search configuration or explicitly test Provider connectivity.',
    tools: Object.freeze(['search_diagnostics'] as const),
  }),
})

export const RESIDENT_TOOL_NAMES = Object.freeze([
  'web_search',
  'docs_search',
  'web_extract',
  'search_tools',
] as const)

export const DEFERRED_TOOL_NAMES = Object.freeze(
  CAPABILITY_GROUPS.flatMap(group => CAPABILITY_GROUP_DEFINITIONS[group].tools),
)

export const SEARCH_TOOLS_MIN_CAPABILITIES = 1
export const SEARCH_TOOLS_MAX_CAPABILITIES = CAPABILITY_GROUPS.length

const capabilityByTool = new Map<string, CapabilityGroup>()
for (const group of CAPABILITY_GROUPS) {
  for (const tool of CAPABILITY_GROUP_DEFINITIONS[group].tools) {
    capabilityByTool.set(tool, group)
  }
}

export function isCapabilityGroup(value: unknown): value is CapabilityGroup {
  return typeof value === 'string' && CAPABILITY_GROUPS.includes(value as CapabilityGroup)
}

export function capabilityGroupForTool(tool: string): CapabilityGroup | undefined {
  return capabilityByTool.get(tool)
}

export function isDeferredToolName(tool: string): boolean {
  return capabilityGroupForTool(tool) !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse the exact closed search_tools argument contract; malformed calls fail closed. */
export function parseSearchToolsArguments(
  value: unknown,
): readonly CapabilityGroup[] | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some(key => key !== 'capabilities')) return undefined
  const capabilities = value.capabilities
  if (
    !Array.isArray(capabilities)
    || capabilities.length < SEARCH_TOOLS_MIN_CAPABILITIES
    || capabilities.length > SEARCH_TOOLS_MAX_CAPABILITIES
  ) return undefined
  const groups: CapabilityGroup[] = []
  for (let index = 0; index < capabilities.length; index += 1) {
    if (!Object.hasOwn(capabilities, index)) return undefined
    const group = capabilities[index]
    if (!isCapabilityGroup(group)) return undefined
    groups.push(group)
  }
  return deduplicateCapabilityGroups(groups)
}

/** Stable first-occurrence de-duplication for one validated model request. */
export function deduplicateCapabilityGroups(
  groups: readonly CapabilityGroup[],
): readonly CapabilityGroup[] {
  const seen = new Set<CapabilityGroup>()
  const unique: CapabilityGroup[] = []
  for (const group of groups) {
    if (seen.has(group)) continue
    seen.add(group)
    unique.push(group)
  }
  return Object.freeze(unique)
}

/** Return a canonical capability order independent of event or request ordering. */
export function orderCapabilityGroups(
  groups: Iterable<CapabilityGroup>,
): readonly CapabilityGroup[] {
  const selected = new Set(groups)
  return Object.freeze(CAPABILITY_GROUPS.filter(group => selected.has(group)))
}

/** Flatten mapped tools in canonical group/tool order without duplicates. */
export function toolsForCapabilityGroups(
  groups: Iterable<CapabilityGroup>,
): readonly string[] {
  const selected = new Set(groups)
  const seen = new Set<string>()
  const tools: string[] = []
  for (const group of CAPABILITY_GROUPS) {
    if (!selected.has(group)) continue
    for (const tool of CAPABILITY_GROUP_DEFINITIONS[group].tools) {
      if (seen.has(tool)) continue
      seen.add(tool)
      tools.push(tool)
    }
  }
  return Object.freeze(tools)
}

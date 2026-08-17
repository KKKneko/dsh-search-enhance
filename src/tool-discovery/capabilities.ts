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
  readonly operations: readonly string[]
}

const context7Operations = Object.freeze([
  'context7_resolve_library_id',
  'context7_query_docs',
  'context7_get_library_docs',
  'context7_get_cached_doc_raw',
] as const)

/** Stable public capability-to-operation mapping shared by disclosure and replay. */
export const CAPABILITY_GROUP_DEFINITIONS: Readonly<
  Record<CapabilityGroup, CapabilityGroupDefinition>
> = Object.freeze({
  context7: Object.freeze({
    description: 'Granular Context7 library resolution, documentation lookup, and cached-document access.',
    operations: context7Operations,
  }),
  sources: Object.freeze({
    description: 'Paginate durable source records returned by source-producing search tools.',
    operations: Object.freeze(['search_sources'] as const),
  }),
  site_map: Object.freeze({
    description: 'Discover bounded candidate URLs under a known website.',
    operations: Object.freeze(['web_map'] as const),
  }),
  planning: Object.freeze({
    description: 'Create an offline research plan for explicit deep-research work.',
    operations: Object.freeze(['research_plan'] as const),
  }),
  diagnostics: Object.freeze({
    description: 'Inspect masked search configuration or explicitly test Provider connectivity.',
    operations: Object.freeze(['search_diagnostics'] as const),
  }),
})

export const RESIDENT_TOOL_NAMES = Object.freeze([
  'web_search',
  'docs_search',
  'web_extract',
  'search_tools',
  'search_call',
] as const)

export const DEFERRED_OPERATION_NAMES = Object.freeze(
  CAPABILITY_GROUPS.flatMap(group => CAPABILITY_GROUP_DEFINITIONS[group].operations),
)

export const SEARCH_TOOLS_MIN_CAPABILITIES = 1
export const SEARCH_TOOLS_MAX_CAPABILITIES = CAPABILITY_GROUPS.length

const capabilityByOperation = new Map<string, CapabilityGroup>()
for (const group of CAPABILITY_GROUPS) {
  for (const operation of CAPABILITY_GROUP_DEFINITIONS[group].operations) {
    capabilityByOperation.set(operation, group)
  }
}

export function isCapabilityGroup(value: unknown): value is CapabilityGroup {
  return typeof value === 'string' && CAPABILITY_GROUPS.includes(value as CapabilityGroup)
}

export function capabilityGroupForOperation(operation: string): CapabilityGroup | undefined {
  return capabilityByOperation.get(operation)
}

export function isDeferredOperationName(operation: string): boolean {
  return capabilityGroupForOperation(operation) !== undefined
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

/** Flatten mapped operations in canonical group/operation order without duplicates. */
export function operationsForCapabilityGroups(
  groups: Iterable<CapabilityGroup>,
): readonly string[] {
  const selected = new Set(groups)
  const seen = new Set<string>()
  const operations: string[] = []
  for (const group of CAPABILITY_GROUPS) {
    if (!selected.has(group)) continue
    for (const operation of CAPABILITY_GROUP_DEFINITIONS[group].operations) {
      if (seen.has(operation)) continue
      seen.add(operation)
      operations.push(operation)
    }
  }
  return Object.freeze(operations)
}

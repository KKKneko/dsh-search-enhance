import { deepFreeze, HarnessError } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import {
  ToolArgsError,
  ToolOutputError,
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  defineTool,
  parameterSchemaSpecToJsonSchema,
  validateJsonSchemaValue,
  type JsonValue,
  type ToolCallView,
  type ToolDefinition,
  type ToolResult,
  type ToolResultView,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import type { ToolDiscoveryMode } from '../config.js'
import { throwIfAborted } from '../provider-runtime/index.js'
import {
  CAPABILITY_GROUPS,
  DEFERRED_OPERATION_NAMES,
  capabilityGroupForOperation,
  isDeferredOperationName,
  operationsForCapabilityGroups,
  type CapabilityGroup,
} from '../tool-discovery/capabilities.js'
import { foldEffectiveToolDisclosureEvents } from '../tool-discovery/fold.js'

export interface DeferredOperationManifest {
  readonly name: string
  readonly description: string
  readonly parameters: JsonValue
  readonly call: {
    readonly tool: 'search_call'
    readonly operation: string
  }
}

interface DeferredOperationRecord {
  readonly capability: CapabilityGroup
  readonly definition: ToolDefinition
  readonly manifest: DeferredOperationManifest
}

function snapshotSchema(value: unknown, label: string): JsonValue {
  try {
    const snapshot = snapshotJsonValue(value)
    if (snapshot === undefined) throw new TypeError(`${label} is not lossless JSON`)
    return deepFreeze(snapshot) as JsonValue
  } catch (error) {
    throw new TypeError(`${label} could not be snapshotted`, { cause: error })
  }
}

function snapshotOperationOutput(operation: string, value: unknown): JsonValue {
  try {
    const snapshot = snapshotJsonValue(value)
    if (snapshot === undefined) {
      throw new ToolOutputError(operation, ['value is not lossless JSON'])
    }
    return deepFreeze(snapshot) as JsonValue
  } catch (error) {
    if (error instanceof ToolOutputError) throw error
    throw new ToolOutputError(operation, ['value snapshot failed'])
  }
}

function operationRunContext(
  exec: ToolRunContext,
  operation: string,
  args: Readonly<Record<string, JsonValue>>,
): ToolRunContext {
  return Object.freeze({
    ...exec,
    name: operation,
    arguments: args,
    deferContext: (...contexts: Parameters<ToolRunContext['deferContext']>) => exec.deferContext(...contexts),
    concludeTurn: () => exec.concludeTurn(),
  })
}

class SearchOperationUnavailableError extends HarnessError {
  constructor(operation: string, capability?: CapabilityGroup) {
    const detail = capability === undefined
      ? `unknown deferred search operation "${operation}"`
      : `deferred search operation "${operation}" is inactive; disclose capability "${capability}" with search_tools first`
    super(detail, 'SEARCH_OPERATION_UNAVAILABLE')
    this.name = 'SearchOperationUnavailableError'
  }
}

/**
 * Fiber-local definitions for operations that never enter ctx.tools. The
 * constructor snapshots the exact schemas used by manifests and rejects an
 * incomplete or ambiguous operation set at plugin load time.
 */
export class DeferredOperationRegistry {
  private readonly records = new Map<string, DeferredOperationRecord>()

  constructor(definitions: readonly ToolDefinition[]) {
    const byName = new Map<string, ToolDefinition>()
    for (const definition of definitions) {
      if (!isDeferredOperationName(definition.name)) {
        throw new TypeError(`unknown deferred search operation: ${definition.name}`)
      }
      if (byName.has(definition.name)) {
        throw new TypeError(`duplicate deferred search operation: ${definition.name}`)
      }
      byName.set(definition.name, definition)
    }

    const missing = DEFERRED_OPERATION_NAMES.filter(name => !byName.has(name))
    if (missing.length > 0) {
      throw new TypeError(`missing deferred search operations: ${missing.join(', ')}`)
    }

    for (const name of DEFERRED_OPERATION_NAMES) {
      const source = byName.get(name)
      if (source === undefined) continue
      if (source.finalizeContent !== undefined) {
        throw new TypeError(`deferred search operation "${name}" cannot define finalizeContent`)
      }
      if (typeof source.description !== 'string' || source.description.trim().length === 0) {
        throw new TypeError(`deferred search operation "${name}" requires a description`)
      }
      const parameters = snapshotSchema(source.parameters, `${name} parameters`)
      const outputSchema = snapshotSchema(source.output.schema, `${name} output schema`)
      assertObjectJsonSchema(parameters)
      assertSupportedJsonSchema(outputSchema)
      const capability = capabilityGroupForOperation(name)
      if (capability === undefined) throw new TypeError(`missing capability for operation: ${name}`)
      const definition: ToolDefinition = Object.freeze({
        ...source,
        parameters: parameters as ToolDefinition['parameters'],
        output: Object.freeze({
          ...source.output,
          schema: outputSchema as ToolDefinition['output']['schema'],
        }),
      })
      const manifest = deepFreeze({
        name,
        description: source.description,
        parameters,
        call: { tool: 'search_call' as const, operation: name },
      })
      this.records.set(name, { capability, definition, manifest })
    }
  }

  manifestsForGroups(groups: Iterable<CapabilityGroup>): readonly DeferredOperationManifest[] {
    return Object.freeze(operationsForCapabilityGroups(groups).map(name => {
      const record = this.records.get(name)
      if (record === undefined) throw new TypeError(`missing deferred search operation: ${name}`)
      return record.manifest
    }))
  }

  renderCapabilityDisclosure(group: CapabilityGroup): string {
    return [
      `Capability "${group}" is active for this Agent. Deferred operations remain behind the fixed search_call gateway.`,
      JSON.stringify({
        capability: group,
        gateway: 'search_call',
        operations: this.manifestsForGroups([group]),
      }, null, 2),
    ].join('\n')
  }

  async invoke(
    operation: string,
    args: Readonly<Record<string, JsonValue>>,
    exec: ToolRunContext,
    activeGroups: readonly CapabilityGroup[],
  ): Promise<JsonValue> {
    const record = this.requireActive(operation, activeGroups)
    throwIfAborted(exec.signal)
    const value = await record.definition.execute(
      args,
      operationRunContext(exec, operation, args),
    )
    throwIfAborted(exec.signal)
    return this.validateOutput(record, snapshotOperationOutput(operation, value))
  }

  render(
    operation: string,
    args: Readonly<Record<string, JsonValue>>,
    value: JsonValue,
  ) {
    const record = this.requireKnown(operation)
    return record.definition.output.render(args, this.validateOutput(record, value))
  }

  presentationMeta(
    operation: string,
    args: Readonly<Record<string, JsonValue>>,
    value: JsonValue,
  ): JsonValue {
    const record = this.requireKnown(operation)
    const validated = this.validateOutput(record, value)
    return {
      version: 1,
      type: 'search_call',
      operation,
      operation_meta: record.definition.output.presentationMeta?.(args, validated) ?? null,
    }
  }

  presentCall(
    operation: string,
    args: Readonly<Record<string, JsonValue>>,
  ): ToolCallView | undefined {
    return this.records.get(operation)?.definition.presentCall?.(args)
  }

  presentResult(
    operation: string,
    args: Readonly<Record<string, JsonValue>>,
    result: ToolResult,
  ): ToolResultView | undefined {
    const record = this.records.get(operation)
    if (record?.definition.presentResult === undefined) return undefined
    if (result.isError) return record.definition.presentResult(args, result)
    const meta = this.operationMeta(result.meta, operation)
    if (meta === undefined) return undefined
    return record.definition.presentResult(args, {
      content: result.content,
      isError: false,
      ...(meta === null ? {} : { meta }),
    })
  }

  isConcurrencySafe(operation: string, args: Readonly<Record<string, JsonValue>>): boolean {
    const record = this.records.get(operation)
    if (record?.definition.isConcurrencySafe === undefined) return false
    if (validateJsonSchemaValue(record.definition.parameters, args, '').length > 0) return false
    return record.definition.isConcurrencySafe(args) === true
  }

  private requireKnown(operation: string): DeferredOperationRecord {
    const record = this.records.get(operation)
    if (record === undefined) throw new SearchOperationUnavailableError(operation)
    return record
  }

  private requireActive(
    operation: string,
    activeGroups: readonly CapabilityGroup[],
  ): DeferredOperationRecord {
    const record = this.requireKnown(operation)
    if (!activeGroups.includes(record.capability)) {
      throw new SearchOperationUnavailableError(operation, record.capability)
    }
    return record
  }

  private operationMeta(value: JsonValue | undefined, operation: string): JsonValue | null | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const meta = value as Record<string, JsonValue>
    if (
      meta.version !== 1
      || meta.type !== 'search_call'
      || meta.operation !== operation
      || !Object.hasOwn(meta, 'operation_meta')
    ) return undefined
    return meta.operation_meta === null ? null : meta.operation_meta
  }

  private validateOutput(record: DeferredOperationRecord, value: JsonValue): JsonValue {
    const violations = validateJsonSchemaValue(record.definition.output.schema, value, 'value')
    if (violations.length > 0) throw new ToolOutputError(record.definition.name, violations)
    return value
  }
}

export interface SearchCallArgs {
  readonly operation: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

const SEARCH_CALL_PARAMETER_SPEC = {
  operation: {
    type: 'string',
    required: true,
    description: 'Exact operation name from a search_tools or source-produced operation manifest.',
  },
  arguments: {
    type: 'object',
    properties: {},
    additionalProperties: true,
    required: true,
    description: 'Arguments validated against the disclosed operation manifest before execution.',
  },
} as const

/** Fixed model-facing gateway schema; operation-specific schemas stay in append-only results. */
export const SEARCH_CALL_PARAMETERS = Object.freeze({
  ...parameterSchemaSpecToJsonSchema(SEARCH_CALL_PARAMETER_SPEC),
  additionalProperties: false,
})

export const SEARCH_CALL_OUTPUT_SCHEMA = { type: 'json' } as const

export interface SearchCallDependencies {
  readonly mode: ToolDiscoveryMode
  readonly registry: DeferredOperationRegistry
}

function assertSearchCallArguments(args: SearchCallArgs): SearchCallArgs {
  const unexpected = Object.keys(args).filter(key => key !== 'operation' && key !== 'arguments')
  if (unexpected.length > 0) {
    throw new ToolArgsError(unexpected.map(key => `"${key}" is not allowed`))
  }
  if (args.operation.trim().length === 0) {
    throw new ToolArgsError(['"operation" must be a non-empty manifest operation name'])
  }
  return args
}

function activeGroups(mode: ToolDiscoveryMode, exec: ToolRunContext): readonly CapabilityGroup[] {
  if (mode === 'all') return CAPABILITY_GROUPS
  if (exec.agent === undefined) throw new Error('search_call requires a live Agent session')
  return foldEffectiveToolDisclosureEvents(exec.agent.session.events).activeGroups
}

function searchCallResultView(args: SearchCallArgs, result: ToolResult): ToolResultView {
  return {
    card: 'generic',
    title: result.isError
      ? `Search operation failed: ${args.operation}`
      : `Search operation completed: ${args.operation}`,
  }
}

/** Build the permanent Native/Code gateway for every deferred search operation. */
export function createSearchCallTool(dependencies: SearchCallDependencies): ToolDefinition {
  const definition = defineTool({
    name: 'search_call',
    description: 'Execute one deferred search operation from an append-only manifest. The operation must already be active for this Agent; arguments and canonical output are validated against that operation\'s real schemas.',
    parameters: SEARCH_CALL_PARAMETER_SPEC,
    output: {
      schema: SEARCH_CALL_OUTPUT_SCHEMA,
      render: (args, value) => dependencies.registry.render(args.operation, args.arguments, value),
      presentationMeta: (args, value) => dependencies.registry.presentationMeta(
        args.operation,
        args.arguments,
        value,
      ),
    },
    async execute(args, exec: ToolRunContext) {
      const parsed = assertSearchCallArguments(args)
      if (exec.agent === undefined) throw new Error('search_call requires a live Agent session')
      return dependencies.registry.invoke(
        parsed.operation,
        parsed.arguments,
        exec,
        activeGroups(dependencies.mode, exec),
      )
    },
    isConcurrencySafe: args => dependencies.registry.isConcurrencySafe(
      args.operation,
      args.arguments,
    ),
    presentCall: args => dependencies.registry.presentCall(args.operation, args.arguments) ?? {
      card: 'generic',
      kind: 'search',
      title: `Run search operation: ${args.operation}`,
    },
    presentResult: (args, result) => dependencies.registry.presentResult(
      args.operation,
      args.arguments,
      result,
    ) ?? searchCallResultView(args, result),
  })

  // defineTool's implicit parameter root is open. Keep its typed wrappers while
  // exposing and enforcing the fixed closed gateway projection above.
  return Object.freeze({ ...definition, parameters: SEARCH_CALL_PARAMETERS })
}

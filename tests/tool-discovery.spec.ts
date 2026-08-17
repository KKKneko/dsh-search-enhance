import { Buffer } from 'node:buffer'

import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  type JsonValue,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  defineTool,
  jsonSchemaToTs,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { Config } from '../src/config.js'
import { renderDocsSearchText, renderWebSearchText } from '../src/presentation/render.js'
import {
  CAPABILITY_GROUP_DEFINITIONS,
  CAPABILITY_GROUPS,
  DEFERRED_OPERATION_NAMES,
  RESIDENT_TOOL_NAMES,
  createSourceProducedBlock,
  foldEffectiveToolDisclosureEvents,
  foldToolDisclosureEvents,
  operationsForCapabilityGroups,
} from '../src/tool-discovery/index.js'
import { createContext7Tools } from '../src/tools/context7.js'
import { ForegroundOperationScope } from '../src/tools/operations.js'
import { createResearchPlanTool } from '../src/tools/research-plan.js'
import {
  DEFERRED_CAPABILITY_NOTICE_MAX_BYTES,
  DEFERRED_OPERATION_MANIFEST_MAX_BYTES,
  DEFERRED_OPERATION_SCHEMA_MAX_BYTES,
  DeferredOperationRegistry,
  SEARCH_CALL_OUTPUT_SCHEMA,
  SEARCH_CALL_PARAMETERS,
  SEARCH_SOURCE_OPERATION_NOTICE_MAX_BYTES,
  createSearchCallTool,
} from '../src/tools/search-call.js'
import {
  SEARCH_TOOLS_CANONICAL_MAX_BYTES,
  SEARCH_TOOLS_OUTPUT_SCHEMA,
  SEARCH_TOOLS_PARAMETERS,
  boundSearchToolsOutput,
  createSearchToolsTool,
  projectSearchToolsOutput,
  renderSearchToolsText,
  type SearchToolsOutput,
} from '../src/tools/search-tools.js'
import { createSearchDiagnosticsTool } from '../src/tools/search-diagnostics.js'
import { createSearchSourcesTool } from '../src/tools/search-sources.js'
import type { DocsSearchOutput, WebSearchOutput } from '../src/tools/schemas.js'
import { createWebMapTool } from '../src/tools/web-map.js'

function stubDeferredOperation(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `${name} operation description`,
    parameters: {
      value: { type: 'string', required: true, description: `${name} input` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          operation: { type: 'string', required: true },
          value: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `${value.operation}:${value.value}` }],
    },
    async execute(args) {
      return { operation: name, value: args.value }
    },
    ...(name === 'web_map' ? { isConcurrencySafe: () => true } : {}),
  })
}

function operationRegistry(
  replacements: ReadonlyMap<string, ToolDefinition> = new Map(),
): DeferredOperationRegistry {
  return new DeferredOperationRegistry(
    DEFERRED_OPERATION_NAMES.map(name => replacements.get(name) ?? stubDeferredOperation(name)),
  )
}

function productionOperationRegistry(): {
  readonly operations: ForegroundOperationScope
  readonly registry: DeferredOperationRegistry
} {
  const config = Config({} as never)
  const operations = new ForegroundOperationScope()
  const getConfig = () => config
  const registry = new DeferredOperationRegistry([
    ...createContext7Tools({
      documentation: {} as never,
      getConfig,
      operations,
    }),
    createSearchSourcesTool({
      getConfig,
      operations,
      sources: {} as never,
    }),
    createWebMapTool({
      getConfig,
      operations,
      provider: {} as never,
    }),
    createResearchPlanTool({ getConfig, operations }),
    createSearchDiagnosticsTool({
      getConfig,
      operations,
      reporter: {} as never,
    }),
  ])
  return { operations, registry }
}

function runContext(
  name: string,
  args: unknown,
  agent: Agent | undefined,
  signal = new AbortController().signal,
): ToolRunContext {
  return {
    callId: CallId(`${name}-call`),
    rootCallId: CallId(`${name}-call`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    token: Symbol(name) as never,
    signal,
    deferContext() {},
    concludeTurn() {},
  }
}

function agentWithEvents(events: readonly SessionEvent[] = []): Agent {
  return {
    session: Session.create(SessionId(`tool-discovery-${Math.random()}`), events),
  } as Agent
}

function nativeCall(
  seq: number,
  callId: string,
  name: string,
  args: unknown,
): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      callId: CallId(callId),
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function nativeResult(
  seq: number,
  callId: string,
  options: {
    readonly isError?: boolean
    readonly sourceProducedBy?: 'web_search' | 'docs_search'
  } = {},
): SessionEvent {
  const isError = options.isError ?? false
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId(callId),
        content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
        isError,
      }),
      ...(isError ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
      ...(options.sourceProducedBy === undefined ? {} : {
        meta: {
          version: 1,
          type: options.sourceProducedBy,
          source_produced: true,
        },
      }),
    },
    sourceEventSeqs: [seq - 1],
    surfaceOp: 'append',
  }
}

function completedDisclosureEvents(capabilities: readonly string[]): SessionEvent[] {
  return [
    { type: 'step/start', seq: 0, time: 0, data: { turn: 1, step: 1 } },
    nativeCall(1, 'disclose', 'search_tools', { capabilities }),
    nativeResult(2, 'disclose'),
    { type: 'step/end', seq: 3, time: 3, data: { turn: 1, step: 1 } },
  ]
}

function sourceEvents(): SessionEvent[] {
  return [
    { type: 'step/start', seq: 0, time: 0, data: { turn: 1, step: 1 } },
    nativeCall(1, 'source', 'docs_search', { query: 'React docs' }),
    nativeResult(2, 'source', { sourceProducedBy: 'docs_search' }),
    { type: 'step/end', seq: 3, time: 3, data: { turn: 1, step: 1 } },
  ]
}

describe('progressive capability definitions and folding', () => {
  it('keeps one canonical fixed surface and deferred operation mapping', () => {
    expect(CAPABILITY_GROUPS).toEqual([
      'context7',
      'sources',
      'site_map',
      'planning',
      'diagnostics',
    ])
    expect(RESIDENT_TOOL_NAMES).toEqual([
      'web_search',
      'docs_search',
      'web_extract',
      'search_tools',
      'search_call',
    ])
    expect(CAPABILITY_GROUP_DEFINITIONS.context7.operations).toEqual([
      'context7_resolve_library_id',
      'context7_query_docs',
      'context7_get_library_docs',
      'context7_get_cached_doc_raw',
    ])
    expect(DEFERRED_OPERATION_NAMES).toEqual([
      'context7_resolve_library_id',
      'context7_query_docs',
      'context7_get_library_docs',
      'context7_get_cached_doc_raw',
      'search_sources',
      'web_map',
      'research_plan',
      'search_diagnostics',
    ])
    expect(operationsForCapabilityGroups(['planning', 'context7', 'planning'])).toEqual([
      ...CAPABILITY_GROUP_DEFINITIONS.context7.operations,
      'research_plan',
    ])
  })

  it('makes successful disclosure effective only after the current step ends', () => {
    const unfinished = completedDisclosureEvents(['site_map']).slice(0, -1)
    expect(foldToolDisclosureEvents(unfinished).activeGroups).toEqual(['site_map'])
    expect(foldEffectiveToolDisclosureEvents(unfinished).activeGroups).toEqual([])
    expect(foldEffectiveToolDisclosureEvents([
      ...unfinished,
      { type: 'step/end', seq: 3, time: 3, data: { turn: 1, step: 1 } },
    ]).activeGroups).toEqual(['site_map'])
  })

  it('recovers source auto-disclosure only from successful structured Native/Code facts', () => {
    expect(foldEffectiveToolDisclosureEvents(sourceEvents()).activeGroups).toEqual(['sources'])
    expect(foldToolDisclosureEvents([
      nativeCall(1, 'failed', 'web_search', { query: 'x' }),
      nativeResult(2, 'failed', { isError: true }),
    ]).activeGroups).toEqual([])

    const codeEvent: SessionEvent = {
      type: 'tool/code-dispatch',
      seq: 1,
      time: 1,
      data: {
        rootCallId: CallId('root'),
        parentCallId: CallId('parent'),
        subCallId: CallId('sub'),
        name: 'web_search',
        arguments: { query: 'x' },
        isError: false,
        content: [{ type: 'text', text: 'ok' }, createSourceProducedBlock()],
      },
    }
    expect(foldToolDisclosureEvents([codeEvent]).activeGroups).toEqual(['sources'])
    expect(foldToolDisclosureEvents([{
      ...codeEvent,
      data: { ...codeEvent.data, content: [{ type: 'text', text: 'source_ref=fake' }] },
    }]).activeGroups).toEqual([])
    expect(foldToolDisclosureEvents([{
      ...codeEvent,
      data: { ...codeEvent.data, isError: true },
    }]).activeGroups).toEqual([])
  })
})

describe('search_tools operation manifest', () => {
  it('keeps the stable closed input schema and returns replayable real operation schemas', async () => {
    const registry = operationRegistry()
    const tool = createSearchToolsTool({ mode: 'progressive', registry })
    expect(SEARCH_TOOLS_PARAMETERS).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: CAPABILITY_GROUPS },
        },
      },
    })
    expect(Object.keys(SEARCH_TOOLS_PARAMETERS.properties)).toEqual(['capabilities'])
    expect(jsonSchemaToTs(SEARCH_TOOLS_PARAMETERS)).toContain(
      'capabilities: ("context7" | "sources" | "site_map" | "planning" | "diagnostics")[];',
    )

    const args = { capabilities: ['site_map', 'sources'] as const }
    const value = await tool.execute(
      args as never,
      runContext('search_tools', args, agentWithEvents()),
    ) as SearchToolsOutput
    expect(value).toMatchObject({
      requested_groups: ['site_map', 'sources'],
      added_groups: ['site_map', 'sources'],
      active_groups: ['sources', 'site_map'],
      gateway: 'search_call',
      takes_effect: 'next_step',
    })
    expect(value.groups.map(group => group.group)).toEqual(['site_map', 'sources'])
    expect(value.groups[0]?.operations[0]).toEqual({
      name: 'web_map',
      description: 'web_map operation description',
      parameters: expect.objectContaining({
        type: 'object',
        required: ['value'],
      }),
      output_schema: {
        type: 'object',
        properties: {
          operation: { type: 'string' },
          value: { type: 'string' },
        },
        additionalProperties: false,
        required: ['operation', 'value'],
      },
      call: { tool: 'search_call', operation: 'web_map' },
    })
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(SEARCH_TOOLS_OUTPUT_SCHEMA),
      value,
    )).toEqual([])
  })

  it('builds the complete real operation manifest within the canonical bound', async () => {
    const production = productionOperationRegistry()
    try {
      const value = projectSearchToolsOutput(CAPABILITY_GROUPS, [], production.registry)
      expect(value.groups.flatMap(group => group.operations.map(operation => operation.name)))
        .toEqual(DEFERRED_OPERATION_NAMES)
      expect(value.groups.flatMap(group => group.operations).every(operation => (
        Buffer.byteLength(JSON.stringify(operation), 'utf8')
        <= DEFERRED_OPERATION_MANIFEST_MAX_BYTES
      ))).toBe(true)
      expect(Buffer.byteLength(
        production.registry.renderCapabilityDisclosure('context7'),
        'utf8',
      )).toBeLessThanOrEqual(DEFERRED_CAPABILITY_NOTICE_MAX_BYTES)
      expect(() => boundSearchToolsOutput(value)).not.toThrow()
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8'))
        .toBeLessThanOrEqual(SEARCH_TOOLS_CANONICAL_MAX_BYTES)
    } finally {
      await production.operations.stop()
    }
  })

  it('rejects oversized operation schemas and source notices before disclosure', () => {
    const operationWithOutputDescription = (description: string): ToolDefinition => defineTool({
      name: 'web_map',
      description: 'bounded output schema',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          description,
          properties: { value: { type: 'string', required: true } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.value }],
      },
      async execute(args) { return { value: args.value } },
    })
    const emptyDescription = operationWithOutputDescription('')
    const emptySchemaBytes = Buffer.byteLength(
      JSON.stringify(emptyDescription.output.schema),
      'utf8',
    )
    const exactDescription = 'x'.repeat(
      DEFERRED_OPERATION_SCHEMA_MAX_BYTES - emptySchemaBytes,
    )
    expect(() => operationRegistry(new Map([
      ['web_map', operationWithOutputDescription(exactDescription)],
    ]))).not.toThrow()
    expect(() => operationRegistry(new Map([
      ['web_map', operationWithOutputDescription(`${exactDescription}界`)],
    ]))).toThrow(/web_map output schema.*UTF-8 limit/i)

    const oversizedNotice = defineTool({
      name: 'search_sources',
      description: 'x'.repeat(5_000),
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) { return args.value },
    })
    const registry = operationRegistry(new Map([['search_sources', oversizedNotice]]))
    expect(() => registry.renderCapabilityDisclosure('sources'))
      .toThrow(/sources capability disclosure.*UTF-8 limit/i)
  })

  it('returns manifests again for already-active groups and honors all mode', async () => {
    const registry = operationRegistry()
    const args = { capabilities: ['site_map'] }
    const progressive = await createSearchToolsTool({ mode: 'progressive', registry }).execute(
      args as never,
      runContext('search_tools', args, agentWithEvents(completedDisclosureEvents(['site_map']))),
    ) as SearchToolsOutput
    expect(progressive.added_groups).toEqual([])
    expect(progressive.takes_effect).toBe('already_active')
    expect(progressive.groups[0]?.operations.map(operation => operation.name)).toEqual(['web_map'])

    const all = await createSearchToolsTool({ mode: 'all', registry }).execute(
      args as never,
      runContext('search_tools', args, agentWithEvents()),
    ) as SearchToolsOutput
    expect(all.added_groups).toEqual([])
    expect(all.active_groups).toEqual(CAPABILITY_GROUPS)
    expect(all.takes_effect).toBe('already_active')
  })

  it('bounds complete canonical and model projections without splitting Unicode', () => {
    const value = projectSearchToolsOutput(CAPABILITY_GROUPS, [], operationRegistry())
    const canonicalBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    expect(boundSearchToolsOutput(value, canonicalBytes)).toBe(value)
    expect(() => boundSearchToolsOutput(value, canonicalBytes - 1)).toThrow(
      /search_tools canonical output/i,
    )
    const multibyte = {
      ...value,
      groups: value.groups.map((group, index) => index === 0
        ? { ...group, description: `界🙂${group.description}` }
        : group),
    }
    const complete = renderSearchToolsText(multibyte)
    expect(JSON.parse(complete)).toEqual(multibyte)
    const compactBytes = Buffer.byteLength(JSON.stringify(multibyte), 'utf8')
    const over = renderSearchToolsText(multibyte, compactBytes - 1)
    expect(over).toContain('[search_tools model text truncated]')
    expect(Buffer.from(over, 'utf8').toString('utf8')).toBe(over)
  })
})

describe('search_call gateway', () => {
  it('exposes one fixed small schema and the selected operation canonical value', async () => {
    const registry = operationRegistry()
    const tool = createSearchCallTool({ mode: 'progressive', registry })
    expect(SEARCH_CALL_PARAMETERS).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: expect.objectContaining({ type: 'string' }),
        arguments: expect.objectContaining({
          type: 'object',
          additionalProperties: true,
        }),
      },
      required: ['operation', 'arguments'],
    })
    expect(valueSchemaSpecToJsonSchema(SEARCH_CALL_OUTPUT_SCHEMA)).toEqual({})

    const args = { operation: 'web_map', arguments: { value: 'docs' } }
    const value = await tool.execute(
      args,
      runContext('search_call', args, agentWithEvents(completedDisclosureEvents(['site_map']))),
    ) as JsonValue
    expect(value).toEqual({ operation: 'web_map', value: 'docs' })
    expect(tool.output.render(args, value)).toEqual([
      { type: 'text', text: 'web_map:docs' },
    ])
    expect(tool.isConcurrencySafe?.(args)).toBe(true)
  })

  it('uses real operation definitions for fail-closed concurrency classification', async () => {
    const production = productionOperationRegistry()
    try {
      const tool = createSearchCallTool({ mode: 'all', registry: production.registry })
      expect(tool.isConcurrencySafe?.({
        operation: 'web_map',
        arguments: { url: 'https://example.test' },
      })).toBe(true)
      expect(tool.isConcurrencySafe?.({
        operation: 'research_plan',
        arguments: { question: 'Plan a bounded comparison' },
      })).toBe(true)
      expect(tool.isConcurrencySafe?.({
        operation: 'search_diagnostics',
        arguments: { action: 'show' },
      })).toBe(true)
      expect(tool.isConcurrencySafe?.({
        operation: 'search_sources',
        arguments: { source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      })).toBe(false)
      expect(tool.isConcurrencySafe?.({
        operation: 'context7_query_docs',
        arguments: { library_id: '/acme/sdk', query: 'docs' },
      })).toBe(false)
      expect(tool.isConcurrencySafe?.({ operation: 'web_map', arguments: {} })).toBe(false)

      const throwing = operationRegistry(new Map([[
        'web_map',
        defineTool({
          name: 'web_map',
          description: 'throwing classifier',
          parameters: { value: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return 'ok' },
          isConcurrencySafe() { throw new Error('classifier failed') },
        }),
      ]]))
      expect(createSearchCallTool({ mode: 'all', registry: throwing }).isConcurrencySafe?.({
        operation: 'web_map',
        arguments: { value: 'x' },
      })).toBe(false)
    } finally {
      await production.operations.stop()
    }
  })

  it('fails closed while inactive, for unknown operations, and during the disclosure step', async () => {
    const tool = createSearchCallTool({ mode: 'progressive', registry: operationRegistry() })
    const args = { operation: 'web_map', arguments: { value: 'docs' } }
    await expect(tool.execute(args, runContext('search_call', args, agentWithEvents())))
      .rejects.toMatchObject({ code: 'SEARCH_OPERATION_UNAVAILABLE' })
    await expect(tool.execute(
      { operation: 'unknown', arguments: {} },
      runContext('search_call', { operation: 'unknown', arguments: {} }, agentWithEvents()),
    )).rejects.toMatchObject({ code: 'SEARCH_OPERATION_UNAVAILABLE' })

    const unfinished = completedDisclosureEvents(['site_map']).slice(0, -1)
    await expect(tool.execute(
      args,
      runContext('search_call', args, agentWithEvents(unfinished)),
    )).rejects.toMatchObject({ code: 'SEARCH_OPERATION_UNAVAILABLE' })
  })

  it('revalidates raw operation arguments before the body and snapshots them canonically', async () => {
    let calls = 0
    let observedArgs: unknown
    const rawOperation: ToolDefinition = {
      name: 'web_map',
      description: 'raw operation definition',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { value: string }).value,
        }],
      },
      async execute(args) {
        calls += 1
        observedArgs = args
        return { value: (args as { value: string }).value }
      },
    }
    const registry = operationRegistry(new Map([['web_map', rawOperation]]))
    const tool = createSearchCallTool({ mode: 'progressive', registry })
    const activeAgent = agentWithEvents(completedDisclosureEvents(['site_map']))
    const invalid = { operation: 'web_map', arguments: {} }
    await expect(tool.execute(invalid, runContext('search_call', invalid, activeAgent)))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(calls).toBe(0)

    const input = { value: 'canonical' }
    const valid = { operation: 'web_map', arguments: input }
    await expect(tool.execute(valid, runContext('search_call', valid, activeAgent)))
      .resolves.toEqual({ value: 'canonical' })
    expect(calls).toBe(1)
    expect(observedArgs).not.toBe(input)
    expect(Object.isFrozen(observedArgs)).toBe(true)
  })

  it('validates the real operation arguments and output after capability checks', async () => {
    const activeAgent = agentWithEvents(completedDisclosureEvents(['site_map']))
    const registry = operationRegistry(new Map([[
      'web_map',
      defineTool({
        name: 'web_map',
        description: 'invalid output operation',
        parameters: { value: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 42 as never },
      }),
    ]]))
    const tool = createSearchCallTool({ mode: 'progressive', registry })

    const invalidArgs = { operation: 'web_map', arguments: {} }
    await expect(tool.execute(
      invalidArgs,
      runContext('search_call', invalidArgs, activeAgent),
    )).rejects.toMatchObject({ code: 'INVALID_ARGS' })

    const invalidOutput = { operation: 'web_map', arguments: { value: 'x' } }
    await expect(tool.execute(
      invalidOutput,
      runContext('search_call', invalidOutput, activeAgent),
    )).rejects.toMatchObject({ code: 'INVALID_TOOL_OUTPUT' })

    const extra = { operation: 'web_map', arguments: { value: 'x' }, provider: 'x' }
    await expect(tool.execute(
      extra as never,
      runContext('search_call', extra, activeAgent),
    )).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  })

  it('forwards the exact cancellation signal and waits for the operation to settle', async () => {
    let releaseStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    let observedSignal: AbortSignal | undefined
    const operation = defineTool({
      name: 'web_map',
      description: 'cancellable web map',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        observedSignal = exec.signal
        releaseStarted?.()
        await new Promise<void>((_resolve, reject) => {
          if (exec.signal.aborted) reject(exec.signal.reason)
          else exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
        })
        return 'unreachable'
      },
    })
    const registry = operationRegistry(new Map([['web_map', operation]]))
    const tool = createSearchCallTool({ mode: 'progressive', registry })
    const controller = new AbortController()
    const args = { operation: 'web_map', arguments: { value: 'x' } }
    const pending = tool.execute(
      args,
      runContext(
        'search_call',
        args,
        agentWithEvents(completedDisclosureEvents(['site_map'])),
        controller.signal,
      ),
    )
    await started
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(observedSignal).toBe(controller.signal)
  })

  it('uses source auto-disclosure and permits all-mode calls without changing the schema', async () => {
    const registry = operationRegistry()
    const args = { operation: 'search_sources', arguments: { value: 'page' } }
    const progressive = createSearchCallTool({ mode: 'progressive', registry })
    await expect(progressive.execute(
      args,
      runContext('search_call', args, agentWithEvents(sourceEvents())),
    )).resolves.toEqual({ operation: 'search_sources', value: 'page' })

    const all = createSearchCallTool({ mode: 'all', registry })
    await expect(all.execute(
      args,
      runContext('search_call', args, agentWithEvents()),
    )).resolves.toEqual({ operation: 'search_sources', value: 'page' })
    expect(all.parameters).toEqual(progressive.parameters)
  })
})

describe('source-produced operation notice', () => {
  it('appends the real search_sources manifest within both resident result bounds', async () => {
    const production = productionOperationRegistry()
    const notice = production.registry.renderCapabilityDisclosure('sources')
    expect(Buffer.byteLength(notice, 'utf8')).toBeLessThanOrEqual(SEARCH_SOURCE_OPERATION_NOTICE_MAX_BYTES)
    expect(notice).toContain('"gateway":"search_call"')
    expect(notice).toContain('"operation":"search_sources"')
    expect(notice).toContain('"parameters"')
    expect(notice).toContain('"output_schema"')

    const web: WebSearchOutput = {
      state: 'complete',
      answer: 'answer '.repeat(1000),
      sources: [],
      source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      total_sources: 1,
      returned_sources: 0,
      truncated: false,
      evidence_level: 'discovery',
      warnings: [],
      model_text_max_bytes: Buffer.byteLength(notice, 'utf8') + 256,
    }
    const webText = renderWebSearchText(web, notice)
    expect(webText).toContain('"operation":"search_sources"')
    expect(Buffer.byteLength(webText, 'utf8')).toBeLessThanOrEqual(web.model_text_max_bytes)

    const multibyteNotice = `${notice}\n界🙂`
    const sourceTail = `Source reference: ${web.source_ref}\n\n${multibyteNotice}`
    const exactNoticeBytes = Buffer.byteLength(sourceTail, 'utf8')
    expect(renderWebSearchText({
      ...web,
      model_text_max_bytes: exactNoticeBytes,
    }, multibyteNotice)).toBe(sourceTail)
    const over = renderWebSearchText({
      ...web,
      model_text_max_bytes: exactNoticeBytes - 1,
    }, multibyteNotice)
    expect(Buffer.byteLength(over, 'utf8')).toBeLessThanOrEqual(exactNoticeBytes - 1)
    expect(Buffer.from(over, 'utf8').toString('utf8')).toBe(over)
    expect(Buffer.byteLength(renderWebSearchText({
      ...web,
      model_text_max_bytes: 3,
    }, multibyteNotice), 'utf8')).toBeLessThanOrEqual(3)
    const tiny = renderWebSearchText({
      ...web,
      model_text_max_bytes: 96,
    }, notice)
    expect(tiny).toContain('Source reference:')
    expect(tiny).not.toContain('"gateway":"search_call"')

    const docs: DocsSearchOutput = {
      state: 'complete',
      provider: 'context7',
      providers: [{ provider: 'context7', state: 'complete' }],
      snippets: [],
      sources: [],
      source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      cache: {
        resolve: { state: 'miss', evicted_entries: 0 },
        docs: { state: 'miss', evicted_entries: 0 },
      },
      total_sources: 1,
      returned_sources: 0,
      total_snippets: 0,
      returned_snippets: 0,
      truncated: false,
      evidence_level: 'discovery',
      warnings: [],
      model_text_max_bytes: Buffer.byteLength(notice, 'utf8') + 256,
    }
    const docsText = renderDocsSearchText(docs, notice)
    expect(docsText).toContain('"operation":"search_sources"')
    expect(Buffer.byteLength(docsText, 'utf8')).toBeLessThanOrEqual(docs.model_text_max_bytes)
    await production.operations.stop()
  })
})

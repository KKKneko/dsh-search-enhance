import { Buffer } from 'node:buffer'

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  jsonSchemaToTs,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_GROUP_DEFINITIONS,
  CAPABILITY_GROUPS,
  DEFERRED_TOOL_NAMES,
  RESIDENT_TOOL_NAMES,
  createSourceProducedBlock,
  createToolDisclosureFoldState,
  foldToolDisclosureEvent,
  foldToolDisclosureEvents,
  toolsForCapabilityGroups,
} from '../src/tool-discovery/index.js'
import {
  SEARCH_TOOLS_OUTPUT_SCHEMA,
  SEARCH_TOOLS_PARAMETERS,
  boundSearchToolsOutput,
  createSearchToolsTool,
  presentSearchToolsCall,
  presentSearchToolsResult,
  projectSearchToolsOutput,
  renderSearchToolsText,
  searchToolsPresentationMeta,
  type SearchToolsOutput,
} from '../src/tools/search-tools.js'

function runContext(
  args: unknown,
  agent: Agent | undefined,
  signal = new AbortController().signal,
): ToolRunContext {
  return {
    callId: CallId('search-tools-call'),
    rootCallId: CallId('search-tools-call'),
    name: 'search_tools',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    token: Symbol('search-tools') as never,
    signal,
    deferContext() {},
    concludeTurn() {},
  }
}

function agentWithEvents(events: readonly SessionEvent[] = []): Agent {
  return {
    session: Session.create(SessionId('tool-discovery-test'), events),
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
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

function nativeResult(
  seq: number,
  callId: string,
  options: {
    readonly isError?: boolean
    readonly code?: string
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
      ...(options.code === undefined ? {} : {
        error: { name: 'ToolError', code: options.code },
      }),
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

function codeDispatch(
  seq: number,
  name: string,
  args: unknown,
  isError = false,
  sourceProduced = false,
): SessionEvent {
  return {
    type: 'tool/code-dispatch',
    seq,
    time: seq,
    data: {
      rootCallId: CallId('root'),
      parentCallId: CallId('parent'),
      subCallId: CallId(`sub-${seq}`),
      name,
      arguments: args,
      isError,
      content: [
        { type: 'text', text: isError ? 'failed' : 'ok' },
        ...(sourceProduced ? [createSourceProducedBlock()] : []),
      ],
    },
  }
}

describe('progressive capability definitions', () => {
  it('keeps one stable group, resident, and deferred mapping', () => {
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
    ])
    expect(CAPABILITY_GROUP_DEFINITIONS.context7.tools).toEqual([
      'context7_resolve_library_id',
      'context7_query_docs',
      'context7_get_library_docs',
      'context7_get_cached_doc_raw',
    ])
    expect(DEFERRED_TOOL_NAMES).toEqual([
      'context7_resolve_library_id',
      'context7_query_docs',
      'context7_get_library_docs',
      'context7_get_cached_doc_raw',
      'search_sources',
      'web_map',
      'research_plan',
      'search_diagnostics',
    ])
    expect(toolsForCapabilityGroups(['planning', 'context7', 'planning'])).toEqual([
      ...CAPABILITY_GROUP_DEFINITIONS.context7.tools,
      'research_plan',
    ])
  })
})

describe('search_tools schema, execution, bounds, and presentation', () => {
  it('exposes a closed required fixed-enum schema and documents the enforced one-to-five bound', () => {
    expect(SEARCH_TOOLS_PARAMETERS).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          description: 'One to five deferred search capability groups to disclose for this Agent.',
          items: { type: 'string', enum: CAPABILITY_GROUPS },
        },
      },
    })
    expect(Object.keys(SEARCH_TOOLS_PARAMETERS.properties)).toEqual(['capabilities'])
    expect(SEARCH_TOOLS_PARAMETERS.properties.capabilities).not.toHaveProperty('minItems')
    expect(SEARCH_TOOLS_PARAMETERS.properties.capabilities).not.toHaveProperty('maxItems')
    expect(jsonSchemaToTs(SEARCH_TOOLS_PARAMETERS)).toContain(
      'capabilities: ("context7" | "sources" | "site_map" | "planning" | "diagnostics")[];',
    )
  })

  it('accepts one/five groups, stably de-duplicates, and reports monotonic state', async () => {
    const tool = createSearchToolsTool({ mode: 'progressive' })
    expect(tool.isConcurrencySafe).toBeUndefined()
    const agent = agentWithEvents()
    const oneArgs = { capabilities: ['site_map'] as const }
    const one = await tool.execute(oneArgs as never, runContext(oneArgs, agent))
    expect(one).toMatchObject({
      requested_groups: ['site_map'],
      added_groups: ['site_map'],
      active_groups: ['site_map'],
      added_tools: ['web_map'],
      disclosed_tools: ['web_map'],
      takes_effect: 'next_step',
    })

    const allArgs = { capabilities: [...CAPABILITY_GROUPS] }
    const all = await tool.execute(allArgs as never, runContext(allArgs, agent)) as SearchToolsOutput
    expect(all.requested_groups).toEqual(CAPABILITY_GROUPS)
    expect(all.active_groups).toEqual(CAPABILITY_GROUPS)
    expect(all.disclosed_tools).toEqual(DEFERRED_TOOL_NAMES)

    const duplicateArgs = {
      capabilities: ['planning', 'site_map', 'planning', 'sources'] as const,
    }
    const duplicate = await tool.execute(
      duplicateArgs as never,
      runContext(duplicateArgs, agent),
    ) as SearchToolsOutput
    expect(duplicate.requested_groups).toEqual(['planning', 'site_map', 'sources'])
    expect(duplicate.groups.map(group => group.group)).toEqual([
      'planning',
      'site_map',
      'sources',
    ])
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(SEARCH_TOOLS_OUTPUT_SCHEMA),
      duplicate,
    )).toEqual([])
  })

  it('rejects empty/over-limit/sparse/invalid/extra args and agentless execution', async () => {
    const tool = createSearchToolsTool({ mode: 'progressive' })
    const agent = agentWithEvents()
    const sparse = Array(1) as string[]
    const cases: unknown[] = [
      {},
      { capabilities: [] },
      { capabilities: [...CAPABILITY_GROUPS, 'sources'] },
      { capabilities: sparse },
      { capabilities: ['unknown'] },
      { capabilities: ['sources'], provider: 'context7' },
    ]
    for (const args of cases) {
      await expect(tool.execute(args as never, runContext(args, agent))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      })
    }
    const args = { capabilities: ['sources'] }
    await expect(tool.execute(args as never, runContext(args, undefined)))
      .rejects.toThrow('search_tools requires a live Agent session')
  })

  it('checks cancellation before and after its pure commit projection', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    const args = { capabilities: ['sources'] }
    await expect(createSearchToolsTool({ mode: 'progressive' }).execute(
      args as never,
      runContext(args, agentWithEvents(), controller.signal),
    )).rejects.toBe(reason)
  })

  it('uses all-mode state without writing a Session event or installing state', async () => {
    const args = { capabilities: ['site_map'] }
    const value = await createSearchToolsTool({ mode: 'all' }).execute(
      args as never,
      runContext(args, agentWithEvents()),
    ) as SearchToolsOutput
    expect(value.added_groups).toEqual([])
    expect(value.active_groups).toEqual(CAPABILITY_GROUPS)
    expect(value.disclosed_tools).toEqual(DEFERRED_TOOL_NAMES)
  })

  it('enforces exact/over/tiny/multibyte canonical and model-text UTF-8 bounds', () => {
    const value = projectSearchToolsOutput(CAPABILITY_GROUPS, [])
    const canonicalBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    expect(boundSearchToolsOutput(value, canonicalBytes)).toBe(value)
    expect(() => boundSearchToolsOutput(value, canonicalBytes - 1)).toThrow(/search_tools canonical output/i)
    expect(() => boundSearchToolsOutput(value, 1)).toThrow(/search_tools canonical output/i)

    const multibyte: SearchToolsOutput = {
      ...value,
      groups: value.groups.map((group, index) => index === 0
        ? { ...group, description: `界🙂${group.description}` }
        : group),
    }
    const complete = renderSearchToolsText(multibyte, 1024 * 1024)
    const exactBytes = Buffer.byteLength(complete, 'utf8')
    expect(renderSearchToolsText(multibyte, exactBytes)).toBe(complete)
    const over = renderSearchToolsText(multibyte, exactBytes - 1)
    expect(Buffer.byteLength(over, 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(over).toContain('[search_tools model text truncated]')
    expect(Buffer.from(over, 'utf8').toString('utf8')).toBe(over)
    expect(Buffer.byteLength(renderSearchToolsText(multibyte, 3), 'utf8')).toBeLessThanOrEqual(3)
  })

  it('keeps render/meta/cards pure and replayable with generic search intent', () => {
    const args = { capabilities: ['site_map', 'planning'] as const }
    const value = projectSearchToolsOutput([...args.capabilities], [])
    const meta = searchToolsPresentationMeta(args as never, value)
    const live = { isError: false, content: [], details: value, meta } as never
    const replay = { isError: false, content: [], details: undefined, meta } as never
    expect(presentSearchToolsCall(args as never)).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Disclose search capabilities (2)',
    })
    expect(meta).toEqual({
      version: 1,
      type: 'search_tools',
      requested_count: 2,
      added_count: 2,
      active_count: 2,
      takes_effect: 'next_step',
    })
    expect(presentSearchToolsResult(args as never, live)).toEqual(
      presentSearchToolsResult(args as never, replay),
    )
    expect(presentSearchToolsResult(args as never, live)).toEqual({
      card: 'generic',
      title: 'Search capabilities disclosed (2 added; next step)',
    })
    expect(presentSearchToolsResult(args as never, { isError: true } as never)).toEqual({
      card: 'generic',
      title: 'Search capability disclosure failed',
    })
  })
})

describe('standard Session event disclosure fold', () => {
  it('pairs only successful Native calls and merges groups monotonically', () => {
    const events = [
      nativeCall(1, 'one', 'search_tools', { capabilities: ['planning', 'site_map'] }),
      nativeResult(2, 'one'),
      nativeCall(3, 'two', 'search_tools', { capabilities: ['sources', 'planning'] }),
      nativeResult(4, 'two'),
    ]
    expect(foldToolDisclosureEvents(events).activeGroups).toEqual([
      'sources',
      'site_map',
      'planning',
    ])
  })

  it('ignores failed, cancelled, malformed, unknown, and unpaired Native events', () => {
    const events = [
      nativeCall(1, 'failed', 'search_tools', { capabilities: ['planning'] }),
      nativeResult(2, 'failed', { isError: true, code: 'FAILED' }),
      nativeCall(3, 'cancelled', 'search_tools', { capabilities: ['site_map'] }),
      nativeResult(4, 'cancelled', { isError: true, code: 'TOOL_ABORTED' }),
      nativeCall(5, 'invalid', 'search_tools', { capabilities: [] }),
      nativeResult(6, 'invalid'),
      nativeCall(7, 'malformed', 'search_tools', '{not-json'),
      nativeResult(8, 'malformed'),
      nativeCall(9, 'unknown', 'other_tool', {}),
      nativeResult(10, 'unknown'),
      nativeResult(11, 'never-called'),
      nativeCall(12, 'unpaired', 'search_tools', { capabilities: ['context7'] }),
    ]
    const folded = foldToolDisclosureEvents(events)
    expect(folded.activeGroups).toEqual([])
    expect([...folded.pendingNativeCalls.keys()]).toEqual(['unpaired'])
  })

  it('derives sources only from a successful durable structured source fact', () => {
    const successful = foldToolDisclosureEvents([
      nativeCall(1, 'docs', 'docs_search', { query: 'react' }),
      nativeResult(2, 'docs', { sourceProducedBy: 'docs_search' }),
    ])
    expect(successful.activeGroups).toEqual(['sources'])
    const sourceFree = foldToolDisclosureEvents([
      nativeCall(1, 'empty', 'web_search', { query: 'react' }),
      nativeResult(2, 'empty'),
    ])
    expect(sourceFree.activeGroups).toEqual([])
    const failed = foldToolDisclosureEvents([
      nativeCall(1, 'search', 'web_search', { query: 'react' }),
      nativeResult(2, 'search', { isError: true, code: 'FAILED' }),
    ])
    expect(failed.activeGroups).toEqual([])
  })

  it('lets live canonical source_ref facts override fail-closed durable recovery', () => {
    const call = nativeCall(1, 'live-source', 'web_search', { query: 'react' })
    const result = nativeResult(2, 'live-source')
    const pending = foldToolDisclosureEvent(createToolDisclosureFoldState(), call)
    expect(foldToolDisclosureEvent(pending, result, { sourceProduced: false }).activeGroups)
      .toEqual([])
    expect(foldToolDisclosureEvent(pending, result, { sourceProduced: true }).activeGroups)
      .toEqual(['sources'])
  })

  it('uses successful Code dispatch args and ignores starts/errors/malformed/unknown calls', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool/code-dispatch-start',
        seq: 1,
        time: 1,
        data: {
          rootCallId: CallId('root'),
          parentCallId: CallId('parent'),
          subCallId: CallId('start'),
          name: 'search_tools',
          arguments: { capabilities: ['context7'] },
        },
      },
      codeDispatch(2, 'search_tools', { capabilities: ['site_map', 'planning'] }),
      codeDispatch(3, 'search_tools', { capabilities: ['diagnostics'] }, true),
      codeDispatch(4, 'search_tools', { capabilities: [] }),
      codeDispatch(5, 'unknown', { capabilities: ['context7'] }),
      codeDispatch(6, 'docs_search', { query: 'react' }, false, true),
    ]
    expect(foldToolDisclosureEvents(events).activeGroups).toEqual([
      'sources',
      'site_map',
      'planning',
    ])
  })
})

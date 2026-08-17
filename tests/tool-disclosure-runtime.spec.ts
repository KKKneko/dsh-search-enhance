import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import {
  createScope,
  type Scope,
  type ScopeKey,
} from '@deepseek-ai/dsh-scope'
import {
  SessionId,
  SessionStore,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  SystemPrompt,
  renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import {
  ToolRuntime,
  defineTool,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { registerToolDiscoveryGuidance } from '../src/prompt/tool-discovery.js'
import {
  AgentToolDisclosureManager,
  createSourceProducedBlock,
  installAgentToolDisclosure,
  type RestrictionInstaller,
} from '../src/tool-discovery/index.js'
import { createSearchToolsTool } from '../src/tools/search-tools.js'

const CORE_TOOLS = [
  'web_search',
  'docs_search',
  'web_extract',
  'search_tools',
] as const
const EXISTING_DEFERRED_TOOLS = [
  'search_sources',
  'web_map',
  'research_plan',
  'search_diagnostics',
  'context7_resolve_library_id',
  'context7_query_docs',
  'context7_get_library_docs',
  'context7_get_cached_doc_raw',
] as const
const ALL_EXISTING_TOOLS = [...CORE_TOOLS, ...EXISTING_DEFERRED_TOOLS]
const FULL_RESEARCH_ROUTE_GUIDANCE = 'For current or external factual questions, start with one focused web_search (use docs_search for SDK/API documentation); do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
const ENHANCE_RESEARCH_ROUTE_GUIDANCE = 'For current or external factual questions, start with one focused web_search; do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
const DOCS_RESEARCH_ROUTE_GUIDANCE = 'For current or external SDK/API documentation questions, start with one focused docs_search; do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
const DISCOVERY_EVIDENCE_GUIDANCE = 'Treat web_search/docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.'
const ENHANCE_DISCOVERY_EVIDENCE_GUIDANCE = 'Treat web_search answers, snippets, and source metadata as discovery, not claim-level evidence.'
const DOCS_DISCOVERY_EVIDENCE_GUIDANCE = 'Treat docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.'
const EXTRACTED_EVIDENCE_GUIDANCE = 'Before asserting decisive factual or causal conclusions, inspect selected authoritative URLs with web_extract; never present an inferred mechanism as source-stated fact, and label unestablished mechanisms as inference or unconfirmed.'
const INFERENCE_ONLY_GUIDANCE = 'Never present an inferred mechanism as source-stated fact; label unestablished mechanisms as inference or unconfirmed.'

function expectFullEvidenceGuidance(prompt: string): void {
  expect(prompt).toContain([
    FULL_RESEARCH_ROUTE_GUIDANCE,
    DISCOVERY_EVIDENCE_GUIDANCE,
    EXTRACTED_EVIDENCE_GUIDANCE,
  ].join('\n'))
}

function stubTool(name: string): ToolDefinition {
  if (name === 'docs_search') {
    return defineTool({
      name,
      description: `${name} runtime source-producing stub`,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: { source_ref: { type: 'string', required: true } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.source_ref }],
      },
      async execute() {
        return { source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
      },
    })
  }
  return defineTool({
    name,
    description: `${name} runtime test stub`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return name
    },
  })
}

const RICH_WEB_SEARCH_DEFINITION = defineTool({
  name: 'web_search',
  description: 'Rich Agent-scoped web search test definition.',
  parameters: {
    query: { type: 'string', required: true },
    profile: { type: 'string' },
    depth: { type: 'string' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute() {
    return 'rich-web-search'
  },
})

interface TestAgent {
  readonly agent: Agent
  readonly owner: ReturnType<Context['plugin']>
  readonly scope: Scope
  readonly session: Session
}

interface RuntimeHarness {
  readonly ctx: Context
  readonly runtime: ToolRuntime
  readonly toolFiber: ReturnType<Context['plugin']>
}

async function createHarness(): Promise<RuntimeHarness> {
  const ctx = new Context()
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx, { mode: 'native' })
  const toolFiber = ctx.plugin((pluginCtx: Context) => {
    for (const name of ALL_EXISTING_TOOLS) {
      pluginCtx.tools.register(
        name === 'search_tools'
          ? createSearchToolsTool({ mode: 'progressive' })
          : stubTool(name),
      )
    }
  })
  await toolFiber.await()
  return { ctx, runtime, toolFiber }
}

async function createAgent(
  ctx: Context,
  id: string,
  parent?: ScopeKey,
): Promise<TestAgent> {
  const session = ctx.sessions.create(SessionId(id))
  const mutable = {
    id: session.id,
    options: {},
    session,
    ctx: undefined,
  } as unknown as Agent & { ctx: Context }
  const scope = createScope(ctx, mutable, parent === undefined ? undefined : { parent })
  mutable.ctx = scope.ctx
  const agent = mutable as Agent
  const owner = ctx.plugin((pluginCtx: Context) => {
    pluginCtx.agents.register(agent)
  })
  await owner.await()
  return { agent, owner, scope, session }
}

function toolNames(runtime: ToolRuntime, agent: Agent): string[] {
  return runtime.schemas(agent).map(schema => schema.name)
}

function appendNativeResult(
  session: Session,
  name: string,
  args: unknown,
  isError = false,
  endStep = true,
): void {
  const callId = CallId(`${session.id}-call-${session.seq + 1}`)
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: JSON.stringify(args),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
      isError,
    }),
    ...(isError ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
    ...(!isError && (name === 'web_search' || name === 'docs_search') ? {
      meta: { version: 1, type: name, source_produced: true },
    } : {}),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  if (endStep) session.append('step/end', { turn: 1, step: 1 })
}

function appendCodeResult(
  session: Session,
  name: string,
  args: unknown,
  isError = false,
): void {
  const index = session.seq + 1
  session.append('tool/code-dispatch', {
    rootCallId: CallId(`root-${index}`),
    parentCallId: CallId(`parent-${index}`),
    subCallId: CallId(`sub-${index}`),
    name,
    arguments: args,
    isError,
    content: [
      { type: 'text', text: isError ? 'failed' : 'ok' },
      ...(!isError && (name === 'web_search' || name === 'docs_search')
        ? [createSourceProducedBlock()]
        : []),
    ],
  })
  session.append('step/end', { turn: 1, step: 1 })
}

async function executeAndCommitSourceProducer(
  runtime: ToolRuntime,
  agent: TestAgent,
  name: 'web_search' | 'docs_search',
): Promise<void> {
  const callId = CallId(`${agent.session.id}-${name}`)
  const args = name === 'web_search' ? { query: 'source producer test' } : {}
  const call = agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: JSON.stringify(args),
  })
  const result = await runtime.execute({
    callId,
    name,
    arguments: args,
    agent: agent.agent,
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [...result.content],
      isError: result.isError,
    }),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
}

function plainNativeEvent(
  seq: number,
  type: 'call' | 'result',
  callId: string,
): SessionEvent {
  if (type === 'call') {
    return {
      type: 'tool/call',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        callId: CallId(callId),
        name: 'search_tools',
        arguments: JSON.stringify({ capabilities: ['site_map'] }),
      },
    }
  }
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId(callId),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    },
    sourceEventSeqs: [seq - 1],
    surfaceOp: 'append',
  }
}

async function disposeAgent(value: TestAgent): Promise<void> {
  await value.owner.dispose()
  await value.scope.dispose()
}

describe('Agent-scoped progressive tool restrictions', () => {
  it('keeps fresh Agents at four tools and discloses incrementally with A/B isolation', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const inheritedWebSearch = runtime.get('web_search')
    expect(inheritedWebSearch).toBeDefined()
    let disclosure: ReturnType<typeof installAgentToolDisclosure> | undefined
    let changes = 0
    const listener = ctx.plugin((pluginCtx: Context) => {
      pluginCtx.on('tools/change', () => { changes += 1 })
    })
    await listener.await()
    const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
      disclosure = installAgentToolDisclosure(pluginCtx, {
        mode: 'progressive',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
    })
    await disclosureFiber.await()
    const agentA = await createAgent(ctx, 'progressive-a')
    const agentB = await createAgent(ctx, 'progressive-b')
    try {
      expect(disclosure).toBeDefined()
      expect(toolNames(runtime, agentA.agent)).toEqual(CORE_TOOLS)
      expect(toolNames(runtime, agentB.agent)).toEqual(CORE_TOOLS)
      expect(runtime.get('web_search', agentA.agent)).toBe(RICH_WEB_SEARCH_DEFINITION)
      expect(runtime.get('web_search', agentA.agent)).not.toBe(inheritedWebSearch)
      expect(runtime.get('web_search', agentB.agent)).toBe(RICH_WEB_SEARCH_DEFINITION)
      expect(runtime.schemas(agentA.agent).find(schema => schema.name === 'web_search'))
        .toMatchObject({ parameters: { properties: { profile: {}, depth: {} } } })
      const richSearch = await runtime.execute({
        callId: CallId('rich-web-search'),
        name: 'web_search',
        arguments: { query: 'rich search' },
        agent: agentA.agent,
        signal: new AbortController().signal,
      })
      expect(richSearch).toMatchObject({ isError: false, value: 'rich-web-search' })
      const searchToolsSchema = runtime.schemas(agentA.agent)
        .find(schema => schema.name === 'search_tools')
      expect(searchToolsSchema?.parameters).toMatchObject({
        additionalProperties: false,
        properties: {
          capabilities: {
            description: 'One to five deferred search capability groups to disclose for this Agent.',
          },
        },
      })
      expect(runtime.executionMode({
        callId: CallId('search-tools-mode'),
        name: 'search_tools',
        arguments: { capabilities: ['site_map'] },
        agent: agentA.agent,
        signal: new AbortController().signal,
      })).toEqual({ kind: 'exclusive' })
      const uncommitted = await runtime.execute({
        callId: CallId('uncommitted-search-tools'),
        name: 'search_tools',
        arguments: { capabilities: ['site_map'] },
        agent: agentA.agent,
        signal: new AbortController().signal,
      })
      expect(uncommitted).toMatchObject({
        isError: false,
        value: { added_groups: ['site_map'], takes_effect: 'next_step' },
      })
      expect(runtime.get('web_map', agentA.agent)).toBeUndefined()
      const hidden = await runtime.execute({
        callId: CallId('hidden-web-map'),
        name: 'web_map',
        arguments: {},
        agent: agentA.agent,
        signal: new AbortController().signal,
      })
      expect(hidden.error).toMatchObject({ info: { code: 'UNKNOWN_TOOL' } })

      const beforeFirst = changes
      appendNativeResult(
        agentA.session,
        'search_tools',
        { capabilities: ['site_map'] },
        false,
        false,
      )
      expect(changes).toBe(beforeFirst)
      expect(runtime.get('web_map', agentA.agent)).toBeUndefined()
      const sameStepHidden = await runtime.execute({
        callId: CallId('same-step-hidden-web-map'),
        name: 'web_map',
        arguments: {},
        agent: agentA.agent,
        signal: new AbortController().signal,
      })
      expect(sameStepHidden.error).toMatchObject({ info: { code: 'UNKNOWN_TOOL' } })
      agentA.session.append('step/end', { turn: 1, step: 1 })
      expect(changes).toBeGreaterThan(beforeFirst)
      expect(toolNames(runtime, agentA.agent)).toEqual([...CORE_TOOLS, 'web_map'])
      expect(toolNames(runtime, agentB.agent)).toEqual(CORE_TOOLS)
      expect(runtime.get('web_map', agentA.agent)).toBeDefined()
      const visible = await runtime.execute({
        callId: CallId('visible-web-map'),
        name: 'web_map',
        arguments: {},
        agent: agentA.agent,
        signal: new AbortController().signal,
      })
      expect(visible).toMatchObject({ isError: false, value: 'web_map' })

      appendNativeResult(
        agentA.session,
        'search_tools',
        { capabilities: ['planning', 'sources'] },
      )
      expect(toolNames(runtime, agentA.agent)).toEqual([
        ...CORE_TOOLS,
        'search_sources',
        'web_map',
        'research_plan',
      ])
      const beforeDuplicate = changes
      appendNativeResult(agentA.session, 'search_tools', { capabilities: ['site_map'] })
      expect(changes).toBe(beforeDuplicate)

      appendNativeResult(
        agentA.session,
        'search_tools',
        { capabilities: ['context7'] },
      )
      expect(toolNames(runtime, agentA.agent)).toEqual([
        ...CORE_TOOLS,
        'search_sources',
        'web_map',
        'research_plan',
        'context7_resolve_library_id',
        'context7_query_docs',
        'context7_get_library_docs',
        'context7_get_cached_doc_raw',
      ])
      const beforeContext7Duplicate = changes
      appendNativeResult(agentA.session, 'search_tools', { capabilities: ['context7'] })
      expect(changes).toBe(beforeContext7Duplicate)

      appendNativeResult(
        agentA.session,
        'search_tools',
        { capabilities: ['diagnostics'] },
      )
      expect(toolNames(runtime, agentA.agent)).toEqual(ALL_EXISTING_TOOLS)
      expect(toolNames(runtime, agentB.agent)).toEqual(CORE_TOOLS)
    } finally {
      await disposeAgent(agentB)
      await disposeAgent(agentA)
      await disclosureFiber.dispose()
      await listener.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('auto-discloses sources from successful Native/Code producers but not failures', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
      installAgentToolDisclosure(pluginCtx, {
        mode: 'progressive',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
    })
    await disclosureFiber.await()
    const nativeAgent = await createAgent(ctx, 'native-source')
    const codeAgent = await createAgent(ctx, 'code-source')
    const failedAgent = await createAgent(ctx, 'failed-source')
    try {
      appendNativeResult(nativeAgent.session, 'web_search', { query: 'react' })
      appendCodeResult(codeAgent.session, 'docs_search', { query: 'react' })
      appendNativeResult(failedAgent.session, 'docs_search', { query: 'react' }, true)
      expect(runtime.get('search_sources', nativeAgent.agent)).toBeDefined()
      expect(runtime.get('search_sources', codeAgent.agent)).toBeDefined()
      expect(runtime.get('search_sources', failedAgent.agent)).toBeUndefined()
    } finally {
      await disposeAgent(failedAgent)
      await disposeAgent(codeAgent)
      await disposeAgent(nativeAgent)
      await disclosureFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('uses live canonical source_ref facts instead of rendered result text', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
      installAgentToolDisclosure(pluginCtx, {
        mode: 'progressive',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
    })
    await disclosureFiber.await()
    const noSourceAgent = await createAgent(ctx, 'canonical-no-source')
    const sourceAgent = await createAgent(ctx, 'canonical-source')
    try {
      await executeAndCommitSourceProducer(runtime, noSourceAgent, 'web_search')
      await executeAndCommitSourceProducer(runtime, sourceAgent, 'docs_search')
      expect(runtime.get('search_sources', noSourceAgent.agent)).toBeUndefined()
      expect(runtime.get('search_sources', sourceAgent.agent)).toBeDefined()
    } finally {
      await disposeAgent(sourceAgent)
      await disposeAgent(noSourceAgent)
      await disclosureFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('intersects with a Preset deny instead of force-releasing its tool', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const presetKey: ScopeKey = {}
    const preset = createScope(ctx, presetKey)
    preset.ctx.tools.restrict({ deny: ['web_map'] })
    const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
      installAgentToolDisclosure(pluginCtx, {
        mode: 'progressive',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
    })
    await disclosureFiber.await()
    const agent = await createAgent(ctx, 'preset-intersection', presetKey)
    try {
      appendNativeResult(agent.session, 'search_tools', {
        capabilities: ['site_map', 'planning'],
      })
      expect(runtime.get('web_map', agent.agent)).toBeUndefined()
      expect(runtime.get('research_plan', agent.agent)).toBeDefined()
      expect(toolNames(runtime, agent.agent)).toEqual([...CORE_TOOLS, 'research_plan'])
    } finally {
      await disposeAgent(agent)
      await disclosureFiber.dispose()
      await preset.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not inject web_search when a Preset hides the inherited definition', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const inheritedWebSearch = runtime.get('web_search')
    const presetKey: ScopeKey = {}
    const preset = createScope(ctx, presetKey)
    preset.ctx.tools.restrict({ deny: ['web_search'] })
    const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
      installAgentToolDisclosure(pluginCtx, {
        mode: 'progressive',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
    })
    await disclosureFiber.await()
    const agent = await createAgent(ctx, 'preset-web-search-deny', presetKey)
    try {
      expect(runtime.get('web_search', agent.agent)).toBeUndefined()
      expect(toolNames(runtime, agent.agent)).toEqual(
        CORE_TOOLS.filter(name => name !== 'web_search'),
      )
      const hidden = await runtime.execute({
        callId: CallId('preset-hidden-web-search'),
        name: 'web_search',
        arguments: { query: 'must remain hidden' },
        agent: agent.agent,
        signal: new AbortController().signal,
      })
      expect(hidden.error).toMatchObject({ info: { code: 'UNKNOWN_TOOL' } })

      await disclosureFiber.dispose()
      expect(runtime.get('web_search', agent.agent)).toBeUndefined()
      await preset.dispose()
      expect(runtime.get('web_search', agent.agent)).toBe(inheritedWebSearch)
    } finally {
      await disposeAgent(agent)
      await disclosureFiber.dispose()
      await preset.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('fails an exact-scope name conflict without leaking shadow or restriction state', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const agent = await createAgent(ctx, 'exact-shadow-conflict')
    const existingExact = stubTool('web_search')
    const disposeExact = agent.agent.ctx.tools.register(existingExact)
    const manager = new AgentToolDisclosureManager({
      mode: 'progressive',
      deferredToolNames: EXISTING_DEFERRED_TOOLS,
      webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
    })
    try {
      expect(() => manager.attach(agent.agent)).toThrow(
        'tool "web_search" is already registered in this scope',
      )
      expect(runtime.get('web_search', agent.agent)).toBe(existingExact)
      expect(toolNames(runtime, agent.agent)).toEqual(ALL_EXISTING_TOOLS)
      manager.dispose()
      expect(runtime.get('web_search', agent.agent)).toBe(existingExact)
    } finally {
      manager.dispose()
      disposeExact()
      await disposeAgent(agent)
      await ctx.fiber.dispose()
    }
  })

  it('restores the exact prior restriction after synchronous replacement failure', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const agent = await createAgent(ctx, 'restriction-recovery')
    let failNext = false
    const installer: RestrictionInstaller = (subject, deniedTools) => {
      if (failNext) {
        failNext = false
        throw new Error('injected restriction failure')
      }
      return subject.ctx.tools.restrict({ deny: deniedTools })
    }
    const manager = new AgentToolDisclosureManager({
      mode: 'progressive',
      deferredToolNames: EXISTING_DEFERRED_TOOLS,
      webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      installRestriction: installer,
    })
    try {
      manager.attach(agent.agent)
      manager.observe(agent.session, plainNativeEvent(1, 'call', 'recover'))
      manager.observe(agent.session, plainNativeEvent(2, 'result', 'recover'))
      failNext = true
      expect(() => manager.observe(agent.session, {
        type: 'step/end',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1 },
      })).toThrow('injected restriction failure')
      expect(runtime.get('web_map', agent.agent)).toBeUndefined()
      expect(toolNames(runtime, agent.agent)).toEqual(CORE_TOOLS)

      manager.observe(agent.session, {
        type: 'step/end',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1 },
      })
      expect(runtime.get('web_map', agent.agent)).toBeDefined()
    } finally {
      manager.dispose()
      manager.dispose()
      await disposeAgent(agent)
      await ctx.fiber.dispose()
    }
  })

  it('rebuilds existing Agents on install/HMR and removes only its own exact restriction', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const agent = await createAgent(ctx, 'existing-hmr')
    const inheritedWebSearch = runtime.get('web_search', agent.agent)
    let current: AgentToolDisclosureManager | undefined
    try {
      expect(toolNames(runtime, agent.agent)).toEqual(ALL_EXISTING_TOOLS)
      expect(inheritedWebSearch).toBeDefined()
      const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
        current = installAgentToolDisclosure(pluginCtx, {
          mode: 'progressive',
          deferredToolNames: EXISTING_DEFERRED_TOOLS,
          webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
        })
      })
      await disclosureFiber.await()
      expect(toolNames(runtime, agent.agent)).toEqual(CORE_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH_DEFINITION)

      await disclosureFiber.restart()
      expect(toolNames(runtime, agent.agent)).toEqual(CORE_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH_DEFINITION)
      current?.dispose()
      current?.dispose()
      expect(toolNames(runtime, agent.agent)).toEqual(ALL_EXISTING_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(inheritedWebSearch)
      await disclosureFiber.dispose()
      expect(toolNames(runtime, agent.agent)).toEqual(ALL_EXISTING_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(inheritedWebSearch)

      const secondFiber = ctx.plugin((pluginCtx: Context) => {
        installAgentToolDisclosure(pluginCtx, {
          mode: 'progressive',
          deferredToolNames: EXISTING_DEFERRED_TOOLS,
          webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
        })
      })
      await secondFiber.await()
      expect(toolNames(runtime, agent.agent)).toEqual(CORE_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH_DEFINITION)
      await agent.owner.dispose()
      expect(toolNames(runtime, agent.agent)).toEqual(ALL_EXISTING_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(inheritedWebSearch)
      await secondFiber.dispose()
      await agent.scope.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('installs the exact shadow but no plugin restriction in all mode', async () => {
    const harness = await createHarness()
    const { ctx, runtime } = harness
    const disclosureFiber = ctx.plugin((pluginCtx: Context) => {
      installAgentToolDisclosure(pluginCtx, {
        mode: 'all',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
    })
    await disclosureFiber.await()
    const agent = await createAgent(ctx, 'all-mode')
    try {
      expect(toolNames(runtime, agent.agent)).toEqual(ALL_EXISTING_TOOLS)
      expect(runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH_DEFINITION)
    } finally {
      await disposeAgent(agent)
      await disclosureFiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('scope-aware progressive tool prompt', () => {
  it('keeps evidence discipline through initial, partial, and complete disclosure', async () => {
    const harness = await createHarness()
    const { ctx } = harness
    const guidanceFiber = ctx.plugin((pluginCtx: Context) => {
      installAgentToolDisclosure(pluginCtx, {
        mode: 'progressive',
        deferredToolNames: EXISTING_DEFERRED_TOOLS,
        webSearchDefinition: RICH_WEB_SEARCH_DEFINITION,
      })
      registerToolDiscoveryGuidance(pluginCtx, 'progressive')
    })
    await guidanceFiber.await()
    const agent = await createAgent(ctx, 'prompt-progressive')
    try {
      const initial = renderPrompt(await ctx.systemPrompt.assemble({
        scope: agent.agent,
        agent: agent.agent,
      }))
      expect(initial).toContain('context7, sources, site_map, planning, diagnostics')
      expect(initial).toContain('next model step')
      expect(initial).toContain('current run_code SDK')
      expectFullEvidenceGuidance(initial)

      appendNativeResult(agent.session, 'search_tools', { capabilities: ['site_map'] })
      const afterMap = renderPrompt(await ctx.systemPrompt.assemble({
        scope: agent.agent,
        agent: agent.agent,
      }))
      expect(afterMap).toContain('context7, sources, planning, diagnostics')
      expect(afterMap).not.toContain('deferred for this Agent: context7, sources, site_map')
      expectFullEvidenceGuidance(afterMap)

      appendNativeResult(agent.session, 'search_tools', { capabilities: [...[
        'context7', 'sources', 'planning', 'diagnostics',
      ]] })
      const complete = renderPrompt(await ctx.systemPrompt.assemble({
        scope: agent.agent,
        agent: agent.agent,
      }))
      expect(complete).not.toContain('Additional Search Enhance capabilities are deferred')
      expectFullEvidenceGuidance(complete)
    } finally {
      await disposeAgent(agent)
      await guidanceFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps evidence guidance scope-aware when disclosure guidance is absent', async () => {
    const harness = await createHarness()
    const { ctx } = harness
    const searchToolsHiddenKey: ScopeKey = {}
    const searchToolsHiddenPreset = createScope(ctx, searchToolsHiddenKey)
    searchToolsHiddenPreset.ctx.tools.restrict({ deny: ['search_tools'] })
    const noExtractKey: ScopeKey = {}
    const noExtractPreset = createScope(ctx, noExtractKey)
    noExtractPreset.ctx.tools.restrict({ deny: ['web_extract'] })
    const onlyEnhanceKey: ScopeKey = {}
    const onlyEnhancePreset = createScope(ctx, onlyEnhanceKey)
    onlyEnhancePreset.ctx.tools.restrict({ allow: ['web_search', 'web_extract'] })
    const onlyDocsKey: ScopeKey = {}
    const onlyDocsPreset = createScope(ctx, onlyDocsKey)
    onlyDocsPreset.ctx.tools.restrict({ allow: ['docs_search', 'web_extract'] })
    const noPluginKey: ScopeKey = {}
    const noPluginPreset = createScope(ctx, noPluginKey)
    noPluginPreset.ctx.tools.restrict({ deny: ALL_EXISTING_TOOLS })
    const guidanceFiber = ctx.plugin((pluginCtx: Context) => {
      registerToolDiscoveryGuidance(pluginCtx, 'progressive')
    })
    await guidanceFiber.await()
    const hiddenSearchTools = await createAgent(ctx, 'prompt-hidden-search-tools', searchToolsHiddenKey)
    const noExtract = await createAgent(ctx, 'prompt-no-extract', noExtractKey)
    const onlyEnhance = await createAgent(ctx, 'prompt-only-enhance', onlyEnhanceKey)
    const onlyDocs = await createAgent(ctx, 'prompt-only-docs', onlyDocsKey)
    const noPlugin = await createAgent(ctx, 'prompt-no-plugin', noPluginKey)
    try {
      const hiddenSearchToolsPrompt = renderPrompt(await ctx.systemPrompt.assemble({
        scope: hiddenSearchTools.agent,
        agent: hiddenSearchTools.agent,
      }))
      expect(hiddenSearchToolsPrompt).not.toContain('Additional Search Enhance capabilities are deferred')
      expectFullEvidenceGuidance(hiddenSearchToolsPrompt)

      const noExtractPrompt = renderPrompt(await ctx.systemPrompt.assemble({
        scope: noExtract.agent,
        agent: noExtract.agent,
      }))
      expect(noExtractPrompt).toContain([
        FULL_RESEARCH_ROUTE_GUIDANCE,
        DISCOVERY_EVIDENCE_GUIDANCE,
        INFERENCE_ONLY_GUIDANCE,
      ].join('\n'))
      expect(noExtractPrompt).not.toContain(EXTRACTED_EVIDENCE_GUIDANCE)

      const onlyEnhancePrompt = renderPrompt(await ctx.systemPrompt.assemble({
        scope: onlyEnhance.agent,
        agent: onlyEnhance.agent,
      }))
      expect(onlyEnhancePrompt).toContain([
        ENHANCE_RESEARCH_ROUTE_GUIDANCE,
        ENHANCE_DISCOVERY_EVIDENCE_GUIDANCE,
        EXTRACTED_EVIDENCE_GUIDANCE,
      ].join('\n'))
      expect(onlyEnhancePrompt).not.toContain('web_search/docs_search')

      const onlyDocsPrompt = renderPrompt(await ctx.systemPrompt.assemble({
        scope: onlyDocs.agent,
        agent: onlyDocs.agent,
      }))
      expect(onlyDocsPrompt).toContain([
        DOCS_RESEARCH_ROUTE_GUIDANCE,
        DOCS_DISCOVERY_EVIDENCE_GUIDANCE,
        EXTRACTED_EVIDENCE_GUIDANCE,
      ].join('\n'))
      expect(onlyDocsPrompt).not.toContain('web_search')

      const noPluginPrompt = renderPrompt(await ctx.systemPrompt.assemble({
        scope: noPlugin.agent,
        agent: noPlugin.agent,
      }))
      expect(noPluginPrompt).not.toContain('claim-level evidence')
      expect(noPluginPrompt).not.toContain('inferred mechanism')
    } finally {
      await disposeAgent(noPlugin)
      await disposeAgent(onlyDocs)
      await disposeAgent(onlyEnhance)
      await disposeAgent(noExtract)
      await disposeAgent(hiddenSearchTools)
      await guidanceFiber.dispose()
      await noPluginPreset.dispose()
      await onlyDocsPreset.dispose()
      await onlyEnhancePreset.dispose()
      await noExtractPreset.dispose()
      await searchToolsHiddenPreset.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps evidence discipline in all mode', async () => {
    const harness = await createHarness()
    const { ctx } = harness
    const guidanceFiber = ctx.plugin((pluginCtx: Context) => {
      registerToolDiscoveryGuidance(pluginCtx, 'all')
    })
    await guidanceFiber.await()
    const agent = await createAgent(ctx, 'prompt-all')
    try {
      const prompt = renderPrompt(await ctx.systemPrompt.assemble({
        scope: agent.agent,
        agent: agent.agent,
      }))
      expect(prompt).not.toContain('Additional Search Enhance capabilities are deferred')
      expectFullEvidenceGuidance(prompt)
    } finally {
      await disposeAgent(agent)
      await guidanceFiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

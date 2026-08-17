import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import {
  SessionId,
  SessionStore,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { SystemPrompt, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  ToolRuntime,
  defineTool,
  type ToolDefinition,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import {
  EVIDENCE_DISCIPLINE_GUIDANCE,
  TOOL_DISCOVERY_GUIDANCE,
  registerToolDiscoveryGuidance,
} from '../src/prompt/tool-discovery.js'
import {
  DEFERRED_OPERATION_NAMES,
  RESIDENT_TOOL_NAMES,
  createSourceProducedBlock,
  installAgentToolDisclosure,
  type AgentToolDisclosureManager,
} from '../src/tool-discovery/index.js'
import {
  DeferredOperationRegistry,
  createSearchCallTool,
} from '../src/tools/search-call.js'
import { createSearchToolsTool } from '../src/tools/search-tools.js'

const SOURCE_REF = 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function textTool(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `${name} test definition`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() { return name },
  })
}

function deferredOperation(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `${name} deferred operation`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: `${name}:${value}` }],
    },
    async execute(args) { return args.value },
  })
}

function operationRegistry(): DeferredOperationRegistry {
  return new DeferredOperationRegistry(DEFERRED_OPERATION_NAMES.map(deferredOperation))
}

const BASE_WEB_SEARCH = defineTool({
  name: 'web_search',
  description: 'Base web search stub.',
  parameters: { query: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) { return `base:${args.query}` },
})

const RICH_WEB_SEARCH = defineTool({
  name: 'web_search',
  description: 'Rich Agent-scoped web search stub.',
  parameters: {
    query: { type: 'string', required: true },
    profile: { type: 'string' },
    depth: { type: 'string' },
  },
  output: {
    schema: {
      type: 'object',
      properties: { source_ref: { type: 'string', required: true } },
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: `Source reference: ${value.source_ref}` }],
    presentationMeta: () => ({
      version: 1,
      type: 'web_search',
      source_produced: true,
    }),
  },
  async execute() { return { source_ref: SOURCE_REF } },
})

interface TestAgent {
  readonly agent: Agent
  readonly owner: ReturnType<Context['plugin']>
  readonly scope: Scope
  readonly session: Session
}

interface RuntimeHarness {
  readonly baseFiber: ReturnType<Context['plugin']>
  readonly ctx: Context
  pluginFiber: ReturnType<Context['plugin']>
  readonly registry: DeferredOperationRegistry
  readonly runtime: ToolRuntime
  manager: AgentToolDisclosureManager | undefined
}

async function createHarness(mode: 'native' | 'code' = 'native'): Promise<RuntimeHarness> {
  const ctx = new Context()
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, {})
  if (mode === 'code') {
    new WorkerThreadCodeRuntime(ctx, {
      computeMs: 1000,
      maxWallMs: 5000,
      maxOutputBytes: 64 * 1024,
      maxOldGenerationSizeMb: 64,
    })
  }
  const runtime = new ToolRuntime(ctx, { mode })
  const registry = operationRegistry()
  const baseFiber = ctx.plugin((pluginCtx: Context) => {
    pluginCtx.tools.register(BASE_WEB_SEARCH)
  })
  await baseFiber.await()

  const harness = {
    baseFiber,
    ctx,
    pluginFiber: undefined as unknown as ReturnType<Context['plugin']>,
    registry,
    runtime,
    manager: undefined,
  } as RuntimeHarness
  const pluginFiber = ctx.plugin((pluginCtx: Context) => {
    pluginCtx.tools.register(textTool('docs_search'))
    pluginCtx.tools.register(textTool('web_extract'))
    pluginCtx.tools.register(createSearchToolsTool({ mode: 'progressive', registry }))
    pluginCtx.tools.register(createSearchCallTool({ mode: 'progressive', registry }))
    harness.manager = installAgentToolDisclosure(pluginCtx, {
      webSearchDefinition: RICH_WEB_SEARCH,
    })
    registerToolDiscoveryGuidance(pluginCtx)
  })
  harness.pluginFiber = pluginFiber
  await pluginFiber.await()
  return harness
}

async function createAgent(
  ctx: Context,
  id: string,
  options: { readonly events?: readonly SessionEvent[]; readonly parent?: ScopeKey } = {},
): Promise<TestAgent> {
  const session = ctx.sessions.create(
    SessionId(id),
    options.events === undefined ? undefined : { seed: options.events },
  )
  const mutable = {
    id: session.id,
    options: {},
    session,
    ctx: undefined,
  } as unknown as Agent & { ctx: Context }
  const scope = createScope(
    ctx,
    mutable,
    options.parent === undefined ? undefined : { parent: options.parent },
  )
  mutable.ctx = scope.ctx
  const agent = mutable as Agent
  const owner = ctx.plugin((pluginCtx: Context) => {
    pluginCtx.agents.register(agent)
  })
  await owner.await()
  return { agent, owner, scope, session }
}

async function disposeAgent(value: TestAgent): Promise<void> {
  await value.owner.dispose()
  await value.scope.dispose()
}

function appendDisclosure(session: Session, capability: string, step: number): void {
  session.append('step/start', { turn: 1, step })
  const callId = CallId(`disclose-${step}`)
  const call = session.append('tool/call', {
    turn: 1,
    step,
    callId,
    name: 'search_tools',
    arguments: JSON.stringify({ capabilities: [capability] }),
  })
  session.append('tool/result', {
    turn: 1,
    step,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'manifest' }],
      isError: false,
    }),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
}

function appendNativeSource(session: Session, step: number): void {
  session.append('step/start', { turn: 1, step })
  const callId = CallId(`source-${step}`)
  const call = session.append('tool/call', {
    turn: 1,
    step,
    callId,
    name: 'web_search',
    arguments: JSON.stringify({ query: 'source' }),
  })
  session.append('tool/result', {
    turn: 1,
    step,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'source' }],
      isError: false,
    }),
    meta: { version: 1, type: 'web_search', source_produced: true },
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
}

async function assembly(ctx: Context, agent: Agent): Promise<PromptAssembly> {
  return ctx.systemPrompt.assemble({ scope: agent, agent })
}

function assemblySnapshot(value: PromptAssembly) {
  return {
    prompt: renderPrompt(value),
    tools: JSON.stringify(value.tools),
  }
}

async function execute(
  runtime: ToolRuntime,
  agent: Agent,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  return runtime.execute({
    callId: CallId(`${name}-${Math.random()}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

describe('fixed progressive-disclosure surface', () => {
  it('keeps Native prompt/schema/order fixed across disclosure, source activation, rejection, and recovery', async () => {
    const harness = await createHarness()
    const agentA = await createAgent(harness.ctx, 'fixed-native-a')
    const agentB = await createAgent(harness.ctx, 'fixed-native-b')
    try {
      const initialAssembly = await assembly(harness.ctx, agentA.agent)
      const initial = assemblySnapshot(initialAssembly)
      expect(initialAssembly.tools.map(tool => tool.name)).toEqual([
        'docs_search',
        'search_call',
        'search_tools',
        'web_extract',
        'web_search',
      ])
      expect(harness.runtime.schemas(agentA.agent).map(tool => tool.name).sort()).toEqual(
        [...RESIDENT_TOOL_NAMES].sort(),
      )
      expect(initial.prompt).toContain(TOOL_DISCOVERY_GUIDANCE)
      expect(initial.prompt).toContain(EVIDENCE_DISCIPLINE_GUIDANCE)
      for (const operation of DEFERRED_OPERATION_NAMES) {
        expect(harness.runtime.get(operation, agentA.agent)).toBeUndefined()
      }

      const inactive = await execute(harness.runtime, agentA.agent, 'search_call', {
        operation: 'web_map',
        arguments: { value: 'x' },
      })
      expect(inactive).toMatchObject({
        isError: true,
        error: { info: { code: 'SEARCH_OPERATION_UNAVAILABLE' } },
      })
      expect(assemblySnapshot(await assembly(harness.ctx, agentA.agent))).toEqual(initial)

      appendDisclosure(agentA.session, 'site_map', 1)
      expect(assemblySnapshot(await assembly(harness.ctx, agentA.agent))).toEqual(initial)
      expect(assemblySnapshot(await assembly(harness.ctx, agentB.agent))).toEqual(initial)
      const active = await execute(harness.runtime, agentA.agent, 'search_call', {
        operation: 'web_map',
        arguments: { value: 'mapped' },
      })
      expect(active).toMatchObject({ isError: false, value: 'mapped' })
      const isolated = await execute(harness.runtime, agentB.agent, 'search_call', {
        operation: 'web_map',
        arguments: { value: 'mapped' },
      })
      expect(isolated.isError).toBe(true)

      appendNativeSource(agentA.session, 2)
      expect(assemblySnapshot(await assembly(harness.ctx, agentA.agent))).toEqual(initial)
      const sourcePage = await execute(harness.runtime, agentA.agent, 'search_call', {
        operation: 'search_sources',
        arguments: { value: 'page' },
      })
      expect(sourcePage).toMatchObject({ isError: false, value: 'page' })

      const recovered = await createAgent(harness.ctx, 'fixed-native-recovered', {
        events: agentA.session.events,
      })
      try {
        expect(assemblySnapshot(await assembly(harness.ctx, recovered.agent))).toEqual(initial)
        const recoveredMap = await execute(harness.runtime, recovered.agent, 'search_call', {
          operation: 'web_map',
          arguments: { value: 'recovered' },
        })
        expect(recoveredMap).toMatchObject({ isError: false, value: 'recovered' })
      } finally {
        await disposeAgent(recovered)
      }

      const direct = await execute(harness.runtime, agentA.agent, 'web_map', { value: 'x' })
      expect(direct).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    } finally {
      await disposeAgent(agentB)
      await disposeAgent(agentA)
      await harness.pluginFiber.dispose()
      await harness.baseFiber.dispose()
      await harness.ctx.fiber.dispose()
    }
  })

  it('keeps Code SDK text and the top-level run_code schema fixed across the same transitions', async () => {
    const harness = await createHarness('code')
    const agent = await createAgent(harness.ctx, 'fixed-code')
    try {
      const initialAssembly = await assembly(harness.ctx, agent.agent)
      const initial = assemblySnapshot(initialAssembly)
      expect(initialAssembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(initial.prompt).toContain('interface ToolArgsMap')
      expect(initial.prompt).toContain('search_call:')
      expect(initial.prompt).not.toMatch(/\n\s+web_map: \{/u)

      appendDisclosure(agent.session, 'site_map', 1)
      expect(assemblySnapshot(await assembly(harness.ctx, agent.agent))).toEqual(initial)
      appendNativeSource(agent.session, 2)
      expect(assemblySnapshot(await assembly(harness.ctx, agent.agent))).toEqual(initial)

      const recovered = await createAgent(harness.ctx, 'fixed-code-recovered', {
        events: agent.session.events,
      })
      try {
        expect(assemblySnapshot(await assembly(harness.ctx, recovered.agent))).toEqual(initial)
      } finally {
        await disposeAgent(recovered)
      }
    } finally {
      await disposeAgent(agent)
      await harness.pluginFiber.dispose()
      await harness.baseFiber.dispose()
      await harness.ctx.fiber.dispose()
    }
  })
})

describe('Agent lifecycle and source recovery bridge', () => {
  it('rebuilds only the web_search shadow on HMR and never installs a disclosure restriction', async () => {
    const harness = await createHarness()
    const agent = await createAgent(harness.ctx, 'shadow-hmr')
    try {
      expect(harness.runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH)
      expect(harness.runtime.schemas(agent.agent).map(tool => tool.name).sort()).toEqual(
        [...RESIDENT_TOOL_NAMES].sort(),
      )
      await harness.pluginFiber.restart()
      expect(harness.runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH)
      expect(harness.runtime.schemas(agent.agent).map(tool => tool.name).sort()).toEqual(
        [...RESIDENT_TOOL_NAMES].sort(),
      )
      await harness.pluginFiber.dispose()
      expect(harness.runtime.get('web_search', agent.agent)).toBe(BASE_WEB_SEARCH)
      expect(harness.runtime.schemas(agent.agent).map(tool => tool.name)).toEqual(['web_search'])
    } finally {
      await disposeAgent(agent)
      await harness.pluginFiber.dispose()
      await harness.baseFiber.dispose()
      await harness.ctx.fiber.dispose()
    }
  })

  it('does not create a web_search shadow when an inherited Preset hides it', async () => {
    const harness = await createHarness()
    const presetKey: ScopeKey = {}
    const preset = createScope(harness.ctx, presetKey)
    preset.ctx.tools.restrict({ deny: ['web_search'] })
    const agent = await createAgent(harness.ctx, 'shadow-hidden', { parent: presetKey })
    try {
      expect(harness.runtime.get('web_search', agent.agent)).toBeUndefined()
      expect(harness.runtime.schemas(agent.agent).map(tool => tool.name).sort()).toEqual([
        'docs_search',
        'search_call',
        'search_tools',
        'web_extract',
      ])
    } finally {
      await disposeAgent(agent)
      await preset.dispose()
      await harness.pluginFiber.dispose()
      await harness.baseFiber.dispose()
      await harness.ctx.fiber.dispose()
    }
  })

  it('turns a final canonical Code source_ref into a reference-free recoverable Session fact', async () => {
    const harness = await createHarness()
    const agent = await createAgent(harness.ctx, 'code-source-bridge')
    try {
      const parent = Symbol('parent') as never
      const result = await harness.runtime.execute({
        callId: CallId('code-source-subcall'),
        rootCallId: CallId('code-source-root'),
        name: 'web_search',
        arguments: { query: 'source' },
        agent: agent.agent,
        parent,
        signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: { source_ref: SOURCE_REF } })
      const content = harness.manager?.shapeCodeDispatchLog({
        exec: {} as never,
        agent: agent.agent,
        subCallId: CallId('code-source-subcall'),
        name: 'web_search',
        isError: false,
        content: [...result.content],
      }, [...result.content])
      expect(content?.at(-1)).toEqual(createSourceProducedBlock())

      agent.session.append('step/start', { turn: 1, step: 1 })
      agent.session.append('tool/code-dispatch', {
        rootCallId: CallId('code-source-root'),
        parentCallId: CallId('code-source-parent'),
        subCallId: CallId('code-source-subcall'),
        name: 'web_search',
        arguments: { query: 'source' },
        isError: false,
        content: content ?? [],
      })
      agent.session.append('step/end', { turn: 1, step: 1 })
      const page = await execute(harness.runtime, agent.agent, 'search_call', {
        operation: 'search_sources',
        arguments: { value: 'page' },
      })
      expect(page).toMatchObject({ isError: false, value: 'page' })
    } finally {
      await disposeAgent(agent)
      await harness.pluginFiber.dispose()
      await harness.baseFiber.dispose()
      await harness.ctx.fiber.dispose()
    }
  })
})

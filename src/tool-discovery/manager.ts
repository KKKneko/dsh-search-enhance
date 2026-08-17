import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  CodeDispatchLog,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

import type { ToolDiscoveryMode } from '../config.js'
import { isSourceRef } from '../source-storage/index.js'
import {
  DEFERRED_TOOL_NAMES,
  capabilityGroupForTool,
  type CapabilityGroup,
} from './capabilities.js'
import {
  createSourceProducedBlock,
  foldToolDisclosureEvent,
  foldToolDisclosureEvents,
  SOURCE_PRODUCING_TOOL_NAMES,
  type ToolDisclosureFoldState,
} from './fold.js'

export type RestrictionDisposer = () => void
export type RestrictionInstaller = (
  agent: Agent,
  deniedTools: readonly string[],
) => RestrictionDisposer

export interface AgentToolDisclosureManagerOptions {
  readonly mode: ToolDiscoveryMode
  /** Deferred definitions actually registered by this plugin version. */
  readonly deferredToolNames: readonly string[]
  /** Rich protocol definition installed only as an exact Agent-scope shadow. */
  readonly webSearchDefinition: ToolDefinition
  /** Test seam for exercising atomic restriction replacement failure recovery. */
  readonly installRestriction?: RestrictionInstaller
}

interface AgentToolState {
  readonly agent: Agent
  fold: ToolDisclosureFoldState
  effectiveGroups: readonly CapabilityGroup[]
  hiddenTools: readonly string[]
  readonly sourceResults: Map<string, boolean>
  disposeRestriction: RestrictionDisposer | undefined
  disposeWebSearchShadow: RestrictionDisposer | undefined
}

function effectiveGroups(events: readonly SessionEvent[]): readonly CapabilityGroup[] {
  const lastStepStart = events.findLastIndex(event => event.type === 'step/start')
  const lastStepEnd = events.findLastIndex(event => event.type === 'step/end')
  const stableEvents = lastStepStart > lastStepEnd
    ? events.slice(0, lastStepStart)
    : events
  return foldToolDisclosureEvents(stableEvents).activeGroups
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function resultCallId(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const block = event.data.message.content[0]
  return block?.type === 'tool-result' ? String(block.toolCallId) : undefined
}

function canonicalDeferredTools(values: readonly string[]): readonly string[] {
  const requested = new Set(values)
  for (const value of requested) {
    if (capabilityGroupForTool(value) === undefined) {
      throw new TypeError(`unknown deferred search tool: ${value}`)
    }
  }
  return Object.freeze(DEFERRED_TOOL_NAMES.filter(tool => requested.has(tool)))
}

/**
 * Own one rich `web_search` shadow and one replaceable deny-only restriction per
 * live Agent. Durable disclosure remains standard Session log data, including
 * reference-free structured source facts; this manager is only its process-local
 * projection.
 */
export class AgentToolDisclosureManager {
  readonly mode: ToolDiscoveryMode
  private readonly deferredToolNames: readonly string[]
  private readonly installRestriction: RestrictionInstaller
  private readonly webSearchDefinition: ToolDefinition
  private readonly byAgent = new Map<Agent, AgentToolState>()
  private readonly bySession = new Map<Session, AgentToolState>()
  private disposed = false

  constructor(options: AgentToolDisclosureManagerOptions) {
    if (options.webSearchDefinition.name !== 'web_search') {
      throw new TypeError('Agent web-search shadow definition must be named "web_search"')
    }
    this.mode = options.mode
    this.deferredToolNames = canonicalDeferredTools(options.deferredToolNames)
    this.installRestriction = options.installRestriction
      ?? ((agent, deniedTools) => agent.ctx.tools.restrict({ deny: deniedTools }))
    this.webSearchDefinition = options.webSearchDefinition
  }

  attach(agent: Agent): void {
    if (this.disposed || this.byAgent.has(agent)) return
    const existing = this.bySession.get(agent.session)
    if (existing !== undefined && existing.agent !== agent) {
      throw new Error(`session ${agent.session.id} is already attached to another Agent`)
    }
    const state: AgentToolState = {
      agent,
      fold: foldToolDisclosureEvents(agent.session.events),
      effectiveGroups: effectiveGroups(agent.session.events),
      hiddenTools: Object.freeze([]),
      sourceResults: new Map(),
      disposeRestriction: undefined,
      disposeWebSearchShadow: undefined,
    }
    this.byAgent.set(agent, state)
    this.bySession.set(agent.session, state)
    try {
      this.installWebSearchShadow(state)
      this.synchronize(state)
    } catch (error) {
      this.byAgent.delete(agent)
      this.bySession.delete(agent.session)
      state.disposeRestriction?.()
      state.disposeWebSearchShadow?.()
      throw error
    }
  }

  detach(agent: Agent): void {
    const state = this.byAgent.get(agent)
    if (state === undefined) return
    this.byAgent.delete(agent)
    this.bySession.delete(agent.session)
    const disposeRestriction = state.disposeRestriction
    const disposeWebSearchShadow = state.disposeWebSearchShadow
    state.disposeRestriction = undefined
    state.disposeWebSearchShadow = undefined
    state.hiddenTools = Object.freeze([])
    state.sourceResults.clear()
    disposeRestriction?.()
    disposeWebSearchShadow?.()
  }

  observeToolResult(execution: ToolExecution, result: ToolExecutionResult): void {
    if (
      this.mode === 'all'
      || this.disposed
      || execution.agent === undefined
      || !SOURCE_PRODUCING_TOOL_NAMES.includes(execution.name as never)
    ) return
    const state = this.byAgent.get(execution.agent)
    if (state === undefined) return
    const callId = String(execution.callId)
    if (execution.parent === undefined && !state.fold.pendingNativeCalls.has(callId)) return
    const value = !result.isError && 'value' in result ? result.value : undefined
    const sourceProduced = (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && isSourceRef((value as { source_ref?: unknown }).source_ref)
    )
    state.sourceResults.set(callId, sourceProduced)
  }

  /** Add one log-only source fact after every downstream Code log shaper settles. */
  shapeCodeDispatchLog(
    dispatch: CodeDispatchLog,
    content: ContentBlock[],
  ): ContentBlock[] {
    if (
      this.mode === 'all'
      || this.disposed
      || dispatch.agent === undefined
      || dispatch.isError
      || !SOURCE_PRODUCING_TOOL_NAMES.includes(dispatch.name as never)
    ) return content
    const state = this.byAgent.get(dispatch.agent)
    return state?.sourceResults.get(String(dispatch.subCallId)) === true
      ? [...content, createSourceProducedBlock()]
      : content
  }

  observe(session: Session, event: SessionEvent): void {
    if (this.mode === 'all' || this.disposed) return
    const state = this.bySession.get(session)
    if (state === undefined) return
    const callId = event.type === 'tool/result'
      ? resultCallId(event)
      : event.type === 'tool/code-dispatch'
        ? String(event.data.subCallId)
        : undefined
    const sourceProduced = callId === undefined ? undefined : state.sourceResults.get(callId)
    if (callId !== undefined) state.sourceResults.delete(callId)
    state.fold = foldToolDisclosureEvent(
      state.fold,
      event,
      sourceProduced === undefined ? {} : { sourceProduced },
    )
    if (event.type === 'step/end' || event.type === 'turn/end') {
      state.sourceResults.clear()
      state.effectiveGroups = state.fold.activeGroups
      this.synchronize(state)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const agent of [...this.byAgent.keys()]) this.detach(agent)
  }

  private hiddenTools(activeGroups: readonly CapabilityGroup[]): readonly string[] {
    if (this.mode === 'all') return Object.freeze([])
    const active = new Set(activeGroups)
    return Object.freeze(this.deferredToolNames.filter(tool => {
      const group = capabilityGroupForTool(tool)
      return group !== undefined && !active.has(group)
    }))
  }

  private installWebSearchShadow(state: AgentToolState): void {
    if (state.agent.ctx.tools.get('web_search', state.agent) === undefined) return
    state.disposeWebSearchShadow = state.agent.ctx.tools.register(this.webSearchDefinition)
  }

  /** Replace the old layer, restoring it exactly if installing the new layer fails. */
  private synchronize(state: AgentToolState): void {
    const nextHidden = this.hiddenTools(state.effectiveGroups)
    if (sameStrings(nextHidden, state.hiddenTools)) return

    const previousHidden = state.hiddenTools
    const previousDispose = state.disposeRestriction
    state.disposeRestriction = undefined
    previousDispose?.()

    try {
      const dispose = nextHidden.length === 0
        ? undefined
        : this.installRestriction(state.agent, nextHidden)
      state.hiddenTools = nextHidden
      state.disposeRestriction = dispose
    } catch (installError) {
      try {
        state.disposeRestriction = previousHidden.length === 0
          ? undefined
          : this.installRestriction(state.agent, previousHidden)
        state.hiddenTools = previousHidden
      } catch (restoreError) {
        state.hiddenTools = Object.freeze([])
        throw new AggregateError(
          [installError, restoreError],
          'failed to replace and restore Agent search-tool restriction',
        )
      }
      throw installError
    }
  }
}

/** Install lifecycle/event projection and rebuild Agent shadows/restrictions for HMR. */
export function installAgentToolDisclosure(
  ctx: Context,
  options: AgentToolDisclosureManagerOptions,
): AgentToolDisclosureManager {
  const manager = new AgentToolDisclosureManager(options)
  ctx.effect(() => () => manager.dispose())
  ctx.on('agent/created', ({ agent }) => manager.attach(agent))
  ctx.on('agent/disposed', ({ agent }) => manager.detach(agent))

  if (options.mode !== 'all') {
    ctx.on('tools/result', (execution, result) => {
      manager.observeToolResult(execution, result)
      return undefined
    })
    ctx.on('tools/code-dispatch-log', async (dispatch, next) => (
      manager.shapeCodeDispatchLog(dispatch, await next())
    ))
    ctx.on('session/event', (session, event) => manager.observe(session, event))
  }

  for (const agent of ctx.agents.list()) manager.attach(agent)
  return manager
}

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

import { isSourceRef } from '../source-storage/index.js'
import {
  createSourceProducedBlock,
  SOURCE_PRODUCING_TOOL_NAMES,
} from './fold.js'

export interface AgentToolDisclosureManagerOptions {
  /** Rich protocol definition installed only as an exact Agent-scope shadow. */
  readonly webSearchDefinition: ToolDefinition
}

interface AgentToolState {
  readonly agent: Agent
  readonly sourceResults: Map<string, boolean>
  disposeWebSearchShadow: (() => void) | undefined
}

/**
 * Own the per-Agent web_search shadow and the live-to-durable bridge for Code
 * source publication facts. Capability recovery itself folds only standard
 * Session events; this manager never changes tool visibility after attachment.
 */
export class AgentToolDisclosureManager {
  private readonly webSearchDefinition: ToolDefinition
  private readonly byAgent = new Map<Agent, AgentToolState>()
  private readonly bySession = new Map<Session, AgentToolState>()
  private disposed = false

  constructor(options: AgentToolDisclosureManagerOptions) {
    if (options.webSearchDefinition.name !== 'web_search') {
      throw new TypeError('Agent web-search shadow definition must be named "web_search"')
    }
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
      sourceResults: new Map(),
      disposeWebSearchShadow: undefined,
    }
    this.byAgent.set(agent, state)
    this.bySession.set(agent.session, state)
    try {
      if (agent.ctx.tools.get('web_search', agent) !== undefined) {
        state.disposeWebSearchShadow = agent.ctx.tools.register(this.webSearchDefinition)
      }
    } catch (error) {
      this.byAgent.delete(agent)
      this.bySession.delete(agent.session)
      state.disposeWebSearchShadow?.()
      throw error
    }
  }

  detach(agent: Agent): void {
    const state = this.byAgent.get(agent)
    if (state === undefined) return
    this.byAgent.delete(agent)
    this.bySession.delete(agent.session)
    const disposeWebSearchShadow = state.disposeWebSearchShadow
    state.disposeWebSearchShadow = undefined
    state.sourceResults.clear()
    disposeWebSearchShadow?.()
  }

  /** Observe final canonical Code sub-call values before their durable log is shaped. */
  observeToolResult(execution: ToolExecution, result: ToolExecutionResult): void {
    if (
      this.disposed
      || execution.agent === undefined
      || execution.parent === undefined
      || !SOURCE_PRODUCING_TOOL_NAMES.includes(execution.name as never)
    ) return
    const state = this.byAgent.get(execution.agent)
    if (state === undefined) return
    const value = !result.isError && 'value' in result ? result.value : undefined
    const sourceProduced = (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && isSourceRef((value as { source_ref?: unknown }).source_ref)
    )
    state.sourceResults.set(String(execution.callId), sourceProduced)
  }

  /** Append one reference-free recovery fact to a successful Code dispatch log. */
  shapeCodeDispatchLog(dispatch: CodeDispatchLog, content: ContentBlock[]): ContentBlock[] {
    if (this.disposed || dispatch.agent === undefined) return content
    const state = this.byAgent.get(dispatch.agent)
    const callId = String(dispatch.subCallId)
    const sourceProduced = state?.sourceResults.get(callId) === true
    state?.sourceResults.delete(callId)
    if (
      dispatch.isError
      || !SOURCE_PRODUCING_TOOL_NAMES.includes(dispatch.name as never)
      || !sourceProduced
    ) return content
    return [...content, createSourceProducedBlock()]
  }

  observeSession(session: Session, event: SessionEvent): void {
    if (event.type !== 'step/end' && event.type !== 'turn/end') return
    this.bySession.get(session)?.sourceResults.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const agent of [...this.byAgent.keys()]) this.detach(agent)
  }
}

/** Install Agent lifecycle, source observation, and replay-safe Code log shaping. */
export function installAgentToolDisclosure(
  ctx: Context,
  options: AgentToolDisclosureManagerOptions,
): AgentToolDisclosureManager {
  const manager = new AgentToolDisclosureManager(options)
  ctx.effect(() => () => manager.dispose())
  ctx.on('agent/created', ({ agent }) => manager.attach(agent))
  ctx.on('agent/disposed', ({ agent }) => manager.detach(agent))
  ctx.on('tools/result', (execution, result) => {
    manager.observeToolResult(execution, result)
    return undefined
  })
  ctx.on('tools/code-dispatch-log', async (dispatch, next) => (
    manager.shapeCodeDispatchLog(dispatch, await next())
  ))
  ctx.on('session/event', (session, event) => manager.observeSession(session, event))

  for (const agent of ctx.agents.list()) manager.attach(agent)
  return manager
}

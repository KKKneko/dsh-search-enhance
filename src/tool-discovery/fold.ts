import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools/types'

import {
  orderCapabilityGroups,
  parseSearchToolsArguments,
  type CapabilityGroup,
} from './capabilities.js'

export const SOURCE_PRODUCING_TOOL_NAMES = Object.freeze([
  'web_search',
  'docs_search',
] as const)

export const SOURCE_PRODUCED_BLOCK_TYPE = 'search-enhance/source-produced' as const

/**
 * Log-only structured fact for a successful Code sub-dispatch whose canonical
 * output carried source_ref. It contains no reference or Provider data and is
 * ignored by model history; recovery never parses rendered tool text.
 */
export interface SourceProducedBlock {
  readonly type: typeof SOURCE_PRODUCED_BLOCK_TYPE
  readonly version: 1
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface ContentBlockMap {
    [SOURCE_PRODUCED_BLOCK_TYPE]: SourceProducedBlock
  }
}

export function createSourceProducedBlock(): SourceProducedBlock {
  return Object.freeze({ type: SOURCE_PRODUCED_BLOCK_TYPE, version: 1 })
}

function hasSourceProducedBlock(content: readonly ContentBlock[]): boolean {
  return content.some(block => (
    block.type === SOURCE_PRODUCED_BLOCK_TYPE
    && block.version === 1
    && Object.keys(block).length === 2
  ))
}

function nativeSourceProduced(meta: unknown, name: string): boolean {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false
  const value = meta as Record<string, unknown>
  return value.version === 1
    && value.type === name
    && value.source_produced === true
}

interface PendingNativeCall {
  readonly groups: readonly CapabilityGroup[]
  readonly name: string
  readonly sourceProducer: boolean
  readonly turn: number
  readonly step: number
}

export interface ToolDisclosureFoldOptions {
  /** Live canonical result fact; absent recovery requires a durable structured marker. */
  readonly sourceProduced?: boolean
}

export interface ToolDisclosureFoldState {
  readonly activeGroups: readonly CapabilityGroup[]
  readonly pendingNativeCalls: ReadonlyMap<string, PendingNativeCall>
}

const SOURCES_GROUP = Object.freeze(['sources'] as const)

export function createToolDisclosureFoldState(): ToolDisclosureFoldState {
  return Object.freeze({
    activeGroups: Object.freeze([]),
    pendingNativeCalls: new Map(),
  })
}

interface Activation {
  readonly groups: readonly CapabilityGroup[]
  readonly sourceProducer: boolean
}

function activation(
  name: unknown,
  args: unknown,
): Activation | undefined {
  if (name === 'search_tools') {
    const groups = parseSearchToolsArguments(args)
    return groups === undefined ? undefined : { groups, sourceProducer: false }
  }
  return typeof name === 'string' && SOURCE_PRODUCING_TOOL_NAMES.includes(name as never)
    ? { groups: SOURCES_GROUP, sourceProducer: true }
    : undefined
}

function parseNativeArguments(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function addActiveGroups(
  state: ToolDisclosureFoldState,
  groups: readonly CapabilityGroup[],
  pendingNativeCalls = state.pendingNativeCalls,
): ToolDisclosureFoldState {
  const activeGroups = orderCapabilityGroups([...state.activeGroups, ...groups])
  if (
    pendingNativeCalls === state.pendingNativeCalls
    && activeGroups.length === state.activeGroups.length
  ) return state
  return Object.freeze({ activeGroups, pendingNativeCalls })
}

function withPending(
  state: ToolDisclosureFoldState,
  pendingNativeCalls: ReadonlyMap<string, PendingNativeCall>,
): ToolDisclosureFoldState {
  return Object.freeze({ activeGroups: state.activeGroups, pendingNativeCalls })
}

function readToolResultCallId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0]
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return undefined
  if ((block as { type?: unknown }).type !== 'tool-result') return undefined
  const callId = (block as { toolCallId?: unknown }).toolCallId
  return typeof callId === 'string' ? callId : undefined
}

function isSuccessfulToolResult(data: {
  readonly error?: unknown
  readonly message?: unknown
}): boolean {
  if (data.error !== undefined) return false
  const message = data.message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content) || content.length !== 1) return false
  const block = content[0]
  return (
    block !== null
    && typeof block === 'object'
    && !Array.isArray(block)
    && (block as { type?: unknown }).type === 'tool-result'
    && (block as { isError?: unknown }).isError !== true
  )
}

/**
 * Fold one standard Session event into disclosure state. The input state is never
 * mutated; failed, cancelled, malformed, unknown, or unpaired calls fail closed.
 */
export function foldToolDisclosureEvent(
  state: ToolDisclosureFoldState,
  event: SessionEvent,
  options: ToolDisclosureFoldOptions = {},
): ToolDisclosureFoldState {
  if (event.type === 'tool/call') {
    const callId = event.data.callId
    if (typeof callId !== 'string' || state.pendingNativeCalls.has(callId)) return state
    const selected = activation(
      event.data.name,
      parseNativeArguments(event.data.arguments),
    )
    if (selected === undefined) return state
    const pendingNativeCalls = new Map(state.pendingNativeCalls)
    pendingNativeCalls.set(callId, {
      groups: selected.groups,
      name: event.data.name,
      sourceProducer: selected.sourceProducer,
      turn: event.data.turn,
      step: event.data.step,
    })
    return withPending(state, pendingNativeCalls)
  }

  if (event.type === 'tool/result') {
    const callId = readToolResultCallId(event.data.message)
    if (callId === undefined) return state
    const pending = state.pendingNativeCalls.get(callId)
    if (pending === undefined) return state
    const pendingNativeCalls = new Map(state.pendingNativeCalls)
    pendingNativeCalls.delete(callId)
    const sourceProduced = options.sourceProduced
      ?? nativeSourceProduced(event.data.meta, pending.name)
    if (
      pending.turn !== event.data.turn
      || pending.step !== event.data.step
      || !isSuccessfulToolResult(event.data)
      || (pending.sourceProducer && !sourceProduced)
    ) return withPending(state, pendingNativeCalls)
    return addActiveGroups(state, pending.groups, pendingNativeCalls)
  }

  if (event.type === 'tool/code-dispatch') {
    if (event.data.isError !== false) return state
    const selected = activation(event.data.name, event.data.arguments)
    const sourceProduced = options.sourceProduced
      ?? hasSourceProducedBlock(event.data.content)
    if (
      selected === undefined
      || (selected.sourceProducer && !sourceProduced)
    ) return state
    return addActiveGroups(state, selected.groups)
  }

  return state
}

/** Reconstruct disclosure solely from standard Session events and structured result facts. */
export function foldToolDisclosureEvents(
  events: readonly SessionEvent[],
): ToolDisclosureFoldState {
  let state = createToolDisclosureFoldState()
  for (const event of events) state = foldToolDisclosureEvent(state, event)
  return state
}

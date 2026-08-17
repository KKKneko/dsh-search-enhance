import {
  CallId,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'

const scripted = []
const observedRequests = []

export const name = 'search-enhance-scripted-llm'
export const inject = ['llm']

/** Replace the deterministic response queue used by the real AgentLoop fixture. */
export function setScript(responses) {
  scripted.splice(0, scripted.length, ...responses)
  observedRequests.splice(0, observedRequests.length)
}

/** Append responses without clearing already observed model requests. */
export function appendScript(...responses) {
  scripted.push(...responses)
}

/** Return detached model requests with no signal or live service objects. */
export function requests() {
  return structuredClone(observedRequests)
}

export function remainingResponses() {
  return scripted.length
}

function snapshotRequest(options) {
  return JSON.parse(JSON.stringify({
    provider: options.provider,
    model: options.model,
    system: options.system,
    tools: options.tools,
    messages: options.messages,
  }))
}

class ScriptedAdapter extends LlmAdapter {
  async *stream(options) {
    observedRequests.push(snapshotRequest(options))
    const response = scripted.shift()
    if (response === undefined) {
      throw new Error('scripted LLM response queue is empty')
    }
    const toolCalls = response.kind === 'tool'
      ? [response]
      : response.kind === 'tools'
        ? response.calls
        : undefined
    if (toolCalls !== undefined) {
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('scripted tool response requires at least one call')
      }
      for (const [index, tool] of toolCalls.entries()) {
        const id = CallId(tool.id)
        const argumentsText = JSON.stringify(tool.arguments)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id,
          name: tool.name,
          argumentsDelta: argumentsText,
        }
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id,
            name: tool.name,
            arguments: argumentsText,
          },
        }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (response.kind === 'text') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response.text }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: response.text },
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    throw new Error(`unsupported scripted response kind: ${String(response.kind)}`)
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['search-enhance-scripted'], new ScriptedAdapter())
}

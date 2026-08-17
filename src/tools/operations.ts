import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'

import { throwIfAborted } from '../provider-runtime/index.js'

class ForegroundOperationAbortedError extends HarnessError {
  constructor(cause?: unknown) {
    super(
      'search-enhance foreground operation aborted',
      TOOL_ABORTED,
      cause instanceof Error ? { cause } : undefined,
    )
    this.name = 'AbortError'
  }
}

/**
 * Fiber-owned foreground operation set. Disposal closes admission, cancels only
 * Agents with active plugin calls so AgentLoop cannot advance through an HMR
 * assembly gap, aborts their Provider work, and waits for full quiescence.
 */
export class ForegroundOperationScope {
  private readonly lifecycle = new AbortController()
  private readonly active = new Map<Promise<unknown>, Agent | undefined>()
  private stopped = false

  async run<T>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    agent?: Agent,
  ): Promise<T> {
    if (this.stopped) throw new ForegroundOperationAbortedError()
    const signal = AbortSignal.any([callerSignal, this.lifecycle.signal])
    const pending = (async () => {
      try {
        throwIfAborted(signal)
        return await operation(signal)
      } catch (error) {
        if (signal.aborted) throw new ForegroundOperationAbortedError(error)
        throw error
      }
    })()
    this.active.set(pending, agent)
    void pending.then(
      () => { this.active.delete(pending) },
      () => { this.active.delete(pending) },
    )
    return pending
  }

  /** Cancel owning turns, stop admission, abort active work, and await complete settlement. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      const agents = new Set(
        [...this.active.values()].filter((agent): agent is Agent => agent !== undefined),
      )
      for (const agent of agents) {
        agent.cancel({ kind: 'hook', reason: 'search-enhance plugin disposing' })
      }
      this.lifecycle.abort(new DOMException('search-enhance plugin disposed', 'AbortError'))
    }
    await Promise.allSettled([...this.active.keys()])
  }
}

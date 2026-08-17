import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

import type {
  SourceCallIdentity,
  SourceRecordCandidate,
} from '../contracts/index.js'
import {
  SourceRecordStore,
  type SourcePageResult,
  type SourceRecordCommit,
  type SourceRecordLookup,
} from './store.js'
import type { SourcePageRequest } from './pagination.js'

export const SOURCE_RECORD_SERVICE_KEY = 'searchEnhanceSources'

export interface SourceExecutionIdentityInput {
  readonly rootCallId: string
  readonly callId: string
  readonly name: string
  readonly parent?: unknown
}

export function sourceCallIdentity(
  execution: SourceExecutionIdentityInput,
): Readonly<SourceCallIdentity> {
  return Object.freeze({
    callId: String(execution.callId),
    mode: execution.parent === undefined ? 'top-level' : 'nested-code',
    name: execution.name,
    rootCallId: String(execution.rootCallId),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    searchEnhanceSources: SearchEnhanceSourceService
  }
}

/**
 * Host-side authority for durable hidden sources. The root Consumer calls this
 * service from its separately registered tools; the Service itself registers no
 * model surface and disappears with its owning fiber.
 */
export class SearchEnhanceSourceService extends Service {
  constructor(ctx: Context, private readonly store: SourceRecordStore) {
    super(ctx, SOURCE_RECORD_SERVICE_KEY)
  }

  record(
    session: Session,
    call: SourceCallIdentity,
    candidate: SourceRecordCandidate,
    signal: AbortSignal,
  ): Promise<Readonly<SourceRecordCommit>> {
    return this.store.record(session, call, candidate, signal)
  }

  lookup(session: Session, sourceRef: unknown): SourceRecordLookup {
    return this.store.lookup(session, sourceRef)
  }

  page(session: Session, request: SourcePageRequest): SourcePageResult {
    return this.store.page(session, request)
  }
}

import type { Session } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import type {
  SourceCallIdentity,
  SourceRecordCandidate,
  SourceRef,
  StoredSourceRecord,
} from '../contracts/index.js'
import { OutputLimitError, throwIfAborted } from '../provider-runtime/index.js'
import { canReadSourceRecord } from './authorization.js'
import { StoredSourceRecordSchema } from './domain.js'
import {
  paginateSourceRecord,
  parseSourcePageRequest,
  type SourcePageFound,
  type SourcePageRequest,
  type SourcePaginationLimits,
} from './pagination.js'
import { createSourceRef, isSourceRef, type SourceRefEntropy } from './refs.js'
import { retainSourceRecord, type SourceRecordRetentionLimits } from './retention.js'

export type SourceStoreErrorCode =
  | 'SOURCE_STORE_CLOSED'
  | 'SOURCE_STORE_CAPACITY'
  | 'SOURCE_STORE_ENTROPY'
  | 'SOURCE_RECORD_EMPTY'
  | 'SOURCE_RECORD_BUDGET'
  | 'SOURCE_RECORD_WRITE'
  | 'SOURCE_RECORD_CORRUPT'

export class SourceStoreError extends Error {
  override readonly name = 'SourceStoreError'

  constructor(
    readonly code: SourceStoreErrorCode,
    options: ErrorOptions = {},
  ) {
    super(code, options)
  }
}

export interface SourceRecordCommit {
  readonly sourceRef: SourceRef
  readonly record: Readonly<StoredSourceRecord>
}

export const SOURCE_REF_NOT_FOUND = Object.freeze({
  state: 'not_found' as const,
  code: 'SOURCE_REF_NOT_FOUND' as const,
})

export type SourceRecordNotFound = typeof SOURCE_REF_NOT_FOUND

export interface SourceRecordFound {
  readonly state: 'found'
  readonly record: Readonly<StoredSourceRecord>
}

export type SourceRecordLookup = SourceRecordFound | SourceRecordNotFound
export type SourcePageResult = SourcePageFound | SourceRecordNotFound

export interface SourceRecordStoreOptions
  extends SourceRecordRetentionLimits, SourcePaginationLimits {
  readonly maxRecords: number
  readonly entropy?: SourceRefEntropy
}

const MAX_REF_COLLISION_ATTEMPTS = 32

function safeInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`)
  }
  return value
}

/** Durable source-record repository. The supplied storage-domain table is its only authority. */
export class SourceRecordStore {
  private readonly maxSources: number
  private readonly maxBytes: number
  private readonly maxRecords: number
  private readonly maxPageSize: number
  private readonly maxPageBytes: number
  private readonly maxSnippetCharacters: number
  private readonly entropy: SourceRefEntropy | undefined
  private tail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly table: KvTable<SourceRef, StoredSourceRecord>,
    options: SourceRecordStoreOptions,
  ) {
    this.maxSources = safeInteger(options.maxSources, 'maxSources', 1)
    this.maxBytes = safeInteger(options.maxBytes, 'maxBytes', 1)
    this.maxRecords = safeInteger(options.maxRecords, 'maxRecords', 1)
    this.maxPageSize = safeInteger(options.maxPageSize, 'maxPageSize', 1)
    this.maxPageBytes = safeInteger(options.maxPageBytes, 'maxPageBytes', 1)
    this.maxSnippetCharacters = safeInteger(
      options.maxSnippetCharacters,
      'maxSnippetCharacters',
      0,
    )
    this.entropy = options.entropy
  }

  private assertOpen(): void {
    if (this.stopped) throw new SourceStoreError('SOURCE_STORE_CLOSED')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private nextUnusedRef(): SourceRef {
    for (let attempt = 0; attempt < MAX_REF_COLLISION_ATTEMPTS; attempt += 1) {
      const sourceRef = createSourceRef(this.entropy)
      if (this.table.get(sourceRef) === undefined) return sourceRef
    }
    throw new SourceStoreError('SOURCE_STORE_ENTROPY')
  }

  async record(
    session: Session,
    call: SourceCallIdentity,
    candidate: SourceRecordCandidate,
    signal: AbortSignal,
  ): Promise<Readonly<SourceRecordCommit>> {
    this.assertOpen()
    throwIfAborted(signal)
    return this.enqueue(async () => {
      this.assertOpen()
      throwIfAborted(signal)
      if (candidate.sources.length === 0) {
        throw new SourceStoreError('SOURCE_RECORD_EMPTY')
      }
      if (this.table.size >= this.maxRecords) {
        throw new SourceStoreError('SOURCE_STORE_CAPACITY')
      }
      const sourceRef = this.nextUnusedRef()
      let record: Readonly<StoredSourceRecord>
      try {
        record = retainSourceRecord({
          call,
          candidate,
          ownerSessionId: String(session.id),
          sourceRef,
        }, {
          maxBytes: this.maxBytes,
          maxSources: this.maxSources,
        })
      } catch (error) {
        if (error instanceof OutputLimitError) {
          throw new SourceStoreError('SOURCE_RECORD_BUDGET', { cause: error })
        }
        throw error
      }
      if (record.sources.length === 0) {
        throw new SourceStoreError('SOURCE_RECORD_BUDGET')
      }
      try {
        await this.table.put(sourceRef, record)
      } catch (error) {
        throw new SourceStoreError('SOURCE_RECORD_WRITE', { cause: error })
      }
      throwIfAborted(signal)
      return Object.freeze({ record, sourceRef })
    })
  }

  lookup(session: Session, value: unknown): SourceRecordLookup {
    this.assertOpen()
    if (!isSourceRef(value)) return SOURCE_REF_NOT_FOUND
    const stored = this.table.get(value)
    if (stored === undefined) return SOURCE_REF_NOT_FOUND
    const parsed = StoredSourceRecordSchema.safeParse(stored)
    if (!parsed.success || stored.sourceRef !== value) {
      throw new SourceStoreError('SOURCE_RECORD_CORRUPT', {
        ...(!parsed.success ? { cause: parsed.error } : {}),
      })
    }
    if (!canReadSourceRecord(session, stored)) return SOURCE_REF_NOT_FOUND
    return Object.freeze({ record: stored, state: 'found' })
  }

  page(session: Session, request: SourcePageRequest): SourcePageResult {
    const parsed = parseSourcePageRequest(request, this.maxPageSize)
    const lookup = this.lookup(session, parsed.sourceRef)
    if (lookup.state === 'not_found') return lookup
    return paginateSourceRecord(lookup.record, parsed, {
      maxPageBytes: this.maxPageBytes,
      maxSnippetCharacters: this.maxSnippetCharacters,
    })
  }

  /** Stop admission synchronously; already queued writes are allowed to settle. */
  stop(): void {
    this.stopped = true
  }

  async drain(): Promise<void> {
    await this.tail
  }
}

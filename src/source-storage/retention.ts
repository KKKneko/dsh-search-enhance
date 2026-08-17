import type {
  SourceCallIdentity,
  SourceRecordCandidate,
  SourceRef,
  StoredSourceRecord,
} from '../contracts/index.js'
import { retainJsonPrefix } from '../provider-runtime/index.js'
import { StoredSourceRecordSchema } from './domain.js'

export interface SourceRecordRetentionLimits {
  readonly maxSources: number
  readonly maxBytes: number
}

export interface RetainSourceRecordInput {
  readonly sourceRef: SourceRef
  readonly ownerSessionId: string
  readonly call: SourceCallIdentity
  readonly candidate: SourceRecordCandidate
}

function freezeRecord(record: StoredSourceRecord): Readonly<StoredSourceRecord> {
  const sources = Object.freeze(record.sources.map(source => Object.freeze({ ...source })))
  return Object.freeze({
    ...record,
    call: Object.freeze({ ...record.call }),
    sources,
  })
}

/** Retain a stable source prefix while measuring the complete versioned record envelope. */
export function retainSourceRecord(
  input: RetainSourceRecordInput,
  limits: SourceRecordRetentionLimits,
): Readonly<StoredSourceRecord> {
  const totalBeforeRetention = input.candidate.sources.length
  const retained = retainJsonPrefix(input.candidate.sources, {
    label: 'source record',
    maxBytes: limits.maxBytes,
    maxItems: limits.maxSources,
    project: sources => ({
      version: 1,
      sourceRef: input.sourceRef,
      ownerSessionId: input.ownerSessionId,
      query: input.candidate.query,
      profile: input.candidate.profile,
      depth: input.candidate.depth,
      call: input.call,
      sources,
      totalBeforeRetention,
      collectionTruncated: input.candidate.collectionTruncated,
      truncated: input.candidate.collectionTruncated || sources.length < totalBeforeRetention,
    }),
  })
  return freezeRecord(StoredSourceRecordSchema.parse(retained.value))
}

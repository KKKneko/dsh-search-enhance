import type { SearchDepth, SearchProfile } from '../config.js'

export const SOURCE_PROVIDERS = [
  'search-api',
  'context7',
  'exa',
  'tavily',
  'firecrawl',
  'smart-direct',
  'direct',
] as const

export type SourceProvider = (typeof SOURCE_PROVIDERS)[number]

export const SOURCE_CATEGORIES = [
  'official',
  'primary',
  'documentation',
  'code',
  'academic',
  'news',
  'community',
  'aggregate',
  'unknown',
] as const

export type SourceCategory = (typeof SOURCE_CATEGORIES)[number]

declare const sourceRefBrand: unique symbol

/** Opaque session-local reference. Consumers may store and return it, but must not parse it. */
export type SourceRef = string & { readonly [sourceRefBrand]: 'SourceRef' }

/** Provider-neutral discovery record used before any presentation projection. */
export interface CanonicalSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
  readonly provider: SourceProvider
  readonly category?: SourceCategory
}

export const SOURCE_CALL_MODES = ['top-level', 'nested-code'] as const
export type SourceCallMode = (typeof SOURCE_CALL_MODES)[number]

/** Public structured tool identity retained privately for fork authorization. */
export interface SourceCallIdentity {
  readonly mode: SourceCallMode
  readonly rootCallId: string
  readonly callId: string
  readonly name: string
}

/** Complete merged source candidate passed from orchestration to the durable layer. */
export interface SourceRecordCandidate {
  readonly query: string
  readonly profile: SearchProfile
  readonly depth: SearchDepth
  readonly sources: readonly CanonicalSource[]
  /** A Provider had already bounded its collection before this layer observed it. */
  readonly collectionTruncated: boolean
}

/** Versioned private-storage value. It is never appended as a custom SessionEvent. */
export interface StoredSourceRecord {
  readonly version: 1
  readonly sourceRef: SourceRef
  readonly ownerSessionId: string
  readonly query: string
  readonly profile: SearchProfile
  readonly depth: SearchDepth
  readonly call: SourceCallIdentity
  readonly sources: readonly CanonicalSource[]
  readonly totalBeforeRetention: number
  readonly collectionTruncated: boolean
  readonly truncated: boolean
}

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import {
  SEARCH_DEPTHS,
  SEARCH_PROFILES,
} from '../config.js'
import {
  SOURCE_CALL_MODES,
  SOURCE_CATEGORIES,
  SOURCE_PROVIDERS,
  type CanonicalSource,
  type SourceCallIdentity,
  type SourceRef,
  type StoredSourceRecord,
} from '../contracts/index.js'

export const SOURCE_RECORD_DOMAIN_NAME = 'search_enhance_sources'
export const SOURCE_RECORD_TABLE_NAME = 'records'
export const SOURCE_RECORD_FORMAT_VERSION = 1
export const SOURCE_REF_PATTERN = /^src_[A-Za-z0-9_-]{32}$/

export const SourceRefSchema = z.string().regex(SOURCE_REF_PATTERN) as unknown as z.ZodType<SourceRef>

const optionalBoundedText = z.string().max(1_000_000).optional()

export const CanonicalSourceSchema: z.ZodType<CanonicalSource> = z.object({
  url: z.url().refine(value => value.startsWith('http://') || value.startsWith('https://')),
  title: optionalBoundedText,
  snippet: optionalBoundedText,
  publishedAt: z.string().max(4096).optional(),
  provider: z.enum(SOURCE_PROVIDERS),
  category: z.enum(SOURCE_CATEGORIES).optional(),
}).strict() as z.ZodType<CanonicalSource>

export const SourceCallIdentitySchema: z.ZodType<SourceCallIdentity> = z.object({
  mode: z.enum(SOURCE_CALL_MODES),
  rootCallId: z.string().min(1).max(4096),
  callId: z.string().min(1).max(4096),
  name: z.string().min(1).max(512),
}).strict().superRefine((value, context) => {
  if (value.mode === 'top-level' && value.rootCallId !== value.callId) {
    context.addIssue({
      code: 'custom',
      message: 'top-level rootCallId must equal callId',
      path: ['rootCallId'],
    })
  }
}) as z.ZodType<SourceCallIdentity>

export const StoredSourceRecordSchema: z.ZodType<StoredSourceRecord> = z.object({
  version: z.literal(SOURCE_RECORD_FORMAT_VERSION),
  sourceRef: SourceRefSchema,
  ownerSessionId: z.string().min(1).max(4096),
  query: z.string().min(1).max(1_000_000),
  profile: z.enum(SEARCH_PROFILES),
  depth: z.enum(SEARCH_DEPTHS),
  call: SourceCallIdentitySchema,
  sources: z.array(CanonicalSourceSchema).max(5000),
  totalBeforeRetention: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  collectionTruncated: z.boolean(),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.sources.length > value.totalBeforeRetention) {
    context.addIssue({
      code: 'custom',
      message: 'sources cannot exceed totalBeforeRetention',
      path: ['sources'],
    })
  }
  const expectedTruncated = value.collectionTruncated
    || value.sources.length < value.totalBeforeRetention
  if (value.truncated !== expectedTruncated) {
    context.addIssue({
      code: 'custom',
      message: 'truncated must reflect collection or retention truncation',
      path: ['truncated'],
    })
  }
}) as z.ZodType<StoredSourceRecord>

export const SOURCE_RECORD_DOMAIN_SPEC = defineDomain({
  name: SOURCE_RECORD_DOMAIN_NAME,
  version: SOURCE_RECORD_FORMAT_VERSION,
  tables: {
    [SOURCE_RECORD_TABLE_NAME]: domainTable<SourceRef, StoredSourceRecord>(StoredSourceRecordSchema),
  },
})

export type SourceRecordDomain = Domain<typeof SOURCE_RECORD_DOMAIN_SPEC>

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const CONTEXT7_CACHE_DOMAIN_NAME = 'search_enhance_context7_cache'
export const CONTEXT7_CACHE_TABLE_NAME = 'entries'
export const CONTEXT7_CACHE_FORMAT_VERSION = 1
export const CONTEXT7_CACHE_KEY_PATTERN = /^ctx7[rd]_[A-Za-z0-9_-]{43}$/
export const CONTEXT7_DOC_REF_PATTERN = /^ctx7d_[A-Za-z0-9_-]{43}$/

declare const context7CacheKeyBrand: unique symbol
declare const context7DocRefBrand: unique symbol

export type Context7CacheKey = string & { readonly [context7CacheKeyBrand]: 'Context7CacheKey' }
export type Context7DocRef = Context7CacheKey & { readonly [context7DocRefBrand]: 'Context7DocRef' }

export interface CachedContext7Library {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly trustScore?: number
  readonly benchmarkScore?: number
  readonly totalSnippets?: number
  readonly stars?: number
  readonly versions?: readonly string[]
}

export interface CachedDocumentationSnippet {
  readonly content: string
  readonly title?: string
  readonly libraryId?: string
}

interface Context7CacheEntryBase {
  readonly version: typeof CONTEXT7_CACHE_FORMAT_VERSION
  readonly cacheKey: Context7CacheKey
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly maxResults: number
  readonly responseBytes: number
  readonly totalItems: number
  readonly truncated: boolean
}

export interface Context7ResolveCacheEntry extends Context7CacheEntryBase {
  readonly kind: 'resolve'
  readonly libraries: readonly CachedContext7Library[]
}

export interface Context7DocsCacheEntry extends Context7CacheEntryBase {
  readonly kind: 'docs'
  readonly docRef: Context7DocRef
  readonly libraryId: string
  readonly snippets: readonly CachedDocumentationSnippet[]
}

export type Context7CacheEntry = Context7ResolveCacheEntry | Context7DocsCacheEntry

const boundedText = z.string().max(1_000_000)
const context7LibraryId = z.string()
  .max(4096)
  .regex(/^\/[^/\s?#]+\/[^/\s?#]+(?:\/[^/\s?#]+)?$/u)
const finiteNumber = z.number().finite()
const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const Context7CacheKeySchema = z.string()
  .regex(CONTEXT7_CACHE_KEY_PATTERN) as unknown as z.ZodType<Context7CacheKey>
export const Context7DocRefSchema = z.string()
  .regex(CONTEXT7_DOC_REF_PATTERN) as unknown as z.ZodType<Context7DocRef>

export const CachedContext7LibrarySchema: z.ZodType<CachedContext7Library> = z.object({
  id: boundedText.optional(),
  title: boundedText.optional(),
  description: boundedText.optional(),
  trustScore: finiteNumber.optional(),
  benchmarkScore: finiteNumber.optional(),
  totalSnippets: finiteNumber.nonnegative().optional(),
  stars: finiteNumber.nonnegative().optional(),
  versions: z.array(boundedText).max(1000).optional(),
}).strict() as z.ZodType<CachedContext7Library>

export const CachedDocumentationSnippetSchema: z.ZodType<CachedDocumentationSnippet> = z.object({
  content: boundedText,
  title: boundedText.optional(),
  libraryId: boundedText.optional(),
}).strict() as z.ZodType<CachedDocumentationSnippet>

const cacheEntryBase = z.object({
  version: z.literal(CONTEXT7_CACHE_FORMAT_VERSION),
  cacheKey: Context7CacheKeySchema,
  createdAtMs: nonNegativeSafeInteger,
  expiresAtMs: nonNegativeSafeInteger,
  maxResults: z.number().int().positive().max(5000),
  responseBytes: nonNegativeSafeInteger,
  totalItems: nonNegativeSafeInteger,
  truncated: z.boolean(),
})

export const Context7ResolveCacheEntrySchema: z.ZodType<Context7ResolveCacheEntry> = cacheEntryBase.extend({
  kind: z.literal('resolve'),
  libraries: z.array(CachedContext7LibrarySchema).max(5000),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs < value.createdAtMs) {
    context.addIssue({ code: 'custom', message: 'cache expiry precedes creation time', path: ['expiresAtMs'] })
  }
  if (!value.cacheKey.startsWith('ctx7r_')) {
    context.addIssue({ code: 'custom', message: 'resolve cache key has the wrong prefix', path: ['cacheKey'] })
  }
  if (value.libraries.length > value.totalItems) {
    context.addIssue({ code: 'custom', message: 'libraries exceed totalItems', path: ['libraries'] })
  }
}) as z.ZodType<Context7ResolveCacheEntry>

export const Context7DocsCacheEntrySchema: z.ZodType<Context7DocsCacheEntry> = cacheEntryBase.extend({
  kind: z.literal('docs'),
  docRef: Context7DocRefSchema,
  libraryId: context7LibraryId,
  snippets: z.array(CachedDocumentationSnippetSchema).max(5000),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs < value.createdAtMs) {
    context.addIssue({ code: 'custom', message: 'cache expiry precedes creation time', path: ['expiresAtMs'] })
  }
  if (!value.cacheKey.startsWith('ctx7d_') || value.docRef !== value.cacheKey) {
    context.addIssue({ code: 'custom', message: 'docs cache key and docRef must match', path: ['docRef'] })
  }
  if (value.snippets.length > value.totalItems) {
    context.addIssue({ code: 'custom', message: 'snippets exceed totalItems', path: ['snippets'] })
  }
}) as z.ZodType<Context7DocsCacheEntry>

export const Context7CacheEntrySchema: z.ZodType<Context7CacheEntry> = z.union([
  Context7ResolveCacheEntrySchema,
  Context7DocsCacheEntrySchema,
]) as z.ZodType<Context7CacheEntry>

export const CONTEXT7_CACHE_DOMAIN_SPEC = defineDomain({
  name: CONTEXT7_CACHE_DOMAIN_NAME,
  version: CONTEXT7_CACHE_FORMAT_VERSION,
  tables: {
    [CONTEXT7_CACHE_TABLE_NAME]: domainTable<Context7CacheKey, Context7CacheEntry>(
      Context7CacheEntrySchema,
    ),
  },
})

export type Context7CacheDomain = Domain<typeof CONTEXT7_CACHE_DOMAIN_SPEC>

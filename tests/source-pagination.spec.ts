import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'

import type {
  CanonicalSource,
  SourceRef,
  StoredSourceRecord,
} from '../src/contracts/index.js'
import {
  SOURCE_REF_NOT_FOUND,
  SourcePageError,
  SourceRecordStore,
  createSourceRef,
  paginateSourceRecord,
  parseSourcePageRequest,
  retainSourceRecord,
} from '../src/source-storage/index.js'

function entropy(byte: number): (size: number) => Uint8Array {
  return size => new Uint8Array(size).fill(byte)
}

function source(index: number, snippet = `snippet-${index}`): CanonicalSource {
  return {
    ...(index % 2 === 0 ? { category: 'official' as const } : {}),
    provider: 'search-api',
    publishedAt: `2026-08-${String(index + 1).padStart(2, '0')}`,
    snippet,
    title: `Title ${index}`,
    url: `https://pagination.test/${index}`,
  }
}

function record(count = 5): Readonly<StoredSourceRecord> {
  const sourceRef = createSourceRef(entropy(9))
  return retainSourceRecord({
    call: {
      callId: 'page-call',
      mode: 'top-level',
      name: 'web_search',
      rootCallId: 'page-call',
    },
    candidate: {
      collectionTruncated: false,
      depth: 'compact',
      profile: 'auto',
      query: 'pagination query',
      sources: Array.from({ length: count }, (_value, index) => source(index)),
    },
    ownerSessionId: 'page-owner',
    sourceRef,
  }, { maxBytes: 128 * 1024, maxSources: 100 })
}

function page(
  stored: StoredSourceRecord,
  offset: number,
  limit: number,
  format: 'compact' | 'full' = 'compact',
  maxPageBytes = 128 * 1024,
) {
  return paginateSourceRecord(
    stored,
    parseSourcePageRequest({ format, limit, offset, source_ref: stored.sourceRef }, 100),
    { maxPageBytes, maxSnippetCharacters: 4 },
  )
}

class ReadOnlyTable implements KvTable<SourceRef, StoredSourceRecord> {
  constructor(private readonly key: SourceRef, private readonly value: StoredSourceRecord) {}
  get size(): number { return 1 }
  get(key: SourceRef): StoredSourceRecord | undefined { return key === this.key ? this.value : undefined }
  * entries(): IterableIterator<[SourceRef, StoredSourceRecord]> { yield [this.key, this.value] }
  * keys(): IterableIterator<SourceRef> { yield this.key }
  async put(): Promise<void> { throw new Error('unused') }
  async delete(): Promise<boolean> { throw new Error('unused') }
  async update(): Promise<StoredSourceRecord> { throw new Error('unused') }
}

describe('source page request and projection', () => {
  it('applies defaults and validates offset, limit, format, and max page size', () => {
    expect(parseSourcePageRequest({ source_ref: 'opaque' }, 50)).toEqual({
      format: 'compact',
      limit: 20,
      offset: 0,
      sourceRef: 'opaque',
    })
    for (const request of [
      { source_ref: 'x', offset: -1 },
      { source_ref: 'x', offset: 1.5 },
      { source_ref: 'x', limit: 0 },
      { source_ref: 'x', limit: 51 },
      { source_ref: 'x', format: 'raw' },
    ]) {
      expect(() => parseSourcePageRequest(request, 50)).toThrow(SourcePageError)
    }
  })

  it('returns compact title/url/date/category only and maps absent category to unknown', () => {
    const result = page(record(2), 0, 2)

    expect(result.sources).toEqual([
      {
        category: 'official',
        date: '2026-08-01',
        title: 'Title 0',
        url: 'https://pagination.test/0',
      },
      {
        category: 'unknown',
        date: '2026-08-02',
        title: 'Title 1',
        url: 'https://pagination.test/1',
      },
    ])
    expect(JSON.stringify(result.sources)).not.toContain('snippet')
    expect(JSON.stringify(result.sources)).not.toContain('provider')
  })

  it('adds a code-point-bounded snippet only in full format', () => {
    const stored = record(1)
    const first = stored.sources[0]
    if (first === undefined) throw new Error('missing fixture source')
    const rewritten: StoredSourceRecord = {
      ...stored,
      sources: [{ ...first, snippet: '界🙂ABCD' }],
    }
    const result = page(rewritten, 0, 1, 'full')

    expect(result.sources[0]).toMatchObject({
      snippet: '界🙂AB',
      snippetTruncated: true,
    })
    expect(Array.from((result.sources[0] as { snippet: string }).snippet)).toHaveLength(4)
  })

  it('returns correct first, middle, tail, equal-total, and beyond-total cursors', () => {
    const stored = record(5)
    expect(page(stored, 0, 2)).toMatchObject({
      hasMore: true,
      nextOffset: 2,
      offset: 0,
      returned: 2,
      total: 5,
    })
    expect(page(stored, 2, 2)).toMatchObject({
      hasMore: true,
      nextOffset: 4,
      offset: 2,
      returned: 2,
    })
    const tail = page(stored, 4, 2)
    expect(tail).toMatchObject({ hasMore: false, offset: 4, returned: 1 })
    expect(tail).not.toHaveProperty('nextOffset')

    for (const offset of [5, 8]) {
      const empty = page(stored, offset, 2)
      expect(empty).toMatchObject({
        hasMore: false,
        offset,
        pageByteLimited: false,
        returned: 0,
        sources: [],
        state: 'found',
        total: 5,
      })
      expect(empty).not.toHaveProperty('nextOffset')
    }
  })
})

describe('independent canonical page byte cap and not-found semantics', () => {
  it('accepts exact bytes and advances by the actually retained over-limit prefix', () => {
    const stored = record(2)
    const complete = page(stored, 0, 2, 'full')
    const exactBytes = Buffer.byteLength(JSON.stringify(complete), 'utf8')

    expect(page(stored, 0, 2, 'full', exactBytes)).toEqual(complete)
    const over = page(stored, 0, 2, 'full', exactBytes - 1)
    expect(over).toMatchObject({
      hasMore: true,
      nextOffset: 1,
      pageByteLimited: true,
      returned: 1,
      total: 2,
    })
    expect(over.nextOffset).toBe(over.offset + over.returned)
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
  })

  it('fails tiny envelopes and a non-empty page with no fitting item', () => {
    const stored = record(1)
    expect(() => page(stored, 0, 1, 'compact', 1)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_PAGE_BUDGET' }),
    )

    let firstSuccessful = 0
    for (let bytes = 1; bytes < 2000; bytes += 1) {
      try {
        page(stored, 0, 1, 'compact', bytes)
        firstSuccessful = bytes
        break
      } catch (error) {
        expect(error).toBeInstanceOf(SourcePageError)
      }
    }
    expect(firstSuccessful).toBeGreaterThan(1)
    expect(() => page(stored, 0, 1, 'compact', firstSuccessful - 1)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_PAGE_BUDGET' }),
    )
  })

  it('returns one stable not-found for absent, malformed, and unauthorized refs', () => {
    const stored = record(2)
    const repository = new SourceRecordStore(
      new ReadOnlyTable(stored.sourceRef, stored),
      {
        maxBytes: 64 * 1024,
        maxRecords: 10,
        maxSources: 10,
        maxPageSize: 100,
        maxPageBytes: 64 * 1024,
        maxSnippetCharacters: 20,
      },
    )
    const owner = Session.create(SessionId('page-owner'))
    const unrelated = Session.create(SessionId('someone-else'))

    expect(repository.page(owner, { source_ref: 'invalid' })).toBe(SOURCE_REF_NOT_FOUND)
    expect(repository.page(owner, { source_ref: createSourceRef(entropy(3)) })).toBe(SOURCE_REF_NOT_FOUND)
    expect(repository.page(unrelated, { source_ref: stored.sourceRef })).toBe(SOURCE_REF_NOT_FOUND)
    expect(repository.page(owner, { source_ref: stored.sourceRef })).toMatchObject({
      state: 'found',
      total: 2,
    })
  })
})

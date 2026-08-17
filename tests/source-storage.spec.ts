import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionStore,
} from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'

import type {
  CanonicalSource,
  SourceCallIdentity,
  SourceRecordCandidate,
  SourceRef,
  StoredSourceRecord,
} from '../src/contracts/index.js'
import { OutputLimitError } from '../src/provider-runtime/index.js'
import {
  SOURCE_REF_NOT_FOUND,
  SourceRecordStore,
  SourceStoreError,
  createSourceRef,
  retainSourceRecord,
  sourceCallIdentity,
} from '../src/source-storage/index.js'

function source(index: number, snippet = `snippet-${index}`): CanonicalSource {
  return Object.freeze({
    category: 'documentation',
    provider: 'search-api',
    publishedAt: '2026-08-14',
    snippet,
    title: `Source ${index}`,
    url: `https://example.test/${index}`,
  })
}

function candidate(
  sources: readonly CanonicalSource[] = [source(1)],
  collectionTruncated = false,
): SourceRecordCandidate {
  return Object.freeze({
    collectionTruncated,
    depth: 'compact',
    profile: 'coding_docs',
    query: 'React 文档 query',
    sources,
  })
}

function call(mode: SourceCallIdentity['mode'] = 'top-level'): SourceCallIdentity {
  return Object.freeze({
    callId: mode === 'top-level' ? 'call-native' : 'call-root:code:0',
    mode,
    name: 'web_search',
    rootCallId: mode === 'top-level' ? 'call-native' : 'call-root',
  })
}

function deterministicEntropy(seed: number): (size: number) => Uint8Array {
  let value = seed
  return size => {
    const bytes = new Uint8Array(size)
    bytes.fill(value % 256)
    value += 1
    return bytes
  }
}

class TestTable implements KvTable<SourceRef, StoredSourceRecord> {
  readonly records = new Map<SourceRef, StoredSourceRecord>()
  putHook: ((key: SourceRef, value: StoredSourceRecord) => Promise<void>) | undefined

  get size(): number {
    return this.records.size
  }

  get(key: SourceRef): StoredSourceRecord | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[SourceRef, StoredSourceRecord]> {
    return new Map(this.records).entries()
  }

  keys(): IterableIterator<SourceRef> {
    return new Map(this.records).keys()
  }

  async put(key: SourceRef, value: StoredSourceRecord): Promise<void> {
    if (this.putHook !== undefined) return this.putHook(key, value)
    this.records.set(key, value)
  }

  async delete(key: SourceRef): Promise<boolean> {
    return this.records.delete(key)
  }

  async update(
    key: SourceRef,
    transform: (current: StoredSourceRecord) => StoredSourceRecord,
  ): Promise<StoredSourceRecord> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing')
    const next = transform(current)
    this.records.set(key, next)
    return next
  }
}

function store(
  table = new TestTable(),
  overrides: Partial<ConstructorParameters<typeof SourceRecordStore>[1]> = {},
): { readonly store: SourceRecordStore; readonly table: TestTable } {
  return {
    store: new SourceRecordStore(table, {
      entropy: deterministicEntropy(1),
      maxBytes: 64 * 1024,
      maxRecords: 100,
      maxSources: 10,
      maxPageSize: 100,
      maxPageBytes: 64 * 1024,
      maxSnippetCharacters: 4000,
      ...overrides,
    }),
    table,
  }
}

function detachedSession(id: string): Session {
  return Session.create(SessionId(id))
}

function retentionInput(sourceRef: SourceRef, sources = [source(1)]) {
  return {
    call: call(),
    candidate: candidate(sources),
    ownerSessionId: 'owner-session',
    sourceRef,
  }
}

describe('opaque source refs and complete-record retention', () => {
  it('creates fixed-shape random ids without embedding caller data', () => {
    const first = createSourceRef(deterministicEntropy(7))
    const second = createSourceRef(deterministicEntropy(8))

    expect(first).toMatch(/^src_[A-Za-z0-9_-]{32}$/)
    expect(second).not.toBe(first)
    expect(first).not.toContain('owner-session')
    expect(first).not.toContain('example.test')
    expect(first).not.toContain('React')
  })

  it('measures empty, tiny, exact, over-limit, count, and UTF-8 envelopes', () => {
    const sourceRef = createSourceRef(deterministicEntropy(1))
    const empty = retainSourceRecord(retentionInput(sourceRef, []), {
      maxBytes: 64 * 1024,
      maxSources: 10,
    })
    const emptyBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8')
    expect(empty).toMatchObject({ sources: [], totalBeforeRetention: 0, truncated: false })
    expect(() => retainSourceRecord(retentionInput(sourceRef, []), {
      maxBytes: emptyBytes - 1,
      maxSources: 10,
    })).toThrow(OutputLimitError)

    const unicodeSources = [source(1, '界🙂'), source(2, '第二条')]
    const full = retainSourceRecord(retentionInput(sourceRef, unicodeSources), {
      maxBytes: 64 * 1024,
      maxSources: 10,
    })
    const exactBytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
    expect(retainSourceRecord(retentionInput(sourceRef, unicodeSources), {
      maxBytes: exactBytes,
      maxSources: 10,
    })).toEqual(full)

    const over = retainSourceRecord(retentionInput(sourceRef, unicodeSources), {
      maxBytes: exactBytes - 1,
      maxSources: 10,
    })
    expect(over.sources).toHaveLength(1)
    expect(over.sources[0]?.snippet).toBe('界🙂')
    expect(over).toMatchObject({ totalBeforeRetention: 2, truncated: true })

    const countLimited = retainSourceRecord(retentionInput(sourceRef, unicodeSources), {
      maxBytes: exactBytes,
      maxSources: 1,
    })
    expect(countLimited.sources).toHaveLength(1)
    expect(countLimited.truncated).toBe(true)
  })

  it('preserves upstream collection truncation independently of record retention', () => {
    const sourceRef = createSourceRef(deterministicEntropy(2))
    const record = retainSourceRecord({
      ...retentionInput(sourceRef),
      candidate: candidate([source(1)], true),
    }, { maxBytes: 64 * 1024, maxSources: 10 })

    expect(record).toMatchObject({
      collectionTruncated: true,
      totalBeforeRetention: 1,
      truncated: true,
    })
  })
})

describe('source store durability ordering, cancellation, and concurrency', () => {
  it('does not make a ref visible or return it before durable put resolves', async () => {
    const table = new TestTable()
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    table.putHook = async (key, value) => {
      markStarted()
      await gate
      table.records.set(key, value)
    }
    const test = store(table)
    const owner = detachedSession('owner')
    const expectedRef = createSourceRef(deterministicEntropy(1))

    let published: SourceRef | undefined
    const pending = test.store.record(owner, call(), candidate(), new AbortController().signal)
      .then(commit => { published = commit.sourceRef; return commit })
    await started

    expect(published).toBeUndefined()
    expect(test.store.lookup(owner, expectedRef)).toBe(SOURCE_REF_NOT_FOUND)
    release()

    const commit = await pending
    expect(commit.sourceRef).toBe(expectedRef)
    expect(test.store.lookup(owner, expectedRef)).toMatchObject({ state: 'found' })
  })

  it('publishes no successful ref on write failure or cancellation', async () => {
    const failedTable = new TestTable()
    failedTable.putHook = async () => { throw new Error('disk failed') }
    const failed = store(failedTable)
    const owner = detachedSession('owner-failed')

    await expect(failed.store.record(
      owner,
      call(),
      candidate(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SOURCE_RECORD_WRITE' })
    expect(failedTable.size).toBe(0)

    const preCancelled = new AbortController()
    const preCancelledReason = new Error('cancel before source commit')
    preCancelled.abort(preCancelledReason)
    await expect(failed.store.record(
      owner,
      call(),
      candidate(),
      preCancelled.signal,
    )).rejects.toBe(preCancelledReason)
    expect(failedTable.size).toBe(0)

    const cancelledTable = new TestTable()
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    cancelledTable.putHook = async (key, value) => {
      markStarted()
      await gate
      cancelledTable.records.set(key, value)
    }
    const cancelled = store(cancelledTable)
    const controller = new AbortController()
    const reason = new Error('cancel source commit')
    const pending = cancelled.store.record(owner, call(), candidate(), controller.signal)
    await started
    controller.abort(reason)
    release()

    await expect(pending).rejects.toBe(reason)
    expect(cancelledTable.size).toBe(1)
  })

  it('serializes concurrent records, handles collisions, and never overwrites', async () => {
    const table = new TestTable()
    let entropyCalls = 0
    const entropy = (size: number): Uint8Array => {
      const value = entropyCalls <= 1 ? 1 : entropyCalls
      entropyCalls += 1
      return new Uint8Array(size).fill(value)
    }
    const test = store(table, { entropy })
    const owner = detachedSession('owner-concurrent')

    const commits = await Promise.all(Array.from({ length: 20 }, (_value, index) =>
      test.store.record(
        owner,
        call(),
        candidate([source(index)]),
        new AbortController().signal,
      )))

    expect(new Set(commits.map(commit => commit.sourceRef)).size).toBe(20)
    expect(entropyCalls).toBe(21)
    expect(table.size).toBe(20)
    for (const commit of commits) {
      expect(table.get(commit.sourceRef)?.sourceRef).toBe(commit.sourceRef)
    }
  })

  it('fails closed at capacity and rejects a record whose envelope retains no source', async () => {
    const capacity = store(new TestTable(), { maxRecords: 1 })
    const owner = detachedSession('owner-capacity')
    await capacity.store.record(owner, call(), candidate(), new AbortController().signal)
    await expect(capacity.store.record(
      owner,
      call(),
      candidate([source(2)]),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SOURCE_STORE_CAPACITY' })
    expect(capacity.table.size).toBe(1)

    const sourceRef = createSourceRef(deterministicEntropy(1))
    const emptyEnvelope = retainSourceRecord(retentionInput(sourceRef, []), {
      maxBytes: 64 * 1024,
      maxSources: 1,
    })
    const tiny = store(new TestTable(), {
      maxBytes: Buffer.byteLength(JSON.stringify(emptyEnvelope), 'utf8'),
      maxSources: 1,
    })
    await expect(tiny.store.record(
      detachedSession('owner-tiny'),
      call(),
      candidate([source(1, 'large source')]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(SourceStoreError)
    expect(tiny.table.size).toBe(0)
  })
})

describe('owner, restored-session, and structured fork authorization', () => {
  it('authorizes owner immediately and a restored object with the same session id', async () => {
    const test = store()
    const owner = detachedSession('owner-restored')
    const commit = await test.store.record(
      owner,
      call(),
      candidate(),
      new AbortController().signal,
    )

    expect(test.store.lookup(owner, commit.sourceRef)).toMatchObject({ state: 'found' })
    expect(test.store.lookup(
      detachedSession('owner-restored'),
      commit.sourceRef,
    )).toMatchObject({ state: 'found' })
    expect(test.store.lookup(detachedSession('unrelated'), commit.sourceRef)).toBe(SOURCE_REF_NOT_FOUND)
    expect(test.store.lookup(owner, 'not-a-source-ref')).toBe(SOURCE_REF_NOT_FOUND)
  })

  it('uses inherited successful tool/result identity for real top-level forks and multi-level forks', async () => {
    const context = new Context()
    new SessionStore(context)
    try {
      const owner = context.sessions.create(SessionId('owner-native'))
      const test = store()
      const identity = call('top-level')
      const commit = await test.store.record(
        owner,
        identity,
        candidate(),
        new AbortController().signal,
      )
      const lateIdentityChild = context.sessions.fork(
        owner,
        undefined,
        SessionId('late-identity-child'),
      )
      lateIdentityChild.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId(identity.callId),
          content: [{ type: 'text', text: commit.sourceRef }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      expect(test.store.lookup(lateIdentityChild, commit.sourceRef)).toBe(SOURCE_REF_NOT_FOUND)

      owner.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId(identity.callId),
          content: [{ type: 'text', text: `source ${commit.sourceRef}` }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })

      const child = context.sessions.fork(owner, undefined, SessionId('child-native'))
      const grandchild = context.sessions.fork(child, undefined, SessionId('grandchild-native'))
      expect(test.store.lookup(child, commit.sourceRef)).toMatchObject({ state: 'found' })
      expect(test.store.lookup(grandchild, commit.sourceRef)).toMatchObject({ state: 'found' })

      const unrelatedParent = context.sessions.create(SessionId('unrelated-parent'))
      unrelatedParent.append('user/message', createUserMessage({
        content: [{
          type: 'text',
          text: `display only ${commit.sourceRef} ${identity.callId} web_search`,
        }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const unrelatedFork = context.sessions.fork(
        unrelatedParent,
        undefined,
        SessionId('unrelated-fork'),
      )
      expect(test.store.lookup(unrelatedFork, commit.sourceRef)).toBe(SOURCE_REF_NOT_FOUND)
    } finally {
      await context.fiber.dispose()
    }
  })

  it('uses inherited successful tool/code-dispatch fields and rejects failed or text-only matches', async () => {
    const context = new Context()
    new SessionStore(context)
    try {
      const owner = context.sessions.create(SessionId('owner-code'))
      const test = store()
      const identity = call('nested-code')
      const commit = await test.store.record(
        owner,
        identity,
        candidate(),
        new AbortController().signal,
      )
      owner.append('tool/code-dispatch', {
        arguments: { query: 'React docs' },
        content: [{ type: 'text', text: `stored ${commit.sourceRef}` }],
        isError: false,
        name: identity.name,
        parentCallId: CallId(identity.rootCallId),
        rootCallId: CallId(identity.rootCallId),
        subCallId: CallId(identity.callId),
      })
      const child = context.sessions.fork(owner, undefined, SessionId('child-code'))
      const grandchild = context.sessions.fork(child, undefined, SessionId('grandchild-code'))
      expect(test.store.lookup(child, commit.sourceRef)).toMatchObject({ state: 'found' })
      expect(test.store.lookup(grandchild, commit.sourceRef)).toMatchObject({ state: 'found' })

      const failedParent = context.sessions.create(SessionId('failed-code-parent'))
      failedParent.append('tool/code-dispatch', {
        arguments: {},
        content: [{ type: 'text', text: commit.sourceRef }],
        isError: true,
        name: identity.name,
        parentCallId: CallId(identity.rootCallId),
        rootCallId: CallId(identity.rootCallId),
        subCallId: CallId(identity.callId),
      })
      const failedFork = context.sessions.fork(
        failedParent,
        undefined,
        SessionId('failed-code-fork'),
      )
      expect(test.store.lookup(failedFork, commit.sourceRef)).toBe(SOURCE_REF_NOT_FOUND)
    } finally {
      await context.fiber.dispose()
    }
  })

  it('derives future call identity only from public execution fields', () => {
    expect(sourceCallIdentity({
      callId: 'native',
      name: 'web_search',
      rootCallId: 'native',
    })).toEqual({
      callId: 'native',
      mode: 'top-level',
      name: 'web_search',
      rootCallId: 'native',
    })
    expect(sourceCallIdentity({
      callId: 'root:code:1',
      name: 'web_search',
      parent: Symbol('opaque'),
      rootCallId: 'root',
    }).mode).toBe('nested-code')
  })
})

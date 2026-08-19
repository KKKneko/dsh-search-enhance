import { Buffer } from 'node:buffer'

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId,
} from '@deepseek-ai/dsh-llm'
import {
  parameterSchemaSpecToJsonSchema,
  type ToolResult,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { Config } from '../src/config.js'
import type {
  Context7DocRef,
  DocumentationSearchResult,
} from '../src/documentation/index.js'
import type { SourceRef, StoredSourceRecord } from '../src/contracts/index.js'
import type { SearchOrchestrationResult } from '../src/orchestration/index.js'
import {
  docsSearchPresentationMeta,
  webSearchPresentationMeta,
  presentDocsSearchCall,
  presentDocsSearchResult,
  presentWebSearchCall,
  presentWebSearchResult,
  presentSearchSourcesResult,
  searchSourcesPresentationMeta,
} from '../src/presentation/web-card.js'
import {
  renderDocsSearchText,
  renderWebSearchText,
  renderSearchSourcesText,
  sourceDisplayLabel,
} from '../src/presentation/render.js'
import type { SourcePageFound } from '../src/source-storage/index.js'
import {
  DOCS_SEARCH_PARAMETERS,
  WEB_SEARCH_PARAMETERS,
  SEARCH_SOURCES_PARAMETERS,
  boundDocsSearchOutput,
  boundWebSearchOutput,
  boundSearchSourcesOutput,
  createDocsSearchTool,
  projectDocsSearchOutput,
  projectWebSearchOutput,
  projectSearchSourcesOutput,
  ForegroundOperationScope,
  type DocsSearchOutput,
  type WebSearchOutput,
  type SearchSourcesOutput,
} from '../src/tools/index.js'

const sourceRef = 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as SourceRef

function resolvedConfig(maxModelTextBytes = 4096) {
  const base = Config({} as never)
  return {
    ...base,
    budgets: {
      ...base.budgets,
      auto: {
        ...base.budgets.auto,
        compact: {
          ...base.budgets.auto.compact,
          maxModelTextBytes,
        },
      },
    },
  }
}

function orchestrationResult(): SearchOrchestrationResult {
  return {
    canonical: {
      state: 'complete',
      answer: 'Bounded answer',
      sources: [{
        url: 'https://visible.test/a',
        title: 'Visible A',
        snippet: 'Discovery snippet',
        publishedAt: '2026-08-14',
        provider: 'search-api',
        category: 'official',
      }],
      totalSources: 2,
      returnedSources: 1,
      totalAnswerCharacters: 14,
      returnedAnswerCharacters: 14,
      truncated: true,
      evidenceLevel: 'discovery',
      warnings: [{ code: 'provider_failed', provider: 'exa', errorKind: 'network' }],
    },
    persistence: {
      query: 'search query',
      profile: 'auto',
      depth: 'compact',
      collectionTruncated: false,
      sources: [
        { url: 'https://visible.test/a', provider: 'search-api' },
        { url: 'https://hidden.test/b', provider: 'exa' },
      ],
    },
    diagnostics: {
      routing: {
        profile: 'auto',
        depth: 'compact',
        documentationEnhancement: true,
        extraDiscoveryBudget: 0,
        discoveryAllocation: { tavily: 0, firecrawl: 0 },
      },
      attempts: [],
    },
  }
}

function storedRecord(truncated = false): StoredSourceRecord {
  return {
    version: 1,
    sourceRef,
    ownerSessionId: 'session-a',
    query: 'search query',
    profile: 'auto',
    depth: 'compact',
    call: {
      mode: 'top-level',
      rootCallId: 'call-a',
      callId: 'call-a',
      name: 'web_search',
    },
    sources: [{ url: 'https://visible.test/a', provider: 'search-api' }],
    totalBeforeRetention: truncated ? 2 : 1,
    collectionTruncated: false,
    truncated,
  }
}

function docsResult(overrides: Partial<DocumentationSearchResult> = {}): DocumentationSearchResult {
  const result: DocumentationSearchResult = {
    query: 'React useEffect API docs',
    provider: 'all',
    providers: [
      { provider: 'context7', state: 'complete' },
      { provider: 'exa', state: 'failed' },
    ],
    selectedLibrary: {
      id: '/react/react',
      title: 'React',
      description: 'Official React documentation',
    },
    docRef: 'ctx7d_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Context7DocRef,
    snippets: [{ content: 'useEffect cleanup snippet', title: 'Cleanup', libraryId: '/react/react' }],
    sources: [
      {
        provider: 'context7',
        category: 'documentation',
        title: 'React docs',
        snippet: 'Context7 discovery snippet',
        url: 'https://react.dev/reference/react/useEffect',
      },
      {
        provider: 'exa',
        category: 'official',
        title: 'React API',
        url: 'https://react.dev/reference/react',
      },
    ],
    cache: {
      resolve: { state: 'hit', evictedEntries: 0 },
      docs: { state: 'stale', evictedEntries: 1 },
    },
    attempts: [],
    warnings: [
      { code: 'cache_stale', provider: 'context7-cache', path: 'docs', errorKind: 'timeout' },
      { code: 'provider_failed', provider: 'exa', errorKind: 'network' },
    ],
    persistence: {
      query: 'React useEffect API docs',
      profile: 'coding_docs',
      depth: 'compact',
      sources: [
        { provider: 'context7', url: 'https://react.dev/reference/react/useEffect' },
        { provider: 'exa', url: 'https://react.dev/reference/react' },
      ],
      collectionTruncated: false,
    },
    totalSources: 2,
    returnedSources: 2,
    totalSnippets: 1,
    returnedSnippets: 1,
    providerResponseBytes: 1234,
    truncated: false,
  }
  return { ...result, ...overrides }
}

function toolRunContext(
  session: Session,
  callId: string,
  args: unknown,
  parent?: symbol,
): ToolRunContext {
  const id = CallId(callId)
  return {
    callId: id,
    rootCallId: id,
    name: 'docs_search',
    arguments: args,
    token: Symbol('docs-search-exec') as never,
    ...(parent === undefined ? {} : { parent: parent as never }),
    signal: new AbortController().signal,
    agent: { session } as never,
    deferContext() {},
    concludeTurn() {},
  }
}

function resultWithLimit(maximumBytes: number, answer = 'Answer'): WebSearchOutput {
  return {
    state: 'complete',
    answer,
    sources: [{
      url: 'https://source.test/a',
      title: 'Source title',
      snippet: 'A useful discovery snippet.',
      publishedAt: '2026-08-14',
    }],
    source_ref: sourceRef,
    total_sources: 3,
    returned_sources: 1,
    truncated: true,
    evidence_level: 'discovery',
    warnings: [{ code: 'provider_failed', provider: 'exa', error_kind: 'network' }],
    model_text_max_bytes: maximumBytes,
  }
}

describe('fiber-owned foreground operations', () => {
  it('cancels owning turns, aborts, and drains active work before rejecting later admission', async () => {
    const operations = new ForegroundOperationScope()
    const cancel = vi.fn()
    const agent = { cancel } as unknown as Agent
    let settled = false
    const running = operations.run(
      new AbortController().signal,
      signal => new Promise((_resolve, reject) => {
        const abort = () => {
          settled = true
          reject(signal.reason)
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }),
      agent,
    )
    const observed = running.catch(error => error)
    await operations.stop()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith({
      kind: 'hook',
      reason: 'search-enhance plugin disposing',
    })
    const error = await observed
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORTED' })
    expect(settled).toBe(true)
    await expect(operations.run(
      new AbortController().signal,
      async () => 'late',
    )).rejects.toMatchObject({ name: 'AbortError', code: 'ABORTED' })
  })
})

describe('docs_search execution and durable publication', () => {
  it('reads Settings once, forwards one active signal, and records before publishing source_ref', async () => {
    const session = Session.create(SessionId('docs-tool-session'))
    const config = resolvedConfig()
    const operations = new ForegroundOperationScope()
    const order: string[] = []
    let settingsReads = 0
    let operationSignal: AbortSignal | undefined
    const result = docsResult({
      provider: 'context7',
      providers: [
        { provider: 'context7', state: 'complete' },
        { provider: 'exa', state: 'skipped' },
      ],
      cache: {
        resolve: { state: 'miss', evictedEntries: 0 },
        docs: { state: 'miss', evictedEntries: 0 },
      },
      warnings: [],
    })
    const tool = createDocsSearchTool({
      getConfig: () => {
        settingsReads += 1
        order.push('settings')
        return config
      },
      documentation: {
        search: async input => {
          order.push('documentation')
          operationSignal = input.signal
          expect(input).toMatchObject({
            config,
            forceRefresh: true,
            libraryId: '/react/react',
            libraryName: 'React',
            maxResults: 6,
            provider: 'context7',
            query: 'React useEffect API docs',
          })
          expect(input.signal.aborted).toBe(false)
          return result
        },
      },
      operations,
      sourceOperationNotice: 'source operation manifest',
      sources: {
        record: async (owner, call, candidate, signal) => {
          order.push('record')
          expect(owner).toBe(session)
          expect(signal).toBe(operationSignal)
          expect(call).toEqual({
            callId: 'docs-tool-call',
            mode: 'top-level',
            name: 'docs_search',
            rootCallId: 'docs-tool-call',
          })
          expect(candidate).toEqual(result.persistence)
          return {
            sourceRef,
            record: {
              version: 1,
              sourceRef,
              ownerSessionId: String(session.id),
              query: candidate.query,
              profile: candidate.profile,
              depth: candidate.depth,
              call,
              sources: candidate.sources,
              totalBeforeRetention: candidate.sources.length,
              collectionTruncated: candidate.collectionTruncated,
              truncated: candidate.collectionTruncated,
            },
          }
        },
      },
    })
    const args = {
      query: 'React useEffect API docs',
      provider: 'context7' as const,
      library_name: 'React',
      library_id: '/react/react',
      force_refresh: true,
    }
    const exec = toolRunContext(session, 'docs-tool-call', args)
    const value = await tool.execute(args, exec) as DocsSearchOutput

    expect(settingsReads).toBe(1)
    expect(order).toEqual(['settings', 'documentation', 'record'])
    expect(value.source_ref).toBe(sourceRef)
    expect(value.doc_ref).toBe(result.docRef)
    expect(value.state).toBe('complete')
    await operations.stop()
  })

  it('fails before Provider dispatch when max_results exceeds the Settings cap', async () => {
    const session = Session.create(SessionId('docs-tool-limit-session'))
    const operations = new ForegroundOperationScope()
    let searches = 0
    const config = Config({ retention: { docsSearchMaxResults: 6 } } as never)
    const tool = createDocsSearchTool({
      getConfig: () => config,
      documentation: {
        search: async () => {
          searches += 1
          return docsResult()
        },
      },
      operations,
      sourceOperationNotice: 'source operation manifest',
      sources: {
        record: async () => { throw new Error('record must not run') },
      },
    })
    const args = { query: 'React docs', max_results: 7 }
    await expect(tool.execute(
      args,
      toolRunContext(session, 'docs-limit-call', args),
    )).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(searches).toBe(0)
    await operations.stop()
  })

  it('does not fabricate or persist a source_ref for a source-free docs result', async () => {
    const session = Session.create(SessionId('docs-tool-empty'))
    const operations = new ForegroundOperationScope()
    let records = 0
    const empty = docsResult({
      provider: 'context7',
      providers: [
        { provider: 'context7', state: 'complete' },
        { provider: 'exa', state: 'skipped' },
      ],
      sources: [],
      warnings: [],
      persistence: {
        query: 'React useEffect API docs',
        profile: 'coding_docs',
        depth: 'compact',
        sources: [],
        collectionTruncated: false,
      },
      totalSources: 0,
      returnedSources: 0,
    })
    const tool = createDocsSearchTool({
      getConfig: () => resolvedConfig(),
      documentation: { search: async () => empty },
      operations,
      sourceOperationNotice: 'source operation manifest',
      sources: {
        record: async () => {
          records += 1
          throw new Error('source-free results must not be persisted')
        },
      },
    })
    const args = { query: 'React docs', provider: 'context7' as const }
    const value = await tool.execute(
      args,
      toolRunContext(session, 'docs-empty-call', args),
    ) as DocsSearchOutput

    expect(records).toBe(0)
    expect(value.source_ref).toBeUndefined()
    expect(value.sources).toEqual([])
    expect(value.doc_ref).toBe(empty.docRef)
    await operations.stop()
  })

  it('treats cancellation after a durable write as cancellation, not publication', async () => {
    const session = Session.create(SessionId('docs-tool-cancel-after-write'))
    const operations = new ForegroundOperationScope()
    const controller = new AbortController()
    const tool = createDocsSearchTool({
      getConfig: () => resolvedConfig(),
      documentation: { search: async () => docsResult() },
      operations,
      sourceOperationNotice: 'source operation manifest',
      sources: {
        record: async () => {
          controller.abort()
          return { sourceRef, record: storedRecord() }
        },
      },
    })
    const args = { query: 'React docs' }
    await expect(tool.execute(
      args,
      { ...toolRunContext(session, 'docs-cancel-call', args), signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
    await operations.stop()
  })

  it('propagates durable source write failures without publishing a canonical value', async () => {
    const session = Session.create(SessionId('docs-tool-write-failure'))
    const operations = new ForegroundOperationScope()
    const failure = new Error('SOURCE_STORE_WRITE')
    const tool = createDocsSearchTool({
      getConfig: () => resolvedConfig(),
      documentation: { search: async () => docsResult() },
      operations,
      sourceOperationNotice: 'source operation manifest',
      sources: { record: async () => { throw failure } },
    })
    const args = { query: 'React docs' }
    await expect(tool.execute(
      args,
      toolRunContext(session, 'docs-write-call', args),
    )).rejects.toBe(failure)
    await operations.stop()
  })
})

describe('model-facing tool schemas', () => {
  it('exposes only query/profile/depth for web_search', () => {
    const schema = parameterSchemaSpecToJsonSchema(WEB_SEARCH_PARAMETERS)
    expect(Object.keys(schema.properties)).toEqual(['query', 'profile', 'depth'])
    expect(schema.required).toEqual(['query'])
    expect(schema.properties.profile).toMatchObject({
      enum: ['auto', 'coding_docs', 'code_examples', 'project_research', 'academic', 'fact_check'],
      type: 'string',
    })
    expect(schema.properties.depth).toMatchObject({
      enum: ['compact', 'normal', 'deep'],
      type: 'string',
    })
    expect(JSON.stringify(schema)).not.toMatch(/provider|model|credential|api.?key|budget/i)
  })

  it('exposes only task-level docs_search intent with an absolute and Settings result cap', () => {
    const schema = parameterSchemaSpecToJsonSchema(DOCS_SEARCH_PARAMETERS)
    expect(Object.keys(schema.properties)).toEqual([
      'query',
      'provider',
      'library_name',
      'library_id',
      'max_results',
      'force_refresh',
    ])
    expect(schema.required).toEqual(['query'])
    expect(schema.properties.provider).toMatchObject({
      enum: ['auto', 'context7', 'exa', 'all'],
      type: 'string',
    })
    expect(schema.properties.library_name).toMatchObject({ type: 'string' })
    expect(schema.properties.library_id).toMatchObject({ type: 'string' })
    expect(schema.properties.max_results).toMatchObject({
      default: 6,
      enum: Array.from({ length: 20 }, (_value, index) => index + 1),
      type: 'integer',
    })
    expect(schema.properties.force_refresh).toMatchObject({ type: 'boolean' })
    expect(JSON.stringify(schema)).not.toMatch(
      /api.?key|base.?url|max_output_bytes|cache.?ttl|retry|header|credential/i,
    )
  })

  it('exposes the bounded source-page contract and no Provider controls', () => {
    const schema = parameterSchemaSpecToJsonSchema(SEARCH_SOURCES_PARAMETERS)
    expect(Object.keys(schema.properties)).toEqual(['source_ref', 'offset', 'limit', 'format'])
    expect(schema.required).toEqual(['source_ref'])
    expect(schema.properties.offset).toMatchObject({ type: 'integer' })
    expect(schema.properties.limit).toMatchObject({ type: 'integer' })
    expect(schema.properties.format).toMatchObject({ enum: ['compact', 'full'] })
    expect(JSON.stringify(schema)).not.toMatch(/provider|model|credential|api.?key/i)
  })
})

describe('canonical Consumer projections', () => {
  it('publishes only visible sources and only after receiving a durable commit', () => {
    const output = projectWebSearchOutput(
      orchestrationResult(),
      resolvedConfig(),
      { sourceRef, record: storedRecord() },
    )

    expect(output).toMatchObject({
      state: 'complete',
      answer: 'Bounded answer',
      source_ref: sourceRef,
      total_sources: 2,
      returned_sources: 1,
      evidence_level: 'discovery',
      model_text_max_bytes: 4096,
    })
    expect(output.sources).toEqual([{
      url: 'https://visible.test/a',
      title: 'Visible A',
      snippet: 'Discovery snippet',
      publishedAt: '2026-08-14',
    }])
    expect(JSON.stringify(output)).not.toContain('https://hidden.test/b')
    expect(JSON.stringify(output)).not.toMatch(/routing|attempts|credential|extraDiscoveryBudget/)
  })

  it('bounds the complete public envelope after adding source_ref and product fields', () => {
    const value = resultWithLimit(4096, '界面 answer')
    const exactBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    expect(boundWebSearchOutput(value, exactBytes)).toEqual(value)

    const bounded = boundWebSearchOutput(value, exactBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(bounded.truncated).toBe(true)
    expect(bounded.warnings).toContainEqual({ code: 'canonical_output_truncated' })
    expect(bounded.returned_sources).toBe(bounded.sources.length)

    expect(() => boundWebSearchOutput(value, 1)).toThrowError(
      expect.objectContaining({ kind: 'budget_exceeded' }),
    )
  })

  it('does not invent a ref and reports private-record retention truncation', () => {
    const withoutCommit = projectWebSearchOutput(
      orchestrationResult(),
      resolvedConfig(),
    )
    expect(withoutCommit).not.toHaveProperty('source_ref')

    const withTruncatedCommit = projectWebSearchOutput(
      orchestrationResult(),
      resolvedConfig(),
      { sourceRef, record: storedRecord(true) },
    )
    expect(withTruncatedCommit.truncated).toBe(true)
    expect(withTruncatedCommit.warnings).toContainEqual({ code: 'sources_truncated' })
  })

  it('projects bounded docs facts, cache/provider states, and only a durable source_ref', () => {
    const result = docsResult()
    const output = projectDocsSearchOutput(
      result,
      resolvedConfig(),
      { sourceRef, record: { ...storedRecord(), truncated: false } },
    )

    expect(output).toMatchObject({
      state: 'partial',
      provider: 'all',
      source_ref: sourceRef,
      doc_ref: result.docRef,
      selected_library: { id: '/react/react', title: 'React' },
      cache: {
        resolve: { state: 'hit', evicted_entries: 0 },
        docs: { state: 'stale', evicted_entries: 1 },
      },
      total_sources: 2,
      returned_sources: 2,
      total_snippets: 1,
      returned_snippets: 1,
      evidence_level: 'discovery',
      model_text_max_bytes: 9000,
    })
    expect(output.providers).toEqual([
      { provider: 'context7', state: 'complete' },
      { provider: 'exa', state: 'failed' },
    ])
    expect(output.snippets).toEqual([{
      content: 'useEffect cleanup snippet',
      title: 'Cleanup',
      library_id: '/react/react',
    }])
    const serialized = JSON.stringify(output)
    expect(serialized).not.toMatch(/attempts|providerResponseBytes|trustScore|benchmarkScore|Authorization/)

    const withoutCommit = projectDocsSearchOutput(result, resolvedConfig())
    expect(withoutCommit).not.toHaveProperty('source_ref')
    const withRetentionCut = projectDocsSearchOutput(
      result,
      resolvedConfig(),
      { sourceRef, record: { ...storedRecord(true), profile: 'coding_docs', depth: 'compact' } },
    )
    expect(withRetentionCut.warnings).toContainEqual({ code: 'sources_truncated' })
  })

  it('bounds the complete docs_search envelope at exact, over, tiny, and multibyte limits', () => {
    const projected = projectDocsSearchOutput(docsResult(), resolvedConfig())
    const value: DocsSearchOutput = {
      ...projected,
      snippets: [{ ...projected.snippets[0], content: '界面 documentation snippet' }],
    }
    const exactBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    expect(boundDocsSearchOutput(value, exactBytes)).toEqual(value)

    const bounded = boundDocsSearchOutput(value, exactBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(bounded.truncated).toBe(true)
    expect(bounded.warnings).toContainEqual({ code: 'canonical_output_truncated' })
    expect(bounded.returned_sources).toBe(bounded.sources.length)
    expect(bounded.returned_snippets).toBe(bounded.snippets.length)
    expect(() => boundDocsSearchOutput(value, 1)).toThrowError(
      expect.objectContaining({ kind: 'budget_exceeded' }),
    )
  })

  it('projects found and not-found source pages without conflating them', () => {
    const found: SourcePageFound = {
      state: 'found',
      source_ref: sourceRef,
      offset: 2,
      limit: 2,
      format: 'full',
      total: 4,
      returned: 1,
      sources: [{
        url: 'https://page.test/2',
        title: 'Page 2',
        category: 'documentation',
        snippet: 'snippet',
        snippetTruncated: true,
      }],
      hasMore: true,
      nextOffset: 3,
      totalBeforeRetention: 8,
      truncated: true,
      pageByteLimited: true,
    }
    expect(projectSearchSourcesOutput(found)).toEqual({
      state: 'found',
      source_ref: sourceRef,
      offset: 2,
      limit: 2,
      format: 'full',
      total: 4,
      returned: 1,
      sources: [{
        url: 'https://page.test/2',
        title: 'Page 2',
        category: 'documentation',
        snippet: 'snippet',
        snippet_truncated: true,
      }],
      has_more: true,
      next_offset: 3,
      total_before_retention: 8,
      truncated: true,
      page_byte_limited: true,
    })
    expect(projectSearchSourcesOutput({
      state: 'not_found',
      code: 'SOURCE_REF_NOT_FOUND',
    })).toEqual({ state: 'not_found', code: 'SOURCE_REF_NOT_FOUND' })
  })

  it('rechecks exact/over/tiny byte limits on the public snake-case page', () => {
    const page: SearchSourcesOutput = {
      state: 'found',
      source_ref: sourceRef,
      offset: 0,
      limit: 2,
      format: 'full',
      total: 3,
      returned: 2,
      sources: [
        { url: 'https://page.test/one', category: 'official', snippet: '界面 one' },
        { url: 'https://page.test/two', category: 'documentation', snippet: '界面 two' },
      ],
      has_more: true,
      next_offset: 2,
      total_before_retention: 3,
      truncated: false,
      page_byte_limited: false,
    }
    const exactBytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
    expect(boundSearchSourcesOutput(page, exactBytes)).toEqual(page)

    const oneSourceEnvelope = {
      ...page,
      returned: 1,
      sources: page.sources.slice(0, 1),
      has_more: true,
      next_offset: 1,
      page_byte_limited: true,
    }
    const oneSourceBytes = Buffer.byteLength(JSON.stringify(oneSourceEnvelope), 'utf8')
    const bounded = boundSearchSourcesOutput(page, oneSourceBytes)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBe(oneSourceBytes)
    expect(bounded).toEqual(oneSourceEnvelope)
    expect(() => boundSearchSourcesOutput(page, oneSourceBytes - 1)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_PAGE_BUDGET' }),
    )
    expect(() => boundSearchSourcesOutput(page, 1)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_PAGE_BUDGET' }),
    )
    expect(boundSearchSourcesOutput({
      state: 'not_found',
      code: 'SOURCE_REF_NOT_FOUND',
    }, 0)).toEqual({ state: 'not_found', code: 'SOURCE_REF_NOT_FOUND' })
  })
})

describe('Native model text', () => {
  it('renders answer, top sources, counts/ref, limitations, then discovery notice', () => {
    const text = renderWebSearchText(resultWithLimit(64 * 1024))
    const answer = text.indexOf('Answer')
    const sources = text.indexOf('Top sources')
    const counts = text.indexOf('Sources shown: 1/3')
    const limitations = text.indexOf('Limitations')
    const discovery = text.indexOf('Evidence level: discovery')
    expect(answer).toBeGreaterThanOrEqual(0)
    expect(sources).toBeGreaterThan(answer)
    expect(counts).toBeGreaterThan(sources)
    expect(limitations).toBeGreaterThan(counts)
    expect(discovery).toBeGreaterThan(limitations)
    expect(text).toContain('Source reference: src_')
    expect(text).toContain('Date: 2026-08-14')
    expect(text).toContain('Snippet: A useful discovery snippet.')
  })

  it('uses one hostname display fallback without writing a canonical title', () => {
    const url = 'https://www.cnsa.gov.cn/english/n6465652/n6465653/content.html'
    const web: WebSearchOutput = {
      ...resultWithLimit(64 * 1024),
      sources: [{ url }],
    }
    const docs: DocsSearchOutput = {
      ...projectDocsSearchOutput(docsResult(), resolvedConfig()),
      sources: [{ url }],
      returned_sources: 1,
      total_sources: 1,
    }
    const page: SearchSourcesOutput = {
      state: 'found',
      source_ref: sourceRef,
      offset: 0,
      limit: 1,
      format: 'compact',
      total: 1,
      returned: 1,
      sources: [{ url, category: 'official' }],
      has_more: false,
      total_before_retention: 1,
      truncated: false,
      page_byte_limited: false,
    }

    expect(sourceDisplayLabel({ url })).toBe('www.cnsa.gov.cn')
    for (const text of [
      renderWebSearchText(web),
      renderDocsSearchText(docs),
      renderSearchSourcesText(page),
    ]) {
      expect(text).toContain('1. www.cnsa.gov.cn')
      expect(text).not.toContain('Untitled source')
    }
    expect(web.sources[0]).toEqual({ url })
    expect(docs.sources[0]).toEqual({ url })
    expect(page.sources[0]).toEqual({ url, category: 'official' })
  })

  it('renders fixed stale-cache and eviction warnings without arbitrary details', () => {
    const text = renderWebSearchText({
      ...resultWithLimit(64 * 1024),
      warnings: [
        {
          capability: 'docs_search',
          code: 'cache_stale',
          error_kind: 'timeout',
          provider: 'context7-cache',
        },
        {
          capability: 'docs_search',
          code: 'cache_evicted',
          provider: 'context7-cache',
        },
      ],
    })

    expect(text).toContain('Expired Context7 cache data was used after a temporary Provider failure')
    expect(text).toContain('The bounded Context7 cache evicted an older entry')
  })

  it('enforces tiny, exact, over-limit, and multibyte UTF-8 boundaries', () => {
    const unbounded = renderWebSearchText(resultWithLimit(64 * 1024))
    const exactBytes = Buffer.byteLength(unbounded, 'utf8')
    const exact = renderWebSearchText(resultWithLimit(exactBytes))
    expect(exact).toBe(unbounded)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(exactBytes)

    const over = renderWebSearchText(resultWithLimit(exactBytes - 1))
    expect(Buffer.byteLength(over, 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(over.length).toBeLessThan(unbounded.length)

    expect(renderWebSearchText(resultWithLimit(1))).toBe('S')
    const { source_ref: _sourceRef, ...withoutSourceRef } = resultWithLimit(64 * 1024, '界面')
    void _sourceRef
    expect(renderWebSearchText({ ...withoutSourceRef, model_text_max_bytes: 2 })).toBe('')
    expect(renderWebSearchText({ ...withoutSourceRef, model_text_max_bytes: 3 })).toBe('界')
  })

  it('renders library/doc_ref, snippets, sources, cache/provider status, and discovery limits in order', () => {
    const value = projectDocsSearchOutput(docsResult(), resolvedConfig())
    const text = renderDocsSearchText(value)
    const library = text.indexOf('Selected library:')
    const docRef = text.indexOf('Documentation cache reference:')
    const snippets = text.indexOf('Documentation snippets')
    const sources = text.indexOf('Top sources')
    const counts = text.indexOf('Sources shown:')
    const cache = text.indexOf('Context7 resolve cache:')
    const limitations = text.indexOf('Limitations')
    const discovery = text.indexOf('Evidence level: discovery')
    expect(library).toBeGreaterThanOrEqual(0)
    expect(docRef).toBeGreaterThan(library)
    expect(snippets).toBeGreaterThan(docRef)
    expect(sources).toBeGreaterThan(snippets)
    expect(counts).toBeGreaterThan(sources)
    expect(cache).toBeGreaterThan(counts)
    expect(limitations).toBeGreaterThan(cache)
    expect(discovery).toBeGreaterThan(limitations)
    expect(text).toContain('useEffect cleanup snippet')
    expect(text).toContain('Expired Context7 cache data was used')
    expect(text).toContain('Context7 docs cache: stale, evicted 1')
    expect(text).toContain('Some documentation paths failed or stale cache data was used')
    expect(text).toContain('not verified fetched page-body evidence')
  })

  it('bounds docs Native text on UTF-8 exact, over, and multibyte limits', () => {
    const value = projectDocsSearchOutput(docsResult(), resolvedConfig())
    const unbounded = renderDocsSearchText({ ...value, model_text_max_bytes: 64 * 1024 })
    const exactBytes = Buffer.byteLength(unbounded, 'utf8')
    expect(renderDocsSearchText({ ...value, model_text_max_bytes: exactBytes })).toBe(unbounded)
    const over = renderDocsSearchText({ ...value, model_text_max_bytes: exactBytes - 1 })
    expect(Buffer.byteLength(over, 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(renderDocsSearchText({ ...value, model_text_max_bytes: 1 })).toBe('D')
    const multibyteValue = {
      ...value,
      snippets: [{ ...value.snippets[0], content: '界面 documentation' }],
      model_text_max_bytes: 64 * 1024,
    }
    const multibyteText = renderDocsSearchText(multibyteValue)
    const boundary = multibyteText.indexOf('界')
    expect(boundary).toBeGreaterThan(0)
    const beforeBytes = Buffer.byteLength(multibyteText.slice(0, boundary), 'utf8')
    expect(renderDocsSearchText({
      ...multibyteValue,
      model_text_max_bytes: beforeBytes + 2,
    })).toBe(multibyteText.slice(0, boundary))
    expect(renderDocsSearchText({
      ...multibyteValue,
      model_text_max_bytes: beforeBytes + 3,
    })).toBe(`${multibyteText.slice(0, boundary)}界`)
  })

  it('renders not-found as an explicit state rather than an empty page', () => {
    const notFound: SearchSourcesOutput = {
      state: 'not_found',
      code: 'SOURCE_REF_NOT_FOUND',
    }
    expect(renderSearchSourcesText(notFound)).toContain('Source reference not found')
    expect(renderSearchSourcesText(notFound)).toContain('private storage was not restored')
  })
})

describe('pure Web card projections', () => {
  it('uses the query as the generic pending title', () => {
    expect(presentWebSearchCall({ query: 'exact query' })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'exact query',
    })
  })

  it('produces the same web_search Web card from live and replayed metadata', () => {
    const args = { query: 'card query', profile: 'auto' as const }
    const value = resultWithLimit(4096)
    const liveMeta = webSearchPresentationMeta(args, value)
    const replayMeta = JSON.parse(JSON.stringify(liveMeta))
    const content = [{ type: 'text' as const, text: renderWebSearchText(value) }]
    const live = presentWebSearchResult(args, {
      content,
      isError: false,
      meta: liveMeta,
    })
    const replay = presentWebSearchResult(args, {
      content,
      isError: false,
      meta: replayMeta,
    })
    expect(replay).toEqual(live)
    expect(live).toMatchObject({
      card: 'web',
      kind: 'search',
      title: 'card query',
      truncated: true,
    })
    expect(JSON.stringify(liveMeta)).not.toMatch(/source_ref|provider|category|hidden/)
    expect(liveMeta).toMatchObject({ source_produced: true })
  })

  it('keeps titleless canonical sources titleless in replayable Web cards', () => {
    const url = 'https://www.cnsa.gov.cn/english/content.html'
    const webArgs = { query: 'titleless source' }
    const webValue: WebSearchOutput = {
      ...resultWithLimit(4096),
      sources: [{ url }],
    }
    const webMeta = webSearchPresentationMeta(webArgs, webValue)
    const webCard = presentWebSearchResult(webArgs, { content: [], isError: false, meta: webMeta })

    const docsArgs = { query: 'titleless docs source' }
    const docsValue: DocsSearchOutput = {
      ...projectDocsSearchOutput(docsResult(), resolvedConfig()),
      sources: [{ url }],
      returned_sources: 1,
      total_sources: 1,
    }
    const docsMeta = docsSearchPresentationMeta(docsArgs, docsValue)
    const docsCard = presentDocsSearchResult(docsArgs, { content: [], isError: false, meta: docsMeta })

    expect(webCard).toHaveProperty('sources', [{ url }])
    expect(docsCard).toHaveProperty('sources', [{ url }])
  })

  it('builds replay-identical docs cards from visible snippets/sources/cache metadata', () => {
    const args = {
      query: 'React cleanup docs',
      provider: 'context7' as const,
      max_results: 6 as const,
    }
    const value = projectDocsSearchOutput(docsResult(), resolvedConfig())
    const meta = docsSearchPresentationMeta(args, value)
    const content = [{ type: 'text' as const, text: renderDocsSearchText(value) }]
    const live = presentDocsSearchResult(args, { content, isError: false, meta })
    const replay = presentDocsSearchResult(args, {
      content,
      isError: false,
      meta: JSON.parse(JSON.stringify(meta)),
    })

    expect(presentDocsSearchCall(args)).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Docs: React cleanup docs',
    })
    expect(replay).toEqual(live)
    expect(live).toMatchObject({
      card: 'web',
      kind: 'search',
      title: 'Docs (stale cache): React cleanup docs',
      truncated: false,
    })
    expect(live).toMatchObject({
      answer: expect.stringContaining('discovery metadata; not fetched page bodies'),
    })
    expect(JSON.stringify(meta)).not.toMatch(
      /source_ref|doc_ref|attempts|providerResponseBytes|credential|selected_library/,
    )
    expect(meta).toMatchObject({
      type: 'docs_search',
      source_produced: false,
      snippets: [{ content: 'useEffect cleanup snippet' }],
      cache: { docs: { state: 'stale' }, resolve: { state: 'hit' } },
    })
    expect(presentDocsSearchResult(args, {
      content,
      isError: false,
      meta: {
        ...(meta as Record<string, unknown>),
        cache: { docs: { state: 'unknown' } },
      } as never,
    })).toBeUndefined()
    expect(presentDocsSearchResult(args, {
      content,
      isError: true,
    })).toEqual({ card: 'generic', title: 'Documentation search failed' })
  })

  it('uses visible page metadata for a source card and a generic not-found result', () => {
    const args = { source_ref: sourceRef }
    const found: SearchSourcesOutput = {
      state: 'found',
      source_ref: sourceRef,
      offset: 0,
      limit: 20,
      format: 'compact',
      total: 1,
      returned: 1,
      sources: [{ url: 'https://page.test', category: 'official' }],
      has_more: false,
      total_before_retention: 1,
      truncated: false,
      page_byte_limited: false,
    }
    const meta = searchSourcesPresentationMeta(args, found)
    const result: ToolResult = { content: [], isError: false, meta }
    const live = presentSearchSourcesResult(args, result)
    const replay = presentSearchSourcesResult(args, {
      content: [],
      isError: false,
      meta: JSON.parse(JSON.stringify(meta)),
    })
    expect(replay).toEqual(live)
    expect(live).toEqual({
      card: 'web',
      kind: 'search',
      title: 'Sources 0-0 of 1',
      sources: [{ url: 'https://page.test' }],
      truncated: false,
    })

    const notFound: SearchSourcesOutput = {
      state: 'not_found',
      code: 'SOURCE_REF_NOT_FOUND',
    }
    expect(presentSearchSourcesResult(args, {
      content: [],
      isError: false,
      meta: searchSourcesPresentationMeta(args, notFound),
    })).toEqual({
      card: 'generic',
      title: 'Source reference not found (SOURCE_REF_NOT_FOUND)',
    })
  })
})

import { Buffer } from 'node:buffer'

import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  ToolRuntime,
  parameterSchemaSpecToJsonSchema,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  presentWebExtractCall,
  presentWebExtractResult,
  webExtractPresentationMeta,
} from '../src/presentation/web-card.js'
import {
  isWebExtractModelTextTruncated,
  renderWebExtractText,
} from '../src/presentation/render.js'
import {
  ForegroundOperationScope,
  WEB_EXTRACT_OUTPUT_SCHEMA,
  WEB_EXTRACT_PARAMETERS,
  boundWebExtractOutput,
  createWebExtractTool,
  projectWebExtractOutput,
  WebExtractToolError,
  type WebExtractOutput,
} from '../src/tools/index.js'
import {
  WebExtractInfrastructureError,
  type WebExtractResult,
  type WebExtractRouteAttempt,
} from '../src/web-extract/index.js'

function config(overrides: Partial<SearchEnhanceConfig['webExtract']> = {}): SearchEnhanceConfig {
  const base = Config({} as never)
  return {
    ...base,
    webExtract: {
      ...base.webExtract,
      ...overrides,
      tavily: { ...base.webExtract.tavily, ...overrides.tavily },
      firecrawl: { ...base.webExtract.firecrawl, ...overrides.firecrawl },
      smartDirect: { ...base.webExtract.smartDirect, ...overrides.smartDirect },
      direct: { ...base.webExtract.direct, ...overrides.direct },
    },
  }
}

function attempt(
  provider: WebExtractRouteAttempt['provider'] = 'direct',
  outcome: WebExtractRouteAttempt['outcome'] = 'success',
): WebExtractRouteAttempt {
  return {
    attempts: outcome === 'skipped' ? 0 : 1,
    capability: 'web_extract',
    durationMs: 7,
    outcome,
    participatedInFallback: provider !== 'tavily_extract',
    provider,
    ...(outcome === 'failed'
      ? { errorKind: 'network' as const, retryable: true }
      : {}),
    ...(outcome === 'skipped'
      ? { skipReason: 'format_unsupported' as const }
      : {}),
  }
}

function internalResult(overrides: Partial<WebExtractResult> = {}): WebExtractResult {
  return {
    requestedUrl: 'https://example.test/article',
    finalUrl: 'https://example.test/final',
    content: 'A界🙂Z body',
    format: 'markdown',
    title: 'Explicit title',
    author: 'Ada',
    publishedAt: '2026-08-15',
    canonicalUrl: 'https://example.test/canonical',
    contentType: 'text/html; charset=utf-8',
    contentLength: 123,
    contentDisposition: 'inline',
    contentEncoding: 'gzip',
    statusCode: 200,
    encodedBytes: 80,
    decompressedBytes: 123,
    contentTransform: 'html_to_markdown',
    outputTruncated: true,
    metadataTruncated: true,
    retrievalRoute: 'direct',
    evidenceLevel: 'direct_http_content',
    truncated: true,
    attempts: [attempt()],
    ...overrides,
  }
}

function output(overrides: Partial<WebExtractOutput> = {}): WebExtractOutput {
  return {
    requested_url: 'https://example.test/article',
    final_url: 'https://example.test/final',
    content: 'Readable body',
    format: 'markdown',
    content_type: 'text/html; charset=utf-8',
    status_code: 200,
    retrieval_route: 'direct',
    evidence_level: 'direct_http_content',
    truncated: false,
    attempts: [{
      route: 'direct',
      outcome: 'success',
      count: 1,
      duration_ms: 7,
      fallback: true,
    }],
    model_text_max_bytes: 64 * 1024,
    ...overrides,
  }
}

function runContext(args: unknown, signal = new AbortController().signal): ToolRunContext {
  return {
    callId: CallId('web-extract-tool-call'),
    rootCallId: CallId('web-extract-tool-call'),
    name: 'web_extract',
    arguments: args,
    token: Symbol('web-extract-tool') as never,
    signal,
    deferContext() {},
    concludeTurn() {},
  }
}

function toolWith(
  extract: (input: Record<string, unknown>) => Promise<Readonly<WebExtractResult>>,
  value = config(),
) {
  const operations = new ForegroundOperationScope()
  const tool = createWebExtractTool({
    getConfig: () => value,
    operations,
    orchestrator: { extract: extract as never },
  })
  return { operations, tool }
}

describe('web_extract model tool contract', () => {
  it('exposes only url/format and rejects extra, invalid-format, and invalid-URL arguments', async () => {
    const schema = parameterSchemaSpecToJsonSchema(WEB_EXTRACT_PARAMETERS)
    expect(Object.keys(schema.properties)).toEqual(['url', 'format'])
    expect(schema.required).toEqual(['url'])
    expect(schema.properties.format).toMatchObject({
      default: 'markdown',
      enum: ['markdown', 'text', 'html', 'json', 'raw'],
    })
    expect(JSON.stringify(schema)).not.toMatch(/provider|proxy|header|fingerprint|browser|budget|redirect|retry|defuddle/i)

    const extract = vi.fn(async () => internalResult())
    const { operations, tool } = toolWith(extract)
    for (const args of [
      { url: 'https://example.test', provider: 'direct' },
      { url: 'https://example.test', format: 'yaml' },
      { url: '' },
      { url: 'ftp://example.test/file' },
      { url: 'https://user:secret@example.test/file' },
    ]) {
      await expect(tool.execute(args as never, runContext(args))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      })
    }
    expect(extract).not.toHaveBeenCalled()
    await operations.stop()
  })

  it('snapshots Settings once, defaults markdown, and returns a validated snake-case value', async () => {
    let settingsReads = 0
    const value = config({ modelTextMaxBytes: 8192 })
    const extract = vi.fn(async input => {
      expect(input).toMatchObject({
        url: 'http://localhost:8080/article',
        config: value,
      })
      expect(input).not.toHaveProperty('format')
      return internalResult({
        requestedUrl: 'http://localhost:8080/article',
        format: 'markdown',
      })
    })
    const operations = new ForegroundOperationScope()
    const tool = createWebExtractTool({
      getConfig: () => {
        settingsReads += 1
        return value
      },
      operations,
      orchestrator: { extract: extract as never },
    })
    const args = { url: '  http://localhost:8080/article  ' }
    const result = await tool.execute(args, runContext(args)) as WebExtractOutput

    expect(settingsReads).toBe(1)
    expect(extract).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      requested_url: 'http://localhost:8080/article',
      final_url: 'https://example.test/final',
      format: 'markdown',
      published_at: '2026-08-15',
      canonical_url: 'https://example.test/canonical',
      content_type: 'text/html; charset=utf-8',
      content_length: 123,
      content_disposition: 'inline',
      content_encoding: 'gzip',
      status_code: 200,
      encoded_bytes: 80,
      decompressed_bytes: 123,
      content_transform: 'html_to_markdown',
      output_truncated: true,
      metadata_truncated: true,
      retrieval_route: 'direct',
      evidence_level: 'direct_http_content',
      model_text_max_bytes: 8192,
      attempts: [{
        route: 'direct',
        outcome: 'success',
        count: 1,
        duration_ms: 7,
        fallback: true,
      }],
    })
    expect(result).not.toHaveProperty('requestedUrl')
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(WEB_EXTRACT_OUTPUT_SCHEMA),
      result,
    )).toEqual([])
    await operations.stop()
  })

  it('preserves cancellation and converts all-route failure to one safe coded summary', async () => {
    const reason = new Error('caller cancellation identity')
    const cancelled = toolWith(async () => { throw reason })
    await expect(cancelled.tool.execute(
      { url: 'https://example.test' },
      runContext({ url: 'https://example.test' }),
    )).rejects.toBe(reason)
    await cancelled.operations.stop()

    const statuses: WebExtractRouteAttempt[] = [
      { ...attempt('tavily_extract', 'failed'), httpStatus: 503 },
      attempt('firecrawl_scrape', 'skipped'),
      { ...attempt('smart_direct', 'failed'), errorKind: 'timeout' },
      { ...attempt('direct', 'failed'), errorKind: 'http', httpStatus: 404, retryable: false },
    ]
    const failed = toolWith(async () => {
      throw new WebExtractInfrastructureError(statuses)
    })
    let caught: unknown
    try {
      await failed.tool.execute(
        { url: 'https://example.test' },
        runContext({ url: 'https://example.test' }),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WebExtractToolError)
    expect(caught).toMatchObject({ code: 'SEARCH_WEB_EXTRACT_FAILED' })
    const message = (caught as Error).message
    expect(message).toContain('tavily_extract[outcome=failed,count=1')
    expect(message).toContain('http_status=503')
    expect(message).toContain('firecrawl_scrape[outcome=skipped,count=0')
    expect(message).toContain('skip_reason=format_unsupported')
    expect(message).toContain('direct[outcome=failed')
    expect(message).not.toMatch(/https?:|authorization|bearer|body=/i)
    await failed.operations.stop()
  })

  it('materializes the safe all-route code and statuses as the model-visible registry error', async () => {
    const statuses: WebExtractRouteAttempt[] = [
      { ...attempt('tavily_extract', 'failed'), httpStatus: 503 },
      attempt('firecrawl_scrape', 'skipped'),
      { ...attempt('smart_direct', 'failed'), errorKind: 'timeout' },
      { ...attempt('direct', 'failed'), errorKind: 'http', httpStatus: 404, retryable: false },
    ]
    const failed = toolWith(async () => {
      throw new WebExtractInfrastructureError(statuses)
    })
    const ctx = new Context()
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx, { mode: 'native' })
    ctx.tools.register(failed.tool)
    try {
      const result = await ctx.tools.execute({
        callId: CallId('web-extract-safe-failure'),
        name: 'web_extract',
        arguments: { url: 'https://secret-target.invalid/path' },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('expected a failed tool result')
      expect(result.error.info).toEqual({
        name: 'WebExtractToolError',
        code: 'SEARCH_WEB_EXTRACT_FAILED',
      })
      expect(result.content).toEqual([{
        type: 'text',
        text: expect.stringContaining('SEARCH_WEB_EXTRACT_FAILED: tavily_extract[outcome=failed'),
      }])
      const visible = JSON.stringify(result.content)
      expect(visible).toContain('firecrawl_scrape[outcome=skipped')
      expect(visible).toContain('skip_reason=format_unsupported')
      expect(visible).toContain('http_status=404')
      expect(visible).not.toContain('secret-target')
    } finally {
      await failed.operations.stop()
      await ctx.fiber.dispose()
    }
  })
})

describe('web_extract canonical and render boundaries', () => {
  it('bounds the projected full public JSON at exact, over, tiny, and Unicode boundaries', () => {
    const value = projectWebExtractOutput(
      internalResult({ content: 'A界🙂Z'.repeat(100) }),
      config(),
    )
    const exactBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    expect(boundWebExtractOutput(value, exactBytes)).toEqual(value)

    const bounded = boundWebExtractOutput(value, exactBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(bounded.truncated).toBe(true)
    expect(bounded.canonical_output_truncated).toBe(true)
    expect(Array.from(bounded.content).length).toBeLessThan(Array.from(value.content).length)
    expect(bounded.attempts).toEqual(value.attempts)
    expect(bounded.retrieval_route).toBe(value.retrieval_route)
    expect(bounded.evidence_level).toBe(value.evidence_level)
    expect(bounded.status_code).toBe(value.status_code)
    expect(bounded.content).not.toContain('\uFFFD')
    expect(() => boundWebExtractOutput(value, 1)).toThrowError(
      expect.objectContaining({ kind: 'budget_exceeded' }),
    )
  })

  it('orders route facts before content and attempts, with route-specific limitations', () => {
    for (const [route, evidence, limitation] of [
      ['tavily_extract', 'extracted_content', 'third-party extracted content'],
      ['firecrawl_scrape', 'extracted_content', 'third-party extracted content'],
      ['smart_direct', 'extracted_content', 'Defuddle may select, abridge, or reorder'],
      ['direct', 'direct_http_content', 'direct host HTTP used no JavaScript'],
    ] as const) {
      const text = renderWebExtractText(output({
        retrieval_route: route,
        evidence_level: evidence,
        attempts: [{
          route,
          outcome: 'success',
          count: 1,
          duration_ms: 2,
          fallback: route !== 'tavily_extract',
        }],
      }))
      expect(text.indexOf('Requested URL:')).toBeLessThan(text.indexOf('Content\n'))
      expect(text.indexOf('Content\n')).toBeLessThan(text.indexOf('Route attempts'))
      expect(text).toContain(`Retrieval route: ${route}`)
      expect(text).toContain(`Evidence level: ${evidence}`)
      expect(text).toContain(limitation)
    }
  })

  it('marks model-text truncation, preserves safe attempts, and never splits Unicode', () => {
    const broad = output({
      content: `界🙂${'body '.repeat(500)}`,
      model_text_max_bytes: 64 * 1024,
    })
    const complete = renderWebExtractText(broad)
    const exactBytes = Buffer.byteLength(complete, 'utf8')
    const exact = { ...broad, model_text_max_bytes: exactBytes }
    expect(isWebExtractModelTextTruncated(exact)).toBe(false)
    expect(renderWebExtractText(exact)).toBe(complete)

    const over = { ...broad, model_text_max_bytes: 700 }
    expect(isWebExtractModelTextTruncated(over)).toBe(true)
    const bounded = renderWebExtractText(over)
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(700)
    expect(bounded).toContain('[Model text truncated by model_text_max_bytes.]')
    expect(bounded).toContain('Route attempts')
    expect(bounded).toContain('direct: outcome=success')
    expect(bounded).not.toContain('\uFFFD')

    expect(renderWebExtractText({ ...broad, model_text_max_bytes: 1 })).toBe('[')
    expect(renderWebExtractText({ ...broad, model_text_max_bytes: 2 })).toBe('[M')
  })

  it('prioritizes marker, route, evidence, response facts, then requested URL in the tiny fallback', () => {
    const value = output()
    const compact = [
      '[Model text truncated by model_text_max_bytes.]',
      'Retrieval route: direct',
      'Evidence level: direct_http_content',
      'HTTP status: 200',
      'Content-Type: text/html; charset=utf-8',
      'Truncated: no',
      'Requested URL: https://example.test/article',
    ].join('\n')
    const bounded = renderWebExtractText({
      ...value,
      model_text_max_bytes: Buffer.byteLength(compact, 'utf8'),
    })
    expect(bounded).toBe(compact)
  })
})

describe('web_extract replayable cards', () => {
  it('uses a generic fetch pending card and never fabricates a remote HTTP status/card', () => {
    const args = { url: 'https://example.test/article', format: 'markdown' as const }
    expect(presentWebExtractCall(args)).toEqual({
      card: 'generic',
      kind: 'fetch',
      title: 'Read https://example.test/article',
    })

    const { final_url: _finalUrl, status_code: _statusCode, ...remoteBase } = output({
      content: 'remote body '.repeat(300),
    })
    void _finalUrl
    void _statusCode
    const broadRemote: WebExtractOutput = {
      ...remoteBase,
      retrieval_route: 'tavily_extract',
      evidence_level: 'extracted_content',
    }
    const completeBytes = Buffer.byteLength(renderWebExtractText(broadRemote), 'utf8')
    const remote = { ...broadRemote, model_text_max_bytes: completeBytes - 1 }
    expect(remote.truncated).toBe(false)
    expect(isWebExtractModelTextTruncated(remote)).toBe(true)

    const meta = webExtractPresentationMeta(args, remote)
    expect(meta).toEqual({
      version: 1,
      type: 'web_extract',
      retrieval_route: 'tavily_extract',
      evidence_level: 'extracted_content',
      truncated: true,
    })
    const live = presentWebExtractResult(args, {
      content: [],
      isError: false,
      meta,
    })
    const replay = presentWebExtractResult(args, {
      content: [],
      isError: false,
      meta: JSON.parse(JSON.stringify(meta)),
    })
    expect(replay).toEqual(live)
    expect(live).toEqual({
      card: 'generic',
      title: 'Extracted via tavily_extract (extracted_content)',
    })
    expect(JSON.stringify(meta)).not.toContain(remote.content)
    expect(JSON.stringify(meta)).not.toContain('requested_url')
    expect(JSON.stringify(meta)).not.toContain('status_code')
  })

  it('projects exact/over caps onto SmartDirect/Direct cards and ignores host spill on replay', () => {
    const args = { url: 'https://example.test/article' }
    const matrix = []
    for (const [route, evidence] of [
      ['smart_direct', 'extracted_content'],
      ['direct', 'direct_http_content'],
    ] as const) {
      const broad = output({
        content: `界🙂${'local body '.repeat(400)}`,
        evidence_level: evidence,
        retrieval_route: route,
        attempts: [{
          route,
          outcome: 'success',
          count: 1,
          duration_ms: 7,
          fallback: true,
        }],
      })
      const completeBytes = Buffer.byteLength(renderWebExtractText(broad), 'utf8')
      for (const [boundary, maximumBytes, expectedTruncated] of [
        ['exact', completeBytes, false],
        ['over', completeBytes - 1, true],
      ] as const) {
        const value = { ...broad, model_text_max_bytes: maximumBytes }
        expect(value.truncated).toBe(false)
        expect(value.content).toBe(broad.content)
        expect(isWebExtractModelTextTruncated(value)).toBe(expectedTruncated)

        const meta = webExtractPresentationMeta(args, value)
        expect(meta).toMatchObject({ truncated: expectedTruncated })
        const live = presentWebExtractResult(args, {
          content: [{
            type: 'text',
            text: 'Full formatted result stored at: <spill-locator>',
          }],
          isError: false,
          meta,
        })
        const replay = presentWebExtractResult(args, {
          content: [],
          isError: false,
          meta: JSON.parse(JSON.stringify(meta)),
        })
        expect(replay).toEqual(live)
        expect(live).toEqual({
          card: 'web',
          kind: 'fetch',
          url: 'https://example.test/final',
          statusCode: 200,
          truncated: expectedTruncated,
        })
        matrix.push({
          boundary,
          canonical_truncated: value.truncated,
          card: live,
          meta,
          model_text_truncated: isWebExtractModelTextTruncated(value),
          replay_equal: JSON.stringify(replay) === JSON.stringify(live),
          route,
        })
      }
    }

    expect(matrix).toMatchSnapshot()
    expect(presentWebExtractResult(args, { content: [], isError: true })).toEqual({
      card: 'generic',
      title: 'Web extraction failed',
    })
  })
})

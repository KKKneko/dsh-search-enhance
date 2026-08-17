import { Buffer } from 'node:buffer'

import { CallId } from '@deepseek-ai/dsh-llm'
import {
  parameterSchemaSpecToJsonSchema,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  isWebMapModelTextTruncated,
  renderWebMapText,
} from '../src/presentation/render.js'
import {
  presentWebMapCall,
  presentWebMapResult,
  webMapPresentationMeta,
} from '../src/presentation/web-card.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import type {
  SiteMapProvider,
  TavilyMapInput,
  TavilyMapResult,
} from '../src/site-map/index.js'
import {
  ForegroundOperationScope,
  WEB_MAP_OUTPUT_SCHEMA,
  WEB_MAP_PARAMETERS,
  boundWebMapOutput,
  createWebMapTool,
  projectWebMapOutput,
  type WebMapOutput,
} from '../src/tools/index.js'

function config(overrides: Partial<SearchEnhanceConfig['siteMap']> = {}): SearchEnhanceConfig {
  const base = Config({} as never)
  return {
    ...base,
    siteMap: { ...base.siteMap, ...overrides },
  }
}

function providerResult(overrides: Partial<TavilyMapResult> = {}): TavilyMapResult {
  return {
    baseUrl: 'https://docs.example.test/',
    results: [
      'https://docs.example.test/start',
      'https://docs.example.test/界🙂',
      'https://docs.example.test/api',
    ],
    responseTime: 0.25,
    invalidResultUrls: 0,
    duplicateResultUrls: 0,
    responseBytes: 256,
    attempts: 2,
    totalDelayMs: 5,
    ...overrides,
  }
}

function runContext(args: unknown, signal = new AbortController().signal): ToolRunContext {
  return {
    callId: CallId('web-map-tool-call'),
    rootCallId: CallId('web-map-tool-call'),
    name: 'web_map',
    arguments: args,
    token: Symbol('web-map-tool') as never,
    signal,
    deferContext() {},
    concludeTurn() {},
  }
}

function toolWith(
  map: (input: TavilyMapInput) => Promise<Readonly<TavilyMapResult>>,
  value = config(),
  now: () => number = (() => {
    const values = [100, 107]
    return () => values.shift() ?? 107
  })(),
) {
  const operations = new ForegroundOperationScope()
  const provider: SiteMapProvider = {
    provider: 'tavily',
    map,
  }
  const tool = createWebMapTool({
    getConfig: () => value,
    operations,
    provider,
    now,
  })
  return { operations, tool }
}

function output(overrides: Partial<WebMapOutput> = {}): WebMapOutput {
  return {
    requested_url: 'https://docs.example.test/',
    base_url: 'https://docs.example.test/',
    results: [
      'https://docs.example.test/start',
      'https://docs.example.test/界🙂',
    ],
    total_results: 2,
    returned_results: 2,
    max_depth: 1,
    max_breadth: 10,
    limit: 30,
    response_time: 0.25,
    truncated: false,
    evidence_level: 'discovery',
    provider: 'tavily',
    attempts: [{
      provider: 'tavily',
      outcome: 'success',
      count: 1,
      duration_ms: 7,
      fallback: false,
    }],
    warnings: [],
    model_text_max_bytes: 64 * 1024,
    ...overrides,
  }
}

describe('web_map model tool contract', () => {
  it('exposes only task intent, applies declared defaults, and keeps deployment controls out of the schema', () => {
    const schema = parameterSchemaSpecToJsonSchema(WEB_MAP_PARAMETERS)
    expect(Object.keys(schema.properties)).toEqual([
      'url',
      'instructions',
      'max_depth',
      'max_breadth',
      'limit',
    ])
    expect(schema.required).toEqual(['url'])
    expect(schema.properties.max_depth).toMatchObject({
      default: 1,
      enum: [1, 2, 3, 4, 5],
      type: 'integer',
    })
    expect(schema.properties.max_breadth).toMatchObject({ default: 10, type: 'integer' })
    expect(schema.properties.limit).toMatchObject({ default: 30, type: 'integer' })
    expect(JSON.stringify(schema)).not.toMatch(/credential|authorization|header|base.?url|timeout|retry|api.?key/i)
  })

  it('rejects extra keys, schema-invalid numbers, HTTP/userinfo/length violations, and never dispatches them', async () => {
    const map = vi.fn(async () => providerResult())
    const value = config({ maxUrlCharacters: 30, maxInstructionsCharacters: 3 })
    const { operations, tool } = toolWith(map, value)
    const cases = [
      { url: 'https://docs.example.test', provider: 'tavily' },
      { url: 'https://docs.example.test', timeout: 150 },
      { url: 'https://docs.example.test', max_depth: 0 },
      { url: 'https://docs.example.test', max_depth: 6 },
      { url: 'https://docs.example.test', max_breadth: 0 },
      { url: 'https://docs.example.test', max_breadth: 501 },
      { url: 'https://docs.example.test', max_breadth: 1.5 },
      { url: 'https://docs.example.test', limit: 0 },
      { url: 'https://docs.example.test', limit: 501 },
      { url: '' },
      { url: '/relative' },
      { url: 'ftp://docs.example.test/file' },
      { url: 'https://user:secret@docs.test/' },
      { url: `https://docs.test/${'界'.repeat(30)}` },
      { url: 'https://docs.test/', instructions: '界🙂AB' },
    ]
    for (const args of cases) {
      await expect(tool.execute(args as never, runContext(args))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      })
    }
    expect(map).not.toHaveBeenCalled()
    await operations.stop()
  })

  it('accepts exact Unicode URL/instructions and 500-link argument boundaries', async () => {
    const url = 'https://x.test/界🙂'
    const instructions = '界🙂A'
    const value = config({
      maxUrlCharacters: Array.from(url).length,
      maxInstructionsCharacters: Array.from(instructions).length,
      maxLinks: 500,
    })
    const map = vi.fn(async () => providerResult({ results: [] }))
    const { operations, tool } = toolWith(map, value)
    const args = {
      url,
      instructions,
      max_depth: 5 as const,
      max_breadth: 500,
      limit: 500,
    }

    await expect(tool.execute(args, runContext(args))).resolves.toMatchObject({
      requested_url: url,
      max_depth: 5,
      max_breadth: 500,
      limit: 500,
    })
    expect(map).toHaveBeenCalledWith(expect.objectContaining({ url, instructions }))
    await operations.stop()
  })

  it('rejects explicit breadth/limit above the deployment cap and safely lowers omitted defaults', async () => {
    const value = config({ maxLinks: 5 })
    const map = vi.fn(async () => providerResult({ results: [] }))
    const { operations, tool } = toolWith(map, value)
    for (const args of [
      { url: 'https://docs.example.test', max_breadth: 6 },
      { url: 'https://docs.example.test', limit: 6 },
    ]) {
      await expect(tool.execute(args, runContext(args))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('siteMap.maxLinks'),
      })
    }

    const args = { url: ' https://docs.example.test/ ' }
    const result = await tool.execute(args, runContext(args)) as WebMapOutput
    expect(map).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://docs.example.test/',
      maxDepth: 1,
      maxBreadth: 5,
      limit: 5,
      config: value,
    }))
    expect(result).toMatchObject({ max_depth: 1, max_breadth: 5, limit: 5 })
    await operations.stop()
  })

  it('snapshots Settings once, normalizes optional instructions, and returns the closed snake-case value', async () => {
    let settingsReads = 0
    const value = config({ modelTextMaxBytes: 8192 })
    const map = vi.fn(async input => {
      expect(input).toMatchObject({
        url: 'https://docs.example.test/',
        instructions: 'only API docs',
        maxDepth: 2,
        maxBreadth: 4,
        limit: 2,
        config: value,
      })
      return providerResult({
        invalidResultUrls: 2,
        duplicateResultUrls: 1,
      })
    })
    const operations = new ForegroundOperationScope()
    const provider: SiteMapProvider = { provider: 'tavily', map }
    const values = [10, 19]
    const tool = createWebMapTool({
      getConfig: () => {
        settingsReads += 1
        return value
      },
      operations,
      provider,
      now: () => values.shift() ?? 19,
    })
    const args = {
      url: ' https://docs.example.test/ ',
      instructions: '  only API docs  ',
      max_depth: 2 as const,
      max_breadth: 4,
      limit: 2,
    }

    const result = await tool.execute(args, runContext(args)) as WebMapOutput

    expect(settingsReads).toBe(1)
    expect(result).toEqual({
      requested_url: 'https://docs.example.test/',
      base_url: 'https://docs.example.test/',
      results: [
        'https://docs.example.test/start',
        'https://docs.example.test/界🙂',
      ],
      total_results: 3,
      returned_results: 2,
      max_depth: 2,
      max_breadth: 4,
      limit: 2,
      response_time: 0.25,
      truncated: true,
      evidence_level: 'discovery',
      provider: 'tavily',
      attempts: [{
        provider: 'tavily',
        outcome: 'success',
        count: 2,
        duration_ms: 9,
        fallback: false,
      }],
      warnings: [
        { code: 'invalid_result_url_omitted', count: 2 },
        { code: 'duplicate_result_url_omitted', count: 1 },
        { code: 'results_truncated', count: 1 },
      ],
      model_text_max_bytes: 8192,
    })
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(WEB_MAP_OUTPUT_SCHEMA),
      result,
    )).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/authorization|credential|header|endpoint|raw error/i)
    await operations.stop()
  })

  it('treats a valid empty Provider mapping as complete success without inferring base/time', async () => {
    const emptyResult: TavilyMapResult = {
      results: [],
      invalidResultUrls: 0,
      duplicateResultUrls: 0,
      responseBytes: 2,
      attempts: 1,
      totalDelayMs: 0,
    }
    const { operations, tool } = toolWith(async () => emptyResult)
    const args = { url: 'https://empty.example.test/' }

    const result = await tool.execute(args, runContext(args)) as WebMapOutput

    expect(result.results).toEqual([])
    expect(result.total_results).toBe(0)
    expect(result.returned_results).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.warnings).toEqual([])
    expect(result).not.toHaveProperty('base_url')
    expect(result).not.toHaveProperty('response_time')
    await operations.stop()
  })

  it('propagates generic Provider infrastructure errors and never retains target/key/raw causes', async () => {
    const failure = new ProviderError({
      capability: 'site_map',
      kind: 'credential_missing',
      provider: 'tavily',
      cause: new Error('raw key material'),
    })
    const { operations, tool } = toolWith(async () => { throw failure })
    const args = { url: 'https://secret-target.example.test/path' }

    await expect(tool.execute(args, runContext(args))).rejects.toBe(failure)
    expect(String(failure)).toBe('ProviderError: tavily: credential is not configured')
    expect(String(failure)).not.toMatch(/secret-target|raw key material/i)
    await operations.stop()
  })

  it('cancels and drains an active Provider operation when the foreground scope stops', async () => {
    let quiesced = false
    const { operations, tool } = toolWith(async input => new Promise<TavilyMapResult>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          quiesced = true
          reject(input.signal.reason)
        })
      }, { once: true })
    }))
    const args = { url: 'https://docs.example.test/' }
    const pending = tool.execute(args, runContext(args))
    await vi.waitFor(() => { expect(quiesced).toBe(false) })

    await operations.stop()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(quiesced).toBe(true)
  })
})

describe('web_map output, render, and replayable card bounds', () => {
  it('enforces exact/over/tiny complete canonical JSON boundaries using whole Unicode URL entries', () => {
    const request = {
      url: 'https://docs.example.test/',
      maxDepth: 1,
      maxBreadth: 10,
      limit: 30,
    }
    const source = providerResult({
      results: Array.from({ length: 8 }, (_value, index) => (
        `https://docs.example.test/${index}/界🙂${'x'.repeat(30)}`
      )),
      attempts: 1,
    })
    const roomy = config({ maxOutputBytes: 256 * 1024 })
    const full = projectWebMapOutput(source, request, roomy, 7)
    const exactBytes = Buffer.byteLength(JSON.stringify(full))

    expect(projectWebMapOutput(source, request, config({ maxOutputBytes: exactBytes }), 7)).toEqual(full)
    const over = projectWebMapOutput(source, request, config({ maxOutputBytes: exactBytes - 1 }), 7)
    expect(Buffer.byteLength(JSON.stringify(over))).toBeLessThanOrEqual(exactBytes - 1)
    expect(over.returned_results).toBeLessThan(full.returned_results)
    expect(over.results.every(url => source.results.includes(url))).toBe(true)
    expect(over.warnings).toContainEqual({ code: 'canonical_output_truncated' })
    expect(over.truncated).toBe(true)
    expect(() => boundWebMapOutput(full, 1)).toThrowError(expect.objectContaining({
      kind: 'budget_exceeded',
    }))
  })

  it('renders summary/base/request/links/counts/limits/discovery and marks Unicode-safe model truncation', () => {
    const full = output()
    const complete = renderWebMapText(full)
    const exactBytes = Buffer.byteLength(complete)
    const exact = { ...full, model_text_max_bytes: exactBytes }
    expect(renderWebMapText(exact)).toBe(complete)
    expect(isWebMapModelTextTruncated(exact)).toBe(false)

    const over = { ...full, model_text_max_bytes: exactBytes - 1 }
    const rendered = renderWebMapText(over)
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(exactBytes - 1)
    expect(rendered).toContain('[Model text truncated by model_text_max_bytes.]')
    expect(rendered).not.toContain('\uFFFD')
    expect(isWebMapModelTextTruncated(over)).toBe(true)
    expect(complete).toContain('Website map discovery')
    expect(complete).toContain('Provider base URL: https://docs.example.test/')
    expect(complete).toContain('Max depth: 1')
    expect(complete).toContain('Links shown: 2/2')
    expect(complete).toContain('Evidence level: discovery')
    expect(complete).toContain('web_extract')

    const markerOnly = renderWebMapText({ ...full, model_text_max_bytes: 30 })
    expect(Buffer.byteLength(markerOnly)).toBeLessThanOrEqual(30)
    expect(markerOnly).toBe('[Model text truncated by model')
  })

  it('projects one WebSource per URL and replays the official Web search card exactly', () => {
    const args = { url: 'https://docs.example.test/' }
    const value = output({ model_text_max_bytes: 120 })
    const meta = webMapPresentationMeta(args, value)
    const result = {
      content: [{ type: 'text' as const, text: renderWebMapText(value) }],
      isError: false,
      meta,
    }
    const pending = presentWebMapCall(args)
    const live = presentWebMapResult(args, result)
    const replay = presentWebMapResult(
      structuredClone(args),
      structuredClone(result),
    )

    expect(pending).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Map https://docs.example.test/',
    })
    expect(live).toEqual({
      card: 'web',
      kind: 'search',
      title: 'Site map: https://docs.example.test/',
      sources: [
        { url: 'https://docs.example.test/start' },
        { url: 'https://docs.example.test/界🙂' },
      ],
      truncated: true,
    })
    expect(replay).toEqual(live)
    expect(presentWebMapResult(args, { content: [], isError: true })).toEqual({
      card: 'generic',
      title: 'Website mapping failed',
    })
    expect({ pending, meta, live, replay, model_text: result.content }).toMatchSnapshot()
  })
})

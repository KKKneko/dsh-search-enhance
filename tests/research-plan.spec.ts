import { Buffer } from 'node:buffer'

import {
  CallId,
} from '@deepseek-ai/dsh-llm'
import {
  parameterSchemaSpecToJsonSchema,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  isResearchPlanModelTextTruncated,
  renderResearchPlanText,
} from '../src/research-plan/index.js'
import {
  presentResearchPlanCall,
  presentResearchPlanResult,
  researchPlanPresentationMeta,
} from '../src/presentation/research-plan-card.js'
import {
  ForegroundOperationScope,
  RESEARCH_PLAN_OUTPUT_SCHEMA,
  RESEARCH_PLAN_PARAMETERS,
  boundResearchPlanOutput,
  buildResearchPlan,
  createResearchPlanTool,
  type ResearchPlanOutput,
} from '../src/tools/index.js'

function config(overrides: Partial<SearchEnhanceConfig['researchPlan']> = {}): SearchEnhanceConfig {
  const base = Config({} as never)
  return {
    ...base,
    researchPlan: { ...base.researchPlan, ...overrides },
  }
}

function options(
  researchPlan: SearchEnhanceConfig['researchPlan'] = config().researchPlan,
  webMapAvailable = true,
  siteMapMaxLinks = 500,
) {
  return {
    config: researchPlan,
    webMapAvailable,
    siteMapMaxLinks,
  }
}

function runContext(args: unknown, signal = new AbortController().signal): ToolRunContext {
  return {
    callId: CallId('research-plan-call'),
    rootCallId: CallId('research-plan-call'),
    name: 'research_plan',
    arguments: args,
    token: Symbol('research-plan') as never,
    signal,
    deferContext() {},
    concludeTurn() {},
  }
}

function toolWith(value = config()) {
  const operations = new ForegroundOperationScope()
  const tool = createResearchPlanTool({
    getConfig: () => value,
    operations,
  })
  return { operations, tool }
}

const baseArgs = {
  question: 'How does React useEffect cleanup work?',
  budget: 'deep' as const,
  recency_requirement: 'recent' as const,
  locale_domain_scope: 'global' as const,
  source_authority_need: 'high' as const,
  claim_risk: 'medium' as const,
  cross_validation_need: 'high' as const,
  sub_queries: [{
    id: 'sq1',
    question: 'Find the official React useEffect cleanup documentation',
    reason: 'The official API semantics are required.',
    tool: 'docs_search' as const,
  }],
}

describe('research_plan schema and deterministic planner', () => {
  it('exposes only bounded task intent and actual Search Enhance operations', () => {
    const schema = parameterSchemaSpecToJsonSchema(RESEARCH_PLAN_PARAMETERS)
    expect(Object.keys(schema.properties)).toEqual([
      'question',
      'budget',
      'recency_requirement',
      'locale_domain_scope',
      'source_authority_need',
      'claim_risk',
      'cross_validation_need',
      'known_urls',
      'sub_queries',
    ])
    expect(schema.required).toEqual(['question'])
    expect(schema.properties.sub_queries!.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'question', 'reason'],
    })
    const wire = JSON.stringify(schema)
    expect(wire).not.toMatch(/search_planning|plan_intent|provider|credential|header|timeout|password|api.?key/i)
    expect(wire).toContain('web_search')
    expect(wire).toContain('docs_search')
    expect(wire).toContain('web_extract')
    expect(wire).toContain('web_map')
  })

  it('creates a complete offline plan with stable actual-tool mappings and evidence gaps', () => {
    const value = buildResearchPlan(baseArgs, options())
    expect(value.plan_complete).toBe(true)
    expect(value.research_plan).toMatchObject({
      mode: 'deep_research',
      query_mode: 'deep',
      trigger_source: 'explicit_tool',
      evidence_policy: 'fetch_before_claim',
      preflight: {
        network_access: 'not_used',
        credential_access: 'not_used',
        session_storage: 'not_used',
        web_map_available: true,
      },
      gap_check: { required: true },
    })
    expect(value.research_plan.steps[0]!).toMatchObject({
      tool: 'docs_search',
      capability: 'docs_search',
      params: { query: baseArgs.sub_queries[0]!.question },
    })
    expect(JSON.stringify(value)).not.toMatch(/web_fetch|search_planning|plan_intent|plan_complexity|plan_sub_query|plan_search_term|plan_tool_mapping|plan_execution/)
    expect(value.research_plan.usage_boundary.execution).toContain('resident operations directly')
    expect(renderResearchPlanText(value)).toContain('via resident tool docs_search')
    expect(renderResearchPlanText(value)).not.toContain('search_call operation docs_search')
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(RESEARCH_PLAN_OUTPUT_SCHEMA),
      value,
    )).toEqual([])
  })

  it('maps known URLs to web_extract, detects docs intent, and emits executable web_map steps', () => {
    const known = buildResearchPlan({
      question: 'Compare these pages',
      known_urls: [' https://example.test/a ', 'https://example.test/b'],
    }, options())
    expect(known.research_plan.intent_signals.known_url).toBe(true)
    expect(known.research_plan.steps.map(step => step.tool)).toEqual(['web_extract', 'web_extract'])
    expect(known.research_plan.steps[0]?.params).toEqual({
      url: 'https://example.test/a',
      format: 'markdown',
    })

    const unavailable = buildResearchPlan({
      question: 'Map the API site',
      sub_queries: [{
        id: 'sq1',
        question: 'Find API pages',
        reason: 'The site map is needed first.',
        tool: 'web_map',
        query: 'https://example.test',
      }],
    }, options(undefined, false, 4))
    expect(unavailable.research_plan.preflight.unavailable_tools).toEqual(['web_map'])
    expect(unavailable.research_plan.preflight.gaps.join('\n')).toMatch(/disclose site_map.*search_call/i)

    const mapped = buildResearchPlan({
      question: 'Map the API site',
      sub_queries: [{
        id: 'sq1',
        question: 'Find API pages',
        reason: 'The site map is needed first.',
        tool: 'web_map',
        query: 'https://example.test',
      }],
    }, options(undefined, true, 4))
    expect(mapped.research_plan.preflight.unavailable_tools).toEqual([])
    expect(mapped.research_plan.preflight.web_map_available).toBe(true)
    expect(renderResearchPlanText(mapped)).toContain('via search_call operation web_map')
    expect(mapped.research_plan.steps[0]?.params).toEqual({
      url: 'https://example.test',
      max_depth: 1,
      max_breadth: 4,
      limit: 4,
    })
  })

  it('fails closed when no Agent capability resolver is supplied', async () => {
    const { operations, tool } = toolWith()
    const args = { question: 'Plan a bounded comparison' }
    try {
      const value = await tool.execute(args, runContext(args)) as ResearchPlanOutput
      expect(value.research_plan.preflight.web_map_available).toBe(false)
    } finally {
      await operations.stop()
    }
  })

  it('rejects extra arguments, empty strings, invalid enums, URL/userinfo/count/string boundaries', async () => {
    const value = config({
      maxQuestionCharacters: 4,
      maxSubQueryCharacters: 4,
      maxQueryCharacters: 4,
      maxReasonCharacters: 4,
      maxKnownUrlCharacters: 20,
      maxKnownUrls: 1,
    })
    const { operations, tool } = toolWith(value)
    const cases: unknown[] = [
      { question: 'okay', extra: true },
      { question: '   ' },
      { question: 'okay', budget: 'huge' },
      { question: 'okay', known_urls: ['ftp://example.test'] },
      { question: 'okay', known_urls: ['https://user:secret@example.test'] },
      { question: 'okay', known_urls: ['https://example.test/a', 'https://example.test/b'] },
      { question: 'okay', sub_queries: [] },
      { question: 'okay', sub_queries: [{ id: 'sq1', question: 'longer', reason: 'why' }] },
      { question: 'okay', sub_queries: [{ id: 'sq1', question: 'ok', reason: 'ok', extra: true }] },
      { question: 'okay', sub_queries: [{ id: 'sq1', question: 'ok', reason: 'ok', tool: 'web_fetch' }] },
      { question: 'okay', sub_queries: [{ id: 'sq1', question: 'ok', reason: 'ok', query: '' }] },
    ]
    for (const args of cases) {
      await expect(tool.execute(args as never, runContext(args))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      })
    }
    await operations.stop()
  })

  it('proves planning does not call fetch or touch Provider dependencies', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    let providerAccesses = 0
    const forbiddenProviderDependencies = new Proxy({}, {
      get() {
        providerAccesses += 1
        throw new Error('offline planner touched Provider dependencies')
      },
    })
    const value = buildResearchPlan(
      { question: 'offline comparison' },
      { ...options(), providerDependencies: forbiddenProviderDependencies } as never,
    )
    expect(value.plan_complete).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(providerAccesses).toBe(0)
  })
})

describe('research_plan bounds, render, card, and replay', () => {
  it('enforces exact and over canonical JSON bytes without splitting Unicode text', () => {
    const full = buildResearchPlan({
      question: '比较界🙂'.repeat(20),
      sub_queries: [{ id: 'sq1', question: '检查界🙂页面', reason: '需要多源证据界🙂' }],
    }, options())
    const exactBytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
    expect(boundResearchPlanOutput(full, exactBytes)).toEqual(full)
    const over = boundResearchPlanOutput(full, exactBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
    expect(over.research_plan.canonical_output_truncated).toBe(true)
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(RESEARCH_PLAN_OUTPUT_SCHEMA),
      over,
    )).toEqual([])
    expect(() => boundResearchPlanOutput(full, 1)).toThrow(/output budget/i)
  })

  it('preserves executable URL targets when the canonical envelope is bounded', () => {
    const longPath = 'a'.repeat(60_000)
    const full = buildResearchPlan({
      question: 'Compare the selected pages',
      known_urls: [`https://example.test/${longPath}`, `https://example.test/b${longPath}`],
    }, options(config({
      maxKnownUrlCharacters: 65_536,
      maxOutputBytes: 4 * 1024 * 1024,
    }).researchPlan))
    const bounded = boundResearchPlanOutput(full, 250_000)
    expect(bounded.research_plan.canonical_output_truncated).toBe(true)
    expect(bounded.research_plan.steps.length).toBeGreaterThanOrEqual(1)
    const step = bounded.research_plan.steps[0]!
    expect(step.tool).toBe('web_extract')
    expect(step.query).toMatch(/^https:\/\//)
    expect(step.params).toEqual({ url: step.query, format: 'markdown' })
    expect(validateJsonSchemaValue(
      valueSchemaSpecToJsonSchema(RESEARCH_PLAN_OUTPUT_SCHEMA),
      bounded,
    )).toEqual([])

    const invalidTarget = 'not-a-url-'.repeat(8_000)
    const invalidFull = buildResearchPlan({
      question: 'Keep an invalid explicit target as a preflight gap',
      sub_queries: [{
        id: 'sq1',
        question: 'Inspect a target after the caller corrects it',
        reason: 'The selected page must be read before claims.',
        tool: 'web_extract',
        query: invalidTarget,
      }],
    }, options(config({
      maxQueryCharacters: 100_000,
      maxOutputBytes: 4 * 1024 * 1024,
    }).researchPlan))
    const invalidBounded = boundResearchPlanOutput(invalidFull, 20_000)
    const invalidStep = invalidBounded.research_plan.steps[0]!
    expect(invalidStep.query.length).toBeLessThan(invalidTarget.length)
    expect(invalidStep.params).toEqual({ url: invalidStep.query, format: 'markdown' })
    expect(invalidBounded.research_plan.preflight.gaps.join('\n')).toMatch(/valid absolute HTTP\(S\) URL/i)
  })

  it('renders a readable offline boundary with an independent Unicode-safe model cap', () => {
    const value = buildResearchPlan({ question: '界🙂 offline research plan' }, options())
    const complete = renderResearchPlanText({
      ...value,
      model_text_max_bytes: 1024 * 1024,
    })
    const exact = renderResearchPlanText({
      ...value,
      model_text_max_bytes: Buffer.byteLength(complete, 'utf8'),
    })
    expect(exact).toBe(complete)
    const limited = renderResearchPlanText({
      ...value,
      model_text_max_bytes: Buffer.byteLength(complete, 'utf8') - 1,
    })
    expect(Buffer.byteLength(limited, 'utf8')).toBeLessThanOrEqual(Buffer.byteLength(complete, 'utf8') - 1)
    expect(limited).toContain('[Model text truncated by model_text_max_bytes.]')
    expect(limited).not.toContain('\uFFFD')
    expect(isResearchPlanModelTextTruncated({
      ...value,
      model_text_max_bytes: Buffer.byteLength(complete, 'utf8') - 1,
    })).toBe(true)
    expect(complete).toContain('Offline research plan')
    expect(complete).toContain('does not search, fetch pages')
    expect(complete).toContain('Evidence policy: fetch_before_claim')
  })

  it('uses a generic search call card and a generic replayable result card, never a web card', () => {
    const args = { question: 'How should evidence be checked?' }
    const value = buildResearchPlan(args, options())
    const meta = researchPlanPresentationMeta(args, value)
    const result = {
      content: [{ type: 'text' as const, text: renderResearchPlanText(value) }],
      isError: false,
      meta,
    }
    const pending = presentResearchPlanCall(args)
    const longPending = presentResearchPlanCall({ question: '界🙂'.repeat(300) })
    const live = presentResearchPlanResult(args, result)
    const replay = presentResearchPlanResult(structuredClone(args), structuredClone(result))
    expect(pending).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'Plan research: How should evidence be checked?',
    })
    expect(Array.from(longPending.title).length).toBeLessThan(300)
    expect(longPending.title).not.toContain('\uFFFD')
    expect(live).toMatchObject({ card: 'generic' })
    expect(live).not.toMatchObject({ card: 'web' })
    expect(replay).toEqual(live)
  })
})

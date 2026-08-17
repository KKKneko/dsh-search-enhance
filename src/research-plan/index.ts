import { ToolArgsError } from '@deepseek-ai/dsh-tools'

import type { ResearchPlanConfig } from '../config.js'
import {
  SITE_MAP_DEFAULT_LIMIT,
  SITE_MAP_DEFAULT_MAX_BREADTH,
  SITE_MAP_DEFAULT_MAX_DEPTH,
  SITE_MAP_MAX_DEPTH,
  SITE_MAP_MAX_LINKS,
} from '../config.js'
import {
  RESEARCH_PLAN_BUDGETS,
  RESEARCH_PLAN_CLAIM_RISKS,
  RESEARCH_PLAN_CROSS_VALIDATION_NEEDS,
  RESEARCH_PLAN_DIFFICULTIES,
  RESEARCH_PLAN_LOCALE_DOMAIN_SCOPES,
  RESEARCH_PLAN_PARAMETERS,
  RESEARCH_PLAN_RECENCY_REQUIREMENTS,
  RESEARCH_PLAN_SOURCE_AUTHORITY_NEEDS,
  RESEARCH_PLAN_TOOLS,
  type ResearchPlanArgs,
  type ResearchPlanCanonical,
  type ResearchPlanOutput,
  type ResearchPlanStep,
  type ResearchPlanTool,
} from '../tools/schemas.js'
import {
  truncateCharacters,
  truncateUtf8,
  utf8ByteLength,
} from '../provider-runtime/index.js'

export interface ResearchPlanBuildOptions {
  readonly config: ResearchPlanConfig
  /** Whether the web_map operation is active for the Agent executing this plan. */
  readonly webMapAvailable: boolean
  /** The deployment site-map link cap used when emitting a web_map step. */
  readonly siteMapMaxLinks?: number
}

const RESEARCH_PLAN_MAX_STEPS = 10
const PLAN_BOUNDARY = 'Stay within this sub-question and do not infer unsupported claims.'
const PREFLIGHT_RULE = 'Planning is offline. A listed tool is an execution instruction, not an automatic call or claim verification.'
const GAP_RULE = 'Discovery candidates are not claim evidence; fetch selected key pages, inspect route and truncation facts, and mark unresolved claims as unverified.'
const PLANNING_BOUNDARY = 'Offline plan only: this call does not search, fetch pages, access credentials, verify claims, or write session/storage state.'
const EXECUTION_BOUNDARY = 'Call listed resident operations directly. Invoke only deferred web_map steps through search_call after the site_map capability is active.'
const FINAL_ANSWER_POLICY = 'Cite extracted evidence for claim-level statements, separate discovery candidates from extracted evidence, disclose truncation and route limitations, and state unresolved gaps.'

const DOCS_INTENT_PATTERN = /\b(api|apis|sdk|docs?|documentation|reference|framework|library|libraries|github|readme|changelog|migration|migrate|release)\b|文档|文档库|接口|软件开发工具包|框架|库|代码库|迁移|版本说明/iu

const CAPABILITY_REASONS: Record<ResearchPlanTool, string> = {
  web_search: 'Broad discovery and bounded synthesis candidates for general research questions.',
  docs_search: 'Documentation, SDK/API, library, README, release, and migration discovery.',
  web_extract: 'Read a selected HTTP(S) page through the plugin extraction contract before relying on claims.',
  web_map: 'Discover bounded candidate URLs under a known site; this remains discovery evidence only.',
}

const EXPECTED_OUTPUTS: Record<ResearchPlanTool, string> = {
  web_search: 'A bounded discovery synthesis and source candidates.',
  docs_search: 'Authoritative documentation discovery snippets and source candidates.',
  web_extract: 'Bounded extracted page content with route, evidence, and truncation facts.',
  web_map: 'A bounded list of discovered candidate URLs, not page-body evidence.',
}

const EVIDENCE_REQUIREMENTS: Record<ResearchPlanTool, string> = {
  web_search: 'Discovery output only; fetch selected source pages with web_extract before claim-level conclusions.',
  docs_search: 'Documentation discovery output only; fetch the selected canonical page with web_extract before claims.',
  web_extract: 'Inspect evidence_level, retrieval_route, status, and truncation before using extracted content for a claim.',
  web_map: 'Discovery URLs only; select pages and fetch them with web_extract before any claim-level conclusion.',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(...violations: string[]): never {
  throw new ToolArgsError(violations)
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value as number
}

function assertPlannerConfig(config: ResearchPlanConfig): void {
  positiveSafeInteger(config.maxQuestionCharacters, 'researchPlan.maxQuestionCharacters')
  positiveSafeInteger(config.maxSubQueryCharacters, 'researchPlan.maxSubQueryCharacters')
  positiveSafeInteger(config.maxQueryCharacters, 'researchPlan.maxQueryCharacters')
  positiveSafeInteger(config.maxReasonCharacters, 'researchPlan.maxReasonCharacters')
  positiveSafeInteger(config.maxKnownUrlCharacters, 'researchPlan.maxKnownUrlCharacters')
  positiveSafeInteger(config.maxKnownUrls, 'researchPlan.maxKnownUrls')
  positiveSafeInteger(config.maxOutputBytes, 'researchPlan.maxOutputBytes')
  positiveSafeInteger(config.modelTextMaxBytes, 'researchPlan.modelTextMaxBytes')
  if (config.maxKnownUrls > 10) {
    throw new RangeError('researchPlan.maxKnownUrls cannot exceed the model contract maximum of 10')
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function boundedText(
  value: unknown,
  label: string,
  maximumCharacters: number,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') invalid(`${label} must be a string`)
  const trimmed = (value as string).trim()
  if (trimmed.length === 0) {
    if (!required) return undefined
    invalid(`${label} must not be empty`)
  }
  if (codePointLength(trimmed) > maximumCharacters) {
    invalid(`${label} exceeds its configured character limit`)
  }
  return trimmed
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
  fallback: T[number],
): T[number] {
  const selected = value === undefined ? fallback : value
  if (typeof selected !== 'string' || !values.includes(selected)) {
    invalid(`${label} must be one of ${values.join(', ')}`)
  }
  return selected as T[number]
}

function assertOnlyDeclaredArguments(args: unknown): asserts args is Record<string, unknown> {
  if (!isRecord(args)) invalid('arguments must be an object')
  const allowed = new Set(Object.keys(RESEARCH_PLAN_PARAMETERS))
  const unexpected = Object.keys(args).filter(key => !allowed.has(key))
  if (unexpected.length > 0) {
    invalid(...unexpected.map(key => `"${key}" is not allowed`))
  }
}

function normalizeUrl(
  value: unknown,
  label: string,
  maximumCharacters: number,
): string {
  const text = boundedText(value, label, maximumCharacters)
  if (text === undefined) invalid(`${label} must not be empty`)
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(text)?.[1]
  if (authority === undefined || authority.includes('@')) {
    invalid(`${label} must be an absolute HTTP(S) URL without userinfo`)
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    invalid(`${label} must be an absolute HTTP(S) URL without userinfo`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) {
    invalid(`${label} must be an absolute HTTP(S) URL without userinfo`)
  }
  return text
}

interface NormalizedSubQuery {
  readonly id: string
  readonly question: string
  readonly reason: string
  readonly tool?: ResearchPlanTool
  readonly query?: string
}

interface NormalizedInput {
  readonly question: string
  readonly budget: (typeof RESEARCH_PLAN_BUDGETS)[number]
  readonly recencyRequirement: (typeof RESEARCH_PLAN_RECENCY_REQUIREMENTS)[number]
  readonly localeDomainScope: (typeof RESEARCH_PLAN_LOCALE_DOMAIN_SCOPES)[number]
  readonly sourceAuthorityNeed: (typeof RESEARCH_PLAN_SOURCE_AUTHORITY_NEEDS)[number]
  readonly claimRisk?: (typeof RESEARCH_PLAN_CLAIM_RISKS)[number]
  readonly crossValidationNeed?: (typeof RESEARCH_PLAN_CROSS_VALIDATION_NEEDS)[number]
  readonly knownUrls: readonly string[]
  readonly subQueries: readonly NormalizedSubQuery[]
}

function normalizeInput(
  rawArgs: unknown,
  config: ResearchPlanConfig,
): NormalizedInput {
  assertOnlyDeclaredArguments(rawArgs)
  const question = boundedText(
    rawArgs.question,
    'question',
    config.maxQuestionCharacters,
  )
  if (question === undefined) invalid('question must not be empty')
  const budget = enumValue(rawArgs.budget, 'budget', RESEARCH_PLAN_BUDGETS, 'standard')
  const recencyRequirement = enumValue(
    rawArgs.recency_requirement,
    'recency_requirement',
    RESEARCH_PLAN_RECENCY_REQUIREMENTS,
    'none',
  )
  const localeDomainScope = enumValue(
    rawArgs.locale_domain_scope,
    'locale_domain_scope',
    RESEARCH_PLAN_LOCALE_DOMAIN_SCOPES,
    'global',
  )
  const sourceAuthorityNeed = enumValue(
    rawArgs.source_authority_need,
    'source_authority_need',
    RESEARCH_PLAN_SOURCE_AUTHORITY_NEEDS,
    'high',
  )
  const claimRisk = rawArgs.claim_risk === undefined
    ? undefined
    : enumValue(rawArgs.claim_risk, 'claim_risk', RESEARCH_PLAN_CLAIM_RISKS, 'medium')
  const crossValidationNeed = rawArgs.cross_validation_need === undefined
    ? undefined
    : enumValue(
        rawArgs.cross_validation_need,
        'cross_validation_need',
        RESEARCH_PLAN_CROSS_VALIDATION_NEEDS,
        'normal',
      )

  let knownUrls: string[] = []
  if (rawArgs.known_urls !== undefined) {
    if (!Array.isArray(rawArgs.known_urls) || !isDenseArray(rawArgs.known_urls)) {
      invalid('known_urls must be a dense array')
    }
    const values = rawArgs.known_urls as unknown[]
    if (values.length > 10 || values.length > config.maxKnownUrls) {
      invalid('known_urls exceeds its configured maximum of 10 URLs')
    }
    knownUrls = values.map((value, index) => normalizeUrl(
      value,
      `known_urls[${index}]`,
      config.maxKnownUrlCharacters,
    ))
  }

  let subQueries: NormalizedSubQuery[] = []
  if (rawArgs.sub_queries !== undefined) {
    if (!Array.isArray(rawArgs.sub_queries) || !isDenseArray(rawArgs.sub_queries)) {
      invalid('sub_queries must be a dense array')
    }
    const values = rawArgs.sub_queries as unknown[]
    if (values.length < 1 || values.length > 6) {
      invalid('sub_queries must contain between 1 and 6 items')
    }
    subQueries = values.map((value, index) => {
      if (!isRecord(value)) invalid(`sub_queries[${index}] must be an object`)
      const unexpected = Object.keys(value).filter(key => (
        !['id', 'question', 'reason', 'tool', 'query'].includes(key)
      ))
      if (unexpected.length > 0) {
        invalid(...unexpected.map(key => `"sub_queries[${index}].${key}" is not allowed`))
      }
      const id = boundedText(
        value.id,
        `sub_queries[${index}].id`,
        config.maxSubQueryCharacters,
      )
      const subQuestion = boundedText(
        value.question,
        `sub_queries[${index}].question`,
        config.maxSubQueryCharacters,
      )
      const reason = boundedText(
        value.reason,
        `sub_queries[${index}].reason`,
        config.maxReasonCharacters,
      )
      if (id === undefined || subQuestion === undefined || reason === undefined) {
        invalid(`sub_queries[${index}] requires id, question, and reason`)
      }
      const tool = value.tool === undefined
        ? undefined
        : enumValue(value.tool, `sub_queries[${index}].tool`, RESEARCH_PLAN_TOOLS, 'web_search')
      const query = value.query === undefined
        ? undefined
        : boundedText(
            value.query,
            `sub_queries[${index}].query`,
            config.maxQueryCharacters,
          )
      return {
        id,
        question: subQuestion,
        reason,
        ...(tool === undefined ? {} : { tool }),
        ...(query === undefined ? {} : { query }),
      }
    })
  }

  return {
    question,
    budget,
    recencyRequirement,
    localeDomainScope,
    sourceAuthorityNeed,
    ...(claimRisk === undefined ? {} : { claimRisk }),
    ...(crossValidationNeed === undefined ? {} : { crossValidationNeed }),
    knownUrls,
    subQueries,
  }
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false
  }
  return true
}

function docsApiIntent(input: NormalizedInput): boolean {
  return DOCS_INTENT_PATTERN.test([
    input.question,
    ...input.subQueries.flatMap(subQuery => [subQuery.question, subQuery.query ?? '']),
  ].join(' '))
}

function defaultClaimRisk(
  input: NormalizedInput,
): (typeof RESEARCH_PLAN_CLAIM_RISKS)[number] {
  if (input.claimRisk !== undefined) return input.claimRisk
  if (input.budget === 'deep') return 'high'
  if (input.budget === 'standard') return 'medium'
  return 'low'
}

function defaultCrossValidation(
  input: NormalizedInput,
): (typeof RESEARCH_PLAN_CROSS_VALIDATION_NEEDS)[number] {
  if (input.crossValidationNeed !== undefined) return input.crossValidationNeed
  return input.budget === 'deep' ? 'high' : 'normal'
}

function depthForBudget(
  budget: (typeof RESEARCH_PLAN_BUDGETS)[number],
): 'compact' | 'normal' | 'deep' {
  return budget === 'quick' ? 'compact' : budget === 'standard' ? 'normal' : 'deep'
}

function difficultyForBudget(
  budget: (typeof RESEARCH_PLAN_BUDGETS)[number],
): (typeof RESEARCH_PLAN_DIFFICULTIES)[number] {
  return budget === 'quick' ? 'low' : budget === 'standard' ? 'standard' : 'high'
}

function selectedDefaultTool(
  hasKnownUrls: boolean,
  hasDocsIntent: boolean,
): ResearchPlanTool {
  if (hasKnownUrls) return 'web_extract'
  if (hasDocsIntent) return 'docs_search'
  return 'web_search'
}

function siteMapDefaults(
  budget: (typeof RESEARCH_PLAN_BUDGETS)[number],
  deploymentMaximum: number,
): { readonly maxDepth: number; readonly maxBreadth: number; readonly limit: number } {
  const maximum = Math.min(
    SITE_MAP_MAX_LINKS,
    positiveSafeInteger(deploymentMaximum, 'siteMap.maxLinks'),
  )
  const requested = budget === 'quick'
    ? { maxDepth: 1, maxBreadth: 5, limit: 10 }
    : budget === 'standard'
      ? { maxDepth: 1, maxBreadth: SITE_MAP_DEFAULT_MAX_BREADTH, limit: SITE_MAP_DEFAULT_LIMIT }
      : { maxDepth: 2, maxBreadth: 20, limit: 60 }
  return {
    maxDepth: Math.min(requested.maxDepth, SITE_MAP_MAX_DEPTH),
    maxBreadth: Math.min(requested.maxBreadth, maximum),
    limit: Math.min(requested.limit, maximum),
  }
}

function normalizedPlanEntries(
  input: NormalizedInput,
  hasDocsIntent: boolean,
): Array<{
  readonly id: string
  readonly goal: string
  readonly reason: string
  readonly tool: ResearchPlanTool
  readonly query: string
}> {
  const fallbackTool = selectedDefaultTool(input.knownUrls.length > 0, hasDocsIntent)
  if (input.subQueries.length === 0) {
    if (input.knownUrls.length > 0) {
      return input.knownUrls.slice(0, RESEARCH_PLAN_MAX_STEPS).map((url, index) => ({
        id: `sq${index + 1}`,
        goal: index === 0 ? input.question : `Inspect known source ${index + 1}`,
        reason: index === 0
          ? 'Inspect the caller-supplied source before relying on its claims.'
          : 'Inspect each additional caller-supplied source independently.',
        tool: 'web_extract',
        query: url,
      }))
    }
    return [{
      id: 'sq1',
      goal: input.question,
      reason: 'Answer the primary research question with bounded source-backed evidence.',
      tool: fallbackTool,
      query: input.question,
    }]
  }

  return input.subQueries.slice(0, RESEARCH_PLAN_MAX_STEPS).map((subQuery, index) => {
    const tool = subQuery.tool ?? (input.knownUrls.length > 0 ? 'web_extract' : fallbackTool)
    const query = subQuery.query
      ?? (tool === 'web_extract' || tool === 'web_map'
        ? input.knownUrls[index] ?? input.knownUrls[0] ?? subQuery.question
        : subQuery.question)
    return {
      id: subQuery.id,
      goal: subQuery.question,
      reason: subQuery.reason,
      tool,
      query,
    }
  })
}

function toolParams(
  tool: ResearchPlanTool,
  query: string,
  budget: (typeof RESEARCH_PLAN_BUDGETS)[number],
  siteMapMaxLinks: number,
): ResearchPlanStep['params'] {
  switch (tool) {
    case 'web_search':
      return { query, depth: depthForBudget(budget) }
    case 'docs_search':
      return { query }
    case 'web_extract':
      return { url: query, format: 'markdown' }
    case 'web_map': {
      const limits = siteMapDefaults(budget, siteMapMaxLinks)
      return {
        url: query,
        max_depth: limits.maxDepth,
        max_breadth: limits.maxBreadth,
        limit: limits.limit,
      }
    }
  }
}

function uniqueTools(steps: readonly { readonly tool: ResearchPlanTool }[]): ResearchPlanTool[] {
  const tools: ResearchPlanTool[] = []
  for (const step of steps) {
    if (!tools.includes(step.tool)) tools.push(step.tool)
  }
  return tools
}

function validTargetUrl(value: string): boolean {
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(value)?.[1]
  if (authority === undefined || authority.includes('@')) return false
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username.length === 0
      && parsed.password.length === 0
    )
  } catch {
    return false
  }
}

function buildGapMessages(
  steps: readonly ResearchPlanStep[],
  unavailableTools: readonly ResearchPlanTool[],
  crossValidationNeed: (typeof RESEARCH_PLAN_CROSS_VALIDATION_NEEDS)[number],
): string[] {
  const gaps: string[] = []
  for (const tool of unavailableTools) {
    gaps.push(`${tool} is not active for the current Agent; disclose site_map with search_tools before invoking web_map through search_call.`)
  }
  for (const step of steps) {
    if ((step.tool === 'web_extract' || step.tool === 'web_map') && !validTargetUrl(step.query)) {
      gaps.push(`${step.id} requires a valid absolute HTTP(S) URL before ${step.tool} can run.`)
    }
    if (step.tool !== 'web_extract') {
      gaps.push(`${step.id} is discovery evidence; select key URLs and fetch them with web_extract before claims.`)
    }
  }
  if (crossValidationNeed === 'high' && uniqueTools(steps).length < 2) {
    gaps.push('High cross-validation was requested but the bounded plan has only one selected capability.')
  }
  return gaps
}

function executionOrder(
  steps: readonly ResearchPlanStep[],
): ResearchPlanCanonical['execution_order'] {
  const discovery = steps
    .filter(step => step.tool !== 'web_extract')
    .map(step => step.id)
  const extraction = steps
    .filter(step => step.tool === 'web_extract')
    .map(step => step.id)
  if (discovery.length > 0) {
    return {
      parallel: discovery.length > 1 ? [discovery] : [],
      sequential: discovery.length === 1 ? [...discovery, ...extraction] : extraction,
      estimated_rounds: extraction.length > 0 ? 2 : 1,
    }
  }
  return {
    parallel: extraction.length > 1 ? [extraction] : [],
    sequential: extraction.length <= 1 ? extraction : [],
    estimated_rounds: 1,
  }
}

function planForInput(
  input: NormalizedInput,
  options: ResearchPlanBuildOptions,
): ResearchPlanOutput {
  const hasDocsIntent = docsApiIntent(input)
  const entries = normalizedPlanEntries(input, hasDocsIntent)
  for (const entry of entries) {
    if (
      (entry.tool === 'web_extract' || entry.tool === 'web_map')
      && /^https?:\/\//iu.test(entry.query)
      && codePointLength(entry.query) > options.config.maxKnownUrlCharacters
    ) {
      invalid(`${entry.tool} target exceeds researchPlan.maxKnownUrlCharacters`)
    }
  }
  const deploymentLinkCap = options.siteMapMaxLinks ?? SITE_MAP_MAX_LINKS
  const steps: ResearchPlanStep[] = entries.map((entry, index) => ({
    id: `s${index + 1}`,
    subquestion_id: entry.id,
    tool: entry.tool,
    capability: entry.tool,
    purpose: entry.reason,
    query: entry.query,
    params: toolParams(entry.tool, entry.query, input.budget, deploymentLinkCap),
    evidence_requirement: EVIDENCE_REQUIREMENTS[entry.tool],
  }))
  const tools = uniqueTools(steps)
  const unavailableTools = options.webMapAvailable || !tools.includes('web_map')
    ? []
    : ['web_map' as const]
  const preflightGaps = buildGapMessages(steps, unavailableTools, defaultCrossValidation(input))
  const decomposition = entries.map(entry => ({
    id: entry.id,
    goal: entry.goal,
    reason: entry.reason,
    expected_output: EXPECTED_OUTPUTS[entry.tool],
    boundary: PLAN_BOUNDARY,
    tool_hint: entry.tool,
    query: entry.query,
  }))
  const capabilityPlan = tools.map(tool => ({
    capability: tool,
    tools: [tool],
    reason: CAPABILITY_REASONS[tool],
  }))
  const gapCheckGaps = buildGapMessages(steps, unavailableTools, defaultCrossValidation(input))
  const output = {
    plan_complete: true as const,
    research_plan: {
      mode: 'deep_research' as const,
      query_mode: input.budget,
      question: input.question,
      trigger_source: 'explicit_tool' as const,
      difficulty: difficultyForBudget(input.budget),
      canonical_output_truncated: false,
      intent_signals: {
        recency_requirement: input.recencyRequirement,
        docs_api_intent: hasDocsIntent,
        locale_domain_scope: input.localeDomainScope,
        known_url: input.knownUrls.length > 0,
        source_authority_need: input.sourceAuthorityNeed,
        claim_risk: defaultClaimRisk(input),
        cross_validation_need: defaultCrossValidation(input),
        breadth_depth_budget: input.budget,
      },
      decomposition,
      capability_plan: capabilityPlan,
      preflight: {
        network_access: 'not_used' as const,
        credential_access: 'not_used' as const,
        session_storage: 'not_used' as const,
        web_map_available: options.webMapAvailable,
        required_tools: tools,
        unavailable_tools: unavailableTools,
        gaps: preflightGaps,
        rule: PREFLIGHT_RULE,
      },
      steps,
      execution_order: executionOrder(steps),
      evidence_policy: 'fetch_before_claim' as const,
      gap_check: {
        required: true as const,
        gaps: gapCheckGaps,
        rule: GAP_RULE,
      },
      final_answer_policy: FINAL_ANSWER_POLICY,
      usage_boundary: {
        planning: PLANNING_BOUNDARY,
        execution: EXECUTION_BOUNDARY,
      },
    },
    model_text_max_bytes: options.config.modelTextMaxBytes,
  }
  return output as ResearchPlanOutput
}

/**
 * Build one deterministic offline plan. This function has no Provider,
 * credential, session, storage, clock, or network dependency.
 */
export function buildResearchPlan(
  rawArgs: ResearchPlanArgs,
  options: ResearchPlanBuildOptions,
): ResearchPlanOutput {
  assertPlannerConfig(options.config)
  const input = normalizeInput(rawArgs, options.config)
  const full = planForInput(input, options)
  return boundResearchPlanOutput(full, options.config.maxOutputBytes)
}

function stringLengths(value: unknown, result: number[] = []): number[] {
  if (typeof value === 'string') {
    result.push(codePointLength(value))
    return result
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLengths(item, result)
    return result
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) stringLengths(item, result)
  }
  return result
}

function shorten(value: string, maximumCharacters: number): string {
  const retained = truncateCharacters(value, Math.max(1, maximumCharacters)).text
  return retained.length === 0 ? '…' : retained
}

function compactParams(
  params: ResearchPlanStep['params'],
  maximumCharacters: number,
): ResearchPlanStep['params'] {
  if ('depth' in params) {
    return {
      query: shorten(params.query, maximumCharacters),
      ...(params.profile === undefined ? {} : { profile: params.profile }),
      depth: params.depth,
    }
  }
  if ('format' in params) {
    return {
      url: validTargetUrl(params.url) ? params.url : shorten(params.url, maximumCharacters),
      format: 'markdown',
    }
  }
  if ('max_depth' in params) {
    return {
      url: validTargetUrl(params.url) ? params.url : shorten(params.url, maximumCharacters),
      max_depth: params.max_depth,
      max_breadth: params.max_breadth,
      limit: params.limit,
    }
  }
  return { query: shorten(params.query, maximumCharacters) }
}

function compactResearchPlan(
  value: ResearchPlanOutput,
  stepCount: number,
  maximumCharacters: number,
): ResearchPlanOutput {
  const original = value.research_plan
  const selectedSteps = original.steps.slice(0, stepCount)
  const selectedSubIds = new Set(selectedSteps.map(step => step.subquestion_id))
  const selectedTools = uniqueTools(selectedSteps)
  const compactText = (text: string): string => shorten(text, maximumCharacters)
  const urlQueries = new Set(
    selectedSteps
      .filter(step => (
        (step.tool === 'web_extract' || step.tool === 'web_map')
        && validTargetUrl(step.query)
      ))
      .map(step => step.query),
  )
  const compactQuery = (query: string): string => (
    urlQueries.has(query) ? query : compactText(query)
  )
  const compactSteps = selectedSteps.map(step => ({
    ...step,
    subquestion_id: compactText(step.subquestion_id),
    purpose: compactText(step.purpose),
    query: compactQuery(step.query),
    params: compactParams(step.params, maximumCharacters),
    evidence_requirement: compactText(step.evidence_requirement),
  }))
  const compactDecomposition = original.decomposition
    .filter(item => selectedSubIds.has(item.id))
    .slice(0, stepCount)
    .map(item => ({
      ...item,
      id: compactText(item.id),
      goal: compactText(item.goal),
      reason: compactText(item.reason),
      expected_output: compactText(item.expected_output),
      boundary: compactText(item.boundary),
      query: urlQueries.has(item.query) ? item.query : compactText(item.query),
    }))
  const compactCapabilities = original.capability_plan
    .filter(item => selectedTools.includes(item.capability))
    .map(item => ({
      ...item,
      tools: item.tools.filter(tool => selectedTools.includes(tool)),
      reason: compactText(item.reason),
    }))
  const gaps = original.gap_check.gaps.slice(0, Math.max(1, stepCount)).map(compactText)
  const preflightGaps = original.preflight.gaps.slice(0, Math.max(1, stepCount)).map(compactText)
  const compactExecutionOrder = executionOrder(compactSteps)
  return {
    plan_complete: true,
    research_plan: {
      ...original,
      question: compactText(original.question),
      canonical_output_truncated: true,
      decomposition: compactDecomposition,
      capability_plan: compactCapabilities,
      preflight: {
        ...original.preflight,
        required_tools: original.preflight.required_tools.filter(tool => selectedTools.includes(tool)),
        unavailable_tools: original.preflight.unavailable_tools.filter(tool => selectedTools.includes(tool)),
        gaps: preflightGaps,
        rule: compactText(original.preflight.rule),
      },
      steps: compactSteps,
      execution_order: compactExecutionOrder,
      gap_check: {
        ...original.gap_check,
        gaps,
        rule: compactText(original.gap_check.rule),
      },
      final_answer_policy: compactText(original.final_answer_policy),
      usage_boundary: {
        planning: compactText(original.usage_boundary.planning),
        execution: compactText(original.usage_boundary.execution),
      },
    },
    model_text_max_bytes: value.model_text_max_bytes,
  }
}

/**
 * Enforce the complete canonical JSON budget while retaining a whole stable
 * prefix of steps and Unicode-safe text prefixes. A truthful minimum plan that
 * cannot fit fails closed instead of returning an invalid or empty success.
 */
export function boundResearchPlanOutput(
  value: ResearchPlanOutput,
  maximumBytes: number,
): ResearchPlanOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  const bytes = (candidate: ResearchPlanOutput): number => utf8ByteLength(JSON.stringify(candidate))
  if (bytes(value) <= maximumBytes) return value

  const maxCharacters = Math.max(1, ...stringLengths(value))
  const maxSteps = Math.min(value.research_plan.steps.length, RESEARCH_PLAN_MAX_STEPS)
  for (let stepCount = maxSteps; stepCount >= 1; stepCount -= 1) {
    let low = 1
    let high = maxCharacters
    let best: ResearchPlanOutput | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = compactResearchPlan(value, stepCount, middle)
      if (bytes(candidate) <= maximumBytes) {
        best = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (best !== undefined) return best
  }

  throw new RangeError('research_plan canonical JSON exceeds its configured output budget')
}

/** Pure check used by the card projection and render tests. */
export function isResearchPlanModelTextTruncated(value: ResearchPlanOutput): boolean {
  const complete = renderResearchPlanTextUnbounded(value)
  return utf8ByteLength(complete) > value.model_text_max_bytes
}

function stepText(step: ResearchPlanStep): string {
  const route = step.tool === 'web_map'
    ? 'via search_call operation web_map'
    : `via resident tool ${step.tool}`
  return [
    `${step.id} (${step.subquestion_id}) ${route}`,
    `Purpose: ${step.purpose}`,
    `Query: ${step.query}`,
    `Params: ${JSON.stringify(step.params)}`,
    `Evidence: ${step.evidence_requirement}`,
  ].join('\n')
}

function renderResearchPlanTextUnbounded(value: ResearchPlanOutput): string {
  const plan = value.research_plan
  const intent = plan.intent_signals
  const capabilities = plan.capability_plan.length === 0
    ? 'None'
    : plan.capability_plan.map(item => `- ${item.capability}: ${item.reason}`).join('\n')
  const preflight = [
    `Network access: ${plan.preflight.network_access}`,
    `Credential access: ${plan.preflight.credential_access}`,
    `Session/storage: ${plan.preflight.session_storage}`,
    `web_map operation active: ${plan.preflight.web_map_available ? 'yes' : 'no'}`,
    `Required tools: ${plan.preflight.required_tools.join(', ') || 'none'}`,
    `Unavailable tools: ${plan.preflight.unavailable_tools.join(', ') || 'none'}`,
    ...(plan.preflight.gaps.length === 0
      ? ['Gaps: none identified before execution.']
      : ['Gaps:', ...plan.preflight.gaps.map(gap => `- ${gap}`)]),
  ].join('\n')
  const steps = plan.steps.length === 0
    ? 'No steps.'
    : plan.steps.map(stepText).join('\n\n')
  const execution = [
    `Parallel groups: ${JSON.stringify(plan.execution_order.parallel)}`,
    `Sequential steps: ${plan.execution_order.sequential.join(', ') || 'none'}`,
    `Estimated rounds: ${plan.execution_order.estimated_rounds}`,
  ].join('\n')
  const gaps = plan.gap_check.gaps.length === 0
    ? 'Gaps: none identified.'
    : ['Gaps:', ...plan.gap_check.gaps.map(gap => `- ${gap}`)].join('\n')
  return [
    `Offline research plan (${plan.query_mode})`,
    `Question: ${plan.question}`,
    `Mode: ${plan.mode}; trigger: ${plan.trigger_source}; difficulty: ${plan.difficulty}`,
    `Intent: recency=${intent.recency_requirement}; docs_api_intent=${intent.docs_api_intent}; locale=${intent.locale_domain_scope}; known_url=${intent.known_url}; authority=${intent.source_authority_need}; claim_risk=${intent.claim_risk}; cross_validation=${intent.cross_validation_need}; budget=${intent.breadth_depth_budget}`,
    `Capabilities\n${capabilities}`,
    `Preflight\n${preflight}`,
    `Ordered steps\n${steps}`,
    `Execution order\n${execution}`,
    `Evidence policy: ${plan.evidence_policy}`,
    `${gaps}\nRule: ${plan.gap_check.rule}`,
    `Final answer policy: ${plan.final_answer_policy}`,
    `Boundary\n${plan.usage_boundary.planning}\n${plan.usage_boundary.execution}`,
    ...(plan.canonical_output_truncated
      ? ['Canonical output was bounded by the configured JSON byte limit.']
      : []),
  ].join('\n\n')
}

/** Pure Native/model projection with a Unicode-safe explicit truncation marker. */
export function renderResearchPlanText(value: ResearchPlanOutput): string {
  const complete = renderResearchPlanTextUnbounded(value)
  const maximumBytes = Number.isSafeInteger(value.model_text_max_bytes)
    && value.model_text_max_bytes > 0
    ? value.model_text_max_bytes
    : 0
  if (utf8ByteLength(complete) <= maximumBytes) return complete

  const marker = '[Model text truncated by model_text_max_bytes.]'
  const suffix = `\n\n${marker}`
  if (utf8ByteLength(suffix) <= maximumBytes) {
    const prefix = truncateUtf8(complete, maximumBytes - utf8ByteLength(suffix)).text
    return `${prefix}${suffix}`
  }
  return truncateUtf8(marker, maximumBytes).text
}

/** Alias with a concise name for callers that only need the pure planner. */
export const planResearch = buildResearchPlan

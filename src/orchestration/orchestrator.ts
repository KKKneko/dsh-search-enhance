import type { Config } from '../config.js'
import type { CanonicalSource } from '../contracts/index.js'
import {
  createProviderAttemptRecord,
  isAbortError,
  isProviderError,
  ProviderError,
  runWithTimeout,
  throwIfAborted,
  truncateCharacters,
  utf8ByteLength,
  type ProviderAttemptRecord,
  type ProviderErrorKind,
  type ProviderSkipReason,
} from '../provider-runtime/index.js'
import type { SearchApiSearchResult } from '../providers/search-api.js'
import type {
  BoundedSourceProvider,
  SourceProviderSearchOutcome,
} from '../providers/types.js'
import {
  applySourceQuality,
  normalizeSourceUrl,
  resolveSearchStrategy,
  type ResolvedSearchStrategy,
} from '../search/index.js'
import { extractMarkdownCitationUrls } from '../search/parse.js'
import { shouldEnhanceDocumentation, splitDiscoveryBudget } from './policy.js'
import type {
  SearchCanonicalResult,
  SearchOrchestrationDiagnostics,
  SearchOrchestrationInput,
  SearchOrchestrationResult,
  SearchOrchestratorDependencies,
  SearchPersistenceCandidate,
  SearchRoutingDecision,
  SearchWarning,
} from './types.js'

const ORCHESTRATOR_PROVIDER = 'search-orchestrator'
const PARTIAL_ANSWER = '主搜索失败，仅返回补充来源。'
const DOCUMENTATION_LIMIT = 8

type SourceSlotKey = 'exa' | 'tavily' | 'firecrawl'

interface TaskTrack<T> {
  readonly provider: string
  readonly startedAt: number
  dispatches: number
  endedAt: number | undefined
  promise: Promise<T>
  settled: PromiseSettledResult<T> | undefined
}

interface SourceSlot {
  readonly key: SourceSlotKey
  readonly provider: BoundedSourceProvider
  readonly capability: 'docs_search' | 'web_search'
  available: boolean
  limit: number
  skipReason: ProviderSkipReason | undefined
  planningError: unknown
  planningDurationMs: number
  track: TaskTrack<SourceProviderSearchOutcome> | undefined
}

function clockValue(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('orchestrator clock must return a finite non-negative value')
  }
  return value
}

function duration(track: Pick<TaskTrack<unknown>, 'startedAt' | 'endedAt'>): number {
  return Math.max(0, (track.endedAt ?? track.startedAt) - track.startedAt)
}

function errorKind(error: unknown): ProviderErrorKind {
  return isProviderError(error) ? error.kind : 'unknown'
}

function warning(
  code: SearchWarning['code'],
  options: {
    readonly capability?: SearchWarning['capability']
    readonly provider?: string
    readonly error?: unknown
  } = {},
): Readonly<SearchWarning> {
  return Object.freeze({
    code,
    ...(options.capability === undefined ? {} : { capability: options.capability }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.error === undefined ? {} : { errorKind: errorKind(options.error) }),
  })
}

function normalizedInfrastructureError(
  error: unknown,
  provider: string,
  capability: 'main_search' | 'docs_search' | 'web_search',
): ProviderError {
  if (isProviderError(error)) return error
  return new ProviderError({ capability, cause: error, kind: 'unknown', provider })
}

function resultBytes(result: SearchCanonicalResult): number {
  return utf8ByteLength(JSON.stringify(result))
}

function freezeCanonicalResult(
  result: SearchCanonicalResult,
): Readonly<SearchCanonicalResult> {
  return Object.freeze({
    ...result,
    sources: Object.freeze([...result.sources]),
    warnings: Object.freeze([...result.warnings]),
  })
}

function freezeDiagnostics(
  diagnostics: SearchOrchestrationDiagnostics,
): Readonly<SearchOrchestrationDiagnostics> {
  return Object.freeze({
    attempts: Object.freeze([...diagnostics.attempts]),
    routing: Object.freeze({
      ...diagnostics.routing,
      discoveryAllocation: Object.freeze({ ...diagnostics.routing.discoveryAllocation }),
    }),
  })
}

function freezePersistence(
  persistence: SearchPersistenceCandidate,
): Readonly<SearchPersistenceCandidate> {
  return Object.freeze({
    ...persistence,
    sources: Object.freeze([...persistence.sources]),
  })
}

function freezeOrchestrationResult(
  result: SearchOrchestrationResult,
): Readonly<SearchOrchestrationResult> {
  return Object.freeze({
    canonical: freezeCanonicalResult(result.canonical),
    diagnostics: freezeDiagnostics(result.diagnostics),
    persistence: freezePersistence(result.persistence),
  })
}

function projectBoundedResult(
  candidate: SearchCanonicalResult,
  answer: string | undefined,
  sources: readonly CanonicalSource[],
  warnings: readonly SearchWarning[],
): Readonly<SearchCanonicalResult> {
  const returnedAnswerCharacters = answer === undefined ? 0 : Array.from(answer).length
  const { answer: _candidateAnswer, ...candidateWithoutAnswer } = candidate
  void _candidateAnswer
  return freezeCanonicalResult({
    ...candidateWithoutAnswer,
    ...(answer === undefined || answer.length === 0 ? {} : { answer }),
    returnedAnswerCharacters,
    returnedSources: sources.length,
    sources,
    truncated: true,
    warnings,
  })
}

/**
 * Apply the canonical JSON-byte budget after answer-character and source-count
 * limits. The partial-success sentence is indivisible; visible sources remain
 * independently configurable and may be zero while the persistence candidate remains full.
 */
export function boundSearchOrchestrationResult(
  candidate: SearchCanonicalResult,
  maximumBytes: number,
): Readonly<SearchCanonicalResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer')
  }
  const frozen = freezeCanonicalResult(candidate)
  if (resultBytes(frozen) <= maximumBytes) return frozen

  const outputWarning = warning('canonical_output_truncated')
  const warnings = Object.freeze(
    frozen.warnings.some(item => item.code === outputWarning.code)
      ? [...frozen.warnings]
      : [...frozen.warnings, outputWarning],
  )
  const fullAnswer = frozen.answer

  if (frozen.state === 'partial') {
    if (fullAnswer === undefined) {
      throw new ProviderError({
        capability: 'main_search',
        kind: 'budget_exceeded',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }
    const answerOnly = projectBoundedResult(frozen, fullAnswer, [], warnings)
    if (resultBytes(answerOnly) > maximumBytes) {
      throw new ProviderError({
        capability: 'main_search',
        kind: 'budget_exceeded',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }
    let retained: readonly CanonicalSource[] = Object.freeze([])
    for (let count = 1; count <= frozen.sources.length; count += 1) {
      const next = Object.freeze(frozen.sources.slice(0, count))
      const projected = projectBoundedResult(frozen, fullAnswer, next, warnings)
      if (resultBytes(projected) > maximumBytes) break
      retained = next
    }
    return projectBoundedResult(frozen, fullAnswer, retained, warnings)
  }

  const codePoints = Array.from(fullAnswer ?? '')
  let retainedAnswer = fullAnswer
  let answerOnly = projectBoundedResult(frozen, retainedAnswer, [], warnings)
  if (resultBytes(answerOnly) > maximumBytes) {
    let low = 0
    let high = codePoints.length
    retainedAnswer = undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const prefix = codePoints.slice(0, middle).join('')
      const projected = projectBoundedResult(
        frozen,
        prefix.length === 0 ? undefined : prefix,
        [],
        warnings,
      )
      if (resultBytes(projected) <= maximumBytes) {
        retainedAnswer = prefix.length === 0 ? undefined : prefix
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    answerOnly = projectBoundedResult(frozen, retainedAnswer, [], warnings)
    if (resultBytes(answerOnly) > maximumBytes) {
      throw new ProviderError({
        capability: 'main_search',
        kind: 'budget_exceeded',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }
  }

  let retainedSources: readonly CanonicalSource[] = Object.freeze([])
  for (let count = 1; count <= frozen.sources.length; count += 1) {
    const next = Object.freeze(frozen.sources.slice(0, count))
    const projected = projectBoundedResult(frozen, retainedAnswer, next, warnings)
    if (resultBytes(projected) > maximumBytes) break
    retainedSources = next
  }
  return projectBoundedResult(frozen, retainedAnswer, retainedSources, warnings)
}

/** Merge group prefixes in routing order and deduplicate only exact URL strings. */
export function mergeCanonicalSources(
  ...groups: ReadonlyArray<readonly CanonicalSource[]>
): readonly CanonicalSource[] {
  const seen = new Set<string>()
  const merged: CanonicalSource[] = []
  for (const group of groups) {
    for (const source of group) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      merged.push(Object.freeze({ ...source }))
    }
  }
  return Object.freeze(merged)
}

function prioritizeCitedSources(
  sources: readonly CanonicalSource[],
  citationUrls: readonly string[],
  maximumUrlCharacters: number,
): readonly CanonicalSource[] {
  if (citationUrls.length === 0) return sources
  const priorityByIdentity = new Map<string, number>()
  for (const url of citationUrls) {
    const identity = normalizeSourceUrl(url, maximumUrlCharacters)
    if (identity !== undefined && !priorityByIdentity.has(identity)) {
      priorityByIdentity.set(identity, priorityByIdentity.size)
    }
  }
  if (priorityByIdentity.size === 0) return sources

  const cited: Array<CanonicalSource | undefined> = Array(priorityByIdentity.size)
  const remaining: CanonicalSource[] = []
  for (const source of sources) {
    const identity = normalizeSourceUrl(source.url, maximumUrlCharacters)
    const priority = identity === undefined ? undefined : priorityByIdentity.get(identity)
    if (priority === undefined || cited[priority] !== undefined) remaining.push(source)
    else cited[priority] = source
  }
  const matched = cited.filter((source): source is CanonicalSource => source !== undefined)
  if (matched.length === 0) return sources
  return Object.freeze([...matched, ...remaining])
}

function startTrackedTask<T>(
  provider: string,
  now: () => number,
  fanout: AbortController,
  operation: (onDispatch: () => void) => Promise<T>,
): TaskTrack<T> {
  const track: TaskTrack<T> = {
    dispatches: 0,
    endedAt: undefined,
    promise: Promise.resolve(undefined as T),
    provider,
    settled: undefined,
    startedAt: clockValue(now),
  }
  let pending: Promise<T>
  try {
    pending = operation(() => { track.dispatches += 1 })
  } catch (error) {
    pending = Promise.reject(error)
  }
  track.promise = pending.then(
    value => {
      track.endedAt = clockValue(now)
      return value
    },
    error => {
      track.endedAt = clockValue(now)
      if (isAbortError(error) && !fanout.signal.aborted) fanout.abort(error)
      throw error
    },
  )
  return track
}

function probeDuration(startedAt: number, now: () => number): number {
  return Math.max(0, clockValue(now) - startedAt)
}

function sourceAttempt(
  slot: SourceSlot,
  mainFailed: boolean,
): ProviderAttemptRecord {
  if (slot.planningError !== undefined) {
    return createProviderAttemptRecord({
      attempts: 1,
      capability: slot.capability,
      durationMs: slot.planningDurationMs,
      error: slot.planningError,
      outcome: 'failed',
      participatedInFallback: mainFailed,
      provider: slot.key,
    })
  }
  if (slot.skipReason !== undefined || slot.track === undefined) {
    return createProviderAttemptRecord({
      attempts: 0,
      capability: slot.capability,
      durationMs: slot.planningDurationMs,
      outcome: 'skipped',
      participatedInFallback: false,
      provider: slot.key,
      skipReason: slot.skipReason ?? 'not_applicable',
    })
  }
  const settled = slot.track.settled
  if (settled === undefined) throw new Error('source task was not settled')
  if (settled.status === 'rejected') {
    return createProviderAttemptRecord({
      attempts: Math.max(1, slot.track.dispatches),
      capability: slot.capability,
      durationMs: duration(slot.track),
      error: settled.reason,
      outcome: 'failed',
      participatedInFallback: mainFailed,
      provider: slot.key,
    })
  }
  if (settled.value.state === 'not_configured') {
    return createProviderAttemptRecord({
      attempts: 0,
      capability: slot.capability,
      durationMs: duration(slot.track),
      outcome: 'skipped',
      participatedInFallback: false,
      provider: slot.key,
      skipReason: 'not_configured',
    })
  }
  return createProviderAttemptRecord({
    attempts: Math.max(1, settled.value.attempts),
    capability: slot.capability,
    durationMs: duration(slot.track),
    outcome: 'success',
    participatedInFallback: mainFailed,
    provider: slot.key,
  })
}

/**
 * Registration-free stage-1 search orchestrator. It resolves Config/strategy
 * once, fans out decided paths, waits for every started path, and never turns
 * cancellation into a warning or partial success.
 */
export class SearchOrchestrator {
  private readonly getConfig: SearchOrchestratorDependencies['getConfig']
  private readonly mainSearch: SearchOrchestratorDependencies['mainSearch']
  private readonly exa: BoundedSourceProvider
  private readonly tavily: BoundedSourceProvider
  private readonly firecrawl: BoundedSourceProvider
  private readonly now: () => number

  constructor(dependencies: SearchOrchestratorDependencies) {
    this.getConfig = dependencies.getConfig
    this.mainSearch = dependencies.mainSearch
    this.exa = dependencies.exa
    this.tavily = dependencies.tavily
    this.firecrawl = dependencies.firecrawl
    this.now = dependencies.now ?? Date.now
  }

  async search(input: SearchOrchestrationInput): Promise<Readonly<SearchOrchestrationResult>> {
    throwIfAborted(input.signal)
    const config = input.config ?? this.getConfig()
    const query = input.query.trim()
    if (
      query.length === 0
      || Array.from(query).length > config.retention.searchQueryMaxCharacters
    ) {
      throw new ProviderError({
        capability: 'main_search',
        kind: 'invalid_request',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }
    let strategy: ResolvedSearchStrategy
    try {
      strategy = resolveSearchStrategy(config, {
        ...(input.depth === undefined ? {} : { depth: input.depth }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
      })
    } catch (error) {
      throw new ProviderError({
        capability: 'main_search',
        cause: error,
        kind: 'invalid_request',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }

    return runWithTimeout(
      signal => this.execute(input, query, config, strategy, signal),
      {
        capability: 'main_search',
        provider: ORCHESTRATOR_PROVIDER,
        signal: input.signal,
        timeoutMs: config.toolTimeoutMs,
      },
    )
  }

  private async execute(
    input: SearchOrchestrationInput,
    query: string,
    config: Config,
    strategy: ResolvedSearchStrategy,
    signal: AbortSignal,
  ): Promise<Readonly<SearchOrchestrationResult>> {
    const fanout = new AbortController()
    const relayAbort = (): void => fanout.abort(signal.reason)
    signal.addEventListener('abort', relayAbort, { once: true })
    const slots: SourceSlot[] = [
      {
        available: false,
        capability: 'docs_search',
        key: 'exa',
        limit: 0,
        planningDurationMs: 0,
        planningError: undefined,
        provider: this.exa,
        skipReason: undefined,
        track: undefined,
      },
      {
        available: false,
        capability: 'web_search',
        key: 'tavily',
        limit: 0,
        planningDurationMs: 0,
        planningError: undefined,
        provider: this.tavily,
        skipReason: undefined,
        track: undefined,
      },
      {
        available: false,
        capability: 'web_search',
        key: 'firecrawl',
        limit: 0,
        planningDurationMs: 0,
        planningError: undefined,
        provider: this.firecrawl,
        skipReason: undefined,
        track: undefined,
      },
    ]

    try {
      const docsEnabled = config.fallbackMode === 'auto'
        && shouldEnhanceDocumentation(strategy.profile, query)
      const extraBudget = config.extraDiscoverySources[strategy.profile]
      const probeSlots: SourceSlot[] = []
      for (const slot of slots) {
        if (slot.capability === 'docs_search') {
          if (!docsEnabled) slot.skipReason = 'not_applicable'
          else probeSlots.push(slot)
        } else if (extraBudget === 0) {
          slot.skipReason = 'budget_zero'
        } else {
          probeSlots.push(slot)
        }
      }

      const probeStarts = probeSlots.map(() => clockValue(this.now))
      const probeResults = await Promise.allSettled(probeSlots.map((slot) => {
        const pending = slot.provider.configured(config)
        return pending.catch((error) => {
          if (isAbortError(error) && !fanout.signal.aborted) fanout.abort(error)
          throw error
        })
      }))
      for (let index = 0; index < probeSlots.length; index += 1) {
        const slot = probeSlots[index]
        const settled = probeResults[index]
        const startedAt = probeStarts[index]
        if (slot === undefined || settled === undefined || startedAt === undefined) continue
        slot.planningDurationMs = probeDuration(startedAt, this.now)
        if (settled.status === 'fulfilled') {
          slot.available = settled.value
          if (!settled.value) slot.skipReason = 'not_configured'
        } else {
          slot.planningError = settled.reason
        }
      }
      throwIfAborted(signal)
      throwIfAborted(fanout.signal)

      const tavilySlot = slots[1]
      const firecrawlSlot = slots[2]
      if (tavilySlot === undefined || firecrawlSlot === undefined) {
        throw new Error('discovery slots are incomplete')
      }
      const allocation = splitDiscoveryBudget(
        extraBudget,
        tavilySlot.available && tavilySlot.planningError === undefined,
        firecrawlSlot.available && firecrawlSlot.planningError === undefined,
      )
      for (const slot of slots) {
        if (slot.capability === 'docs_search' && slot.available) {
          slot.limit = Math.min(strategy.maxCollectedSources, DOCUMENTATION_LIMIT)
        }
      }
      if (tavilySlot.available) {
        tavilySlot.limit = allocation.tavily
        if (allocation.tavily === 0) tavilySlot.skipReason = 'budget_zero'
      }
      if (firecrawlSlot.available) {
        firecrawlSlot.limit = allocation.firecrawl
        if (allocation.firecrawl === 0) firecrawlSlot.skipReason = 'budget_zero'
      }

      const mainTrack = startTrackedTask<SearchApiSearchResult>(
        'search-api',
        this.now,
        fanout,
        onDispatch => this.mainSearch.searchResolved({
          config,
          query,
          signal: fanout.signal,
          strategy,
          onDispatch,
        }),
      )
      const taskTracks: Array<TaskTrack<SearchApiSearchResult | SourceProviderSearchOutcome>> = [
        mainTrack,
      ]
      for (const slot of slots) {
        if (
          slot.skipReason !== undefined
          || slot.planningError !== undefined
          || slot.limit <= 0
        ) continue
        const track = startTrackedTask<SourceProviderSearchOutcome>(
          slot.key,
          this.now,
          fanout,
          onDispatch => slot.provider.search({
            config,
            limit: slot.limit,
            query,
            signal: fanout.signal,
            onDispatch,
          }),
        )
        slot.track = track
        taskTracks.push(track)
      }

      const settledTasks = await Promise.allSettled(taskTracks.map(track => track.promise))
      for (let index = 0; index < taskTracks.length; index += 1) {
        const track = taskTracks[index]
        const settled = settledTasks[index]
        if (track !== undefined && settled !== undefined) track.settled = settled
      }
      throwIfAborted(signal)
      throwIfAborted(fanout.signal)

      const mainSettled = mainTrack.settled
      if (mainSettled === undefined) throw new Error('main search was not settled')
      const mainSucceeded = mainSettled.status === 'fulfilled'
      const supplementalGroups: Array<readonly CanonicalSource[]> = []
      const completedOutcomes = new Map<SourceSlotKey, SourceProviderSearchOutcome>()
      for (const slot of slots) {
        const settled = slot.track?.settled
        if (settled?.status !== 'fulfilled') continue
        completedOutcomes.set(slot.key, settled.value)
        if (settled.value.state === 'not_configured') {
          slot.skipReason = 'not_configured'
          continue
        }
        supplementalGroups.push(settled.value.result.sources)
      }
      const mainSources = mainSucceeded ? mainSettled.value.sources : []
      const compatibilitySources = mergeCanonicalSources(mainSources, ...supplementalGroups)
      const qualitySources = applySourceQuality(query, compatibilitySources)
      if (!mainSucceeded && qualitySources.length === 0) {
        throw normalizedInfrastructureError(mainSettled.reason, 'search-api', 'main_search')
      }

      const rawAnswer = mainSucceeded ? mainSettled.value.answer : PARTIAL_ANSWER
      const limitedAnswer = truncateCharacters(rawAnswer, strategy.budget.maxAnswerCharacters)
      if (!mainSucceeded && limitedAnswer.text !== PARTIAL_ANSWER) {
        throw new ProviderError({
          capability: 'main_search',
          kind: 'budget_exceeded',
          provider: ORCHESTRATOR_PROVIDER,
        })
      }
      const citationUrls = mainSucceeded
        ? extractMarkdownCitationUrls(
          limitedAnswer.text,
          config.webExtract.maxUrlCharacters,
        )
        : []
      const prioritizedSources = prioritizeCitedSources(
        qualitySources,
        citationUrls,
        config.webExtract.maxUrlCharacters,
      )
      const visibleSources = Object.freeze(
        prioritizedSources.slice(0, strategy.budget.maxVisibleSources),
      )

      const warnings: SearchWarning[] = []
      if (!mainSucceeded) {
        warnings.push(warning('main_search_failed', {
          capability: 'main_search',
          error: mainSettled.reason,
          provider: 'search-api',
        }))
      }
      let providerTruncated = false
      for (const slot of slots) {
        if (slot.planningError !== undefined) {
          warnings.push(warning('provider_failed', {
            capability: slot.capability,
            error: slot.planningError,
            provider: slot.key,
          }))
          continue
        }
        const settled = slot.track?.settled
        if (settled?.status === 'rejected') {
          warnings.push(warning('provider_failed', {
            capability: slot.capability,
            error: settled.reason,
            provider: slot.key,
          }))
          continue
        }
        const outcome = completedOutcomes.get(slot.key)
        if (outcome?.state === 'complete') {
          for (const providerWarning of outcome.warnings ?? []) {
            warnings.push(Object.freeze({
              capability: slot.capability,
              code: providerWarning.code,
              ...(providerWarning.errorKind === undefined
                ? {}
                : { errorKind: providerWarning.errorKind }),
              provider: providerWarning.provider,
            }))
          }
          if (outcome.result.truncated) {
            providerTruncated = true
            warnings.push(warning('provider_result_truncated', {
              capability: slot.capability,
              provider: slot.key,
            }))
          }
        }
      }
      if (limitedAnswer.truncated) warnings.push(warning('answer_truncated'))
      const mainSourcesTruncated = mainSucceeded && mainSettled.value.sourcesTruncated
      const collectionTruncated = providerTruncated || mainSourcesTruncated
      const visibleSourcesTruncated = visibleSources.length < prioritizedSources.length
      const sourcesTruncated = collectionTruncated || visibleSourcesTruncated
      if (sourcesTruncated) warnings.push(warning('sources_truncated'))
      if (mainSucceeded && rawAnswer.trim().length === 0 && prioritizedSources.length === 0) {
        warnings.push(warning('no_results'))
      }

      const mainAttempt = createProviderAttemptRecord({
        attempts: mainSucceeded
          ? Math.max(1, mainSettled.value.attempts)
          : Math.max(1, mainTrack.dispatches),
        capability: 'main_search',
        durationMs: duration(mainTrack),
        ...(mainSucceeded ? {} : { error: mainSettled.reason }),
        outcome: mainSucceeded ? 'success' : 'failed',
        participatedInFallback: false,
        provider: 'search-api',
      })
      const attempts = Object.freeze([
        mainAttempt,
        ...slots.map(slot => sourceAttempt(slot, !mainSucceeded)),
      ])
      const routing: SearchRoutingDecision = Object.freeze({
        depth: strategy.depth,
        discoveryAllocation: allocation,
        documentationEnhancement: docsEnabled,
        extraDiscoveryBudget: extraBudget,
        profile: strategy.profile,
      })
      const answer = limitedAnswer.text.length === 0 ? undefined : limitedAnswer.text
      const candidate: SearchCanonicalResult = {
        ...(answer === undefined ? {} : { answer }),
        evidenceLevel: 'discovery',
        returnedAnswerCharacters: limitedAnswer.outputCharacters,
        returnedSources: visibleSources.length,
        sources: visibleSources,
        state: mainSucceeded ? 'complete' : 'partial',
        totalAnswerCharacters: limitedAnswer.totalCharacters,
        totalSources: prioritizedSources.length,
        truncated: limitedAnswer.truncated || sourcesTruncated,
        warnings: Object.freeze(warnings),
      }
      const canonical = boundSearchOrchestrationResult(
        candidate,
        config.retention.canonicalOutputMaxBytes,
      )
      return freezeOrchestrationResult({
        canonical,
        diagnostics: { attempts, routing },
        persistence: {
          collectionTruncated,
          depth: strategy.depth,
          profile: strategy.profile,
          query,
          sources: prioritizedSources,
        },
      })
    } finally {
      signal.removeEventListener('abort', relayAbort)
    }
  }
}

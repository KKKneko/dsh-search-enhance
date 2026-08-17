import type { Config } from '../config.js'
import {
  isAbortError,
  isProviderError,
  runWithTimeout,
  throwIfAborted,
  type ProviderErrorKind,
} from '../provider-runtime/index.js'
import { inspectDiagnosticStatus, type DiagnosticStatusSnapshot } from './status.js'
import {
  DIAGNOSTIC_PROVIDERS,
  type DiagnosticCapabilityStatus,
  type DiagnosticCredentialDescriber,
  type DiagnosticProbe,
  type DiagnosticProviderAttempt,
  type DiagnosticProviderName,
  type DiagnosticProviderStatus,
  type DiagnosticReporter,
  type DiagnosticWarning,
  type DiagnosticWarningCode,
  type SearchDiagnosticReport,
} from './types.js'

const DIAGNOSTIC_RUNTIME_PROVIDER = 'search-diagnostics'

const SHOW_LIMITATIONS = Object.freeze([
  'Capability availability reflects configuration and route enablement, not live connectivity.',
  'show performs no Provider request and uses only DSH Credentials describe for credential status.',
])

const TEST_LIMITATIONS = Object.freeze([
  'Capability availability reflects configuration and route enablement; only provider_attempts describes this test.',
  'Connectivity probes are bounded point-in-time checks and do not guarantee complete third-party service health.',
  'Tavily Extract, Firecrawl Scrape, Tavily Map, smart_direct, and direct are not network-probed; local routes report enabled state only.',
  'The test does not call Search API main search or write session events, source records, or Provider response caches.',
])

export interface SearchDiagnosticsDependencies {
  readonly credentials: DiagnosticCredentialDescriber
  readonly probes: readonly DiagnosticProbe[]
  /** Injectable monotonic-enough clock used only for bounded safe durations. */
  readonly now?: () => number
}

interface ProbeTrack {
  readonly key: string
  readonly status: DiagnosticProviderStatus
  readonly capability: DiagnosticCapabilityStatus['capability']
  readonly probe: DiagnosticProbe
  readonly startedAt: number
  dispatches: number
  settled?: PromiseSettledResult<Readonly<{ state: 'complete' | 'not_configured' }>>
  finishedAt?: number
}

function probeKey(capability: string, provider: string): string {
  return `${capability}/${provider}`
}

function clockValue(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('diagnostics clock must return a finite non-negative value')
  }
  return value
}

function boundedDuration(
  startedAt: number,
  finishedAt: number,
  maximumMs: number,
): number {
  const duration = Math.max(0, Math.round(finishedAt - startedAt))
  if (!Number.isSafeInteger(duration)) return maximumMs
  return Math.min(duration, maximumMs)
}

function probeConfig(config: Config): Config {
  const timeoutMs = config.diagnostics.timeoutMs
  const maxAttempts = Math.min(config.retry.maxAttempts, config.diagnostics.maxProbeAttempts)
  return {
    ...config,
    searchApi: {
      ...config.searchApi,
      timeoutMs: Math.min(config.searchApi.timeoutMs, timeoutMs),
    },
    providers: {
      context7: {
        ...config.providers.context7,
        timeoutMs: Math.min(config.providers.context7.timeoutMs, timeoutMs),
      },
      exa: {
        ...config.providers.exa,
        timeoutMs: Math.min(config.providers.exa.timeoutMs, timeoutMs),
      },
      tavily: {
        ...config.providers.tavily,
        timeoutMs: Math.min(config.providers.tavily.timeoutMs, timeoutMs),
      },
      firecrawl: {
        ...config.providers.firecrawl,
        timeoutMs: Math.min(config.providers.firecrawl.timeoutMs, timeoutMs),
      },
    },
    retry: {
      ...config.retry,
      maxAttempts,
      baseDelayMs: Math.min(config.retry.baseDelayMs, timeoutMs),
      maxDelayMs: Math.min(config.retry.maxDelayMs, timeoutMs),
      maxTotalDelayMs: Math.min(config.retry.maxTotalDelayMs, timeoutMs),
    },
    retention: {
      ...config.retention,
      providerResponseMaxBytes: Math.min(
        config.retention.providerResponseMaxBytes,
        config.diagnostics.maxResponseBytes,
      ),
      providerResultMaxBytes: Math.min(
        config.retention.providerResultMaxBytes,
        config.diagnostics.maxResultBytes,
      ),
    },
  }
}

function flattenedStatuses(
  statuses: readonly DiagnosticCapabilityStatus[],
): readonly Readonly<{ capability: DiagnosticCapabilityStatus['capability']; status: DiagnosticProviderStatus }>[] {
  return Object.freeze(statuses.flatMap(capability => capability.providers.map(status => Object.freeze({
    capability: capability.capability,
    status,
  }))))
}

function statusAttempt(
  capability: DiagnosticCapabilityStatus['capability'],
  status: DiagnosticProviderStatus,
): Readonly<DiagnosticProviderAttempt> | undefined {
  switch (status.state) {
    case 'configured':
      return undefined
    case 'missing':
      return Object.freeze({
        attempts: 0,
        capability,
        durationMs: 0,
        outcome: 'not_configured',
        provider: status.provider,
      })
    case 'disabled':
      return Object.freeze({
        attempts: 0,
        capability,
        durationMs: 0,
        outcome: 'disabled',
        provider: status.provider,
      })
    case 'unsupported':
      return Object.freeze({
        attempts: 0,
        capability,
        durationMs: 0,
        outcome: 'unsupported',
        provider: status.provider,
      })
    case 'unavailable':
      return Object.freeze({
        attempts: 0,
        capability,
        durationMs: 0,
        errorKind: 'unavailable',
        outcome: 'failed',
        provider: status.provider,
      })
  }
}

function failedAttempt(
  track: ProbeTrack,
  durationMs: number,
  errorKind: ProviderErrorKind,
): Readonly<DiagnosticProviderAttempt> {
  return Object.freeze({
    attempts: track.dispatches,
    capability: track.capability,
    durationMs,
    errorKind,
    outcome: 'failed',
    provider: track.status.provider,
  })
}

function attemptFromTrack(
  track: ProbeTrack,
  config: Config,
): Readonly<DiagnosticProviderAttempt> {
  const settled = track.settled
  const finishedAt = track.finishedAt
  if (settled === undefined || finishedAt === undefined) {
    return failedAttempt(track, 0, 'unknown')
  }
  const durationMs = boundedDuration(
    track.startedAt,
    finishedAt,
    config.diagnostics.timeoutMs,
  )
  if (settled.status === 'rejected') {
    const error = settled.reason
    if (isProviderError(error) && error.kind === 'credential_missing') {
      return Object.freeze({
        attempts: track.dispatches,
        capability: track.capability,
        durationMs,
        outcome: 'not_configured',
        provider: track.status.provider,
      })
    }
    return failedAttempt(
      track,
      durationMs,
      isProviderError(error) ? error.kind : 'unknown',
    )
  }
  if (settled.value.state === 'not_configured') {
    return Object.freeze({
      attempts: track.dispatches,
      capability: track.capability,
      durationMs,
      outcome: 'not_configured',
      provider: track.status.provider,
    })
  }
  if (
    track.dispatches < 1
    || track.dispatches > config.diagnostics.maxProbeAttempts
  ) {
    return failedAttempt(
      track,
      durationMs,
      track.dispatches > config.diagnostics.maxProbeAttempts
        ? 'budget_exceeded'
        : 'invalid_response',
    )
  }
  return Object.freeze({
    attempts: track.dispatches,
    capability: track.capability,
    durationMs,
    outcome: 'success',
    provider: track.status.provider,
  })
}

function warning(
  code: DiagnosticWarningCode,
  count: number,
): Readonly<DiagnosticWarning> | undefined {
  return count > 0 ? Object.freeze({ code, count }) : undefined
}

function reportWarnings(
  snapshot: DiagnosticStatusSnapshot,
  attempts: readonly DiagnosticProviderAttempt[],
): readonly DiagnosticWarning[] {
  const warnings = [
    warning(
      'not_configured',
      attempts.length === 0
        ? snapshot.missingProviders
        : attempts.filter(attempt => attempt.outcome === 'not_configured').length,
    ),
    warning('probe_failed', attempts.filter(attempt => attempt.outcome === 'failed').length),
    warning('unsupported', attempts.filter(attempt => attempt.outcome === 'unsupported').length),
    warning('configuration_unavailable', snapshot.unavailableProviders),
  ].filter((item): item is Readonly<DiagnosticWarning> => item !== undefined)
  return Object.freeze(warnings)
}

function freezeReport(input: SearchDiagnosticReport): Readonly<SearchDiagnosticReport> {
  return Object.freeze({
    ...input,
    capabilityStatus: Object.freeze(input.capabilityStatus.map(status => Object.freeze({
      ...status,
      providers: Object.freeze(status.providers.map(provider => Object.freeze({ ...provider }))),
    }))),
    providerAttempts: Object.freeze(input.providerAttempts.map(attempt => Object.freeze({ ...attempt }))),
    providersUsed: Object.freeze([...input.providersUsed]),
    minimumProfile: Object.freeze({ ...input.minimumProfile }),
    configuration: Object.freeze({ ...input.configuration }),
    warnings: Object.freeze(input.warnings.map(item => Object.freeze({ ...item }))),
    limitations: Object.freeze([...input.limitations]),
  })
}

/** Registration-free diagnostics runtime composed from public Provider operations. */
export class SearchDiagnostics implements DiagnosticReporter {
  private readonly credentials: DiagnosticCredentialDescriber
  private readonly probes: ReadonlyMap<string, DiagnosticProbe>
  private readonly now: () => number

  constructor(dependencies: SearchDiagnosticsDependencies) {
    this.credentials = dependencies.credentials
    this.now = dependencies.now ?? Date.now
    const probes = new Map<string, DiagnosticProbe>()
    for (const probe of dependencies.probes) {
      if (!DIAGNOSTIC_PROVIDERS.includes(probe.provider)) {
        throw new TypeError('diagnostic probe provider must use the fixed enum')
      }
      const key = probeKey(probe.capability, probe.provider)
      if (probes.has(key)) throw new TypeError(`duplicate diagnostic probe: ${key}`)
      probes.set(key, probe)
    }
    this.probes = probes
  }

  async show(input: { readonly config: Config; readonly signal: AbortSignal }): Promise<Readonly<SearchDiagnosticReport>> {
    return runWithTimeout(
      signal => this.executeShow(input.config, signal),
      {
        capability: 'model_list',
        provider: DIAGNOSTIC_RUNTIME_PROVIDER,
        signal: input.signal,
        timeoutMs: input.config.diagnostics.timeoutMs,
      },
    )
  }

  private async executeShow(
    config: Config,
    signal: AbortSignal,
  ): Promise<Readonly<SearchDiagnosticReport>> {
    throwIfAborted(signal)
    const snapshot = await inspectDiagnosticStatus(this.credentials, config, signal)
    throwIfAborted(signal)
    return freezeReport({
      action: 'show',
      tested: false,
      capabilityStatus: snapshot.capabilityStatus,
      providerAttempts: Object.freeze([]),
      providersUsed: Object.freeze([]),
      fallbackUsed: false,
      minimumProfile: snapshot.minimumProfile,
      configuration: snapshot.configuration,
      warnings: reportWarnings(snapshot, []),
      limitations: SHOW_LIMITATIONS,
      modelTextMaxBytes: config.diagnostics.modelTextMaxBytes,
    })
  }

  async test(input: { readonly config: Config; readonly signal: AbortSignal }): Promise<Readonly<SearchDiagnosticReport>> {
    return runWithTimeout(
      signal => this.executeTest(input.config, signal),
      {
        capability: 'model_list',
        provider: DIAGNOSTIC_RUNTIME_PROVIDER,
        signal: input.signal,
        timeoutMs: input.config.diagnostics.timeoutMs,
      },
    )
  }

  private async executeTest(
    config: Config,
    signal: AbortSignal,
  ): Promise<Readonly<SearchDiagnosticReport>> {
    const snapshot = await inspectDiagnosticStatus(this.credentials, config, signal)
    throwIfAborted(signal)
    const boundedConfig = probeConfig(config)
    const flattened = flattenedStatuses(snapshot.capabilityStatus)
    const fanout = new AbortController()
    const relayAbort = (): void => fanout.abort(signal.reason)
    signal.addEventListener('abort', relayAbort, { once: true })

    try {
      const tracks: ProbeTrack[] = []
      for (const entry of flattened) {
        if (entry.status.state !== 'configured') continue
        const probe = this.probes.get(probeKey(entry.capability, entry.status.provider))
        if (probe === undefined) continue
        tracks.push({
          capability: entry.capability,
          dispatches: 0,
          key: probeKey(entry.capability, entry.status.provider),
          probe,
          startedAt: clockValue(this.now),
          status: entry.status,
        })
      }

      const pending = tracks.map(async track => {
        try {
          return await track.probe.probe({
            config: boundedConfig,
            onDispatch: () => { track.dispatches += 1 },
            signal: fanout.signal,
          })
        } catch (error) {
          if (isAbortError(error) && !fanout.signal.aborted) fanout.abort(error)
          throw error
        }
      })
      const settled = await Promise.allSettled(pending)
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index]
        const outcome = settled[index]
        if (track === undefined || outcome === undefined) continue
        track.settled = outcome
        track.finishedAt = clockValue(this.now)
      }
      throwIfAborted(signal)
      const aborted = settled.find(
        outcome => outcome.status === 'rejected' && isAbortError(outcome.reason),
      )
      if (aborted?.status === 'rejected') throw aborted.reason

      const tracksByKey = new Map(tracks.map(track => [track.key, track]))
      const attempts = Object.freeze(flattened.map(entry => {
        const inactive = statusAttempt(entry.capability, entry.status)
        if (inactive !== undefined) return inactive
        const track = tracksByKey.get(probeKey(entry.capability, entry.status.provider))
        if (track === undefined) {
          return Object.freeze({
            attempts: 0,
            capability: entry.capability,
            durationMs: 0,
            outcome: 'unsupported' as const,
            provider: entry.status.provider,
          })
        }
        return attemptFromTrack(track, config)
      }))
      const successful = new Set(
        attempts.filter(attempt => attempt.outcome === 'success').map(attempt => attempt.provider),
      )
      const providersUsed = Object.freeze(
        DIAGNOSTIC_PROVIDERS.filter(provider => successful.has(provider)),
      )
      return freezeReport({
        action: 'test',
        tested: true,
        capabilityStatus: snapshot.capabilityStatus,
        providerAttempts: attempts,
        providersUsed,
        // Probes are independent and concurrent; they do not execute product fallback.
        fallbackUsed: false,
        minimumProfile: snapshot.minimumProfile,
        configuration: snapshot.configuration,
        warnings: reportWarnings(snapshot, attempts),
        limitations: TEST_LIMITATIONS,
        modelTextMaxBytes: config.diagnostics.modelTextMaxBytes,
      })
    } finally {
      signal.removeEventListener('abort', relayAbort)
    }
  }
}

export { probeConfig as diagnosticProbeConfig }

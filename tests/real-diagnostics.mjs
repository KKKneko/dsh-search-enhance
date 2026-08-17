import assert from 'node:assert/strict'

import { Config } from '../lib/config.js'
import {
  Context7ResolveDiagnosticProbe,
  SearchApiModelListDiagnosticProbe,
  SearchDiagnostics,
  SourceSearchDiagnosticProbe,
} from '../lib/diagnostics/index.js'
import { Context7RemoteClient } from '../lib/providers/context7.js'
import { ExaProvider } from '../lib/providers/exa.js'
import { FirecrawlSearchProvider } from '../lib/providers/firecrawl.js'
import { SearchApiProvider } from '../lib/providers/search-api.js'
import { TavilySearchProvider } from '../lib/providers/tavily.js'

const keyNames = [
  'SEARCH_API_KEY',
  'CONTEXT7_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
]
const values = Object.fromEntries(keyNames.map(name => [name, process.env[name]?.trim() || undefined]))
const configured = keyNames.filter(name => values[name] !== undefined)
if (configured.length === 0) {
  process.stdout.write('real search_diagnostics e2e: skipped (no Provider credentials are configured)\n')
  process.exit(0)
}

const config = Config({
  searchApi: {
    model: process.env.SEARCH_MODEL?.trim() || 'configured-for-diagnostics',
    timeoutMs: 30_000,
  },
  extraDiscoverySources: { auto: 1 },
  retry: {
    maxAttempts: 1,
    baseDelayMs: 0,
    multiplier: 1,
    maxDelayMs: 0,
    maxTotalDelayMs: 0,
    jitterRatio: 0,
  },
  diagnostics: {
    timeoutMs: 30_000,
    maxProbeAttempts: 1,
    maxResponseBytes: 128 * 1024,
    maxResultBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    modelTextMaxBytes: 16 * 1024,
  },
})
const credentials = {
  async describe(ref) {
    return { configured: values[String(ref)] !== undefined, writable: false }
  },
  async resolve(ref) {
    const value = values[String(ref)]
    return value === undefined
      ? undefined
      : { source: 'real-e2e-environment', value }
  },
}
const originalFetch = globalThis.fetch
let fetchCalls = 0
const trackingFetch = async (...args) => {
  fetchCalls += 1
  return originalFetch(...args)
}
const providerDependencies = { credentials, fetch: trackingFetch }
const context7 = new Context7RemoteClient(providerDependencies)
const exa = new ExaProvider(providerDependencies)
const tavily = new TavilySearchProvider(providerDependencies)
const firecrawl = new FirecrawlSearchProvider(providerDependencies)
const searchApi = new SearchApiProvider({
  credentials,
  fetch: trackingFetch,
  getConfig: () => config,
})
const diagnostics = new SearchDiagnostics({
  credentials,
  probes: [
    new SearchApiModelListDiagnosticProbe(searchApi),
    new Context7ResolveDiagnosticProbe(context7),
    new SourceSearchDiagnosticProbe('docs_search', 'exa', exa),
    new SourceSearchDiagnosticProbe('main_search', 'tavily_search', tavily),
    new SourceSearchDiagnosticProbe('main_search', 'firecrawl_search', firecrawl),
  ],
})

const cancelled = new AbortController()
const reason = new DOMException('cancel diagnostics before status inspection', 'AbortError')
cancelled.abort(reason)
await assert.rejects(
  diagnostics.test({ config, signal: cancelled.signal }),
  error => error === reason,
)

const shown = await diagnostics.show({ config, signal: new AbortController().signal })
assert.equal(shown.tested, false)
assert.deepEqual(shown.providerAttempts, [])
assert.equal(fetchCalls, 0, 'show unexpectedly performed a Provider request')

const tested = await diagnostics.test({ config, signal: new AbortController().signal })
assert.equal(tested.tested, true)
assert.equal(tested.action, 'test')
assert.equal(tested.fallbackUsed, false)
assert.equal(tested.providerAttempts.length, 10)
assert.ok(tested.providerAttempts.some(attempt => attempt.outcome === 'success'))
assert.ok(fetchCalls >= 1)
const serialized = JSON.stringify({ shown, tested })
for (const value of Object.values(values)) {
  if (value !== undefined) assert.equal(serialized.includes(value), false)
}
assert.doesNotMatch(serialized, /authorization|bearer|api.?key/i)
process.stdout.write(`real search_diagnostics e2e: ok (${configured.join(', ')}, ${tested.providersUsed.length} probes succeeded)\n`)

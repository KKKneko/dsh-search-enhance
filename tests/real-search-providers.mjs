import assert from 'node:assert/strict'

import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { Config } from '../lib/config.js'
import {
  Context7RemoteClient,
  ExaProvider,
  FirecrawlSearchProvider,
  TavilySearchProvider,
  context7LibraryUrl,
  selectContext7Library,
} from '../lib/providers/index.js'
import { SearchApiProvider } from '../lib/providers/search-api.js'

const FIXED_QUERY = 'What is HTTP status code 418? Give one concise sourced sentence.'
const CONTEXT7_QUERY = 'React useEffect cleanup official documentation'
const RESULT_LIMIT = 1
const PROVIDER_TIMEOUT_MS = 30_000
const knownFailureKinds = new Set([
  'credential_missing',
  'configuration',
  'invalid_request',
  'rate_limited',
  'timeout',
  'network',
  'http',
  'invalid_response',
  'budget_exceeded',
  'unavailable',
  'unknown',
])

function env(name) {
  const value = process.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

const secrets = {
  SEARCH_API_KEY: env('SEARCH_API_KEY'),
  CONTEXT7_API_KEY: env('CONTEXT7_API_KEY'),
  EXA_API_KEY: env('EXA_API_KEY'),
  TAVILY_API_KEY: env('TAVILY_API_KEY'),
  FIRECRAWL_API_KEY: env('FIRECRAWL_API_KEY'),
}
const searchEndpoint = env('SEARCH_API_E2E_URL')
const searchModel = env('SEARCH_MODEL')
const context7OptIn = env('CONTEXT7_E2E') === '1'

const credentials = {
  async describe(ref) {
    return { configured: secrets[String(ref)] !== undefined, writable: false }
  },
  async resolve(ref) {
    const value = secrets[String(ref)]
    return value === undefined
      ? undefined
      : { source: 'real-provider-e2e-environment', value }
  },
}

function e2eConfig(searchApi = {}) {
  return Config({
    searchApi: {
      timeoutMs: PROVIDER_TIMEOUT_MS,
      ...searchApi,
    },
    providers: {
      context7: { timeoutMs: PROVIDER_TIMEOUT_MS },
      exa: { timeoutMs: PROVIDER_TIMEOUT_MS },
      tavily: { timeoutMs: PROVIDER_TIMEOUT_MS },
      firecrawl: { timeoutMs: PROVIDER_TIMEOUT_MS },
    },
    retry: {
      maxAttempts: 1,
      baseDelayMs: 0,
      multiplier: 1,
      maxDelayMs: 0,
      maxTotalDelayMs: 0,
      jitterRatio: 0,
    },
    retention: {
      providerResponseMaxBytes: 256 * 1024,
      providerMaxSources: 2,
      providerResultMaxBytes: 128 * 1024,
      canonicalOutputMaxBytes: 128 * 1024,
    },
  })
}

function assertHttpUrl(value) {
  const parsed = new URL(value)
  assert.ok(parsed.protocol === 'http:' || parsed.protocol === 'https:')
  assert.equal(parsed.username, '')
  assert.equal(parsed.password, '')
}

function assertSecretFree(value) {
  const serialized = JSON.stringify(value)
  for (const secret of Object.values(secrets)) {
    if (secret !== undefined) assert.equal(serialized.includes(secret), false)
  }
}

function assertNoSensitiveRequestKeys(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, child] of Object.entries(current)) {
      assert.doesNotMatch(key, /^(?:authorization|api[_-]?key|credential|headers?)$/i)
      pending.push(child)
    }
  }
}

async function assertPreAborted(operation, label) {
  const controller = new AbortController()
  const reason = new DOMException(`cancel ${label} before dispatch`, 'AbortError')
  controller.abort(reason)
  await assert.rejects(operation(controller.signal), error => error === reason)
}

function assertSourceOutcome(outcome, label) {
  assert.equal(outcome.state, 'complete', `${label} was unexpectedly unconfigured`)
  assert.ok(outcome.result.returnedSources > 0, `${label} returned no source`)
  assert.ok(outcome.result.returnedSources <= RESULT_LIMIT)
  for (const source of outcome.result.sources) {
    assertHttpUrl(source.url)
    assert.ok((source.title?.trim().length ?? 0) > 0 || (source.snippet?.trim().length ?? 0) > 0)
  }
  assertSecretFree(outcome)
}

function safeFailureKind(error) {
  if (
    error !== null
    && typeof error === 'object'
    && 'kind' in error
    && typeof error.kind === 'string'
    && knownFailureKinds.has(error.kind)
  ) return error.kind
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted'
  return 'unexpected'
}

const failures = []
async function runLane(label, skipReason, operation) {
  if (skipReason !== undefined) {
    process.stdout.write(`real Provider e2e: ${label}: skipped (${skipReason})\n`)
    return
  }
  try {
    await operation()
    process.stdout.write(`real Provider e2e: ${label}: ok\n`)
  } catch (error) {
    const kind = safeFailureKind(error)
    failures.push(label)
    process.stdout.write(`real Provider e2e: ${label}: failed (${kind})\n`)
  }
}

function searchApiSkipReason() {
  if (secrets.SEARCH_API_KEY === undefined) return 'SEARCH_API_KEY is absent'
  const missing = [
    ...(searchEndpoint === undefined ? ['SEARCH_API_E2E_URL'] : []),
    ...(searchModel === undefined ? ['SEARCH_MODEL'] : []),
  ]
  return missing.length === 0
    ? undefined
    : `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} absent`
}

async function runSearchApiProtocol(protocol) {
  assert.ok(searchEndpoint !== undefined)
  assert.ok(searchModel !== undefined)
  const config = e2eConfig({
    baseUrl: searchEndpoint,
    model: searchModel,
    protocol,
    thinkingLevel: 'off',
  })
  const provider = new SearchApiProvider({
    credentials,
    getConfig: () => config,
  })
  const cancelledSession = Session.create(SessionId(`real-${protocol}-cancelled`))
  await assertPreAborted(signal => {
    const input = {
      depth: 'compact',
      profile: 'fact_check',
      query: FIXED_QUERY,
      session: cancelledSession,
      signal,
    }
    return provider.search(input)
  }, `Search API ${protocol}`)
  assert.equal(cancelledSession.events.length, 0)

  const session = Session.create(SessionId(`real-${protocol}`))
  let dispatches = 0
  const input = {
    depth: 'compact',
    profile: 'fact_check',
    query: FIXED_QUERY,
    session,
    signal: new AbortController().signal,
    onDispatch: () => { dispatches += 1 },
  }
  const result = await provider.search(input)
  assert.equal(dispatches, 1)
  assert.equal(result.protocol, protocol)
  assert.ok(result.answer.trim().length > 0 || result.sources.length > 0)
  assertHttpUrl(result.endpoint)
  for (const source of result.sources) assertHttpUrl(source.url)
  assertSecretFree(result)
  assertNoSensitiveRequestKeys(result)
  assert.equal(session.events.length, 0)
  assert.equal(session.events.some(event => String(event.type).startsWith('search-enhance/')), false)
  assertSecretFree(session.events)
}

await runLane(
  'Search API completions',
  searchApiSkipReason(),
  () => runSearchApiProtocol('completions'),
)
await runLane(
  'Search API responses',
  searchApiSkipReason(),
  () => runSearchApiProtocol('responses'),
)

await runLane(
  'Context7 resolve + docs',
  secrets.CONTEXT7_API_KEY !== undefined || context7OptIn
    ? undefined
    : 'CONTEXT7_API_KEY is absent and CONTEXT7_E2E=1 was not set',
  async () => {
    const config = e2eConfig()
    const client = new Context7RemoteClient({ credentials })
    await assertPreAborted(signal => client.resolve({
      config,
      limit: RESULT_LIMIT,
      query: CONTEXT7_QUERY,
      signal,
    }), 'Context7 resolve')

    let resolveDispatches = 0
    const resolved = await client.resolve({
      config,
      limit: RESULT_LIMIT,
      query: CONTEXT7_QUERY,
      signal: new AbortController().signal,
      onDispatch: () => { resolveDispatches += 1 },
    })
    assert.equal(resolveDispatches, 1)
    assert.ok(resolved.libraries.length > 0, 'Context7 resolve returned no library')
    const selected = selectContext7Library(resolved.libraries, 'React', CONTEXT7_QUERY)
    assert.ok(selected?.id, 'Context7 resolve returned no valid library id')
    const libraryUrl = context7LibraryUrl(
      config.providers.context7.baseUrl,
      selected.id,
      config.webExtract.maxUrlCharacters,
    )
    assert.ok(libraryUrl)
    assertHttpUrl(libraryUrl)

    let docsDispatches = 0
    const docs = await client.docs({
      config,
      libraryId: selected.id,
      limit: RESULT_LIMIT,
      query: CONTEXT7_QUERY,
      signal: new AbortController().signal,
      onDispatch: () => { docsDispatches += 1 },
    })
    assert.equal(docsDispatches, 1)
    assert.ok(docs.snippets.some(snippet => snippet.content.trim().length > 0))
    assertSecretFree({ resolved, docs })
  },
)

async function runSourceProvider(label, provider, config) {
  await assertPreAborted(signal => provider.search({
    config,
    limit: RESULT_LIMIT,
    query: FIXED_QUERY,
    signal,
  }), label)
  let dispatches = 0
  const outcome = await provider.search({
    config,
    limit: RESULT_LIMIT,
    query: FIXED_QUERY,
    signal: new AbortController().signal,
    onDispatch: () => { dispatches += 1 },
  })
  assert.equal(dispatches, 1)
  assertSourceOutcome(outcome, label)
}

await runLane(
  'Exa Search',
  secrets.EXA_API_KEY === undefined ? 'EXA_API_KEY is absent' : undefined,
  () => {
    const config = e2eConfig()
    return runSourceProvider('Exa Search', new ExaProvider({ credentials }), config)
  },
)
await runLane(
  'Tavily Search',
  secrets.TAVILY_API_KEY === undefined ? 'TAVILY_API_KEY is absent' : undefined,
  () => {
    const config = e2eConfig()
    return runSourceProvider('Tavily Search', new TavilySearchProvider({ credentials }), config)
  },
)
await runLane(
  'Firecrawl Search',
  secrets.FIRECRAWL_API_KEY === undefined ? 'FIRECRAWL_API_KEY is absent' : undefined,
  () => {
    const config = e2eConfig()
    return runSourceProvider('Firecrawl Search', new FirecrawlSearchProvider({ credentials }), config)
  },
)

if (failures.length > 0) {
  process.stderr.write(`real Provider e2e failed lanes: ${failures.join(', ')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('real Provider e2e: all configured lanes completed; skipped lanes made no Provider request\n')
}

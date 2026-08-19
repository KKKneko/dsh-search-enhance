import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/docs-consumer.json')
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-docs-'))
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const context7Secret = 'docs-context7-secret-value'
const exaSecret = 'docs-exa-secret-value'
const candidateWindowQuery = 'React useEffect cleanup candidate-window documentation'
const candidateWindowMaxResults = 2
const candidateWindowTargetId = '/reactjs/react.dev'
const candidateWindowLibraries = [
  {
    benchmarkScore: 99,
    description: 'A collection of React hooks for browser behavior.',
    id: '/streamich/react-use',
    title: 'React Use',
    totalSnippets: 9000,
    trustScore: 10,
  },
  ...Array.from({ length: 8 }, (_value, index) => ({
    benchmarkScore: 95,
    description: 'Unrelated documentation candidate.',
    id: `/examples/library-${index}`,
    title: `Library ${index}`,
    totalSnippets: 8000,
    trustScore: 10,
  })),
  {
    benchmarkScore: 90,
    description: 'Official React documentation.',
    id: candidateWindowTargetId,
    title: 'React',
    totalSnippets: 7000,
    trustScore: 10,
  },
]
const globalDefinitions = [
  'docs_search',
  'web_extract',
  'search_tools',
  'search_call',
]
const modelTools = [...globalDefinitions].sort()
const credentialNames = [
  'SEARCH_API_KEY',
  'CONTEXT7_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
]
const previousEnvironment = new Map([
  ['DSH_HOME', process.env.DSH_HOME],
  ...credentialNames.map(name => [name, process.env[name]]),
])

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function normalize(value, origin) {
  const serialized = JSON.stringify(value)
    .replaceAll(origin, '<fixture-origin>')
    .replace(/src_[A-Za-z0-9_-]{32}/g, '<source-ref>')
    .replace(/ctx7d_[A-Za-z0-9_-]{43}/g, '<doc-ref>')
  return JSON.parse(serialized)
}

function normalizedToolResult(event, origin) {
  const block = event.data.message.content[0]
  assert.equal(block?.type, 'tool-result')
  return normalize({
    callId: String(block.toolCallId),
    isError: block.isError === true,
    content: block.content,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
  }, origin)
}

function routeRequestSnapshot(requests, origin) {
  return normalize(requests.map(item => ({
    method: item.method,
    url: item.url,
    authorization: item.authorization === undefined ? undefined : '<redacted>',
    exaKey: item.exaKey === undefined ? undefined : '<redacted>',
    ...(item.body === undefined ? {} : { body: item.body }),
  })), origin)
}

function queryForRequest(rawUrl, body) {
  const url = new URL(rawUrl, 'http://fixture.invalid')
  if (url.pathname.endsWith('/api/v2/libs/search')) return url.searchParams.get('query') ?? ''
  if (url.pathname.endsWith('/api/v2/context')) return url.searchParams.get('query') ?? ''
  if (url.pathname.endsWith('/search')) return body?.query ?? ''
  return ''
}

function libraryNameForRequest(rawUrl) {
  const url = new URL(rawUrl, 'http://fixture.invalid')
  return url.pathname.endsWith('/api/v2/libs/search')
    ? url.searchParams.get('libraryName') ?? ''
    : ''
}

async function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

function normalizedCanonical(value, origin) {
  return normalize(value, origin)
}

function stableContext7Snapshot(value) {
  if (typeof value === 'string') {
    return value.replace(
      /("(?:created_at_ms|expires_at_ms|duration_ms)"\s*:\s*)\d+/g,
      '$1<time>',
    )
  }
  if (Array.isArray(value)) return value.map(stableContext7Snapshot)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    ['created_at_ms', 'expires_at_ms', 'duration_ms'].includes(key)
      ? '<time>'
      : stableContext7Snapshot(item),
  ]))
}

const httpRequests = []
let context7Offline = false
const server = createServer(async (request, response) => {
  try {
    const bodyText = await requestBody(request)
    const body = bodyText.length === 0 ? undefined : JSON.parse(bodyText)
    const item = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      exaKey: request.headers['x-api-key'],
      body,
    }
    httpRequests.push(item)
    const parsed = new URL(request.url ?? '/', origin)
    const query = queryForRequest(request.url ?? '/', body)
    const libraryName = libraryNameForRequest(request.url ?? '/')

    if (parsed.pathname === '/context7/api/v2/libs/search' && request.method === 'GET') {
      if (libraryName.length === 0) {
        json(response, 400, { error: 'missing explicit libraryName' })
        return
      }
      if (context7Offline || query.includes('partial-route')) {
        json(response, 503, { error: 'deterministic Context7 resolve outage' })
        return
      }
      json(response, 200, {
        results: query === candidateWindowQuery
          ? candidateWindowLibraries
          : [{
              benchmarkScore: 91,
              description: 'Official Acme SDK documentation',
              id: '/acme/sdk',
              title: 'Acme SDK',
              totalSnippets: 500,
              trustScore: 10,
            }],
      })
      return
    }
    if (parsed.pathname === '/context7/api/v2/context' && request.method === 'GET') {
      if (context7Offline || query.includes('partial-route')) {
        json(response, 503, { error: 'deterministic Context7 docs outage' })
        return
      }
      json(response, 200, {
        codeSnippets: query === candidateWindowQuery
          ? Array.from({ length: 4 }, (_value, index) => ({
              content: `React useEffect cleanup snippet ${index + 1}.`,
              title: `React snippet ${index + 1}`,
            }))
          : [
              { content: 'Initialize the SDK with createClient and dispose it during cleanup.', title: 'Lifecycle' },
              { content: 'Use the v4 migration helper before replacing legacy adapters.', title: 'Migration' },
            ],
      })
      return
    }
    if (parsed.pathname === '/exa/search' && request.method === 'POST') {
      json(response, 200, {
        results: [
          {
            highlights: ['Official Acme SDK discovery summary.'],
            publishedDate: '2026-08-01',
            title: 'Acme SDK documentation',
            url: 'https://docs.acme.test/sdk',
          },
          {
            highlights: ['Acme SDK release and source repository.'],
            title: 'Acme SDK repository',
            url: 'https://github.com/acme/sdk',
          },
        ],
      })
      return
    }
    json(response, 404, { error: 'not found' })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
const origin = `http://127.0.0.1:${address.port}`

process.env.DSH_HOME = dshHome
process.env.CONTEXT7_API_KEY = context7Secret
process.env.EXA_API_KEY = exaSecret
for (const name of ['SEARCH_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY']) delete process.env[name]

let ctx
let disposed = false
let createdSelfLink = false
const handles = []

try {
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }

  await writeFile(loaderConfig, `
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: ${JSON.stringify(join(dshHome, 'search-enhance-storage'))}
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
  config:
    computeMs: 10000
    maxWallMs: 30000
    maxOutputBytes: 1048576
    maxOldGenerationSizeMb: 128
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: agents
  name: '@deepseek-ai/dsh-agent'
- id: scripted-llm
  name: ${JSON.stringify(fixturePath)}
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []
- id: settings
  name: '@deepseek-ai/dsh-settings-file'
  config:
    watch: false
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  config:
    watch: false
- id: search-enhance
  name: dsh-search-enhance
  config:
    toolDiscovery:
      mode: all
    fallbackMode: auto
    providers:
      context7:
        baseUrl: ${JSON.stringify(`${origin}/context7`)}
        timeoutMs: 10000
      exa:
        baseUrl: ${JSON.stringify(`${origin}/exa`)}
        timeoutMs: 10000
    retry:
      maxAttempts: 1
      baseDelayMs: 0
      multiplier: 1
      maxDelayMs: 0
      maxTotalDelayMs: 0
      jitterRatio: 0
    cache:
      context7ResolveTtlHours: 1
      context7DocsTtlHours: 1
    retention:
      docsSearchMaxResults: 20
      sourceStoreMaxRecords: 100
      searchSourcesMaxPageSize: 20
      searchSourcesPageMaxBytes: 32768
      searchSourcesSnippetMaxCharacters: 500
`, 'utf8')

  const [{ boot }, scriptedModule, documentationModule, sourceStorageModule] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(fixturePath).href),
    import('dsh-search-enhance/documentation'),
    import('dsh-search-enhance/source-storage'),
  ])
  const code = [
    "const docs = await tools.docs_search({ query: 'canonical equality docs', provider: 'exa', max_results: 2 });",
    "if (!docs.source_ref) throw new Error('missing docs source_ref');",
    "const page = await tools.search_call({ operation: 'search_sources', arguments: { source_ref: docs.source_ref, offset: 0, limit: 1, format: 'full' } });",
    'return { docs, page };',
  ].join('\n')
  scriptedModule.setScript([
    {
      kind: 'tool',
      id: 'native-docs-call',
      name: 'docs_search',
      arguments: { query: 'canonical equality docs', provider: 'exa', max_results: 2 },
    },
    { kind: 'text', text: 'Native documentation fixture complete.' },
    {
      kind: 'tool',
      id: 'code-docs-call',
      name: 'run_code',
      arguments: { code, description: 'Search documentation and page its source immediately' },
    },
    { kind: 'text', text: 'Code documentation fixture complete.' },
  ])

  ctx = await boot(
    'dsh-search-enhance-docs-consumer',
    loaderConfig,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
  assert.ok(pluginEntry?.fiber, 'Loader did not create the search-enhance fiber')
  await pluginEntry.fiber.await()
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), globalDefinitions)
  for (const name of [
    'context7_resolve_library_id',
    'context7_query_docs',
    'context7_get_library_docs',
    'context7_get_cached_doc_raw',
    'search_sources',
    'web_map',
    'research_plan',
    'search_diagnostics',
  ]) {
    assert.equal(ctx.tools.get(name), undefined)
  }
  assert.equal(ctx.tools.get('web_search'), undefined)
  assert.equal(ctx.tools.get('web_fetch'), undefined)

  const sourceStorageFile = join(
    dshHome,
    'search-enhance-storage',
    `${sourceStorageModule.SOURCE_RECORD_DOMAIN_NAME}.json`,
  )
  const cacheStorageFile = join(
    dshHome,
    'search-enhance-storage',
    `${documentationModule.CONTEXT7_CACHE_DOMAIN_NAME}.json`,
  )
  const observed = []
  const durabilityChecks = []
  ctx.on('tools/result', (exec, result) => {
    if (!['docs_search', 'search_call', 'run_code'].includes(exec.name)) return
    const definition = ctx.tools.get(exec.name, exec.agent)
    const card = definition?.presentResult?.(exec.arguments, {
      content: result.content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    observed.push({
      agentId: String(exec.agent?.id ?? ''),
      callId: String(exec.callId),
      name: exec.name,
      nested: exec.parent !== undefined,
      result,
      ...(card === undefined ? {} : { card: structuredClone(card) }),
    })
    if (
      !result.isError
      && result.value !== null
      && typeof result.value === 'object'
      && !Array.isArray(result.value)
      && typeof result.value.source_ref === 'string'
    ) {
      const sourceRef = result.value.source_ref
      durabilityChecks.push(readFile(sourceStorageFile, 'utf8').then(text => {
        assert.match(text, new RegExp(sourceRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      }))
    }
  })

  async function createAgent(id, setup) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
      ...(setup === undefined ? {} : { setup }),
    })
    handles.push(handle)
    return handle.agent
  }

  const nativeAgent = await createAgent('docs-native-session')
  await followup(nativeAgent, 'Run the native documentation fixture.')
  const codeAgent = await createAgent(
    'docs-code-session',
    agentCtx => { agentCtx.tools.presentAs('code') },
  )
  await followup(codeAgent, 'Run the Code Mode documentation fixture.')
  assert.equal(scriptedModule.remainingResponses(), 0)

  const findObserved = (predicate, label) => {
    const item = observed.find(predicate)
    assert.ok(item, `missing observed result: ${label}`)
    return item
  }
  const nativeDocs = findObserved(
    item => item.callId === 'native-docs-call' && item.name === 'docs_search',
    'native docs',
  )
  const codeDocs = findObserved(
    item => item.agentId === 'docs-code-session' && item.name === 'docs_search' && item.nested,
    'nested code docs',
  )
  const codePage = findObserved(
    item => item.agentId === 'docs-code-session' && item.name === 'search_call' && item.nested,
    'nested code page',
  )
  assert.equal(nativeDocs.result.isError, false)
  assert.equal(codeDocs.result.isError, false)
  assert.equal(codePage.result.isError, false)
  assert.equal(nativeDocs.result.meta?.type, 'docs_search')
  assert.equal(codeDocs.result.meta, undefined)
  assert.equal(codePage.result.meta, undefined)
  const nativeDocsText = nativeDocs.result.content[0]?.type === 'text'
    ? nativeDocs.result.content[0].text
    : ''
  assert.match(nativeDocsText, /Source reference: src_[A-Za-z0-9_-]{32}/)
  assert.match(nativeDocsText, /"operation":"search_sources"/)
  assert.doesNotMatch(nativeDocsText, /"output_schema"/)
  assert.ok(Buffer.byteLength(nativeDocsText, 'utf8') <= nativeDocs.result.value.model_text_max_bytes)
  assert.deepEqual(
    normalizedCanonical(nativeDocs.result.value, origin),
    normalizedCanonical(codeDocs.result.value, origin),
    'Native and Code docs_search canonical values drifted',
  )
  assert.equal(codePage.result.value.source_ref, codeDocs.result.value.source_ref)
  assert.equal(codePage.result.value.state, 'found')

  const nativeCallEvent = nativeAgent.session.events.find(event => (
    event.type === 'tool/call' && String(event.data.callId) === 'native-docs-call'
  ))
  const nativeResultEvent = nativeAgent.session.events.find(event => (
    event.type === 'tool/result'
    && String(event.data.message.content[0]?.toolCallId) === 'native-docs-call'
  ))
  assert.ok(nativeCallEvent && nativeCallEvent.type === 'tool/call')
  assert.ok(nativeResultEvent && nativeResultEvent.type === 'tool/result')
  const docsDefinition = ctx.tools.get('docs_search', nativeAgent)
  assert.ok(docsDefinition?.presentResult)
  const nativeResultBlock = nativeResultEvent.data.message.content[0]
  assert.equal(nativeResultBlock?.type, 'tool-result')
  const replayCard = docsDefinition.presentResult(
    JSON.parse(nativeCallEvent.data.arguments),
    {
      content: nativeResultBlock.content,
      isError: nativeResultBlock.isError === true,
      ...(nativeResultEvent.data.meta === undefined ? {} : { meta: nativeResultEvent.data.meta }),
    },
  )
  assert.deepEqual(replayCard, nativeDocs.card)
  assert.equal(replayCard?.card, 'web')

  let directCounter = 0
  async function executeDocs(argumentsValue, expectedError = false) {
    directCounter += 1
    const result = await ctx.tools.execute({
      callId: CallId(`direct-docs-${directCounter}`),
      name: 'docs_search',
      arguments: argumentsValue,
      agent: nativeAgent,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, expectedError, `docs_search error state: ${JSON.stringify(result.content)}`)
    return result
  }
  async function executeSources(argumentsValue) {
    directCounter += 1
    const gatewayArgs = { operation: 'search_sources', arguments: argumentsValue }
    const result = await ctx.tools.execute({
      callId: CallId(`direct-sources-${directCounter}`),
      name: 'search_call',
      arguments: gatewayArgs,
      agent: nativeAgent,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
    return result
  }
  async function executeGranular(name, argumentsValue) {
    directCounter += 1
    const gatewayArgs = { operation: name, arguments: argumentsValue }
    const result = await ctx.tools.execute({
      callId: CallId(`direct-context7-${directCounter}`),
      name: 'search_call',
      arguments: gatewayArgs,
      agent: nativeAgent,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`)
    const definition = ctx.tools.get('search_call', nativeAgent)
    const card = definition?.presentResult?.(gatewayArgs, {
      content: result.content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    return { card, result }
  }

  const knownArgs = {
    query: 'known library cache route',
    provider: 'context7',
    library_id: '/acme/sdk',
    max_results: 2,
  }
  const knownMiss = await executeDocs(knownArgs)
  const knownMissObserved = observed.at(-1)
  assert.equal(knownMissObserved?.name, 'docs_search')
  const knownHit = await executeDocs(knownArgs)
  const knownRefresh = await executeDocs({ ...knownArgs, force_refresh: true })
  assert.deepEqual(
    [knownMiss.value.cache.docs.state, knownHit.value.cache.docs.state, knownRefresh.value.cache.docs.state],
    ['miss', 'hit', 'refresh'],
  )
  assert.ok([knownMiss, knownHit, knownRefresh].every(result => (
    result.value.cache.resolve.state === 'skipped'
    && result.value.cache.resolve.reason === 'known_library_id'
  )))
  assert.equal(knownMiss.value.doc_ref, knownHit.value.doc_ref)
  assert.equal(knownMiss.value.doc_ref, knownRefresh.value.doc_ref)
  const candidateWindowTargetIndex = candidateWindowLibraries.findIndex(
    library => library.id === candidateWindowTargetId,
  )
  assert.ok(candidateWindowLibraries.length >= 10)
  assert.ok(candidateWindowTargetIndex >= candidateWindowMaxResults)
  const candidateWindow = await executeDocs({
    query: candidateWindowQuery,
    library_name: 'React',
    provider: 'context7',
    max_results: candidateWindowMaxResults,
  })
  const candidateWindowObserved = observed.at(-1)
  assert.equal(candidateWindowObserved?.name, 'docs_search')
  assert.equal(candidateWindow.value.selected_library?.id, candidateWindowTargetId)
  assert.equal('candidates' in candidateWindow.value, false)
  assert.ok(candidateWindow.value.snippets.length <= candidateWindowMaxResults)
  assert.ok(candidateWindow.value.returned_snippets <= candidateWindowMaxResults)
  assert.equal(candidateWindow.value.returned_snippets, candidateWindow.value.snippets.length)
  assert.equal(candidateWindow.value.truncated, true)

  const allRoute = await executeDocs({
    query: 'all provider route',
    library_name: 'Acme SDK',
    provider: 'all',
    max_results: 2,
  })
  const autoRoute = await executeDocs({
    query: 'auto provider route',
    library_name: 'Acme SDK',
    provider: 'auto',
    max_results: 2,
  })
  const partialRoute = await executeDocs({
    query: 'partial-route documentation',
    library_name: 'Acme SDK',
    provider: 'all',
    max_results: 2,
  })
  const partialObserved = observed.at(-1)
  assert.equal(partialObserved?.name, 'docs_search')
  const autoDiscoveryStart = httpRequests.length
  const autoWithoutIdentity = await executeDocs({
    query: 'auto Exa-only discovery route',
    provider: 'auto',
    max_results: 2,
  })
  const autoDiscoveryRequests = httpRequests.slice(autoDiscoveryStart)
  assert.deepEqual(autoWithoutIdentity.value.providers, [
    { provider: 'context7', state: 'skipped' },
    { provider: 'exa', state: 'complete' },
  ])
  assert.equal(autoDiscoveryRequests.filter(item => item.url?.startsWith('/context7/')).length, 0)
  assert.equal(autoDiscoveryRequests.filter(item => item.url === '/exa/search').length, 1)

  const missingIdentityStart = httpRequests.length
  const context7WithoutIdentity = await executeDocs({
    query: 'missing Context7 identity route',
    provider: 'context7',
    max_results: 2,
  }, true)
  const allWithoutIdentity = await executeDocs({
    query: 'missing all identity route',
    provider: 'all',
    max_results: 2,
  }, true)
  assert.equal(httpRequests.length, missingIdentityStart)
  assert.equal(context7WithoutIdentity.error?.message, 'context7-library-name-or-id-required: request was rejected before dispatch')
  assert.deepEqual(context7WithoutIdentity.content, [{
    type: 'text',
    text: 'Error: context7-library-name-or-id-required: request was rejected before dispatch',
  }])
  assert.equal(allWithoutIdentity.error?.message, 'context7-library-name-or-id-required: request was rejected before dispatch')
  assert.deepEqual(allWithoutIdentity.content, [{
    type: 'text',
    text: 'Error: context7-library-name-or-id-required: request was rejected before dispatch',
  }])

  assert.deepEqual(allRoute.value.providers, [
    { provider: 'context7', state: 'complete' },
    { provider: 'exa', state: 'complete' },
  ])
  assert.deepEqual(autoRoute.value.providers, allRoute.value.providers)
  assert.equal(partialRoute.value.state, 'partial')
  assert.deepEqual(partialRoute.value.providers, [
    { provider: 'context7', state: 'failed' },
    { provider: 'exa', state: 'complete' },
  ])
  assert.ok(partialRoute.value.warnings.some(warning => (
    warning.code === 'provider_failed'
    && warning.provider === 'context7'
  )))

  const restartArgs = {
    query: 'restart durable cache route',
    library_name: 'Acme SDK',
    provider: 'context7',
    max_results: 2,
  }
  const restartMiss = await executeDocs(restartArgs)
  assert.deepEqual(
    { resolve: restartMiss.value.cache.resolve.state, docs: restartMiss.value.cache.docs.state },
    { resolve: 'miss', docs: 'miss' },
  )
  const preRestartRequestCount = httpRequests.filter(item => (
    queryForRequest(item.url ?? '/', item.body) === restartArgs.query
  )).length

  const firstPage = await executeSources({
    source_ref: nativeDocs.result.value.source_ref,
    offset: 0,
    limit: 1,
    format: 'full',
  })
  const secondPage = await executeSources({
    source_ref: nativeDocs.result.value.source_ref,
    offset: 1,
    limit: 1,
    format: 'compact',
  })
  const notFound = await executeSources({
    source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  assert.equal(firstPage.value.state, 'found')
  assert.equal(firstPage.value.returned, 1)
  assert.equal(firstPage.value.next_offset, 1)
  assert.equal(secondPage.value.state, 'found')
  assert.equal(notFound.value.state, 'not_found')

  await Promise.all(durabilityChecks)
  const sourceDocumentBeforeRestart = JSON.parse(await readFile(sourceStorageFile, 'utf8'))
  const nativeRecord = sourceDocumentBeforeRestart.tables.records[nativeDocs.result.value.source_ref]
  const codeRecord = sourceDocumentBeforeRestart.tables.records[codeDocs.result.value.source_ref]
  assert.equal(nativeRecord.call.mode, 'top-level')
  assert.equal(nativeRecord.call.name, 'docs_search')
  assert.equal(codeRecord.call.mode, 'nested-code')
  assert.equal(codeRecord.call.name, 'docs_search')
  assert.equal(nativeRecord.profile, 'coding_docs')
  assert.equal(nativeRecord.depth, 'compact')
  assert.deepEqual(
    firstPage.value.sources.map(source => source.url),
    nativeRecord.sources.slice(0, 1).map(source => source.url),
  )
  assert.deepEqual(
    secondPage.value.sources.map(source => source.url),
    nativeRecord.sources.slice(1, 2).map(source => source.url),
  )

  const oldDocumentation = ctx.searchEnhanceDocumentation
  const oldSources = ctx.searchEnhanceSources
  await pluginEntry.fiber.restart()
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), globalDefinitions)
  assert.notEqual(ctx.searchEnhanceDocumentation, oldDocumentation)
  assert.notEqual(ctx.searchEnhanceSources, oldSources)
  assert.equal(ctx.storageDomain.get(documentationModule.CONTEXT7_CACHE_DOMAIN_NAME), undefined)
  await assert.rejects(
    oldDocumentation.search({
      libraryName: 'Acme SDK',
      maxResults: 1,
      provider: 'context7',
      query: 'old service is closed',
      signal: new AbortController().signal,
    }),
    error => error?.name === 'AbortError',
  )

  const restartHit = await executeDocs(restartArgs)
  assert.deepEqual(
    { resolve: restartHit.value.cache.resolve.state, docs: restartHit.value.cache.docs.state },
    { resolve: 'hit', docs: 'hit' },
  )
  assert.equal(restartHit.value.doc_ref, restartMiss.value.doc_ref)
  assert.equal(httpRequests.filter(item => (
    queryForRequest(item.url ?? '/', item.body) === restartArgs.query
  )).length, preRestartRequestCount)
  const postRestartPage = await executeSources({
    source_ref: nativeDocs.result.value.source_ref,
    offset: 0,
    limit: 1,
    format: 'compact',
  })
  assert.equal(postRestartPage.value.state, 'found')

  await pluginEntry.fiber.restart()
  assert.equal(ctx.storageDomain.get(documentationModule.CONTEXT7_CACHE_DOMAIN_NAME), undefined)
  const cacheDocument = JSON.parse(await readFile(cacheStorageFile, 'utf8'))
  for (const entry of Object.values(cacheDocument.tables.entries)) {
    entry.createdAtMs = 0
    entry.expiresAtMs = 1
  }
  await writeFile(cacheStorageFile, `${JSON.stringify(cacheDocument, null, 2)}\n`, 'utf8')
  context7Offline = true
  const stale = await executeDocs(restartArgs)
  context7Offline = false
  assert.equal(stale.value.state, 'partial')
  assert.deepEqual(
    { resolve: stale.value.cache.resolve.state, docs: stale.value.cache.docs.state },
    { resolve: 'stale', docs: 'stale' },
  )
  assert.equal(stale.value.doc_ref, restartMiss.value.doc_ref)
  assert.equal(stale.value.warnings.filter(warning => warning.code === 'cache_stale').length, 2)
  assert.match(stale.content[0]?.type === 'text' ? stale.content[0].text : '', /Expired Context7 cache data was used/)
  const staleObserved = findObserved(
    item => item.callId === `direct-docs-${directCounter}` && item.name === 'docs_search',
    'stale docs card',
  )
  assert.equal(staleObserved.card?.card, 'web')
  assert.match(staleObserved.card?.title ?? '', /stale cache/)

  const codeDispatches = codeAgent.session.events.filter(event => event.type === 'tool/code-dispatch')
  assert.deepEqual(codeDispatches.map(event => event.data.name), ['docs_search', 'search_call'])
  assert.ok(codeDispatches.every(event => !('meta' in event.data)))

  const requests = scriptedModule.requests()
  assert.equal(requests.length, 4)
  const nativeSchema = requests[0].tools
  assert.deepEqual(nativeSchema.map(schema => schema.name), modelTools)
  const docsSchema = nativeSchema.find(schema => schema.name === 'docs_search')
  assert.equal(docsSchema?.parameters.properties.library_name.type, 'string')
  assert.equal(docsSchema?.parameters.required.includes('library_name'), false)
  assert.deepEqual(requests[2].tools.map(schema => schema.name), ['run_code'])
  assert.match(requests[2].system, /docs_search:/)
  assert.match(requests[2].system, /library_name\?: string/)
  assert.match(requests[2].system, /library_name: "FastAPI"/)
  assert.match(requests[2].system, /uses Exa instead of guessing a Context7 library/)
  assert.match(requests[2].system, /search_call:/)
  assert.match(requests[2].system, /search_tools:/)
  assert.match(requests[2].system, /web_extract:/)
  for (const operation of [
    'research_plan',
    'search_diagnostics',
    'search_sources',
    'web_map',
    'context7_resolve_library_id',
    'context7_query_docs',
    'context7_get_library_docs',
    'context7_get_cached_doc_raw',
  ]) {
    assert.doesNotMatch(requests[2].system, new RegExp(`\\n\\s+${operation}: \\{`, 'u'))
  }

  const context7Requests = httpRequests.filter(item => item.url?.startsWith('/context7/'))
  const exaRequests = httpRequests.filter(item => item.url === '/exa/search')
  assert.ok(context7Requests.length > 0)
  assert.ok(exaRequests.length > 0)
  assert.ok(context7Requests.every(item => item.authorization === `Bearer ${context7Secret}`))
  assert.ok(exaRequests.every(item => item.exaKey === exaSecret))
  const knownResolveRequests = context7Requests.filter(item => (
    item.url?.includes('/api/v2/libs/search')
    && queryForRequest(item.url, item.body) === knownArgs.query
  ))
  const knownDocsRequests = context7Requests.filter(item => (
    item.url?.includes('/api/v2/context')
    && queryForRequest(item.url, item.body) === knownArgs.query
  ))
  assert.equal(knownResolveRequests.length, 0)
  assert.equal(knownDocsRequests.length, 2, 'known-id miss/hit/refresh dispatched the wrong number of docs requests')
  const candidateResolveRequests = context7Requests.filter(item => (
    item.url?.includes('/api/v2/libs/search')
    && queryForRequest(item.url, item.body) === candidateWindowQuery
  ))
  const candidateDocsRequests = context7Requests.filter(item => (
    item.url?.includes('/api/v2/context')
    && queryForRequest(item.url, item.body) === candidateWindowQuery
  ))
  assert.equal(candidateResolveRequests.length, 1)
  assert.equal(libraryNameForRequest(candidateResolveRequests[0].url), 'React')
  assert.equal(queryForRequest(candidateResolveRequests[0].url), candidateWindowQuery)
  assert.equal(candidateDocsRequests.length, 1)
  const candidateDocsLibraryId = new URL(candidateDocsRequests[0].url, origin)
    .searchParams.get('libraryId')
  assert.equal(candidateDocsLibraryId, candidateWindowTargetId)

  const granularResolve = await executeGranular('context7_resolve_library_id', {
    library_name: 'Acme SDK',
    query: 'granular snapshot resolution',
    max_results: 2,
  })
  const granularQuery = await executeGranular('context7_query_docs', {
    library_id: '/acme/sdk',
    query: 'granular snapshot docs',
    max_snippets: 2,
  })
  const granularGet = await executeGranular('context7_get_library_docs', {
    library_name: 'Acme SDK',
    query: 'granular combined snapshot docs',
    max_results: 2,
    max_snippets: 2,
    raw: true,
  })
  const granularCached = await executeGranular('context7_get_cached_doc_raw', {
    doc_ref: granularQuery.result.value.doc_ref,
  })
  const granularResults = {
    resolve: granularResolve,
    query: granularQuery,
    get: granularGet,
    cached: granularCached,
  }
  assert.equal(granularResolve.result.value.selected_library.id, '/acme/sdk')
  assert.ok(granularResolve.result.value.candidates.length <= candidateWindowMaxResults)
  assert.ok(granularResolve.result.value.returned_candidates <= candidateWindowMaxResults)
  assert.equal(granularQuery.result.value.doc_ref, granularCached.result.value.doc_ref)
  assert.equal(granularGet.result.value.cache.resolve.state, 'miss')
  assert.ok(Object.values(granularResults).every(item => item.card?.card === 'generic'))

  const persistedText = `${await readFile(sourceStorageFile, 'utf8')}\n${await readFile(cacheStorageFile, 'utf8')}`
  const sessionAndOutputText = JSON.stringify({
    nativeEvents: nativeAgent.session.events,
    codeEvents: codeAgent.session.events,
    outputs: [...observed.map(item => item.result), ...Object.values(granularResults).map(item => item.result)],
  })
  for (const secret of [context7Secret, exaSecret]) {
    assert.equal(persistedText.includes(secret), false)
    assert.equal(sessionAndOutputText.includes(secret), false)
  }
  assert.doesNotMatch(persistedText, /Authorization|x-api-key/i)
  assert.doesNotMatch(sessionAndOutputText, /Authorization|x-api-key/i)
  assert.doesNotMatch(JSON.stringify(stale.value), /attempts|credential|endpoint|providerResponseBytes/)

  const snapshot = normalize({
    native_schema: nativeSchema,
    native_result: normalizedToolResult(nativeResultEvent, origin),
    native_card: {
      live: nativeDocs.card,
      replay: replayCard,
      metadata: nativeResultEvent.data.meta,
    },
    native_status_views: {
      context7_miss: {
        content: knownMiss.content,
        metadata: knownMiss.meta,
        card: knownMissObserved?.card,
      },
      provider_partial: {
        content: partialRoute.content,
        metadata: partialRoute.meta,
        card: partialObserved?.card,
      },
      stale_fallback: {
        content: stale.content,
        metadata: stale.meta,
        card: staleObserved.card,
      },
    },
    canonical_equality: {
      native: nativeDocs.result.value,
      code: codeDocs.result.value,
      code_page: codePage.result.value,
    },
    candidate_window: {
      fixture: {
        candidate_count: candidateWindowLibraries.length,
        target_index: candidateWindowTargetIndex,
        target_library_id: candidateWindowTargetId,
        user_max_results: candidateWindowMaxResults,
      },
      high_level_result: candidateWindow.value,
      high_level_card: candidateWindowObserved?.card,
      public_bounds: {
        high_level_candidates: Array.isArray(candidateWindow.value.candidates)
          ? candidateWindow.value.candidates.length
          : 0,
        high_level_snippets: candidateWindow.value.snippets.length,
        granular_candidates: granularResolve.result.value.candidates.length,
      },
      requests: {
        resolve: candidateResolveRequests.length,
        library_name: libraryNameForRequest(candidateResolveRequests[0].url),
        query: queryForRequest(candidateResolveRequests[0].url),
        docs: candidateDocsRequests.length,
        docs_library_id: candidateDocsLibraryId,
      },
      exact_library_id: {
        resolve_requests: knownResolveRequests.length,
        cache_reason: knownMiss.value.cache.resolve.reason,
      },
    },
    cache_states: {
      known_miss: knownMiss.value,
      known_hit: knownHit.value,
      known_refresh: knownRefresh.value,
      restart_miss: restartMiss.value,
      restart_hit: restartHit.value,
      stale: stale.value,
    },
    routes: {
      all: allRoute.value,
      auto: autoRoute.value,
      auto_without_identity: autoWithoutIdentity.value,
      context7_without_identity: {
        is_error: context7WithoutIdentity.isError,
        message: context7WithoutIdentity.error?.message,
        content: context7WithoutIdentity.content,
      },
      all_without_identity: {
        is_error: allWithoutIdentity.isError,
        message: allWithoutIdentity.error?.message,
        content: allWithoutIdentity.content,
      },
      partial: partialRoute.value,
    },
    granular_context7: stableContext7Snapshot(granularResults),
    source_pages: {
      first: firstPage.value,
      second: secondPage.value,
      not_found: notFound.value,
      post_restart: postRestartPage.value,
    },
    code_dispatches: codeDispatches.map(event => ({
      rootCallId: String(event.data.rootCallId),
      parentCallId: String(event.data.parentCallId),
      subCallId: String(event.data.subCallId),
      name: event.data.name,
      arguments: event.data.arguments,
      isError: event.data.isError,
      content: event.data.content,
    })),
    selected_records: {
      native: nativeRecord,
      code: codeRecord,
    },
    http_requests: routeRequestSnapshot(httpRequests, origin),
  }, origin)

  if (process.env.UPDATE_SEARCH_ENHANCE_SNAPSHOTS === '1') {
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } else {
    const expected = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert.deepEqual(snapshot, expected)
  }

  await pluginEntry.fiber.dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
  assert.equal(ctx.get(sourceStorageModule.SOURCE_RECORD_SERVICE_KEY), undefined)
  assert.equal(ctx.get(documentationModule.DOCUMENTATION_SEARCH_SERVICE_KEY), undefined)
  assert.equal(ctx.storageDomain.get(sourceStorageModule.SOURCE_RECORD_DOMAIN_NAME), undefined)
  assert.equal(ctx.storageDomain.get(documentationModule.CONTEXT7_CACHE_DOMAIN_NAME), undefined)

  for (const handle of handles.reverse()) await handle.dispose()
  handles.length = 0
  await ctx.fiber.dispose()
  disposed = true
  process.stdout.write('docs consumer snapshot: ok (high-level/granular Context7 Native output, Code parity, routes, cache stale/restart, durable sources, cards, secrecy)\n')
} finally {
  context7Offline = false
  for (const handle of handles.reverse()) {
    try {
      await handle.dispose()
    } catch {
      // Best effort after an earlier assertion; root disposal is the final owner.
    }
  }
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) await ctx.fiber.dispose()
  await new Promise(resolve => server.close(resolve))
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

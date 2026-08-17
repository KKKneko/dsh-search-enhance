import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CallId,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const webSearchFixturePath = join(packageRoot, 'tests/fixtures/web-search-stub.mjs')
const webFetchFixturePath = join(packageRoot, 'tests/fixtures/web-fetch-stub.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/headless-consumer.json')
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-headless-'))
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const searchSecret = 'headless-search-secret-value'
const context7Secret = 'headless-context7-secret-value'
const exaSecret = 'headless-exa-secret-value'
const tavilySecret = 'headless-tavily-secret-value'
const firecrawlSecret = 'headless-firecrawl-secret-value'
const secrets = [searchSecret, context7Secret, exaSecret, tavilySecret, firecrawlSecret]
const credentialNames = ['SEARCH_API_KEY', 'TAVILY_API_KEY', 'CONTEXT7_API_KEY', 'EXA_API_KEY', 'FIRECRAWL_API_KEY']
const sourceProducedBlockType = 'search-enhance/source-produced'
const fullResearchRouteGuidance = 'For current or external factual questions, start with one focused web_search (use docs_search for SDK/API documentation); do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
const discoveryEvidenceGuidance = 'Treat web_search/docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.'
const extractedEvidenceGuidance = 'Before asserting decisive factual or causal conclusions, inspect selected authoritative URLs with web_extract; never present an inferred mechanism as source-stated fact, and label unestablished mechanisms as inference or unconfirmed.'
const corePluginToolNames = [
  'web_search',
  'docs_search',
  'web_extract',
  'search_tools',
  'search_call',
]
const deferredOperationNames = [
  'search_sources',
  'web_map',
  'research_plan',
  'search_diagnostics',
  'context7_resolve_library_id',
  'context7_query_docs',
  'context7_get_library_docs',
  'context7_get_cached_doc_raw',
]
const pluginToolNames = corePluginToolNames
const globalPluginToolNames = pluginToolNames.filter(name => name !== 'web_search')
const officialToolNames = ['web_fetch', 'web_search']
const allGlobalToolNames = [...globalPluginToolNames, ...officialToolNames].sort()
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

function queryFromSearchBody(body) {
  const parsed = JSON.parse(body)
  const messages = parsed.messages
  const content = Array.isArray(messages) ? messages.at(-1)?.content : undefined
  if (typeof content !== 'string') throw new Error('fixture received no Search API query')
  return content
}

function normalize(value, origin) {
  const serialized = JSON.stringify(value)
    .replaceAll(origin, '<fixture-origin>')
    .replace(/src_[A-Za-z0-9_-]{32}/g, '<source-ref>')
    .replace(/"duration_ms":\d+/g, '"duration_ms":"<duration-ms>"')
  return JSON.parse(serialized)
}

const sha256 = value => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value))
  .digest('hex')

function requestSurface(request) {
  const tools = request.tools ?? []
  return {
    system_hash: sha256(request.system),
    wire_names: tools.map(schema => schema.name),
    wire_hash: sha256(tools),
    top_level_schema_hash: sha256(tools[0] ?? null),
  }
}

function activationSnapshot(value) {
  return {
    requested_groups: value.requested_groups,
    added_groups: value.added_groups,
    active_groups: value.active_groups,
    groups: value.groups.map(group => ({
      group: group.group,
      operations: group.operations.map(operation => operation.name),
      manifest_hash: sha256(group.operations),
    })),
    gateway: value.gateway,
    takes_effect: value.takes_effect,
  }
}

async function assembledSurface(ctx, agent) {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
  const sdkText = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  return {
    system_hash: sha256(renderPrompt(assembly)),
    wire_names: assembly.tools.map(schema => schema.name),
    wire_hash: sha256(assembly.tools),
    sdk_hash: sha256(sdkText),
    top_level_schema_hash: sha256(assembly.tools[0] ?? null),
  }
}

function normalizedToolResult(event, origin) {
  const block = event.data.message.content[0]
  assert.equal(block?.type, 'tool-result')
  return normalize({
    type: event.type,
    callId: String(block.toolCallId),
    isError: block.isError === true,
    content: block.content,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
  }, origin)
}

function relevantTranscript(session, origin, throughCallId) {
  const start = session.events.findIndex(event => (
    event.type === 'tool/call' && String(event.data.callId) === throughCallId
  ))
  const boundary = session.events.findIndex(event => (
    event.type === 'tool/result'
    && String(event.data.message.content[0]?.toolCallId) === throughCallId
  ))
  assert.notEqual(start, -1, `missing transcript start for ${throughCallId}`)
  assert.ok(boundary >= start, `missing transcript boundary for ${throughCallId}`)
  return session.events.slice(start, boundary + 1).flatMap(event => {
    if (event.type === 'tool/call') {
      return [{
        type: event.type,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: JSON.parse(event.data.arguments),
      }]
    }
    if (event.type === 'tool/result') return [normalizedToolResult(event, origin)]
    return []
  })
}

function snapshotHttpRequests(requests) {
  return requests.map(item => {
    let body = item.body
    if (item.url === '/search/v1/chat/completions') {
      body = {
        model: item.body.model,
        query: item.body.messages.at(-1).content,
        stream: item.body.stream,
      }
    }
    return {
      method: item.method,
      url: item.url,
      authorization: item.authorization === undefined ? undefined : '<redacted>',
      ...(body === undefined ? {} : { body }),
    }
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function responseScript() {
  const firstCode = [
    "const search = await tools.web_search({ query: 'code first-step fixture', profile: 'auto', depth: 'compact' });",
    "let early = 'not-attempted';",
    "try { await tools.search_call({ operation: 'search_sources', arguments: { source_ref: search.source_ref, offset: 0, limit: 1, format: 'full' } }); early = 'unexpected-success'; } catch { early = 'inactive'; }",
    "return { search, search_call_binding: typeof tools.search_call, early };",
  ].join('\n')
  const nextCode = [
    "const search = await tools.web_search({ query: 'code next-SDK fixture', profile: 'auto', depth: 'compact' });",
    "const page = await tools.search_call({ operation: 'search_sources', arguments: { source_ref: search.source_ref, offset: 0, limit: 1, format: 'full' } });",
    "return { search, page, search_call_binding: typeof tools.search_call };",
  ].join('\n')
  return [
    { kind: 'tool', id: 'native-full-call', name: 'web_search', arguments: { query: 'native full SDK v4 fixture', profile: 'auto', depth: 'compact' } },
    { kind: 'text', text: 'Native full fixture complete.' },
    { kind: 'tool', id: 'native-partial-call', name: 'web_search', arguments: { query: 'native partial fixture', profile: 'auto', depth: 'compact' } },
    { kind: 'text', text: 'Native partial fixture complete.' },
    { kind: 'tool', id: 'native-empty-call', name: 'web_search', arguments: { query: 'native empty fixture', profile: 'auto', depth: 'compact' } },
    { kind: 'text', text: 'Native empty fixture complete.' },
    { kind: 'tool', id: 'code-first-call', name: 'run_code', arguments: { code: firstCode, description: 'Search before the sources SDK binding is disclosed' } },
    { kind: 'tool', id: 'code-next-call', name: 'run_code', arguments: { code: nextCode, description: 'Use the sources binding from the next generated SDK' } },
    { kind: 'text', text: 'Code next-SDK fixture complete.' },
  ]
}

async function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

const httpRequests = []
const sockets = new Set()
let slowSearchRequests = 0
const server = createServer(async (request, response) => {
  try {
    const body = await requestBody(request)
    httpRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body.length === 0 ? undefined : JSON.parse(body),
    })

    if (request.url === '/search/v1/models' && request.method === 'GET') {
      json(response, 200, { data: [{ id: 'fixture-search-model' }] })
      return
    }
    if (request.url === '/search/v1/chat/completions' && request.method === 'POST') {
      const query = queryFromSearchBody(body)
      if (query.includes('cancel fixture')) {
        slowSearchRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.write('{"choices":[')
        return
      }
      if (query.includes('malformed fixture')) {
        json(response, 200, { choices: [] })
        return
      }
      if (query.includes('partial')) {
        json(response, 503, { error: 'fixture main failure' })
        return
      }
      if (query.includes('empty')) {
        json(response, 200, { choices: [{ message: { content: '' } }] })
        return
      }
      const content = query.includes('native full SDK v4 fixture')
        ? `Fixture answer for ${query}.\n\nsources(${JSON.stringify([
            {
              url: `${origin}/pages/sdk-v3/?utm_source=fixture`,
              title: 'Acme SDK v3 community guide',
              publishedAt: '2023-01-02',
            },
            {
              url: `${origin}/pages/sdk-v3`,
              title: 'Acme SDK v3 community guide',
              publishedAt: '2023-01-02',
            },
          ])})`
        : `Fixture answer for ${query}.\n\nSources:\n- [Primary fixture](${origin}/pages/primary)`
      json(response, 200, {
        choices: [{ message: { content } }],
      })
      return
    }
    if (request.url === '/tavily/search' && request.method === 'POST') {
      const query = JSON.parse(body).query
      if (query.includes('malformed fixture')) {
        json(response, 500, { error: 'malformed fixture discovery failed' })
        return
      }
      json(response, 200, {
        results: query.includes('empty')
          ? []
          : query.includes('native full SDK v4 fixture')
            ? [{
                url: 'https://github.com/acme/sdk/releases/tag/v4',
                title: 'Acme SDK v4 release',
                content: 'Current release discovery for the v4 fixture',
              }]
            : [{
                url: `${origin}/pages/tavily`,
                title: `Tavily ${query}`,
                content: `Supplemental discovery for ${query}`,
              }],
      })
      return
    }
    if (request.url === '/tavily/map' && request.method === 'POST') {
      const input = JSON.parse(body)
      json(response, 200, {
        base_url: input.url,
        results: [`${input.url.replace(/\/$/, '')}/docs`, `${input.url.replace(/\/$/, '')}/api`],
        response_time: 0.01,
      })
      return
    }
    if (request.url?.startsWith('/context7/api/v2/search?') && request.method === 'GET') {
      json(response, 200, {
        results: [{
          id: '/acme/sdk',
          title: 'Acme SDK',
          description: 'Fixture Context7 library',
          trustScore: 10,
        }],
      })
      return
    }
    if (request.url === '/exa/search' && request.method === 'POST') {
      const input = JSON.parse(body)
      json(response, 200, {
        results: [{
          url: `${origin}/pages/exa-docs`,
          title: 'Exa documentation fixture',
          highlights: [`Documentation for ${input.query}`],
        }],
      })
      return
    }
    if (request.url === '/firecrawl/search' && request.method === 'POST') {
      json(response, 200, {
        data: { web: [{
          url: `${origin}/pages/firecrawl`,
          title: 'Firecrawl fixture',
          description: 'Fixed diagnostics result',
        }] },
      })
      return
    }
    json(response, 404, { error: 'not found' })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})
server.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
const origin = `http://127.0.0.1:${address.port}`

process.env.DSH_HOME = dshHome
process.env.SEARCH_API_KEY = searchSecret
process.env.CONTEXT7_API_KEY = context7Secret
process.env.EXA_API_KEY = exaSecret
process.env.TAVILY_API_KEY = tavilySecret
process.env.FIRECRAWL_API_KEY = firecrawlSecret

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
- id: test-web-search
  name: ${JSON.stringify(webSearchFixturePath)}
- id: test-web-fetch
  name: ${JSON.stringify(webFetchFixturePath)}
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
      mode: progressive
    fallbackMode: off
    searchApi:
      baseUrl: ${JSON.stringify(`${origin}/search/v1`)}
      model: fixture-search-model
      timeoutMs: 10000
    providers:
      context7:
        baseUrl: ${JSON.stringify(`${origin}/context7`)}
        timeoutMs: 10000
      exa:
        baseUrl: ${JSON.stringify(`${origin}/exa`)}
        timeoutMs: 10000
      tavily:
        baseUrl: ${JSON.stringify(`${origin}/tavily`)}
        timeoutMs: 10000
      firecrawl:
        baseUrl: ${JSON.stringify(`${origin}/firecrawl`)}
        timeoutMs: 10000
    retry:
      maxAttempts: 1
      baseDelayMs: 0
      multiplier: 1
      maxDelayMs: 0
      maxTotalDelayMs: 0
      jitterRatio: 0
    extraDiscoverySources:
      auto: 1
    budgets:
      auto:
        compact:
          maxAnswerCharacters: 2000
          maxVisibleSources: 4
          maxModelTextBytes: 4096
    retention:
      sourceStoreMaxRecords: 6
      searchSourcesMaxPageSize: 20
      searchSourcesPageMaxBytes: 16384
      searchSourcesSnippetMaxCharacters: 200
`, 'utf8')

  const [
    { boot },
    scriptedModule,
    sourceStorageModule,
    webSearchModule,
    webFetchModule,
  ] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(fixturePath).href),
    import('dsh-search-enhance/source-storage'),
    import(pathToFileURL(webSearchFixturePath).href),
    import(pathToFileURL(webFetchFixturePath).href),
  ])
  webSearchModule.resetCalls()
  webFetchModule.resetCalls()
  const scriptedResponses = responseScript()
  scriptedModule.setScript(scriptedResponses.slice(0, 2))

  ctx = await boot(
    'dsh-search-enhance-headless-consumer',
    loaderConfig,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
  assert.ok(pluginEntry?.fiber, 'Loader did not create the search-enhance fiber')
  await pluginEntry.fiber.await()
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), allGlobalToolNames)
  const officialDefinitions = Object.fromEntries(
    officialToolNames.map(name => [name, ctx.tools.get(name)]),
  )
  assert.ok(officialDefinitions.web_search)
  assert.ok(officialDefinitions.web_fetch)

  const modelRequestAgents = []
  ctx.on('agent/request', async ({ agent }, next) => {
    modelRequestAgents.push(String(agent.id))
    return next()
  })
  const toolChanges = { count: 0 }
  ctx.on('tools/change', () => { toolChanges.count += 1 })
  const pluginNamesFor = agent => ctx.tools.schemas(agent)
    .map(schema => schema.name)
    .filter(name => pluginToolNames.includes(name))
  const requestsFor = agent => scriptedModule.requests().filter(
    (_request, index) => modelRequestAgents[index] === String(agent.id),
  )

  const storageFile = join(
    dshHome,
    'search-enhance-storage',
    `${sourceStorageModule.SOURCE_RECORD_DOMAIN_NAME}.json`,
  )
  const observedResults = []
  const observedCards = []
  const durabilityChecks = []
  ctx.on('tools/result', (exec, result) => {
    if (![
      'web_search',
      'docs_search',
      'search_call',
      'search_tools',
      'run_code',
    ].includes(exec.name)) return
    observedResults.push({
      agentId: String(exec.agent?.id ?? ''),
      callId: String(exec.callId),
      name: exec.name,
      nested: exec.parent !== undefined,
      result,
    })
    const definition = ctx.tools.get(exec.name, exec.agent)
    const card = definition?.presentResult?.(exec.arguments, {
      content: result.content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    if (card !== undefined) {
      observedCards.push({ callId: String(exec.callId), card: structuredClone(card) })
    }
    if (!result.isError && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)) {
      const sourceRef = result.value.source_ref
      if (typeof sourceRef === 'string') {
        durabilityChecks.push(readFile(storageFile, 'utf8').then(text => {
          assert.match(text, new RegExp(sourceRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        }))
      }
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

  const findResult = (callId, name) => {
    const observed = observedResults.find(item => item.callId === callId && (name === undefined || item.name === name))
    assert.ok(observed, `missing result ${callId}/${name ?? '*'}`)
    return observed
  }

  const waitFor = async (predicate, label, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const sorted = values => [...values].sort()
  const expectedCoreTools = sorted(corePluginToolNames)

  const nativeFull = await createAgent('native-full-session')
  assert.deepEqual(sorted(pluginNamesFor(nativeFull)), expectedCoreTools)
  assert.equal(ctx.tools.get('web_fetch', nativeFull), officialDefinitions.web_fetch)
  assert.notEqual(ctx.tools.get('web_search', nativeFull), officialDefinitions.web_search)
  assert.equal(ctx.tools.schemas(nativeFull).filter(schema => schema.name === 'web_search').length, 1)
  assert.deepEqual(
    Object.keys(ctx.tools.schemas(nativeFull)
      .find(schema => schema.name === 'web_search').parameters.properties),
    ['query', 'profile', 'depth'],
  )
  const initiallyHidden = await ctx.tools.execute({
    callId: CallId('initially-hidden-web-map'),
    name: 'web_map',
    arguments: { url: origin },
    agent: nativeFull,
    signal: new AbortController().signal,
  })
  assert.equal(initiallyHidden.error?.info?.code, 'UNKNOWN_TOOL')

  await followup(nativeFull, 'Run the full native search fixture.')
  const fullResult = findResult('native-full-call', 'web_search')
  assert.equal(fullResult.result.isError, false)
  assert.equal(webSearchModule.callCount(), 0, 'native web_search executed instead of the scoped rich definition')
  const fullSourceRef = fullResult.result.value.source_ref
  assert.equal(typeof fullSourceRef, 'string')
  assert.deepEqual(sorted(pluginNamesFor(nativeFull)), expectedCoreTools)
  const fullModelText = fullResult.result.content[0]?.type === 'text'
    ? fullResult.result.content[0].text
    : ''
  assert.match(fullModelText, /Source reference: src_[A-Za-z0-9_-]{32}/)
  assert.match(fullModelText, /"operation":"search_sources"/)
  assert.doesNotMatch(fullModelText, /"output_schema"/)
  assert.ok(Buffer.byteLength(fullModelText, 'utf8') <= fullResult.result.value.model_text_max_bytes)

  const codeActivateSiteMap = [
    "const activation = await tools.search_tools({ capabilities: ['site_map'] });",
    'const candidate = tools.search_call;',
    "let early = 'not-attempted';",
    "try { await candidate({ operation: 'web_map', arguments: { url: 'https://example.test' } }); early = 'unexpected-success'; } catch { early = 'inactive'; }",
    'return { activation, binding: typeof candidate, early };',
  ].join('\n')
  const codeUseSiteMap = [
    "const map = await tools.search_call({ operation: 'web_map', arguments: { url: 'https://example.test', instructions: 'only docs', max_depth: 1, max_breadth: 2, limit: 2 } });",
    'return { binding: typeof tools.search_call, map };',
  ].join('\n')
  const codeCancel = "return await tools.web_search({ query: 'code cancel fixture', profile: 'auto', depth: 'compact' });"

  scriptedModule.appendScript(
    {
      kind: 'tool',
      id: 'native-page-call',
      name: 'search_call',
      arguments: {
        operation: 'search_sources',
        arguments: { source_ref: fullSourceRef, offset: 0, limit: 1, format: 'full' },
      },
    },
    { kind: 'text', text: 'Native source page fixture complete.' },
    {
      kind: 'tool',
      id: 'native-not-found-call',
      name: 'search_call',
      arguments: {
        operation: 'search_sources',
        arguments: { source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      },
    },
    { kind: 'text', text: 'Native source not-found fixture complete.' },
    ...scriptedResponses.slice(2),
    { kind: 'text', text: 'Only web_search prompt fixture complete.' },
    { kind: 'text', text: 'No search tools prompt fixture complete.' },
    {
      kind: 'tools',
      calls: [
        { id: 'native-activate-batch', name: 'search_tools', arguments: { capabilities: ['site_map', 'planning', 'site_map'] } },
        {
          id: 'native-early-web-map',
          name: 'search_call',
          arguments: {
            operation: 'web_map',
            arguments: { url: 'https://example.test', max_depth: 1, max_breadth: 2, limit: 2 },
          },
        },
      ],
    },
    { kind: 'tool', id: 'native-repeat-activation', name: 'search_tools', arguments: { capabilities: ['site_map', 'context7'] } },
    {
      kind: 'tool',
      id: 'native-web-map',
      name: 'search_call',
      arguments: {
        operation: 'web_map',
        arguments: { url: 'https://example.test', instructions: 'only docs', max_depth: 1, max_breadth: 2, limit: 2 },
      },
    },
    { kind: 'text', text: 'Native progressive activation fixture complete.' },
    { kind: 'tool', id: 'preset-activation', name: 'search_tools', arguments: { capabilities: ['site_map'] } },
    { kind: 'text', text: 'Preset cap fixture complete.' },
    { kind: 'tool', id: 'docs-success', name: 'docs_search', arguments: { query: 'progressive Exa documentation fixture', provider: 'exa', max_results: 1 } },
    { kind: 'text', text: 'Documentation source fixture complete.' },
    { kind: 'tool', id: 'docs-failure', name: 'docs_search', arguments: { query: '', provider: 'exa', max_results: 1 } },
    { kind: 'text', text: 'Documentation failure fixture complete.' },
    { kind: 'tool', id: 'malformed-search', name: 'web_search', arguments: { query: 'malformed fixture', profile: 'auto', depth: 'compact' } },
    { kind: 'text', text: 'Malformed provider fixture complete.' },
    { kind: 'tool', id: 'diagnostics-activation', name: 'search_tools', arguments: { capabilities: ['diagnostics'] } },
    { kind: 'text', text: 'Diagnostics disclosure fixture complete.' },
    {
      kind: 'tool',
      id: 'diagnostics-test',
      name: 'search_call',
      arguments: { operation: 'search_diagnostics', arguments: { action: 'test' } },
    },
    { kind: 'text', text: 'Diagnostics probe fixture complete.' },
    { kind: 'tool', id: 'isolated-sources-activation', name: 'search_tools', arguments: { capabilities: ['sources'] } },
    {
      kind: 'tool',
      id: 'isolated-source-read',
      name: 'search_call',
      arguments: {
        operation: 'search_sources',
        arguments: { source_ref: fullSourceRef, offset: 0, limit: 1, format: 'compact' },
      },
    },
    { kind: 'text', text: 'Source isolation fixture complete.' },
    { kind: 'tool', id: 'code-activate-site-map', name: 'run_code', arguments: { code: codeActivateSiteMap, description: 'Activate a binding without mutating the current SDK' } },
    { kind: 'tool', id: 'code-use-site-map', name: 'run_code', arguments: { code: codeUseSiteMap, description: 'Use the regenerated site-map SDK binding' } },
    { kind: 'text', text: 'Code progressive activation fixture complete.' },
    { kind: 'tool', id: 'native-cancel-search', name: 'web_search', arguments: { query: 'native cancel fixture', profile: 'auto', depth: 'compact' } },
    { kind: 'tool', id: 'code-cancel-run', name: 'run_code', arguments: { code: codeCancel, description: 'Cancel a nested provider request' } },
    { kind: 'tool', id: 'reload-cancel-search', name: 'web_search', arguments: { query: 'reload cancel fixture', profile: 'auto', depth: 'compact' } },
  )
  await followup(nativeFull, 'Page the retained source with the structured reference.')
  await followup(nativeFull, 'Check a missing source reference.')

  const nativePartial = await createAgent('native-partial-session')
  await followup(nativePartial, 'Run the partial native search fixture.')
  const nativeEmpty = await createAgent('native-empty-session')
  await followup(nativeEmpty, 'Run the empty native search fixture.')
  const codeAgent = await createAgent(
    'code-session',
    agentCtx => { agentCtx.tools.presentAs('code') },
  )
  await followup(codeAgent, 'Verify that source auto-disclosure changes capability state without changing the Code SDK.')

  const onlySearchAgent = await createAgent(
    'only-search-session',
    agentCtx => { agentCtx.tools.restrict({ allow: ['web_search'] }) },
  )
  await followup(onlySearchAgent, 'Capture the prompt with only web_search visible.')
  const noSearchAgent = await createAgent(
    'no-search-session',
    agentCtx => { agentCtx.tools.restrict({ deny: allGlobalToolNames }) },
  )
  await followup(noSearchAgent, 'Capture the prompt with web_search hidden.')

  const hiddenWebSearchAgent = await createAgent(
    'hidden-web-search-session',
    agentCtx => { agentCtx.tools.restrict({ deny: pluginToolNames }) },
  )
  assert.deepEqual(
    ctx.tools.schemas(hiddenWebSearchAgent).map(schema => schema.name).sort(),
    ['web_fetch'],
  )
  assert.equal(ctx.tools.get('web_search', hiddenWebSearchAgent), undefined)
  const hiddenNativeSearch = await ctx.tools.execute({
    callId: CallId('hidden-native-web-search'),
    name: 'web_search',
    arguments: { query: 'must stay hidden' },
    agent: hiddenWebSearchAgent,
    signal: new AbortController().signal,
  })
  assert.equal(hiddenNativeSearch.error?.info?.code, 'UNKNOWN_TOOL')
  const independentFetch = await ctx.tools.execute({
    callId: CallId('independent-web-fetch'),
    name: 'web_fetch',
    arguments: { url: 'https://example.test/official-fetch' },
    agent: hiddenWebSearchAgent,
    signal: new AbortController().signal,
  })
  assert.equal(independentFetch.isError, false)
  assert.equal(webSearchModule.callCount(), 0)
  assert.equal(webFetchModule.callCount(), 1)

  const isolatedAgent = await createAgent('isolated-progressive-session')
  const progressiveAgent = await createAgent('native-progressive-session')
  assert.deepEqual(sorted(pluginNamesFor(isolatedAgent)), expectedCoreTools)
  await followup(progressiveAgent, 'Activate multiple groups and try a hidden same-batch tool.')
  const earlyMap = findResult('native-early-web-map', 'search_call')
  assert.equal(earlyMap.result.error?.info?.code, 'SEARCH_OPERATION_UNAVAILABLE')
  const firstActivation = findResult('native-activate-batch', 'search_tools')
  const repeatActivation = findResult('native-repeat-activation', 'search_tools')
  assert.deepEqual(firstActivation.result.value.requested_groups, ['site_map', 'planning'])
  assert.deepEqual(firstActivation.result.value.added_groups, ['site_map', 'planning'])
  assert.deepEqual(repeatActivation.result.value.added_groups, ['context7'])
  assert.equal(firstActivation.result.value.takes_effect, 'next_step')
  assert.equal(repeatActivation.result.value.takes_effect, 'next_step')
  assert.deepEqual(sorted(pluginNamesFor(progressiveAgent)), expectedCoreTools)
  assert.deepEqual(sorted(pluginNamesFor(isolatedAgent)), expectedCoreTools)
  const nativeMap = findResult('native-web-map', 'search_call')
  assert.equal(nativeMap.result.isError, false)

  const presetAgent = await createAgent(
    'preset-deny-session',
    agentCtx => {
      agentCtx.tools.guard(exec => (
        exec.name === 'search_call'
        && exec.arguments?.operation === 'web_map'
          ? 'web_map denied by preset policy'
          : undefined
      ))
    },
  )
  await followup(presetAgent, 'Verify that a Preset deny caps progressive disclosure.')
  const presetActivation = findResult('preset-activation', 'search_tools')
  assert.equal(presetActivation.result.isError, false)
  assert.equal(ctx.tools.get('web_map', presetAgent), undefined)
  const presetHidden = await ctx.tools.execute({
    callId: CallId('preset-hidden-web-map'),
    name: 'search_call',
    arguments: { operation: 'web_map', arguments: { url: 'https://example.test' } },
    agent: presetAgent,
    signal: new AbortController().signal,
  })
  assert.equal(presetHidden.isError, true)
  assert.match(presetHidden.content[0]?.type === 'text' ? presetHidden.content[0].text : '', /denied by preset policy/)

  const docsSuccessAgent = await createAgent('docs-success-session')
  await followup(docsSuccessAgent, 'Run a source-producing documentation search.')
  const docsSuccess = findResult('docs-success', 'docs_search')
  assert.equal(docsSuccess.result.isError, false)
  assert.equal(typeof docsSuccess.result.value.source_ref, 'string')
  assert.deepEqual(sorted(pluginNamesFor(docsSuccessAgent)), expectedCoreTools)

  const docsFailureAgent = await createAgent('docs-failure-session')
  await followup(docsFailureAgent, 'Run a rejected documentation search.')
  assert.equal(findResult('docs-failure', 'docs_search').result.isError, true)
  assert.deepEqual(sorted(pluginNamesFor(docsFailureAgent)), expectedCoreTools)

  const malformedAgent = await createAgent('malformed-result-session')
  await followup(malformedAgent, 'Run malformed Provider responses without disclosing sources.')
  const malformedResult = findResult('malformed-search', 'web_search')
  assert.equal('source_ref' in (malformedResult.result.value ?? {}), false)
  assert.deepEqual(sorted(pluginNamesFor(malformedAgent)), expectedCoreTools)

  const diagnosticsAgent = await createAgent('diagnostics-session')
  const requestsBeforeDisclosure = httpRequests.length
  await followup(diagnosticsAgent, 'Disclose diagnostics without probing Providers.')
  assert.equal(httpRequests.length, requestsBeforeDisclosure)
  await followup(diagnosticsAgent, 'Run the explicitly requested diagnostics probe.')
  const diagnosticsResult = findResult('diagnostics-test', 'search_call')
  assert.equal(diagnosticsResult.result.isError, false)
  assert.equal(
    diagnosticsResult.result.value.provider_attempts.filter(attempt => attempt.attempts > 0).length,
    5,
  )
  assert.equal(httpRequests.length, requestsBeforeDisclosure + 5)

  assert.deepEqual(sorted(pluginNamesFor(isolatedAgent)), expectedCoreTools)
  await followup(isolatedAgent, 'Activate sources and try to read another Session source.')
  const isolatedRead = findResult('isolated-source-read', 'search_call')
  assert.deepEqual(isolatedRead.result.value, {
    state: 'not_found',
    code: 'SOURCE_REF_NOT_FOUND',
  })
  assert.equal(ctx.tools.get('web_map', isolatedAgent), undefined)

  const codePolicyCalls = []
  const codeMapAgent = await createAgent('code-progressive-session', agentCtx => {
    agentCtx.tools.presentAs('code')
    agentCtx.on('tools/pre-execute', async (exec, next) => {
      codePolicyCalls.push({ name: exec.name, nested: exec.parent !== undefined })
      return next()
    })
  })
  await followup(codeMapAgent, 'Verify current-run and next-run Code SDK disclosure.')
  const codeActivation = findResult('code-activate-site-map', 'run_code')
  const codeMapResult = findResult('code-use-site-map', 'run_code')
  assert.equal(codeActivation.result.isError, false)
  assert.deepEqual(
    {
      binding: codeActivation.result.value.result.binding,
      early: codeActivation.result.value.result.early,
      takes_effect: codeActivation.result.value.result.activation.takes_effect,
    },
    { binding: 'function', early: 'inactive', takes_effect: 'next_step' },
  )
  assert.deepEqual(
    codeActivation.result.value.result.activation,
    presetActivation.result.value,
    'Native and nested Code Mode must return the same canonical search_tools value',
  )
  assert.equal(codeMapResult.result.isError, false)
  assert.equal(codeMapResult.result.value.result.binding, 'function')
  assert.ok(codePolicyCalls.some(item => item.name === 'search_tools' && item.nested))
  assert.ok(codePolicyCalls.some(item => item.name === 'search_call' && item.nested))

  const nativeCancelAgent = await createAgent('native-cancel-session')
  const nativeSlowBefore = slowSearchRequests
  await nativeCancelAgent.followup('Cancel a Native Provider request.')
  await waitFor(() => slowSearchRequests === nativeSlowBefore + 1, 'Native cancellation request')
  nativeCancelAgent.cancel({ kind: 'user' })
  await nativeCancelAgent.whenIdle()
  const nativeCancelled = findResult('native-cancel-search', 'web_search')
  const nativeCancelCode = nativeCancelled.result.error?.info?.code ?? nativeCancelled.result.error?.code
  assert.equal(nativeCancelled.result.isError, true)
  assert.equal(nativeCancelCode, 'ABORTED', JSON.stringify(nativeCancelled.result))
  assert.deepEqual(sorted(pluginNamesFor(nativeCancelAgent)), expectedCoreTools)

  const codeCancelAgent = await createAgent(
    'code-cancel-session',
    agentCtx => { agentCtx.tools.presentAs('code') },
  )
  const codeSlowBefore = slowSearchRequests
  await codeCancelAgent.followup('Cancel a Code Mode nested Provider request.')
  await waitFor(() => slowSearchRequests === codeSlowBefore + 1, 'Code cancellation request')
  codeCancelAgent.cancel({ kind: 'user' })
  await codeCancelAgent.whenIdle()
  const cancelledDispatch = codeCancelAgent.session.events.find(
    event => event.type === 'tool/code-dispatch' && event.data.name === 'web_search',
  )
  assert.ok(cancelledDispatch?.type === 'tool/code-dispatch')
  assert.equal(cancelledDispatch.data.isError, true)
  assert.deepEqual(sorted(pluginNamesFor(codeCancelAgent)), expectedCoreTools)

  await Promise.all(durabilityChecks)

  const pageResult = findResult('native-page-call', 'search_call')
  const notFoundResult = findResult('native-not-found-call', 'search_call')
  const partialResult = findResult('native-partial-call', 'web_search')
  const emptyResult = findResult('native-empty-call', 'web_search')
  assert.equal(pageResult.result.isError, false)
  assert.equal(notFoundResult.result.isError, false)
  assert.equal(partialResult.result.isError, false)
  assert.equal(emptyResult.result.isError, false)
  assert.equal(fullResult.result.value.state, 'complete')
  assert.deepEqual(fullResult.result.value.sources.map(source => source.url), [
    'https://github.com/acme/sdk/releases/tag/v4',
    `${origin}/pages/sdk-v3`,
  ])
  assert.equal(fullResult.result.value.total_sources, 2)
  assert.equal(pageResult.result.value.state, 'found')
  assert.deepEqual(notFoundResult.result.value, {
    state: 'not_found',
    code: 'SOURCE_REF_NOT_FOUND',
  })
  assert.equal(partialResult.result.value.state, 'partial')
  assert.equal(emptyResult.result.value.state, 'complete')
  assert.equal('source_ref' in emptyResult.result.value, false)
  assert.equal(emptyResult.result.value.sources.length, 0)

  for (const [callId, argumentsValue] of [
    ['native-invalid-offset', { source_ref: fullSourceRef, offset: -1 }],
    ['native-invalid-limit', { source_ref: fullSourceRef, limit: 21 }],
  ]) {
    const invalid = await ctx.tools.execute({
      callId: CallId(callId),
      name: 'search_call',
      arguments: { operation: 'search_sources', arguments: argumentsValue },
      agent: nativeFull,
      signal: new AbortController().signal,
    })
    assert.equal(invalid.isError, true)
    assert.match(
      invalid.content[0]?.type === 'text' ? invalid.content[0].text : '',
      /SOURCE_PAGE_INVALID_REQUEST/,
    )
  }

  const fullCallEvent = nativeFull.session.events.find(event => event.type === 'tool/call' && String(event.data.callId) === 'native-full-call')
  const fullResultEvent = nativeFull.session.events.find(event => event.type === 'tool/result' && String(event.data.message.content[0]?.toolCallId) === 'native-full-call')
  assert.ok(fullCallEvent && fullCallEvent.type === 'tool/call')
  assert.ok(fullResultEvent && fullResultEvent.type === 'tool/result')
  const fullDefinition = ctx.tools.get('web_search', nativeFull)
  assert.ok(fullDefinition?.presentResult)
  const fullResultBlock = fullResultEvent.data.message.content[0]
  assert.equal(fullResultBlock?.type, 'tool-result')
  const replayCard = fullDefinition.presentResult(
    JSON.parse(fullCallEvent.data.arguments),
    {
      content: fullResultBlock.content,
      isError: fullResultBlock.isError === true,
      ...(fullResultEvent.data.meta === undefined ? {} : { meta: fullResultEvent.data.meta }),
    },
  )
  const liveCard = observedCards.find(item => item.callId === 'native-full-call')?.card
  assert.deepEqual(replayCard, liveCard)
  assert.equal(replayCard?.card, 'web')

  const searchToolsCallEvent = progressiveAgent.session.events.find(
    event => event.type === 'tool/call' && String(event.data.callId) === 'native-repeat-activation',
  )
  const searchToolsResultEvent = progressiveAgent.session.events.find(
    event => event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === 'native-repeat-activation',
  )
  assert.ok(searchToolsCallEvent?.type === 'tool/call')
  assert.ok(searchToolsResultEvent?.type === 'tool/result')
  const searchToolsDefinition = ctx.tools.get('search_tools', progressiveAgent)
  assert.ok(searchToolsDefinition?.presentCall)
  assert.ok(searchToolsDefinition?.presentResult)
  const searchToolsArguments = JSON.parse(searchToolsCallEvent.data.arguments)
  const searchToolsResultBlock = searchToolsResultEvent.data.message.content[0]
  assert.equal(searchToolsResultBlock?.type, 'tool-result')
  const presentationIoBefore = httpRequests.length
  const searchToolsCallView = searchToolsDefinition.presentCall(searchToolsArguments)
  const searchToolsReplayCard = searchToolsDefinition.presentResult(searchToolsArguments, {
    content: searchToolsResultBlock.content,
    isError: searchToolsResultBlock.isError === true,
    ...(searchToolsResultEvent.data.meta === undefined ? {} : { meta: searchToolsResultEvent.data.meta }),
  })
  assert.deepEqual(searchToolsDefinition.presentCall(searchToolsArguments), searchToolsCallView)
  assert.deepEqual(searchToolsDefinition.presentResult(searchToolsArguments, {
    content: searchToolsResultBlock.content,
    isError: searchToolsResultBlock.isError === true,
    ...(searchToolsResultEvent.data.meta === undefined ? {} : { meta: searchToolsResultEvent.data.meta }),
  }), searchToolsReplayCard)
  assert.equal(httpRequests.length, presentationIoBefore)
  const searchToolsLiveCard = observedCards.find(item => item.callId === 'native-repeat-activation')?.card
  assert.deepEqual(searchToolsReplayCard, searchToolsLiveCard)
  assert.deepEqual(
    findResult('native-repeat-activation', 'search_tools').result.content,
    searchToolsResultBlock.content,
  )

  const codeEnhances = observedResults.filter(
    item => item.agentId === 'code-session' && item.name === 'web_search' && item.nested,
  )
  const codePage = observedResults.find(
    item => item.agentId === 'code-session'
      && item.name === 'search_call'
      && item.nested
      && item.result.value?.state === 'found',
  )
  assert.equal(codeEnhances.length, 2)
  assert.ok(codeEnhances.every(item => !item.result.isError))
  assert.ok(codePage && !codePage.result.isError)
  assert.equal(codePage.result.value.state, 'found')
  assert.equal(codePage.result.value.source_ref, codeEnhances[1].result.value.source_ref)
  assert.equal(codeEnhances[0].result.meta, undefined)
  assert.equal(codeEnhances[1].result.meta, undefined)
  assert.equal(codePage.result.meta, undefined)
  const firstCodeResult = findResult('code-first-call', 'run_code')
  const nextCodeResult = findResult('code-next-call', 'run_code')
  assert.equal(firstCodeResult.result.value.result.search_call_binding, 'function')
  assert.equal(firstCodeResult.result.value.result.early, 'inactive')
  assert.equal(nextCodeResult.result.value.result.search_call_binding, 'function')
  const codeDispatches = codeAgent.session.events.filter(event => event.type === 'tool/code-dispatch')
  assert.deepEqual(
    codeDispatches.map(event => event.data.name),
    ['web_search', 'search_call', 'web_search', 'search_call'],
  )
  assert.equal(codeDispatches[1].data.isError, true)
  assert.equal(codeDispatches[3].data.isError, false)
  assert.ok(codeDispatches.every(event => !('meta' in event.data)))
  for (const event of codeDispatches) {
    const markerCount = event.data.content.filter(block => block.type === sourceProducedBlockType).length
    assert.equal(markerCount, event.data.name === 'web_search' ? 1 : 0)
  }

  let storageDocument = JSON.parse(await readFile(storageFile, 'utf8'))
  let storedCount = Object.keys(storageDocument.tables.records).length
  while (storedCount < 6) {
    const fill = await ctx.tools.execute({
      callId: CallId(`capacity-fill-${storedCount}`),
      name: 'web_search',
      arguments: { query: `capacity fill ${storedCount}`, profile: 'auto', depth: 'compact' },
      agent: nativeFull,
      signal: new AbortController().signal,
    })
    assert.equal(fill.isError, false)
    storageDocument = JSON.parse(await readFile(storageFile, 'utf8'))
    storedCount = Object.keys(storageDocument.tables.records).length
  }
  assert.equal(storedCount, 6)
  const capacityResult = await ctx.tools.execute({
    callId: CallId('capacity-failure-direct'),
    name: 'web_search',
    arguments: { query: 'capacity full fixture', profile: 'auto', depth: 'compact' },
    agent: nativeFull,
    signal: new AbortController().signal,
  })
  assert.equal(capacityResult.isError, true)
  assert.equal('value' in capacityResult, false)
  assert.match(capacityResult.content[0]?.type === 'text' ? capacityResult.content[0].text : '', /SOURCE_STORE_CAPACITY/)

  const searchRequests = httpRequests.filter(item => item.url === '/search/v1/chat/completions')
  const modelDiscoveryRequests = httpRequests.filter(item => item.url === '/search/v1/models')
  const tavilyRequests = httpRequests.filter(item => item.url === '/tavily/search')
  assert.ok(searchRequests.length >= 8)
  assert.ok(modelDiscoveryRequests.length >= 2)
  assert.ok(searchRequests.every(item => item.authorization === `Bearer ${searchSecret}`))
  assert.ok(modelDiscoveryRequests.every(item => item.authorization === `Bearer ${searchSecret}`))
  assert.ok(tavilyRequests.every(item => item.authorization === `Bearer ${tavilySecret}`))

  const settingsDescriptors = () => ctx.settings.describe({ redactSecrets: true })
    .filter(descriptor => String(descriptor.ns) === 'search-enhance')
  assert.equal(settingsDescriptors().length, 1)
  assert.equal(settingsDescriptors()[0].value.toolDiscovery.mode, 'progressive')

  const reloadAgent = await createAgent('reload-cancel-session')
  const oldSourceService = ctx.searchEnhanceSources
  const reloadSlowBefore = slowSearchRequests
  await reloadAgent.followup('Reload the plugin during an in-flight Provider request.')
  await waitFor(() => slowSearchRequests === reloadSlowBefore + 1, 'reload cancellation request')
  await pluginEntry.fiber.restart()
  await reloadAgent.whenIdle()
  const reloadCancelled = findResult('reload-cancel-search', 'web_search')
  const reloadCancelCode = reloadCancelled.result.error?.info?.code ?? reloadCancelled.result.error?.code
  assert.equal(reloadCancelled.result.isError, true)
  assert.equal(reloadCancelCode, 'ABORTED')
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), allGlobalToolNames)
  assert.notEqual(ctx.searchEnhanceSources, oldSourceService)
  assert.equal(settingsDescriptors().length, 1)
  for (const name of officialToolNames) assert.equal(ctx.tools.get(name), officialDefinitions[name])
  assert.notEqual(ctx.tools.get('web_search', nativeFull), officialDefinitions.web_search)
  assert.equal(ctx.tools.get('web_search', hiddenWebSearchAgent), undefined)
  assert.deepEqual(sorted(pluginNamesFor(nativeFull)), expectedCoreTools)
  assert.deepEqual(sorted(pluginNamesFor(nativeEmpty)), expectedCoreTools)
  for (const sourceFreeAgent of [
    nativeCancelAgent,
    codeCancelAgent,
    malformedAgent,
    docsFailureAgent,
    reloadAgent,
  ]) {
    assert.deepEqual(sorted(pluginNamesFor(sourceFreeAgent)), expectedCoreTools)
  }
  assert.deepEqual(sorted(pluginNamesFor(docsSuccessAgent)), expectedCoreTools)

  const initialPluginConfig = structuredClone(pluginEntry.options.config)
  const progressiveNativeSurface = await assembledSurface(ctx, nativeEmpty)
  const progressiveCodeSurface = await assembledSurface(ctx, codeAgent)
  const updateDiscoveryMode = async mode => {
    await ctx.loader.update(pluginEntry.id, {
      config: { ...initialPluginConfig, toolDiscovery: { mode } },
    })
    await ctx.loader.await()
    await pluginEntry.fiber?.await()
    assert.equal(settingsDescriptors().length, 1)
    assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), allGlobalToolNames)
    for (const name of officialToolNames) assert.equal(ctx.tools.get(name), officialDefinitions[name])
    assert.notEqual(ctx.tools.get('web_search', nativeFull), officialDefinitions.web_search)
    assert.equal(ctx.tools.get('web_search', hiddenWebSearchAgent), undefined)
  }

  await updateDiscoveryMode('all')
  assert.equal(settingsDescriptors()[0].value.toolDiscovery.mode, 'all')
  assert.deepEqual(await assembledSurface(ctx, nativeEmpty), progressiveNativeSurface)
  assert.deepEqual(await assembledSurface(ctx, codeAgent), progressiveCodeSurface)
  const allModeView = sorted(pluginNamesFor(nativeEmpty))
  assert.deepEqual(allModeView, expectedCoreTools)
  assert.equal(ctx.tools.get('web_map', presetAgent), undefined)
  const allModeMap = await ctx.tools.execute({
    callId: CallId('all-mode-web-map'),
    name: 'search_call',
    arguments: {
      operation: 'web_map',
      arguments: { url: 'https://example.test', max_depth: 1, max_breadth: 2, limit: 2 },
    },
    agent: nativeEmpty,
    signal: new AbortController().signal,
  })
  assert.equal(allModeMap.isError, false)

  await updateDiscoveryMode('progressive')
  assert.equal(settingsDescriptors()[0].value.toolDiscovery.mode, 'progressive')
  assert.deepEqual(await assembledSurface(ctx, nativeEmpty), progressiveNativeSurface)
  assert.deepEqual(await assembledSurface(ctx, codeAgent), progressiveCodeSurface)
  const progressiveMap = await ctx.tools.execute({
    callId: CallId('progressive-inactive-web-map'),
    name: 'search_call',
    arguments: {
      operation: 'web_map',
      arguments: { url: 'https://example.test', max_depth: 1, max_breadth: 2, limit: 2 },
    },
    agent: nativeEmpty,
    signal: new AbortController().signal,
  })
  assert.equal(progressiveMap.error?.info?.code, 'SEARCH_OPERATION_UNAVAILABLE')
  const progressiveViews = {
    fresh: sorted(pluginNamesFor(nativeEmpty)),
    source_restored: sorted(pluginNamesFor(nativeFull)),
    groups_restored: sorted(pluginNamesFor(progressiveAgent)),
    preset_capped: sorted(pluginNamesFor(presetAgent)),
  }
  assert.deepEqual(progressiveViews.fresh, expectedCoreTools)
  assert.deepEqual(progressiveViews.source_restored, expectedCoreTools)
  assert.deepEqual(progressiveViews.groups_restored, expectedCoreTools)
  assert.deepEqual(progressiveViews.preset_capped, expectedCoreTools)

  scriptedModule.appendScript(
    { kind: 'tool', id: 'post-hmr-activation', name: 'search_tools', arguments: { capabilities: ['diagnostics'] } },
    { kind: 'text', text: 'Post-HMR listener fixture complete.' },
  )
  const changesBeforeActivation = toolChanges.count
  await followup(nativeEmpty, 'Activate one group after the restart cycle.')
  assert.equal(toolChanges.count - changesBeforeActivation, 0)
  assert.deepEqual(sorted(pluginNamesFor(nativeEmpty)), expectedCoreTools)
  assert.equal(scriptedModule.remainingResponses(), 0)

  const codeSourceRef = codeEnhances[1].result.value.source_ref
  const postRestartPage = await ctx.tools.execute({
    callId: CallId('post-restart-code'),
    name: 'run_code',
    arguments: {
      code: `return await tools.search_call({ operation: 'search_sources', arguments: { source_ref: ${JSON.stringify(codeSourceRef)}, offset: 0, limit: 1, format: 'compact' } });`,
      description: 'Page a retained source after plugin and config restarts',
    },
    agent: codeAgent,
    signal: new AbortController().signal,
  })
  assert.equal(postRestartPage.isError, false)
  assert.equal(postRestartPage.value.result.state, 'found')
  assert.equal(postRestartPage.value.result.source_ref, codeSourceRef)

  const modelRequestsObserved = scriptedModule.requests()
  assert.equal(modelRequestsObserved.length, modelRequestAgents.length)
  const nativeFullRequests = requestsFor(nativeFull)
  const nativeSchema = nativeFullRequests[0].tools
  assert.deepEqual(
    nativeSchema.map(schema => schema.name),
    sorted([...corePluginToolNames, 'web_fetch']),
  )
  assert.equal(nativeSchema.filter(schema => schema.name === 'web_search').length, 1)
  assert.deepEqual(
    Object.keys(nativeSchema.find(schema => schema.name === 'web_search').parameters.properties),
    ['query', 'profile', 'depth'],
  )
  assert.deepEqual(
    nativeFullRequests[1].tools.map(schema => schema.name),
    sorted([...corePluginToolNames, 'web_fetch']),
  )
  assert.equal(nativeFullRequests[1].system, nativeFullRequests[0].system)
  assert.equal(sha256(nativeFullRequests[1].tools), sha256(nativeFullRequests[0].tools))
  assert.equal(
    JSON.stringify(nativeFullRequests[1].tools[0] ?? null),
    JSON.stringify(nativeFullRequests[0].tools[0] ?? null),
  )
  const nativeEmptyRequests = requestsFor(nativeEmpty)
  assert.deepEqual(
    nativeEmptyRequests.slice(0, 2).map(request => request.tools.map(schema => schema.name)),
    [
      sorted([...corePluginToolNames, 'web_fetch']),
      sorted([...corePluginToolNames, 'web_fetch']),
    ],
  )
  const nativePartialRequests = requestsFor(nativePartial)
  assert.ok(nativePartialRequests.every(request => (
    sha256(request.tools) === sha256(nativePartialRequests[0].tools)
    && request.system === nativePartialRequests[0].system
  )))
  const docsSuccessRequests = requestsFor(docsSuccessAgent)
  const docsFailureRequests = requestsFor(docsFailureAgent)
  const malformedRequests = requestsFor(malformedAgent)
  for (const requests of [docsSuccessRequests, docsFailureRequests, malformedRequests]) {
    assert.ok(requests.every(request => (
      sha256(request.tools) === sha256(requests[0].tools)
      && request.system === requests[0].system
    )))
  }
  assert.equal(requestsFor(nativeCancelAgent).length, 1)
  assert.equal(requestsFor(codeCancelAgent).length, 1)
  assert.equal(requestsFor(reloadAgent).length, 1)

  const progressiveRequests = requestsFor(progressiveAgent)
  assert.deepEqual(
    progressiveRequests.map(request => request.tools.map(schema => schema.name).filter(name => pluginToolNames.includes(name))),
    progressiveRequests.map(() => expectedCoreTools),
  )
  assert.ok(progressiveRequests.every(request => request.system === progressiveRequests[0].system))
  assert.ok(progressiveRequests.every(request => sha256(request.tools) === sha256(progressiveRequests[0].tools)))
  assert.deepEqual(sorted(pluginNamesFor(isolatedAgent)), expectedCoreTools)

  const codeRequests = requestsFor(codeAgent)
  const codeRequest = codeRequests[0]
  const codeNextRequest = codeRequests[1]
  assert.deepEqual(codeRequest.tools.map(schema => schema.name), ['run_code'])
  assert.deepEqual(codeNextRequest.tools.map(schema => schema.name), ['run_code'])
  assert.equal(codeNextRequest.system, codeRequest.system)
  assert.equal(sha256(codeNextRequest.tools), sha256(codeRequest.tools))
  assert.equal(
    JSON.stringify(codeNextRequest.tools[0] ?? null),
    JSON.stringify(codeRequest.tools[0] ?? null),
  )
  const codeMapRequests = requestsFor(codeMapAgent)
  assert.equal(codeMapRequests[1].system, codeMapRequests[0].system)
  assert.equal(sha256(codeMapRequests[1].tools), sha256(codeMapRequests[0].tools))
  assert.equal(
    JSON.stringify(codeMapRequests[1].tools[0] ?? null),
    JSON.stringify(codeMapRequests[0].tools[0] ?? null),
  )

  const onlySearchRequest = requestsFor(onlySearchAgent)[0]
  const noSearchRequest = requestsFor(noSearchAgent)[0]
  assert.deepEqual(onlySearchRequest.tools.map(schema => schema.name), ['web_search'])
  assert.deepEqual(noSearchRequest.tools ?? [], [])
  assert.equal(onlySearchRequest.system, nativeFullRequests[0].system)
  assert.equal(noSearchRequest.system, nativeFullRequests[0].system)
  assert.ok(nativeFullRequests[0].system.includes([
    fullResearchRouteGuidance,
    discoveryEvidenceGuidance,
    extractedEvidenceGuidance,
  ].join('\n')))
  assert.match(nativeFullRequests[0].system, /search_tools/)
  assert.ok(codeRequest.system.includes([
    fullResearchRouteGuidance,
    discoveryEvidenceGuidance,
    extractedEvidenceGuidance,
  ].join('\n')))
  assert.match(codeRequest.system, /web_search:/)
  assert.match(codeRequest.system, /profile\?: "auto"/)
  assert.match(codeRequest.system, /depth\?: "compact"/)
  assert.match(codeRequest.system, /docs_search:/)
  assert.match(codeRequest.system, /search_call:/)
  assert.match(codeRequest.system, /search_tools:/)
  assert.match(codeRequest.system, /web_extract:/)
  assert.match(codeRequest.system, /web_fetch:/)
  for (const operation of deferredOperationNames) {
    assert.doesNotMatch(codeRequest.system, new RegExp(`\\n\\s+${operation}: \\{`, 'u'))
  }

  await Promise.all(durabilityChecks)
  const persistedSessions = ctx.agents.list().map(agent => agent.session.events)
  const sessionsAndStorage = `${JSON.stringify(persistedSessions)}\n${await readFile(storageFile, 'utf8')}`
  for (const secret of secrets) assert.equal(sessionsAndStorage.includes(secret), false)
  assert.equal(
    persistedSessions.flat().some(event => String(event.type).startsWith('search-enhance/')),
    false,
    'the plugin appended a custom SessionEvent',
  )

  storageDocument = JSON.parse(await readFile(storageFile, 'utf8'))
  const storedRecords = Object.values(storageDocument.tables.records)
    .sort((left, right) => left.query.localeCompare(right.query))
  assert.equal(storedRecords.length, 6)
  assert.ok(storedRecords.some(record => record.call.mode === 'nested-code'))

  const snapshot = normalize({
    native_schema: nativeSchema,
    progressive_disclosure: {
      globally_registered_plugin_tools: globalPluginToolNames,
      fresh_plugin_tools: expectedCoreTools,
      source_auto_disclosure: {
        search_success: nativeFullRequests.slice(0, 2).map(request => (
          request.tools.map(schema => schema.name).filter(name => pluginToolNames.includes(name))
        )),
        search_empty: nativeEmptyRequests.slice(0, 2).map(request => (
          request.tools.map(schema => schema.name).filter(name => pluginToolNames.includes(name))
        )),
        docs_success: docsSuccessRequests.map(request => (
          request.tools.map(schema => schema.name).filter(name => pluginToolNames.includes(name))
        )),
        docs_failure: docsFailureRequests.map(request => (
          request.tools.map(schema => schema.name).filter(name => pluginToolNames.includes(name))
        )),
        malformed_provider: malformedRequests.map(request => (
          request.tools.map(schema => schema.name).filter(name => pluginToolNames.includes(name))
        )),
      },
      same_batch_error: earlyMap.result.error?.info?.code,
      first_activation: activationSnapshot(firstActivation.result.value),
      repeated_activation: activationSnapshot(repeatActivation.result.value),
      isolated_source_read: isolatedRead.result.value,
      preset_tools: progressiveViews.preset_capped,
      all_mode_tools: allModeView,
      all_mode_immediate_call: allModeMap.value,
      progressive_inactive_call: progressiveMap.error?.info?.code,
      progressive_after_restart: progressiveViews,
    },
    model_surface_hashes: {
      native_initial: requestSurface(nativeFullRequests[0]),
      native_after_source: requestSurface(nativeFullRequests[1]),
      code_initial: requestSurface(codeRequest),
      code_after_source: requestSurface(codeNextRequest),
      code_site_map_initial: requestSurface(codeMapRequests[0]),
      code_site_map_next: requestSurface(codeMapRequests[1]),
      progressive_native_assembly: progressiveNativeSurface,
      progressive_code_assembly: progressiveCodeSurface,
    },
    search_surface_system_prompts: {
      native_default: nativeFullRequests[0].system,
      native_only_web_search: onlySearchRequest.system,
      native_no_web_search: noSearchRequest.system,
      code_default: codeRequest.system,
    },
    search_surface_wire_tools: {
      native_default: nativeFullRequests[0].tools.map(schema => schema.name),
      native_only_web_search: onlySearchRequest.tools.map(schema => schema.name),
      native_no_web_search: (noSearchRequest.tools ?? []).map(schema => schema.name),
      code_default: codeRequest.tools.map(schema => schema.name),
    },
    native_full_transcript: relevantTranscript(nativeFull.session, origin, 'native-full-call'),
    session_event_types: [...new Set(persistedSessions.flat().map(event => String(event.type)))].sort(),
    native_page_transcript: relevantTranscript(nativeFull.session, origin, 'native-page-call'),
    native_not_found_transcript: relevantTranscript(nativeFull.session, origin, 'native-not-found-call'),
    native_partial_transcript: relevantTranscript(nativePartial.session, origin, 'native-partial-call'),
    native_empty_transcript: relevantTranscript(nativeEmpty.session, origin, 'native-empty-call'),
    native_outputs: {
      complete: fullResult.result.value,
      partial: partialResult.result.value,
      empty: emptyResult.result.value,
      page: pageResult.result.value,
      not_found: notFoundResult.result.value,
      docs: docsSuccess.result.value,
      web_map: nativeMap.result.value,
      diagnostics: diagnosticsResult.result.value,
    },
    cards: {
      search: { live: liveCard, replay: replayCard, metadata: fullResultEvent.data.meta },
      search_tools: {
        call: searchToolsCallView,
        live: searchToolsLiveCard,
        replay: searchToolsReplayCard,
        metadata: searchToolsResultEvent.data.meta,
      },
    },
    code_mode: {
      nested_values: {
        web_search: codeEnhances.map(item => item.result.value),
        search_sources: codePage.result.value,
      },
      outer_values: {
        first: firstCodeResult.result.value,
        next: nextCodeResult.result.value,
        site_map_activation: {
          binding: codeActivation.result.value.result.binding,
          early: codeActivation.result.value.result.early,
          activation: activationSnapshot(codeActivation.result.value.result.activation),
        },
        site_map_next: codeMapResult.result.value,
      },
      dispatches: codeDispatches.map(event => ({
        rootCallId: String(event.data.rootCallId),
        parentCallId: String(event.data.parentCallId),
        subCallId: String(event.data.subCallId),
        name: event.data.name,
        arguments: event.data.arguments,
        isError: event.data.isError,
        content: event.data.content,
      })),
      post_restart_page: postRestartPage.value,
    },
    cancellation: {
      native_error: nativeCancelCode,
      code_dispatch_error: cancelledDispatch.data.isError,
      reload_error: reloadCancelCode,
    },
    native_web_tools: {
      names: officialToolNames,
      hidden_preset_tools: ctx.tools.schemas(hiddenWebSearchAgent).map(schema => schema.name),
      calls_while_plugin_active: {
        web_search: webSearchModule.callCount(),
        web_fetch: webFetchModule.callCount(),
      },
    },
    storage_records: storedRecords,
    http_requests: snapshotHttpRequests(httpRequests),
  }, origin)

  if (process.env.UPDATE_SEARCH_ENHANCE_SNAPSHOTS === '1') {
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } else {
    const expected = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert.deepEqual(snapshot, expected)
  }

  const agentFirst = await createAgent('agent-first-dispose-session')
  const agentFirstHandle = handles.pop()
  assert.equal(agentFirstHandle?.agent, agentFirst)
  await Promise.all([agentFirstHandle.dispose(), agentFirstHandle.dispose()])
  assert.equal(ctx.agents.list().includes(agentFirst), false)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), allGlobalToolNames)

  const raceAgent = await createAgent('dispose-race-session')
  const raceHandle = handles.pop()
  assert.equal(raceHandle?.agent, raceAgent)
  await Promise.all([
    pluginEntry.fiber.dispose(),
    pluginEntry.fiber.dispose(),
    raceHandle.dispose(),
    raceHandle.dispose(),
  ])
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), officialToolNames)
  assert.equal(settingsDescriptors().length, 0)
  assert.equal(ctx.get(sourceStorageModule.SOURCE_RECORD_SERVICE_KEY), undefined)
  assert.equal(ctx.storageDomain.get(sourceStorageModule.SOURCE_RECORD_DOMAIN_NAME), undefined)
  for (const name of officialToolNames) assert.equal(ctx.tools.get(name), officialDefinitions[name])

  for (const [name, argumentsValue] of [
    ['web_search', { query: 'official search after plugin disposal' }],
    ['web_fetch', { url: 'https://example.test/after-plugin-disposal' }],
  ]) {
    const result = await ctx.tools.execute({
      callId: CallId(`post-dispose-${name}`),
      name,
      arguments: argumentsValue,
      agent: nativeFull,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
  }
  assert.equal(webSearchModule.callCount(), 1)
  assert.equal(webFetchModule.callCount(), 2)

  for (const handle of handles.reverse()) await handle.dispose()
  handles.length = 0
  assert.equal(ctx.agents.list().length, 0)
  await ctx.fiber.dispose()
  disposed = true
  process.stdout.write('headless consumer snapshot: ok (fixed Native/Code gateway, progressive/all operation state, Preset guard, HMR restoration)\n')
} finally {
  for (const handle of handles.reverse()) {
    try {
      await handle.dispose()
    } catch {
      // Best effort after an earlier assertion; root disposal is the final owner.
    }
  }
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) {
    await ctx.fiber.dispose()
  }
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
  for (let attempt = 0; attempt < 100 && sockets.size > 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (disposed) assert.equal(sockets.size, 0)
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

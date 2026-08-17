import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-'))
const exampleConfig = join(packageRoot, 'examples/headless/cordis.yml')
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const credentialNames = [
  'SEARCH_API_KEY',
  'CONTEXT7_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
]
const previousEnvironment = new Map([
  ['DSH_HOME', process.env.DSH_HOME],
  ...credentialNames.map((name) => [name, process.env[name]]),
])
const sockets = new Set()
let slowRequests = 0
const fixtureServer = createServer((request, response) => {
  const requestPath = request.url?.startsWith('http://') || request.url?.startsWith('https://')
    ? new URL(request.url).pathname
    : request.url
  if (requestPath === '/slow-json') {
    slowRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"waiting":')
    return
  }
  const body = JSON.stringify({ ok: true })
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
})
fixtureServer.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject)
  fixtureServer.listen(0, '127.0.0.1', resolve)
})
const fixtureAddress = fixtureServer.address()
if (fixtureAddress === null || typeof fixtureAddress === 'string') {
  throw new Error('loader fixture server has no address')
}
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

process.env.DSH_HOME = dshHome
for (const name of credentialNames) delete process.env[name]

let ctx
let disposed = false
let createdSelfLink = false

try {
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }

  const configuredExample = (await readFile(exampleConfig, 'utf8')).replace(
    '- id: search-enhance\n  name: dsh-search-enhance',
    `- id: search-enhance
  name: dsh-search-enhance
  config:
    webExtract:
      smartDirect:
        proxyUrl: ${fixtureOrigin}
      direct:
        proxyUrl: ${fixtureOrigin}`,
  )
  await writeFile(loaderConfig, configuredExample)

  const [
    { boot },
    pluginModule,
    configModule,
    providerRuntime,
    searchPolicy,
    searchApiProvider,
    orchestration,
    documentation,
    sourceStorage,
    scopeModule,
    sessionModule,
    systemPromptModule,
    toolsModule,
  ] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(join(packageRoot, 'lib/index.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/config.js')).href),
    import('dsh-search-enhance/provider-runtime'),
    import('dsh-search-enhance/search'),
    import('dsh-search-enhance/providers/search-api'),
    import('dsh-search-enhance/orchestration'),
    import('dsh-search-enhance/documentation'),
    import('dsh-search-enhance/source-storage'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-session'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-tools'),
  ])

  assert.deepEqual(Object.keys(pluginModule).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.deepEqual(
    pluginModule.inject,
    ['agents', 'credentials', 'settings', 'storageDomain', 'systemPrompt', 'tools'],
  )
  assert.equal('default' in pluginModule, false)
  assert.equal(typeof providerRuntime.retryProviderOperation, 'function')
  assert.equal(typeof searchPolicy.resolveSearchStrategy, 'function')
  assert.equal(typeof searchApiProvider.SearchApiProvider, 'function')
  assert.equal(typeof orchestration.SearchOrchestrator, 'function')
  assert.equal(typeof documentation.DocumentationSearchService, 'function')
  assert.equal(typeof documentation.Context7CachedOperations, 'function')
  assert.equal(typeof sourceStorage.SourceRecordStore, 'function')
  assert.equal(typeof sourceStorage.SearchEnhanceSourceService, 'function')

  ctx = await boot(
    'dsh-search-enhance-loader-smoke',
    loaderConfig,
    undefined,
    undefined,
    pathToFileURL(join(packageRoot, 'package.json')).href,
  )

  assert.equal(ctx.loader.unwrapExports(pluginModule), pluginModule)
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(
    (entry) => entry.options.name === 'dsh-search-enhance',
  )
  assert.ok(pluginEntry?.fiber, 'Loader did not create the package fiber')
  await pluginEntry.fiber.await()
  const registeredSchemas = ctx.tools.schemas()
  const expectedPluginToolNames = [
    'docs_search',
    'web_extract',
    'search_tools',
    'search_call',
  ]
  assert.deepEqual(
    registeredSchemas.map(schema => schema.name),
    expectedPluginToolNames,
    'the Consumer did not register exactly its fixed resident definitions',
  )
  const schemaByName = name => registeredSchemas.find(schema => schema.name === name)
  assert.deepEqual(
    Object.keys(schemaByName('docs_search').parameters.properties),
    ['query', 'provider', 'library_id', 'max_results', 'force_refresh'],
  )
  assert.deepEqual(
    Object.keys(schemaByName('web_extract').parameters.properties),
    ['url', 'format'],
  )
  assert.deepEqual(schemaByName('search_tools').parameters, {
    type: 'object',
    additionalProperties: false,
    properties: {
      capabilities: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['context7', 'sources', 'site_map', 'planning', 'diagnostics'],
        },
        description: 'One to five deferred search capability groups to disclose for this Agent.',
      },
    },
    required: ['capabilities'],
  })
  assert.deepEqual(schemaByName('search_call').parameters, {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: {
        type: 'string',
        description: 'Exact operation name from a search_tools or source-produced operation manifest.',
      },
      arguments: {
        type: 'object',
        properties: {},
        additionalProperties: true,
        description: 'Arguments validated against the disclosed operation manifest before execution.',
      },
    },
    required: ['operation', 'arguments'],
  })
  assert.equal(ctx.tools.get('search_call')?.name, 'search_call')
  assert.equal(ctx.tools.get('search_config'), undefined)

  const harnessIdentity = 'You are an AI agent powered by DeepSeek Harness.'
  const extractedEvidenceGuidance = 'Before asserting decisive factual or causal conclusions, inspect selected authoritative URLs with web_extract; never present an inferred mechanism as source-stated fact, and label unestablished mechanisms as inference or unconfirmed.'
  const docsEvidenceGuidance = [
    'For current or external SDK/API documentation questions, start with one focused docs_search; do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.',
    'Treat docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.',
    extractedEvidenceGuidance,
  ].join('\n')
  const fullEvidenceGuidance = [
    'For current or external factual questions, start with one focused web_search (use docs_search for SDK/API documentation); do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.',
    'Treat web_search/docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.',
    extractedEvidenceGuidance,
  ].join('\n')
  const toolDiscoveryGuidance = 'Search Enhance keeps a fixed model-facing surface: web_search, docs_search, web_extract, search_tools, and search_call.'
  const renderCurrentPrompt = async options => systemPromptModule.renderPrompt(
    await ctx.systemPrompt.assemble(options),
  )
  const initialPrompt = await renderCurrentPrompt()
  assert.ok(initialPrompt.includes(toolDiscoveryGuidance))
  assert.ok(initialPrompt.includes(fullEvidenceGuidance))
  const nativeWebSearchDefinition = toolsModule.defineTool({
    name: 'web_search',
    description: 'Loader-only native web search stub.',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `stub:${args.query}`
    },
  })
  const disposeWebSearch = ctx.tools.register(nativeWebSearchDefinition)
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name),
    [...expectedPluginToolNames, 'web_search'],
  )
  const withWebSearchPrompt = await renderCurrentPrompt()
  assert.ok(withWebSearchPrompt.includes(toolDiscoveryGuidance))
  assert.ok(withWebSearchPrompt.includes(fullEvidenceGuidance))

  const agentSession = sessionModule.Session.create(sessionModule.SessionId('loader-shadow-agent'))
  const mutableAgent = {
    id: agentSession.id,
    options: {},
    session: agentSession,
    ctx: undefined,
  }
  let agentScope
  const agentOwner = ctx.plugin({
    name: 'loader-shadow-agent-owner',
    inject: ['agents', 'tools'],
    apply(pluginCtx) {
      agentScope = scopeModule.createScope(pluginCtx, mutableAgent)
      mutableAgent.ctx = agentScope.ctx
      pluginCtx.agents.register(mutableAgent)
    },
  })
  await agentOwner.await()
  assert.ok(agentScope)
  const agentSchemas = ctx.tools.schemas(mutableAgent)
  assert.equal(agentSchemas.filter(schema => schema.name === 'web_search').length, 1)
  assert.deepEqual(
    Object.keys(agentSchemas.find(schema => schema.name === 'web_search').parameters.properties),
    ['query', 'profile', 'depth'],
  )
  assert.notEqual(ctx.tools.get('web_search', mutableAgent), nativeWebSearchDefinition)
  assert.deepEqual(
    agentSchemas.map(schema => schema.name).sort(),
    ['docs_search', 'search_call', 'search_tools', 'web_extract', 'web_search'],
  )
  const agentPrompt = await renderCurrentPrompt({ scope: mutableAgent, agent: mutableAgent })
  assert.ok(agentPrompt.includes(toolDiscoveryGuidance))
  assert.ok(agentPrompt.includes(fullEvidenceGuidance))

  assert.equal(ctx.get('webServer'), undefined, 'headless Loader unexpectedly mounted a Web server')
  const settings = ctx.settings
  const tools = ctx.tools
  const namespace = String(configModule.SEARCH_ENHANCE_SETTINGS_NAMESPACE)
  const matchingDescriptors = () =>
    settings.describe({ redactSecrets: true }).filter((descriptor) => String(descriptor.ns) === namespace)

  assert.equal(matchingDescriptors().length, 1)
  assert.equal(matchingDescriptors()[0].value.defaultProfile, 'auto')
  assert.deepEqual(matchingDescriptors()[0].value.toolDiscovery, { mode: 'progressive' })
  assert.equal(matchingDescriptors()[0].value.webExtract.smartDirect.proxyUrl, fixtureOrigin)
  assert.equal(matchingDescriptors()[0].value.webExtract.direct.proxyUrl, fixtureOrigin)

  const owner = sessionModule.Session.create(sessionModule.SessionId('loader-owner'))
  const sourceService = ctx.searchEnhanceSources
  const documentationService = ctx.searchEnhanceDocumentation
  assert.equal(typeof documentationService.search, 'function')
  assert.equal(
    ctx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME),
    undefined,
    'unused Context7 cache should remain unopened',
  )
  const call = {
    callId: 'loader-call',
    mode: 'top-level',
    name: 'web_search',
    rootCallId: 'loader-call',
  }
  const candidate = {
    collectionTruncated: false,
    depth: 'compact',
    profile: 'coding_docs',
    query: 'Loader storage recovery proof',
    sources: Array.from({ length: 8 }, (_value, index) => ({
      category: 'documentation',
      provider: 'search-api',
      snippet: `source ${index}`,
      title: `Source ${index}`,
      url: `https://loader.test/${index}`,
    })),
  }
  const commits = await Promise.all(Array.from({ length: 8 }, () =>
    sourceService.record(owner, call, candidate, new AbortController().signal)))
  assert.equal(new Set(commits.map(commit => commit.sourceRef)).size, 8)
  for (const commit of commits) {
    assert.equal(sourceService.lookup(owner, commit.sourceRef).state, 'found')
  }
  assert.deepEqual(
    sourceService.page(owner, { limit: 3, source_ref: commits[0].sourceRef }),
    {
      format: 'compact',
      hasMore: true,
      limit: 3,
      nextOffset: 3,
      offset: 0,
      pageByteLimited: false,
      returned: 3,
      source_ref: commits[0].sourceRef,
      sources: [0, 1, 2].map(index => ({
        category: 'documentation',
        title: `Source ${index}`,
        url: `https://loader.test/${index}`,
      })),
      state: 'found',
      total: 8,
      totalBeforeRetention: 8,
      truncated: false,
    },
  )

  for (const ref of Object.values(configModule.DEFAULT_CREDENTIAL_REFS)) {
    const info = await ctx.credentials.describe(ref)
    assert.deepEqual(info, { configured: false, writable: true })
  }

  const activeWebExtract = tools.execute({
    callId: 'loader-web-extract-active',
    name: 'web_extract',
    arguments: { url: `${fixtureOrigin}/slow-json`, format: 'json' },
    signal: new AbortController().signal,
  })
  await waitFor(() => slowRequests === 1, 'root web_extract did not dispatch direct HTTP')
  await pluginEntry.fiber.restart()
  const stoppedWebExtract = await activeWebExtract
  assert.equal(stoppedWebExtract.isError, true)
  assert.equal('value' in stoppedWebExtract, false)
  assert.doesNotMatch(JSON.stringify(stoppedWebExtract), /slow-json/)
  await waitFor(() => sockets.size === 0, 'root restart left a direct HTTP socket open')
  assert.equal(matchingDescriptors().length, 1, 'reload leaked or duplicated the settings registration')
  assert.deepEqual(
    tools.schemas().map(schema => schema.name).sort(),
    [...expectedPluginToolNames, 'web_search'].sort(),
    'reload leaked or duplicated a model tool',
  )
  const reloadedPrompt = await renderCurrentPrompt()
  assert.ok(reloadedPrompt.includes(toolDiscoveryGuidance))
  assert.ok(reloadedPrompt.includes(fullEvidenceGuidance))
  const restartedAgentWebSearch = tools.get('web_search', mutableAgent)
  assert.notEqual(restartedAgentWebSearch, nativeWebSearchDefinition)
  assert.deepEqual(
    Object.keys(tools.schemas(mutableAgent)
      .find(schema => schema.name === 'web_search').parameters.properties),
    ['query', 'profile', 'depth'],
  )
  assert.notEqual(ctx.searchEnhanceSources, sourceService, 'reload retained the old source service')
  assert.notEqual(
    ctx.searchEnhanceDocumentation,
    documentationService,
    'reload retained the old documentation service',
  )
  await assert.rejects(
    documentationService.search({
      maxResults: 1,
      provider: 'context7',
      query: 'old service must be closed',
      signal: new AbortController().signal,
    }),
    error => error?.name === 'AbortError',
  )
  await assert.rejects(
    sourceService.record(owner, call, candidate, new AbortController().signal),
    { code: 'SOURCE_STORE_CLOSED' },
  )
  for (const commit of commits) {
    assert.equal(ctx.searchEnhanceSources.lookup(owner, commit.sourceRef).state, 'found')
  }
  assert.equal(
    ctx.searchEnhanceSources.page(owner, {
      offset: 3,
      limit: 3,
      format: 'full',
      source_ref: commits[0].sourceRef,
    }).nextOffset,
    6,
  )
  assert.ok(
    ctx.storageDomain.get(sourceStorage.SOURCE_RECORD_DOMAIN_NAME),
    'reload did not reopen the durable source domain',
  )
  const restartedWebExtract = await tools.execute({
    callId: 'loader-web-extract-restarted',
    name: 'web_extract',
    arguments: { url: `${fixtureOrigin}/json`, format: 'json' },
    signal: new AbortController().signal,
  })
  assert.equal(restartedWebExtract.isError, false)
  assert.equal(restartedWebExtract.value.retrieval_route, 'direct')
  assert.equal(restartedWebExtract.value.status_code, 200)
  assert.equal(restartedWebExtract.value.final_url, `${fixtureOrigin}/json`)

  await pluginEntry.fiber.dispose()
  assert.equal(matchingDescriptors().length, 0, 'settings registration survived plugin disposal')
  assert.equal(ctx.get(sourceStorage.SOURCE_RECORD_SERVICE_KEY), undefined)
  assert.equal(ctx.get(documentation.DOCUMENTATION_SEARCH_SERVICE_KEY), undefined)
  assert.equal(ctx.storageDomain.get(sourceStorage.SOURCE_RECORD_DOMAIN_NAME), undefined)
  assert.equal(ctx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME), undefined)
  assert.deepEqual(
    tools.schemas().map(schema => schema.name),
    ['web_search'],
    'plugin disposal removed or retained the wrong model tools',
  )
  assert.equal(
    await renderCurrentPrompt(),
    harnessIdentity,
    'plugin prompt sections survived disposal',
  )
  assert.equal(tools.get('web_search', mutableAgent), nativeWebSearchDefinition)
  assert.deepEqual(
    Object.keys(tools.schemas(mutableAgent)
      .find(schema => schema.name === 'web_search').parameters.properties),
    ['query'],
  )
  const independentWebResult = await tools.execute({
    callId: 'loader-web-search-call',
    name: 'web_search',
    arguments: { query: 'restored native definition' },
    agent: mutableAgent,
    signal: new AbortController().signal,
  })
  assert.equal(independentWebResult.isError, false)
  assert.equal(independentWebResult.value, 'stub:restored native definition')
  await agentOwner.dispose()
  await agentScope.dispose()
  disposeWebSearch()
  assert.equal(tools.schemas().length, 0, 'test web_search stub survived its disposer')

  await ctx.fiber.dispose()
  disposed = true

  const storageFile = join(
    dshHome,
    'search-enhance-storage',
    `${sourceStorage.SOURCE_RECORD_DOMAIN_NAME}.json`,
  )
  const damaged = JSON.parse(await readFile(storageFile, 'utf8'))
  damaged.tables.records[commits[0].sourceRef].query = 42
  await writeFile(storageFile, `${JSON.stringify(damaged, null, 2)}\n`)
  assert.equal(
    sourceStorage.StoredSourceRecordSchema.safeParse(
      damaged.tables.records[commits[0].sourceRef],
    ).success,
    false,
  )
  // Explicit entry disposal is persisted as `disabled` by Loader. Restore the
  // pristine test composition before starting the independent corrupt-read boot.
  await writeFile(loaderConfig, await readFile(exampleConfig, 'utf8'))
  await assert.rejects(
    boot(
      'dsh-search-enhance-corrupt-record',
      loaderConfig,
      undefined,
      undefined,
      pathToFileURL(join(packageRoot, 'package.json')).href,
    ),
    /invalid-record|failed to load|failed to apply/i,
  )

  process.stdout.write(`loader smoke: ok (${expectedPluginToolNames.length} fixed resident tools, static prompt, real storage, pagination/recovery, corruption rejection, reload/dispose)\n`)
} finally {
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) {
    await ctx.fiber.dispose()
  }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => fixtureServer.close(() => resolve()))
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

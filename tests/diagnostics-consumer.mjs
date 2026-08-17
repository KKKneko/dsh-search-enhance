import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/diagnostics-consumer.json')
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-diagnostics-'))
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
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
const secrets = Object.fromEntries(credentialNames.map((name, index) => [
  name,
  `diagnostics-secret-${index + 1}`,
]))
const previousEnvironment = new Map([
  ['DSH_HOME', process.env.DSH_HOME],
  ...credentialNames.map(name => [name, process.env[name]]),
])

const httpRequests = []
const sockets = new Set()
let slowModelList = false
let slowModelSocket

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid')
  const bodyText = await requestBody(request)
  let body
  try {
    body = bodyText.length === 0 ? undefined : JSON.parse(bodyText)
  } catch {
    body = bodyText
  }
  httpRequests.push({
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries([...url.searchParams.entries()].sort()),
    body,
    authorization: request.headers.authorization !== undefined,
    apiKey: request.headers['x-api-key'] !== undefined,
  })

  if (request.method === 'GET' && url.pathname === '/search/v1/models') {
    if (slowModelList) {
      slowModelSocket = request.socket
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"data":[')
      return
    }
    sendJson(response, { data: [{ id: 'fixture-model' }] })
    return
  }
  if (request.method === 'GET' && url.pathname === '/context7/api/v2/search') {
    sendJson(response, {
      results: [{
        id: '/react/react',
        title: 'React',
        description: 'Fixture official React documentation',
        trustScore: 10,
      }],
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/exa/search') {
    sendJson(response, {
      results: [{
        url: 'https://example.test/exa',
        title: 'Exa fixture',
        highlights: ['Fixture result'],
      }],
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/tavily/search') {
    sendJson(response, {
      results: [{
        url: 'https://example.test/tavily',
        title: 'Tavily fixture',
        content: 'Fixture result',
      }],
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/firecrawl/search') {
    sendJson(response, {
      data: { web: [{
        url: 'https://example.test/firecrawl',
        title: 'Firecrawl fixture',
        description: 'Fixture result',
      }] },
    })
    return
  }
  sendJson(response, { unexpected: true })
})
server.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject)
    resolve()
  })
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('diagnostics fixture did not bind TCP')
const origin = `http://127.0.0.1:${address.port}`

function loaderText() {
  return `
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
    searchApi:
      baseUrl: ${JSON.stringify(`${origin}/search/v1`)}
      model: fixture-model
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
    extraDiscoverySources:
      auto: 1
    retry:
      maxAttempts: 1
      baseDelayMs: 0
      multiplier: 1
      maxDelayMs: 0
      maxTotalDelayMs: 0
      jitterRatio: 0
    diagnostics:
      timeoutMs: 10000
      maxProbeAttempts: 1
      maxResponseBytes: 32768
      maxResultBytes: 24576
      maxOutputBytes: 32768
      modelTextMaxBytes: 16384
    optionalTools:
      webMap: false
      researchPlan: false
      diagnostics: false
`
}

function names(ctx) {
  return ctx.tools.schemas().map(schema => schema.name)
}

function parseArguments(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function eventSummary(session) {
  return session.events.flatMap(event => {
    if (event.type === 'tool/call') {
      return [{
        type: event.type,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: parseArguments(event.data.arguments),
      }]
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      return [{
        type: event.type,
        callId: String(block?.toolCallId),
        isError: block?.isError === true,
        content: block?.content,
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
      }]
    }
    if (event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch') {
      return [{
        type: event.type,
        data: {
          rootCallId: String(event.data.rootCallId),
          parentCallId: String(event.data.parentCallId),
          subCallId: String(event.data.subCallId),
          name: event.data.name,
          arguments: parseArguments(event.data.arguments),
          ...(event.type === 'tool/code-dispatch'
            ? { isError: event.data.isError, content: event.data.content }
            : {}),
        },
      }]
    }
    return []
  })
}

function normalize(value) {
  const text = JSON.stringify(value)
    .replaceAll(origin, '<fixture-origin>')
    .replace(/"duration_ms":\d+/g, '"duration_ms":"<duration-ms>"')
    .replace(/duration_ms=\d+/g, 'duration_ms=<duration-ms>')
  return JSON.parse(text)
}

function normalizedDiagnosticValue(value) {
  return {
    ...value,
    provider_attempts: value.provider_attempts.map(attempt => ({
      ...attempt,
      duration_ms: '<duration-ms>',
    })),
  }
}

function stableRequests() {
  return httpRequests
    .map(request => ({
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body,
      authorization: request.authorization,
      api_key: request.apiKey,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

async function directoryText(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
  const chunks = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) chunks.push(await directoryText(path))
    else if (entry.isFile()) chunks.push((await readFile(path)).toString('utf8'))
  }
  return chunks.join('\n')
}

async function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let ctx
let disposed = false
let createdSelfLink = false
const handles = []

try {
  process.env.DSH_HOME = dshHome
  for (const name of credentialNames) process.env[name] = secrets[name]
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }
  await writeFile(loaderConfig, loaderText(), 'utf8')

  const [{ boot }, scriptedModule] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(fixturePath).href),
  ])
  ctx = await boot(
    'dsh-search-enhance-diagnostics-consumer',
    loaderConfig,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(
    entry => entry.options.name === 'dsh-search-enhance',
  )
  assert.ok(pluginEntry?.fiber, 'Loader did not create the diagnostics fiber')
  await pluginEntry.fiber.await()

  const descriptors = () => ctx.settings.describe({ redactSecrets: true })
    .filter(descriptor => String(descriptor.ns) === 'search-enhance')
  assert.deepEqual(names(ctx), globalDefinitions)
  assert.equal(new Set(names(ctx)).size, names(ctx).length)
  assert.equal(descriptors().length, 1)
  assert.equal(descriptors()[0].applies, 'restart')
  assert.equal(descriptors()[0].value.toolDiscovery.mode, 'all')
  assert.deepEqual(descriptors()[0].value.optionalTools, {
    webMap: false,
    researchPlan: false,
    diagnostics: false,
  })

  assert.equal(ctx.tools.get('search_config'), undefined)
  assert.equal(ctx.tools.get('diagnostics'), undefined)
  const gatewaySchema = ctx.tools.schemas().find(schema => schema.name === 'search_call')
  assert.ok(gatewaySchema)
  assert.deepEqual(Object.keys(gatewaySchema.parameters.properties), ['operation', 'arguments'])

  let directShow
  const observed = []
  ctx.on('tools/result', (exec, result) => {
    if (!['search_call', 'run_code'].includes(exec.name)) return
    const definition = ctx.tools.get(exec.name, exec.agent)
    const card = definition?.presentResult?.(exec.arguments, {
      content: result.content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    observed.push({
      callId: String(exec.callId),
      name: exec.name,
      nested: exec.parent !== undefined,
      result,
      ...(card === undefined ? {} : { card: structuredClone(card) }),
    })
  })

  const showGatewayArgs = { operation: 'search_diagnostics', arguments: { action: 'show' } }
  const testGatewayArgs = { operation: 'search_diagnostics', arguments: { action: 'test' } }
  const showCode = `return await tools.search_call(${JSON.stringify(showGatewayArgs)});`
  const testCode = `return await tools.search_call(${JSON.stringify(testGatewayArgs)});`
  scriptedModule.setScript([
    { kind: 'tool', id: 'native-diagnostics-show', name: 'search_call', arguments: showGatewayArgs },
    { kind: 'text', text: 'Native diagnostics show complete.' },
    {
      kind: 'tool',
      id: 'code-diagnostics-show',
      name: 'run_code',
      arguments: { code: showCode, description: 'Inspect masked search capability status' },
    },
    { kind: 'text', text: 'Code diagnostics show complete.' },
    { kind: 'tool', id: 'native-diagnostics-test', name: 'search_call', arguments: testGatewayArgs },
    { kind: 'text', text: 'Native diagnostics test complete.' },
    {
      kind: 'tool',
      id: 'code-diagnostics-test',
      name: 'run_code',
      arguments: { code: testCode, description: 'Run the explicit bounded connectivity test' },
    },
    { kind: 'text', text: 'Code diagnostics test complete.' },
  ])

  const nativeHandle = await ctx.agents.create({
    sessionId: SessionId('diagnostics-native-session'),
    agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
  })
  handles.push(nativeHandle)
  const codeHandle = await ctx.agents.create({
    sessionId: SessionId('diagnostics-code-session'),
    agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
    setup: agentCtx => { agentCtx.tools.presentAs('code') },
  })
  handles.push(codeHandle)

  const manifestResult = await ctx.tools.execute({
    callId: CallId('diagnostics-manifest'),
    name: 'search_tools',
    arguments: { capabilities: ['diagnostics'] },
    agent: nativeHandle.agent,
    signal: new AbortController().signal,
  })
  assert.equal(manifestResult.isError, false)
  assert.equal(manifestResult.value.takes_effect, 'already_active')
  const diagnosticsManifest = manifestResult.value.groups[0].operations[0]
  assert.equal(diagnosticsManifest.name, 'search_diagnostics')
  assert.deepEqual(Object.keys(diagnosticsManifest.parameters.properties), ['action'])
  assert.deepEqual(diagnosticsManifest.parameters.required, ['action'])
  assert.deepEqual(diagnosticsManifest.parameters.properties.action.enum, ['show', 'test'])
  assert.equal(diagnosticsManifest.output_schema.type, 'object')

  directShow = await ctx.tools.execute({
    callId: CallId('diagnostics-direct-show'),
    name: 'search_call',
    arguments: showGatewayArgs,
    agent: nativeHandle.agent,
    signal: new AbortController().signal,
  })
  assert.equal(directShow.isError, false)
  assert.equal(directShow.value.tested, false)
  assert.deepEqual(directShow.value.provider_attempts, [])
  assert.equal(httpRequests.length, 0, 'show performed an HTTP request')
  assert.doesNotMatch(JSON.stringify(directShow), /diagnostics-secret|authorization|bearer/i)

  await followup(nativeHandle.agent, 'Show read-only masked search capability status without network.')
  assert.equal(httpRequests.length, 0, 'Native show performed an HTTP request')
  await followup(codeHandle.agent, 'Use Code Mode to show the same read-only status without network.')
  assert.equal(httpRequests.length, 0, 'Code show performed an HTTP request')
  await followup(nativeHandle.agent, 'Explicitly run bounded connection diagnostics now.')
  await followup(codeHandle.agent, 'Use Code Mode to explicitly run the same bounded connection diagnostics.')
  assert.equal(scriptedModule.remainingResponses(), 0)

  const nativeShow = observed.find(item => item.callId === 'native-diagnostics-show')
  const nativeTest = observed.find(item => item.callId === 'native-diagnostics-test')
  const nestedShows = observed.filter(item => item.name === 'search_call' && item.nested && item.result.value?.action === 'show')
  const nestedTests = observed.filter(item => item.name === 'search_call' && item.nested && item.result.value?.action === 'test')
  assert.ok(nativeShow && !nativeShow.result.isError)
  assert.ok(nativeTest && !nativeTest.result.isError)
  assert.equal(nestedShows.length, 1)
  assert.equal(nestedTests.length, 1)
  assert.equal(nestedShows[0].result.meta, undefined)
  assert.equal(nestedTests[0].result.meta, undefined)
  assert.deepEqual(nativeShow.result.value, nestedShows[0].result.value)
  assert.deepEqual(
    normalizedDiagnosticValue(nativeTest.result.value),
    normalizedDiagnosticValue(nestedTests[0].result.value),
  )
  assert.equal(nativeShow.result.value.tested, false)
  assert.deepEqual(nativeShow.result.value.provider_attempts, [])
  assert.equal(nativeTest.result.value.tested, true)
  assert.equal(nativeTest.result.value.provider_attempts.length, 10)
  assert.equal(nativeTest.result.value.provider_attempts.filter(item => item.outcome === 'success').length, 5)
  assert.deepEqual(nativeTest.result.value.providers_used, [
    'search_api',
    'tavily_search',
    'firecrawl_search',
    'context7',
    'exa',
  ])
  assert.equal(nativeTest.result.value.fallback_used, false)
  assert.equal(nativeTest.result.value.minimum_profile.satisfied, true)

  const requests = scriptedModule.requests()
  const nativeRequest = requests.find(request => request.tools.some(tool => tool.name === 'search_call'))
  const codeRequest = requests.find(request => request.tools.some(tool => tool.name === 'run_code'))
  assert.ok(nativeRequest)
  assert.ok(codeRequest)
  assert.deepEqual(nativeRequest.tools.map(tool => tool.name), modelTools)
  assert.deepEqual(codeRequest.tools.map(tool => tool.name), ['run_code'])
  assert.match(codeRequest.system, /search_call:/)
  assert.doesNotMatch(codeRequest.system, /\n\s+search_diagnostics: \{/u)

  const showCallEvent = nativeHandle.agent.session.events.find(
    event => event.type === 'tool/call' && String(event.data.callId) === 'native-diagnostics-show',
  )
  const showResultEvent = nativeHandle.agent.session.events.find(
    event => event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === 'native-diagnostics-show',
  )
  const testCallEvent = nativeHandle.agent.session.events.find(
    event => event.type === 'tool/call' && String(event.data.callId) === 'native-diagnostics-test',
  )
  const testResultEvent = nativeHandle.agent.session.events.find(
    event => event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === 'native-diagnostics-test',
  )
  assert.ok(showCallEvent && showResultEvent && testCallEvent && testResultEvent)
  const definition = ctx.tools.get('search_call', nativeHandle.agent)
  assert.ok(definition?.presentResult)
  const replayCard = (callEvent, resultEvent) => definition.presentResult(
    JSON.parse(callEvent.data.arguments),
    {
      content: resultEvent.data.message.content[0].content,
      isError: resultEvent.data.message.content[0].isError === true,
      ...(resultEvent.data.meta === undefined ? {} : { meta: resultEvent.data.meta }),
    },
  )
  assert.deepEqual(replayCard(showCallEvent, showResultEvent), nativeShow.card)
  assert.deepEqual(replayCard(testCallEvent, testResultEvent), nativeTest.card)
  assert.equal(nativeShow.card?.card, 'generic')
  assert.equal(nativeTest.card?.card, 'generic')

  const codeDispatches = eventSummary(codeHandle.agent.session)
    .filter(event => event.type === 'tool/code-dispatch' || event.type === 'tool/code-dispatch-start')
  assert.deepEqual(codeDispatches.map(event => event.type), [
    'tool/code-dispatch-start',
    'tool/code-dispatch',
    'tool/code-dispatch-start',
    'tool/code-dispatch',
  ])
  assert.equal(codeDispatches.every(event => event.data.name === 'search_call'), true)
  assert.equal(codeDispatches.every(event => !('meta' in event.data)), true)

  const fixedQuery = 'search-enhance fixed connectivity diagnostic'
  const context7Query = 'react documentation'
  assert.equal(httpRequests.length, 10)
  assert.equal(httpRequests.every(request => [
    '/search/v1/models',
    '/context7/api/v2/search',
    '/exa/search',
    '/tavily/search',
    '/firecrawl/search',
  ].includes(request.path)), true)
  for (const request of httpRequests) {
    if (request.path === '/context7/api/v2/search') {
      assert.deepEqual(request.query, { query: context7Query })
    }
    if (request.path === '/exa/search') {
      assert.equal(request.body.query, fixedQuery)
      assert.equal(request.body.numResults, 1)
    }
    if (request.path === '/tavily/search') {
      assert.equal(request.body.query, fixedQuery)
      assert.equal(request.body.max_results, 1)
    }
    if (request.path === '/firecrawl/search') {
      assert.deepEqual(request.body, { limit: 1, query: fixedQuery })
    }
  }

  const oldDefinition = ctx.tools.get('search_call')
  slowModelList = true
  const activeTest = ctx.tools.execute({
    callId: CallId('diagnostics-active-restart'),
    name: 'search_call',
    arguments: testGatewayArgs,
    agent: nativeHandle.agent,
    signal: new AbortController().signal,
  })
  await waitFor(() => slowModelSocket !== undefined, 'diagnostics restart fixture did not receive model-list probe')
  await pluginEntry.fiber.restart()
  const stoppedTest = await activeTest
  assert.equal(stoppedTest.isError, true)
  assert.equal('value' in stoppedTest, false)
  assert.doesNotMatch(JSON.stringify(stoppedTest), /search\/v1|context7|diagnostics-secret/i)
  await waitFor(() => slowModelSocket?.destroyed === true, 'diagnostics restart left model-list socket open')
  slowModelList = false
  assert.notEqual(ctx.tools.get('search_call'), oldDefinition)
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === 'search_call').length, 1)
  assert.equal(descriptors().length, 1)

  const postRestartShow = await ctx.tools.execute({
    callId: CallId('diagnostics-post-restart-show'),
    name: 'search_call',
    arguments: showGatewayArgs,
    agent: nativeHandle.agent,
    signal: new AbortController().signal,
  })
  assert.equal(postRestartShow.isError, false)
  assert.equal(postRestartShow.value.tested, false)
  const afterRestartHttpCount = httpRequests.length

  const current = structuredClone(pluginEntry.fiber.config)
  await pluginEntry.fiber.update({
    ...current,
    optionalTools: { webMap: true, researchPlan: true, diagnostics: false },
  }, true)
  assert.deepEqual(names(ctx), globalDefinitions)
  assert.equal(ctx.tools.get('search_call')?.name, 'search_call')
  const compatibilityCall = await ctx.tools.execute({
    callId: CallId('diagnostics-compatibility-config'),
    name: 'search_call',
    arguments: showGatewayArgs,
    agent: nativeHandle.agent,
    signal: new AbortController().signal,
  })
  assert.equal(compatibilityCall.isError, false)

  const allSessionText = JSON.stringify([
    nativeHandle.agent.session.events,
    codeHandle.agent.session.events,
    requests,
  ])
  const homeText = await directoryText(dshHome)
  for (const secret of Object.values(secrets)) {
    assert.equal(allSessionText.includes(secret), false)
    assert.equal(homeText.includes(secret), false)
  }

  const snapshot = normalize({
    global_definitions: globalDefinitions,
    deprecated_optional_tools_ignored: names(ctx),
    gateway_schema: gatewaySchema,
    diagnostics_manifest: diagnosticsManifest,
    direct_show: directShow.value,
    native_wire_tools: nativeRequest.tools.map(tool => tool.name),
    code_wire_tools: codeRequest.tools.map(tool => tool.name),
    code_system_has_gateway: /search_call:/.test(codeRequest.system),
    code_system_has_direct_diagnostics: /\n\s+search_diagnostics: \{/u.test(codeRequest.system),
    native_show: nativeShow.result.value,
    code_show: nestedShows[0].result.value,
    native_test: nativeTest.result.value,
    code_test: nestedTests[0].result.value,
    native_cards: {
      show: {
        live: nativeShow.card,
        replay: replayCard(showCallEvent, showResultEvent),
        metadata: showResultEvent.data.meta,
      },
      test: {
        live: nativeTest.card,
        replay: replayCard(testCallEvent, testResultEvent),
        metadata: testResultEvent.data.meta,
      },
    },
    native_events: eventSummary(nativeHandle.agent.session),
    code_events: codeDispatches,
    fixed_probe_requests: stableRequests(),
    restart: {
      stopped_test: stoppedTest,
      post_restart_show: postRestartShow.value,
      http_count_after_show: afterRestartHttpCount,
    },
    compatibility_call: compatibilityCall,
  })
  const snapshotText = JSON.stringify(snapshot)
  for (const secret of Object.values(secrets)) assert.equal(snapshotText.includes(secret), false)

  if (process.env.UPDATE_SEARCH_ENHANCE_SNAPSHOTS === '1') {
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } else {
    const expected = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert.deepEqual(snapshot, expected)
  }

  await pluginEntry.fiber.dispose()
  assert.deepEqual(names(ctx), [])
  assert.equal(descriptors().length, 0)
  for (const handle of handles.reverse()) await handle.dispose()
  handles.length = 0
  await ctx.fiber.dispose()
  disposed = true
  process.stdout.write('search_diagnostics headless snapshot: ok (fixed gateway all-mode execution, show/no-network, probes, Native/Code parity, replay cards, restart/dispose, secret scan)\n')
} finally {
  for (const handle of handles.reverse()) {
    try {
      await handle.dispose()
    } catch {
      // Root disposal remains authoritative after assertion failure.
    }
  }
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) {
    await ctx.fiber.dispose()
  }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(() => resolve()))
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

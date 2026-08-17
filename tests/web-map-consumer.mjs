import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/web-map-consumer.json')
const offHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-map-off-'))
const onHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-map-on-'))
const offConfigPath = join(offHome, 'cordis.yml')
const onConfigPath = join(onHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const tavilySecret = 'web-map-loader-tavily-secret'
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
const sockets = new Set()
const httpRequests = []
let slowRequests = 0
let slowSocket

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

const server = createServer(async (request, response) => {
  try {
    const rawBody = await requestBody(request)
    const body = rawBody.length === 0 ? undefined : JSON.parse(rawBody)
    httpRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    })
    if (request.url !== '/tavily/map' || request.method !== 'POST') {
      json(response, 404, { error: 'fixture route not found' })
      return
    }
    if (typeof body?.url === 'string' && body.url.includes('/slow')) {
      slowRequests += 1
      slowSocket = request.socket
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"results":[')
      return
    }
    json(response, 200, {
      base_url: `${origin}/site/`,
      results: [
        `${origin}/site/page-a`,
        `${origin}/site/界🙂`,
        `${origin}/site/page-a`,
        'ftp://invalid.example.test/file',
        'https://user:password@invalid.example.test/private',
      ],
      response_time: 0.125,
      ignored: { request_id: 'fixture-only' },
    })
  } catch (error) {
    if (!response.headersSent) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    } else {
      response.destroy()
    }
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
if (address === null || typeof address === 'string') throw new Error('web_map fixture has no TCP address')
const origin = `http://127.0.0.1:${address.port}`

function loaderCore(home) {
  return `
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: ${JSON.stringify(join(home, 'search-enhance-storage'))}
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: agents
  name: '@deepseek-ai/dsh-agent'
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
- id: settings
  name: '@deepseek-ai/dsh-settings-file'
  config:
    watch: false
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  config:
    watch: false
`
}

function progressiveConfig(home) {
  return `${loaderCore(home)}
- id: search-enhance
  name: dsh-search-enhance
`
}

function allModeConfig(home) {
  return `${loaderCore(home)}
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
  config:
    computeMs: 10000
    maxWallMs: 30000
    maxOutputBytes: 1048576
    maxOldGenerationSizeMb: 128
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: scripted-llm
  name: ${JSON.stringify(fixturePath)}
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []
- id: search-enhance
  name: dsh-search-enhance
  config:
    toolDiscovery:
      mode: all
    optionalTools:
      webMap: true
      researchPlan: false
      diagnostics: true
    providers:
      tavily:
        baseUrl: ${JSON.stringify(`${origin}/tavily`)}
    retry:
      maxAttempts: 1
      baseDelayMs: 0
      multiplier: 1
      maxDelayMs: 0
      maxTotalDelayMs: 0
      jitterRatio: 0
    siteMap:
      timeoutMs: 10000
      maxResponseBytes: 16384
      maxOutputBytes: 16384
      modelTextMaxBytes: 4096
      maxUrlCharacters: 2048
      maxInstructionsCharacters: 200
      maxLinks: 4
`
}

function schemaNames(ctx) {
  return ctx.tools.schemas().map(schema => schema.name)
}

function normalize(value) {
  const text = JSON.stringify(value)
    .replaceAll(origin, '<fixture-origin>')
    .replace(/"duration_ms":\d+/g, '"duration_ms":"<duration-ms>"')
    .replace(/duration_ms=\d+/g, 'duration_ms=<duration-ms>')
  return JSON.parse(text)
}

function normalizeToolResultEvent(event) {
  const block = event.data.message.content[0]
  assert.equal(block?.type, 'tool-result')
  return normalize({
    type: event.type,
    callId: String(block.toolCallId),
    isError: block.isError === true,
    content: block.content,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
  })
}

function mapTranscript(session, callId) {
  return session.events.flatMap(event => {
    if (event.type === 'tool/call' && String(event.data.callId) === callId) {
      return [{
        type: event.type,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: JSON.parse(event.data.arguments),
      }]
    }
    if (
      event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === callId
    ) return [normalizeToolResultEvent(event)]
    return []
  })
}

function codeDispatches(session) {
  return session.events.flatMap(event => {
    if (event.type !== 'tool/code-dispatch-start' && event.type !== 'tool/code-dispatch') return []
    return [normalize({ type: event.type, data: event.data })]
  })
}

async function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function requestSnapshot() {
  return normalize(httpRequests.map(request => ({
    method: request.method,
    url: request.url,
    authorization: request.authorization === undefined ? undefined : '<redacted>',
    body: request.body,
  })))
}

for (const name of credentialNames) delete process.env[name]
let offCtx
let onCtx
let createdSelfLink = false
let disposedOff = false
let disposedOn = false
const handles = []

try {
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }

  await writeFile(offConfigPath, progressiveConfig(offHome), 'utf8')
  await writeFile(onConfigPath, allModeConfig(onHome), 'utf8')
  const [{ boot }, scriptedModule, configModule] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(fixturePath).href),
    import('dsh-search-enhance/config'),
  ])

  process.env.DSH_HOME = offHome
  offCtx = await boot(
    'dsh-search-enhance-web-map-off',
    offConfigPath,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await offCtx.loader.await()
  const offEntry = [...offCtx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
  assert.ok(offEntry?.fiber)
  await offEntry.fiber.await()
  const progressiveGlobalSchemas = schemaNames(offCtx)
  assert.deepEqual(progressiveGlobalSchemas, globalDefinitions)
  assert.equal(offCtx.tools.get('search_call')?.name, 'search_call')
  assert.equal(offCtx.tools.get('web_map'), undefined)
  assert.equal(offCtx.tools.get('research_plan'), undefined)
  assert.equal(offCtx.tools.get('search_diagnostics'), undefined)
  await offCtx.fiber.dispose()
  disposedOff = true

  process.env.DSH_HOME = onHome
  const nativeMapArgs = {
    operation: 'web_map',
    arguments: {
      url: `${origin}/site/native`,
      instructions: '  only documentation pages  ',
      max_depth: 2,
      max_breadth: 3,
      limit: 3,
    },
  }
  const codeMapArgs = {
    operation: 'web_map',
    arguments: {
      url: `${origin}/site/code`,
      max_depth: 1,
      max_breadth: 2,
      limit: 2,
    },
  }
  scriptedModule.setScript([
    {
      kind: 'tool',
      id: 'native-map-call',
      name: 'search_call',
      arguments: nativeMapArgs,
    },
    { kind: 'text', text: 'Native map fixture complete.' },
    {
      kind: 'tool',
      id: 'code-map-call',
      name: 'run_code',
      arguments: {
        code: `return await tools.search_call(${JSON.stringify(codeMapArgs)});`,
        description: 'Discover two candidate pages under the fixture site',
      },
    },
    { kind: 'text', text: 'Code map fixture complete.' },
  ])
  onCtx = await boot(
    'dsh-search-enhance-web-map-on',
    onConfigPath,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await onCtx.loader.await()
  const pluginEntry = [...onCtx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
  assert.ok(pluginEntry?.fiber)
  await pluginEntry.fiber.await()

  const expectedOnNames = globalDefinitions
  const expectedNativeWireNames = modelTools
  assert.deepEqual(schemaNames(onCtx), expectedOnNames)
  assert.equal(onCtx.tools.get('search_call')?.name, 'search_call')
  assert.equal(onCtx.tools.get('web_map'), undefined)
  assert.equal(onCtx.tools.get('research_plan'), undefined)
  assert.equal(onCtx.tools.get('search_diagnostics'), undefined)
  assert.equal(onCtx.tools.get('diagnostics'), undefined)
  const gatewaySchema = onCtx.tools.schemas().find(schema => schema.name === 'search_call')
  assert.ok(gatewaySchema)

  const namespace = String(configModule.SEARCH_ENHANCE_SETTINGS_NAMESPACE)
  const descriptors = () => onCtx.settings.describe({ redactSecrets: true })
    .filter(descriptor => String(descriptor.ns) === namespace)
  assert.equal(descriptors().length, 1)
  assert.equal(descriptors()[0].value.toolDiscovery.mode, 'all')
  assert.equal(descriptors()[0].value.optionalTools.webMap, true)
  assert.equal(descriptors()[0].applies, 'restart')

  const nativeHandle = await onCtx.agents.create({
    sessionId: SessionId('web-map-native-session'),
    agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
  })
  handles.push(nativeHandle)
  const nativeAgent = nativeHandle.agent

  const manifestResult = await onCtx.tools.execute({
    callId: CallId('web-map-manifest'),
    name: 'search_tools',
    arguments: { capabilities: ['site_map'] },
    agent: nativeAgent,
    signal: new AbortController().signal,
  })
  assert.equal(manifestResult.isError, false)
  assert.equal(manifestResult.value.takes_effect, 'already_active')
  const mapManifest = manifestResult.value.groups[0].operations[0]
  assert.equal(mapManifest.name, 'web_map')
  assert.deepEqual(Object.keys(mapManifest.parameters.properties), [
    'url', 'instructions', 'max_depth', 'max_breadth', 'limit',
  ])
  assert.equal(mapManifest.output_schema.type, 'object')

  const missingArgs = { operation: 'web_map', arguments: { url: `${origin}/site/missing` } }
  const missingCredential = await onCtx.tools.execute({
    callId: CallId('missing-map-credential'),
    name: 'search_call',
    arguments: missingArgs,
    agent: nativeAgent,
    signal: new AbortController().signal,
  })
  assert.equal(missingCredential.isError, true)
  assert.match(missingCredential.content[0]?.type === 'text' ? missingCredential.content[0].text : '', /credential is not configured/)
  assert.doesNotMatch(JSON.stringify(missingCredential), /site\/missing|authorization|bearer/i)
  assert.equal(httpRequests.length, 0)

  await onCtx.credentials.set(configModule.DEFAULT_CREDENTIAL_REFS.tavily, tavilySecret)

  const observedResults = []
  const observedCards = []
  onCtx.on('tools/result', (exec, result) => {
    if (exec.name !== 'search_call' || exec.arguments?.operation !== 'web_map') return
    observedResults.push({
      agentId: String(exec.agent?.id ?? ''),
      callId: String(exec.callId),
      nested: exec.parent !== undefined,
      result,
    })
    const definition = onCtx.tools.get(exec.name, exec.agent)
    const card = definition?.presentResult?.(exec.arguments, {
      content: result.content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    if (card !== undefined) observedCards.push({ callId: String(exec.callId), card: structuredClone(card) })
  })

  async function createAgent(id, setup) {
    const handle = await onCtx.agents.create({
      sessionId: SessionId(id),
      agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
      ...(setup === undefined ? {} : { setup }),
    })
    handles.push(handle)
    return handle.agent
  }

  const codeAgent = await createAgent(
    'web-map-code-session',
    agentCtx => { agentCtx.tools.presentAs('code') },
  )
  await followup(nativeAgent, 'Map the fixture documentation website.')
  await followup(codeAgent, 'Use Code Mode to map the fixture website.')
  assert.equal(scriptedModule.remainingResponses(), 0)

  const nativeObserved = observedResults.find(item => item.callId === 'native-map-call')
  const nestedObserved = observedResults.find(item => item.agentId === 'web-map-code-session' && item.nested)
  assert.ok(nativeObserved && !nativeObserved.result.isError)
  assert.ok(nestedObserved && !nestedObserved.result.isError)
  assert.equal(nativeObserved.result.value.evidence_level, 'discovery')
  assert.equal(nativeObserved.result.value.provider, 'tavily')
  assert.deepEqual(nativeObserved.result.value.warnings, [
    { code: 'invalid_result_url_omitted', count: 2 },
    { code: 'duplicate_result_url_omitted', count: 1 },
  ])
  assert.equal(nativeObserved.result.meta.type, 'search_call')
  assert.equal(nativeObserved.result.meta.operation, 'web_map')
  assert.equal(nativeObserved.result.meta.operation_meta.type, 'web_map')
  assert.equal(nestedObserved.result.meta, undefined)
  assert.deepEqual(nestedObserved.result.value.results, nativeObserved.result.value.results)

  const nativeCallEvent = nativeAgent.session.events.find(event => (
    event.type === 'tool/call' && String(event.data.callId) === 'native-map-call'
  ))
  const nativeResultEvent = nativeAgent.session.events.find(event => (
    event.type === 'tool/result'
    && String(event.data.message.content[0]?.toolCallId) === 'native-map-call'
  ))
  assert.ok(nativeCallEvent && nativeCallEvent.type === 'tool/call')
  assert.ok(nativeResultEvent && nativeResultEvent.type === 'tool/result')
  const nativeBlock = nativeResultEvent.data.message.content[0]
  assert.equal(nativeBlock?.type, 'tool-result')
  const mapDefinition = onCtx.tools.get('search_call', nativeAgent)
  assert.ok(mapDefinition?.presentResult)
  const replayCard = mapDefinition.presentResult(
    JSON.parse(nativeCallEvent.data.arguments),
    {
      content: nativeBlock.content,
      isError: nativeBlock.isError === true,
      ...(nativeResultEvent.data.meta === undefined ? {} : { meta: nativeResultEvent.data.meta }),
    },
  )
  const liveCard = observedCards.find(item => item.callId === 'native-map-call')?.card
  assert.deepEqual(replayCard, liveCard)
  assert.equal(replayCard?.card, 'web')
  assert.equal(replayCard?.kind, 'search')

  const modelRequests = scriptedModule.requests()
  assert.equal(modelRequests.length, 4)
  assert.deepEqual(modelRequests[0].tools.map(schema => schema.name), expectedNativeWireNames)
  assert.deepEqual(modelRequests[2].tools.map(schema => schema.name), ['run_code'])
  assert.match(modelRequests[2].system, /search_call:/)
  assert.doesNotMatch(modelRequests[2].system, /\n\s+web_map: \{/u)
  const dispatchEvents = codeDispatches(codeAgent.session)
  assert.deepEqual(dispatchEvents.map(event => event.type), [
    'tool/code-dispatch-start',
    'tool/code-dispatch',
  ])
  assert.equal(dispatchEvents[1].data.name, 'search_call')
  assert.equal('meta' in dispatchEvents[1].data, false)

  const sessions = JSON.stringify([
    nativeAgent.session.events,
    codeAgent.session.events,
  ])
  assert.equal(sessions.includes(tavilySecret), false)
  assert.equal(sessions.toLowerCase().includes('authorization'), false)
  assert.ok(httpRequests.every(request => request.url === '/tavily/map'))
  assert.ok(httpRequests.every(request => request.authorization === `Bearer ${tavilySecret}`))

  const oldDefinition = onCtx.tools.get('search_call')
  const activeMap = onCtx.tools.execute({
    callId: CallId('active-map-restart'),
    name: 'search_call',
    arguments: {
      operation: 'web_map',
      arguments: { url: `${origin}/site/slow`, limit: 1 },
    },
    agent: nativeAgent,
    signal: new AbortController().signal,
  })
  await waitFor(() => slowRequests === 1, 'web_map did not dispatch the slow fixture request')
  await pluginEntry.fiber.restart()
  const stoppedMap = await activeMap
  assert.equal(stoppedMap.isError, true)
  assert.equal('value' in stoppedMap, false)
  assert.doesNotMatch(JSON.stringify(stoppedMap), /site\/slow|authorization|bearer/i)
  await waitFor(() => slowSocket?.destroyed === true, 'web_map restart left its active socket open')
  assert.notEqual(onCtx.tools.get('search_call'), oldDefinition)
  assert.equal(onCtx.tools.schemas().filter(schema => schema.name === 'search_call').length, 1)
  assert.equal(descriptors().length, 1)

  const postRestart = await onCtx.tools.execute({
    callId: CallId('post-restart-map'),
    name: 'search_call',
    arguments: {
      operation: 'web_map',
      arguments: { url: `${origin}/site/post-restart`, limit: 2 },
    },
    agent: nativeAgent,
    signal: new AbortController().signal,
  })
  assert.equal(postRestart.isError, false)
  assert.equal(postRestart.value.returned_results, 2)

  const enabledConfig = structuredClone(pluginEntry.fiber.config)
  await pluginEntry.fiber.update({
    ...enabledConfig,
    optionalTools: {
      webMap: false,
      researchPlan: false,
      diagnostics: false,
    },
  }, true)
  assert.deepEqual(schemaNames(onCtx), expectedOnNames)
  assert.equal(onCtx.tools.get('search_call')?.name, 'search_call')
  assert.equal(onCtx.tools.get('web_map'), undefined)
  assert.equal(onCtx.tools.get('research_plan'), undefined)
  assert.equal(onCtx.tools.get('search_diagnostics'), undefined)
  await pluginEntry.fiber.update(enabledConfig, true)
  assert.deepEqual(schemaNames(onCtx), expectedOnNames)
  assert.equal(onCtx.tools.schemas().filter(schema => schema.name === 'search_call').length, 1)
  assert.equal(descriptors().length, 1)

  const snapshot = normalize({
    progressive_global_schemas: progressiveGlobalSchemas,
    all_mode_global_schemas: expectedOnNames,
    gateway_schema: gatewaySchema,
    web_map_manifest: mapManifest,
    native_wire_tools: modelRequests[0].tools.map(schema => schema.name),
    code_wire_tools: modelRequests[2].tools.map(schema => schema.name),
    code_system_prompt: modelRequests[2].system,
    missing_credential: missingCredential,
    native_transcript: mapTranscript(nativeAgent.session, 'native-map-call'),
    native_value: nativeObserved.result.value,
    native_card: {
      live: liveCard,
      replay: replayCard,
      metadata: nativeResultEvent.data.meta,
    },
    code_mode: {
      nested_value: nestedObserved.result.value,
      nested_meta: nestedObserved.result.meta ?? null,
      dispatch_events: dispatchEvents,
    },
    restart: {
      active_result: stoppedMap,
      post_restart_value: postRestart.value,
      deprecated_optional_tools_ignored_names: expectedOnNames,
      restored_names: schemaNames(onCtx),
    },
    http_requests: requestSnapshot(),
  })
  assert.equal(JSON.stringify(snapshot).includes(tavilySecret), false)
  if (process.env.UPDATE_SEARCH_ENHANCE_SNAPSHOTS === '1') {
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } else {
    const expected = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert.deepEqual(snapshot, expected)
  }

  await pluginEntry.fiber.dispose()
  assert.deepEqual(schemaNames(onCtx), [])
  assert.equal(descriptors().length, 0)
  assert.equal(onCtx.tools.get('search_call'), undefined)
  assert.equal(onCtx.tools.get('web_map'), undefined)

  for (const handle of handles.reverse()) await handle.dispose()
  handles.length = 0
  await onCtx.fiber.dispose()
  disposedOn = true
  process.stdout.write('web_map headless snapshot: ok (Loader modes, AgentLoop Native/Code, HTTP, cards, restart/dispose, secret exclusion)\n')
} finally {
  for (const handle of handles.reverse()) {
    try {
      await handle.dispose()
    } catch {
      // Best effort after an earlier assertion; root disposal remains authoritative.
    }
  }
  if (offCtx !== undefined && !disposedOff && offCtx.fiber.uid !== null) {
    await offCtx.fiber.dispose()
  }
  if (onCtx !== undefined && !disposedOn && onCtx.fiber.uid !== null) {
    await onCtx.fiber.dispose()
  }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
  await rm(offHome, { force: true, recursive: true })
  await rm(onHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

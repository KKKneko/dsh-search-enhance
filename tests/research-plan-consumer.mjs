import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/research-plan-consumer.json')
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-research-plan-'))
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const secret = 'research-plan-loader-secret-value'
const globalDefinitions = [
  'docs_search',
  'web_extract',
  'search_tools',
  'search_sources',
  'web_map',
  'research_plan',
  'search_diagnostics',
  'context7_resolve_library_id',
  'context7_query_docs',
  'context7_get_library_docs',
  'context7_get_cached_doc_raw',
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
const originalFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls += 1
  throw new Error('research_plan test forbids network')
}

const planArgs = {
  question: 'How does React useEffect cleanup work?',
  budget: 'deep',
  recency_requirement: 'recent',
  locale_domain_scope: 'global',
  source_authority_need: 'high',
  claim_risk: 'medium',
  cross_validation_need: 'high',
  sub_queries: [
    {
      id: 'sq1',
      question: 'Find the official React useEffect cleanup documentation',
      reason: 'The official API semantics are required.',
      tool: 'docs_search',
    },
    {
      id: 'sq2',
      question: 'Inspect the selected official page before making a claim',
      reason: 'Discovery snippets are not page-body evidence.',
      tool: 'web_extract',
      query: 'https://example.test/react/use-effect',
    },
  ],
}

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
    optionalTools:
      webMap: false
      researchPlan: false
      diagnostics: false
`
}

function names(ctx) {
  return ctx.tools.schemas().map(schema => schema.name)
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value))
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

function requestSummary(requests) {
  return requests.map(request => ({
    provider: request.provider,
    model: request.model,
    tools: request.tools,
    system: request.system,
  }))
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

let ctx
let disposed = false
let createdSelfLink = false
const handles = []

try {
  for (const name of credentialNames) delete process.env[name]
  process.env.DSH_HOME = dshHome
  process.env.SEARCH_API_KEY = secret

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
    'dsh-search-enhance-research-plan-consumer',
    loaderConfig,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(
    entry => entry.options.name === 'dsh-search-enhance',
  )
  assert.ok(pluginEntry?.fiber, 'Loader did not create the research-plan fiber')
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

  const observed = []
  ctx.on('tools/result', (exec, result) => {
    if (!['research_plan', 'run_code'].includes(exec.name)) return
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

  const code = `return await tools.research_plan(${JSON.stringify(planArgs)});`
  scriptedModule.setScript([
    { kind: 'tool', id: 'native-plan-call', name: 'research_plan', arguments: planArgs },
    { kind: 'text', text: 'Native offline plan fixture complete.' },
    {
      kind: 'tool',
      id: 'code-plan-call',
      name: 'run_code',
      arguments: { code, description: 'Generate one offline research plan' },
    },
    { kind: 'text', text: 'Code offline plan fixture complete.' },
  ])

  const nativeHandle = await ctx.agents.create({
    sessionId: SessionId('research-plan-native-session'),
    agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
  })
  handles.push(nativeHandle)
  await followup(nativeHandle.agent, 'Generate the explicit offline research plan.')

  const codeHandle = await ctx.agents.create({
    sessionId: SessionId('research-plan-code-session'),
    agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
    setup: agentCtx => { agentCtx.tools.presentAs('code') },
  })
  handles.push(codeHandle)
  await followup(codeHandle.agent, 'Use Code Mode for the same offline research plan.')
  assert.equal(scriptedModule.remainingResponses(), 0)

  const nativeObserved = observed.find(item => item.callId === 'native-plan-call')
  const nestedObserved = observed.find(item => item.name === 'research_plan' && item.nested)
  assert.ok(nativeObserved && !nativeObserved.result.isError)
  assert.ok(nestedObserved && !nestedObserved.result.isError)
  assert.deepEqual(nativeObserved.result.value, nestedObserved.result.value)
  assert.equal(nestedObserved.result.meta, undefined)
  assert.equal(nativeObserved.result.value.plan_complete, true)
  assert.equal(nativeObserved.result.value.research_plan.preflight.network_access, 'not_used')
  assert.equal(nativeObserved.result.value.research_plan.evidence_policy, 'fetch_before_claim')

  const nativeCallEvent = nativeHandle.agent.session.events.find(
    event => event.type === 'tool/call' && String(event.data.callId) === 'native-plan-call',
  )
  const nativeResultEvent = nativeHandle.agent.session.events.find(
    event => event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === 'native-plan-call',
  )
  assert.ok(nativeCallEvent && nativeCallEvent.type === 'tool/call')
  assert.ok(nativeResultEvent && nativeResultEvent.type === 'tool/result')
  const resultBlock = nativeResultEvent.data.message.content[0]
  const definition = ctx.tools.get('research_plan', nativeHandle.agent)
  assert.ok(definition?.presentResult)
  const replayCard = definition.presentResult(
    JSON.parse(nativeCallEvent.data.arguments),
    {
      content: resultBlock.content,
      isError: resultBlock.isError === true,
      ...(nativeResultEvent.data.meta === undefined ? {} : { meta: nativeResultEvent.data.meta }),
    },
  )
  const liveCard = nativeObserved.card
  assert.deepEqual(replayCard, liveCard)
  assert.equal(replayCard?.card, 'generic')

  const codeDispatches = eventSummary(codeHandle.agent.session)
    .filter(event => event.type === 'tool/code-dispatch' || event.type === 'tool/code-dispatch-start')
  assert.deepEqual(codeDispatches.map(event => event.type), [
    'tool/code-dispatch-start',
    'tool/code-dispatch',
  ])
  assert.equal(codeDispatches[1].data.name, 'research_plan')
  assert.equal('meta' in codeDispatches[1].data, false)

  const requests = scriptedModule.requests()
  const nativeRequest = requests.find(request => request.tools.some(tool => tool.name === 'research_plan'))
  const codeRequest = requests.find(request => request.tools.some(tool => tool.name === 'run_code'))
  assert.ok(nativeRequest)
  assert.ok(codeRequest)
  assert.deepEqual(nativeRequest.tools.map(tool => tool.name), modelTools)
  assert.deepEqual(codeRequest.tools.map(tool => tool.name), ['run_code'])
  assert.match(codeRequest.system, /research_plan:/)
  assert.equal(fetchCalls, 0)

  const oldDefinition = ctx.tools.get('research_plan')
  await pluginEntry.fiber.restart()
  assert.deepEqual(names(ctx), globalDefinitions)
  assert.notEqual(ctx.tools.get('research_plan'), oldDefinition)
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === 'research_plan').length, 1)
  const afterRestart = await ctx.tools.execute({
    callId: CallId('research-plan-after-restart'),
    name: 'research_plan',
    arguments: { question: 'offline plan after restart' },
    signal: new AbortController().signal,
  })
  assert.equal(afterRestart.isError, false)

  const current = structuredClone(pluginEntry.fiber.config)
  await pluginEntry.fiber.update({
    ...current,
    optionalTools: { webMap: true, researchPlan: false, diagnostics: true },
  }, true)
  assert.deepEqual(names(ctx), globalDefinitions)
  assert.equal(ctx.tools.get('research_plan')?.name, 'research_plan')
  const compatibilityCall = await ctx.tools.execute({
    callId: CallId('research-plan-compatibility-config'),
    name: 'research_plan',
    arguments: { question: 'deprecated optionalTools must not remove this definition' },
    signal: new AbortController().signal,
  })
  assert.equal(compatibilityCall.isError, false)

  const sessionText = JSON.stringify([
    nativeHandle.agent.session.events,
    codeHandle.agent.session.events,
    requests,
  ])
  assert.equal(sessionText.includes(secret), false)
  assert.equal((await directoryText(dshHome)).includes(secret), false)
  assert.equal(fetchCalls, 0)

  const snapshot = normalize({
    global_definitions: globalDefinitions,
    deprecated_optional_tools_ignored: names(ctx),
    research_plan_schema: ctx.tools.schemas().find(schema => schema.name === 'research_plan'),
    native_wire_tools: nativeRequest.tools.map(tool => tool.name),
    code_wire_tools: codeRequest.tools.map(tool => tool.name),
    code_system_prompt: codeRequest.system,
    native_output: nativeObserved.result.value,
    code_output: nestedObserved.result.value,
    native_card: {
      live: liveCard,
      replay: replayCard,
      metadata: nativeResultEvent.data.meta,
    },
    native_events: eventSummary(nativeHandle.agent.session),
    code_events: codeDispatches,
    after_restart: afterRestart.value,
    compatibility_call: compatibilityCall,
    fetch_calls: fetchCalls,
  })
  assert.equal(JSON.stringify(snapshot).includes(secret), false)

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
  process.stdout.write('research_plan headless snapshot: ok (all-mode visibility, Native/Code parity, generic replay card, offline/no-network, restart/update/dispose)\n')
} finally {
  for (const handle of handles.reverse()) {
    try {
      await handle.dispose()
    } catch {
      // Root disposal remains authoritative after an assertion failure.
    }
  }
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) {
    await ctx.fiber.dispose()
  }
  globalThis.fetch = originalFetch
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

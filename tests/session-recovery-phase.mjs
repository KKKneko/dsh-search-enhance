import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionId,
} from '@deepseek-ai/dsh-session'
import {
  CallId,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const [phase, loaderConfig, statePath] = process.argv.slice(2)
const sessionId = SessionId('fresh-process-search-session')
const coreTools = ['docs_search', 'search_call', 'search_tools', 'web_extract', 'web_search'].sort()
const deferredOperations = [
  'context7_get_cached_doc_raw',
  'context7_get_library_docs',
  'context7_query_docs',
  'context7_resolve_library_id',
  'research_plan',
  'search_diagnostics',
  'search_sources',
  'web_map',
]
const globalToolNames = coreTools

if (!['create', 'reopen'].includes(phase ?? '')) {
  throw new Error('session recovery phase must be create or reopen')
}
if (loaderConfig === undefined || statePath === undefined) {
  throw new Error('session recovery phase requires loader config and state paths')
}

function assertContinuous(events) {
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index]?.seq, index, `session event ${index} is not contiguous`)
  }
}

function assertSupported(events) {
  for (const event of events) {
    assert.ok(
      KNOWN_SESSION_EVENT_TYPES.has(String(event.type)) || event.ignorable === true,
      `unsupported required SessionEvent survived persistence: ${String(event.type)}`,
    )
  }
}

function assertNoPluginEvents(events) {
  assert.equal(
    events.some(event => String(event.type).startsWith('search-enhance/')),
    false,
    'search-enhance appended a custom SessionEvent',
  )
}

function findToolCall(events) {
  const event = events.find(candidate => (
    candidate.type === 'tool/call'
    && String(candidate.data.callId) === 'fresh-process-enhance-call'
  ))
  assert.ok(event && event.type === 'tool/call', 'persisted web_search tool/call is missing')
  return event
}

function findToolResult(events) {
  const event = events.find(candidate => (
    candidate.type === 'tool/result'
    && String(candidate.data.message.content[0]?.toolCallId) === 'fresh-process-enhance-call'
  ))
  assert.ok(event && event.type === 'tool/result', 'persisted web_search tool/result is missing')
  return event
}

function readableToolEvents(events) {
  const call = findToolCall(events)
  const result = findToolResult(events)
  const block = result.data.message.content[0]
  assert.equal(block?.type, 'tool-result')
  const args = JSON.parse(call.data.arguments)
  assert.deepEqual(args, {
    query: 'fresh process recovery fixture',
    profile: 'auto',
    depth: 'compact',
  })
  assert.equal(block.isError === true, false)
  const text = block.content.find(item => item.type === 'text')?.text ?? ''
  assert.match(text, /Fresh-process fixture answer/)
  return {
    call: {
      type: call.type,
      call_id: String(call.data.callId),
      name: call.data.name,
      arguments: args,
    },
    result: {
      type: result.type,
      call_id: String(block.toolCallId),
      is_error: block.isError === true,
      content: block.content,
    },
  }
}

async function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

const [{ boot }, scriptedModule, sourceStorageModule, documentationModule] = await Promise.all([
  import('@deepseek-ai/dsh-app-boot'),
  import(pathToFileURL(fixturePath).href),
  import('dsh-search-enhance/source-storage'),
  import('dsh-search-enhance/documentation'),
])

let ctx
const handles = []
let disposed = false
try {
  if (phase === 'create') {
    scriptedModule.setScript([
      {
        kind: 'tool',
        id: 'fresh-process-context7-activation',
        name: 'search_tools',
        arguments: { capabilities: ['context7'] },
      },
      { kind: 'text', text: 'Context7 disclosure complete.' },
      {
        kind: 'tool',
        id: 'fresh-process-site-map-activation',
        name: 'search_tools',
        arguments: { capabilities: ['site_map'] },
      },
      { kind: 'text', text: 'Site-map disclosure complete.' },
      {
        kind: 'tool',
        id: 'fresh-process-context7-query',
        name: 'search_call',
        arguments: {
          operation: 'context7_query_docs',
          arguments: {
            library_id: '/acme/sdk',
            query: 'fresh process Context7 cache fixture',
            max_snippets: 1,
          },
        },
      },
      { kind: 'text', text: 'Context7 cache fixture complete.' },
      {
        kind: 'tool',
        id: 'fresh-process-enhance-call',
        name: 'web_search',
        arguments: {
          query: 'fresh process recovery fixture',
          profile: 'auto',
          depth: 'compact',
        },
      },
      { kind: 'text', text: 'Fresh-process search fixture complete.' },
    ])
  } else {
    scriptedModule.setScript([
      { kind: 'text', text: 'Recovered parent request complete.' },
      {
        kind: 'tool',
        id: 'fork-child-activation',
        name: 'search_tools',
        arguments: { capabilities: ['planning', 'sources'] },
      },
      { kind: 'text', text: 'Fork child disclosure complete.' },
      {
        kind: 'tool',
        id: 'fork-sibling-activation',
        name: 'search_tools',
        arguments: { capabilities: ['diagnostics'] },
      },
      { kind: 'text', text: 'Fork sibling disclosure complete.' },
      {
        kind: 'tool',
        id: 'fork-parent-activation',
        name: 'search_tools',
        arguments: { capabilities: ['planning'] },
      },
      { kind: 'text', text: 'Fork parent disclosure complete.' },
    ])
  }

  ctx = await boot(
    `dsh-search-enhance-session-${phase}`,
    loaderConfig,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await ctx.loader.await()

  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), globalToolNames)
  for (const operation of deferredOperations) assert.equal(ctx.tools.get(operation), undefined)
  const pluginToolsFor = agent => ctx.tools.schemas(agent).map(schema => schema.name).sort()
  const requestTools = request => (request.tools ?? []).map(schema => schema.name).sort()

  if (phase === 'create') {
    const observedResults = new Map()
    const observedCards = new Map()
    const disposeObserver = ctx.on('tools/result', (exec, result) => {
      observedResults.set(String(exec.callId), result)
      const definition = ctx.tools.get(exec.name, exec.agent)
      const card = definition?.presentResult?.(exec.arguments, {
        content: result.content,
        isError: result.isError,
        ...(result.meta === undefined ? {} : { meta: result.meta }),
      })
      if (card !== undefined) observedCards.set(String(exec.callId), structuredClone(card))
    })

    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
    })
    handles.push(handle)
    assert.deepEqual(pluginToolsFor(handle.agent), coreTools)

    await followup(handle.agent, 'Activate Context7 before the fork boundary.')
    const forkBoundaryEvent = handle.agent.session.events.at(-1)
    assert.equal(forkBoundaryEvent?.type, 'turn/end')
    const forkBoundary = forkBoundaryEvent.seq
    assert.deepEqual(pluginToolsFor(handle.agent), coreTools)

    await followup(handle.agent, 'Activate site_map after the fork boundary.')
    assert.deepEqual(pluginToolsFor(handle.agent), coreTools)
    await followup(handle.agent, 'Populate the Context7 cache through the granular public tool.')
    await followup(handle.agent, 'Run the fresh-process web_search fixture.')
    assert.equal(scriptedModule.remainingResponses(), 0)

    const context7Result = observedResults.get('fresh-process-context7-query')
    assert.ok(context7Result && context7Result.isError === false, 'Context7 query did not complete')
    const docRef = context7Result.value?.doc_ref
    assert.equal(typeof docRef, 'string', 'Context7 query did not publish doc_ref')
    const observedResult = observedResults.get('fresh-process-enhance-call')
    assert.ok(observedResult && observedResult.isError === false, 'web_search did not complete')
    const sourceRef = observedResult.value?.source_ref
    assert.equal(typeof sourceRef, 'string', 'web_search did not publish source_ref')
    assert.deepEqual(pluginToolsFor(handle.agent), coreTools)

    const modelRequests = scriptedModule.requests()
    assert.equal(modelRequests.length, 8)
    const modelToolViews = modelRequests.map(requestTools)
    assert.ok(modelToolViews.every(view => JSON.stringify(view) === JSON.stringify(coreTools)))

    const participated = await ctx.sessions.flush(handle.agent.session)
    assert.equal(participated, true, 'JSONL persistence did not participate in flush')
    const raw = await ctx.sessionPersistence.readRaw(sessionId)
    assert.ok(raw, 'JSONL session artifact was not materialized')

    const events = handle.agent.session.events
    assertContinuous(events)
    assertSupported(events)
    assertNoPluginEvents(events)
    const toolEvents = readableToolEvents(events)
    assert.match(raw.content, /"type":"tool\/call"/)
    assert.match(raw.content, /"type":"tool\/result"/)
    assert.match(raw.content, /fresh process recovery fixture/)
    assert.match(raw.content, /Fresh-process fixture answer/)
    assert.match(raw.content, new RegExp(sourceRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(raw.content, new RegExp(docRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const forbiddenPersistedFacts = {
      search_credential: 'fresh-process-search-secret',
      context7_credential: 'fresh-process-context7-secret',
      endpoint: '/search/v1/chat/completions',
      search_model: 'fresh-process-search-model',
      profile_prompt: '# Search Profile: Auto',
      reasoning_field: 'reasoning_effort',
    }
    for (const [label, value] of Object.entries(forbiddenPersistedFacts)) {
      assert.equal(raw.content.includes(value), false, `${label} unexpectedly entered session JSONL`)
    }

    const sourceStoragePath = join(
      process.env.DSH_HOME,
      'domain-storage',
      `${sourceStorageModule.SOURCE_RECORD_DOMAIN_NAME}.json`,
    )
    const context7StoragePath = join(
      process.env.DSH_HOME,
      'domain-storage',
      `${documentationModule.CONTEXT7_CACHE_DOMAIN_NAME}.json`,
    )
    const [sourceStorage, context7Storage] = await Promise.all([
      readFile(sourceStoragePath, 'utf8'),
      readFile(context7StoragePath, 'utf8'),
    ])
    assert.match(sourceStorage, new RegExp(sourceRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(context7Storage, new RegExp(docRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(sourceStorage.includes(forbiddenPersistedFacts.search_credential), false)
    assert.equal(context7Storage.includes(forbiddenPersistedFacts.context7_credential), false)

    const context7ResultEvent = events.find(event => (
      event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === 'fresh-process-context7-query'
    ))
    assert.ok(context7ResultEvent?.type === 'tool/result')
    const context7Block = context7ResultEvent.data.message.content[0]
    assert.equal(context7Block?.type, 'tool-result')

    await writeFile(statePath, `${JSON.stringify({
      sessionId: String(sessionId),
      sourceRef,
      docRef,
      forkBoundary,
      phase1: {
        pid: process.pid,
        event_count: events.length,
        event_types: [...new Set(events.map(event => String(event.type)))],
        custom_event_types: events
          .map(event => String(event.type))
          .filter(type => type.startsWith('search-enhance/')),
        sequences_contiguous: true,
        event_types_supported: true,
        model_tool_views: modelToolViews,
        fork_boundary_event_type: forkBoundaryEvent.type,
        context7_card: observedCards.get('fresh-process-context7-query'),
        context7_model_content: context7Block.content,
        tool_events: toolEvents,
        raw_artifact: {
          filename: raw.filename,
          has_tool_call: raw.content.includes('"type":"tool/call"'),
          has_tool_result: raw.content.includes('"type":"tool/result"'),
          has_tool_args: raw.content.includes('fresh process recovery fixture'),
          has_final_result: raw.content.includes('Fresh-process fixture answer'),
          has_source_ref: raw.content.includes(sourceRef),
          has_doc_ref: raw.content.includes(docRef),
          has_search_credential: raw.content.includes(forbiddenPersistedFacts.search_credential),
          has_context7_credential: raw.content.includes(forbiddenPersistedFacts.context7_credential),
          has_resolved_endpoint: raw.content.includes(forbiddenPersistedFacts.endpoint),
          has_search_model: raw.content.includes(forbiddenPersistedFacts.search_model),
          has_profile_prompt: raw.content.includes(forbiddenPersistedFacts.profile_prompt),
          has_reasoning_field: raw.content.includes(forbiddenPersistedFacts.reasoning_field),
        },
        private_source_record_durable: sourceStorage.includes(sourceRef),
        context7_cache_durable: context7Storage.includes(docRef),
      },
    }, null, 2)}\n`, 'utf8')

    disposeObserver()
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.sessionId, String(sessionId))
    assert.equal(typeof state.sourceRef, 'string')
    assert.equal(typeof state.docRef, 'string')
    assert.equal(Number.isSafeInteger(state.forkBoundary), true)

    const inspection = await ctx.sessionPersistence.load(sessionId)
    assert.equal(String(inspection.meta.id), String(sessionId))
    assertContinuous(inspection.events)
    assertSupported(inspection.events)
    assertNoPluginEvents(inspection.events)
    const toolEvents = readableToolEvents(inspection.events)

    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
    })
    handles.push(handle)
    await handle.agent.whenIdle()
    assert.ok(
      handle.agent.session.events.length >= inspection.events.length,
      'resumed Session lost persisted events',
    )
    assert.deepEqual(
      handle.agent.session.events.slice(0, inspection.events.length),
      inspection.events,
      'resume did not preserve the loaded JSONL prefix',
    )
    assertContinuous(handle.agent.session.events)
    assertSupported(handle.agent.session.events)
    assertNoPluginEvents(handle.agent.session.events)

    const recoveredTools = coreTools
    const recoveredBeforeRequest = pluginToolsFor(handle.agent)
    assert.deepEqual(recoveredBeforeRequest, recoveredTools)
    await followup(handle.agent, 'Assemble the first request only after cold recovery.')
    const firstRequestTools = requestTools(scriptedModule.requests()[0])
    assert.deepEqual(firstRequestTools, recoveredTools)

    const page = await ctx.tools.execute({
      callId: CallId('fresh-process-page-call'),
      name: 'search_call',
      arguments: {
        operation: 'search_sources',
        arguments: {
          source_ref: state.sourceRef,
          offset: 0,
          limit: 1,
          format: 'full',
        },
      },
      agent: handle.agent,
      signal: new AbortController().signal,
    })
    assert.equal(page.isError, false, 'restored source_ref pagination failed')
    assert.equal(page.value.state, 'found')
    assert.equal(page.value.source_ref, state.sourceRef)
    assert.equal(page.value.returned, 1)
    assert.match(page.value.sources[0]?.url ?? '', /\/evidence\/primary$/)

    const cached = await ctx.tools.execute({
      callId: CallId('fresh-process-context7-cache-read'),
      name: 'search_call',
      arguments: {
        operation: 'context7_get_cached_doc_raw',
        arguments: { doc_ref: state.docRef },
      },
      agent: handle.agent,
      signal: new AbortController().signal,
    })
    assert.equal(cached.isError, false, 'restored Context7 cache read failed')
    assert.equal(cached.value.state, 'found')
    assert.equal(cached.value.doc_ref, state.docRef)
    assert.equal(cached.value.raw_envelope?.library_id, '/acme/sdk')

    const context7CallEvent = inspection.events.find(event => (
      event.type === 'tool/call'
      && String(event.data.callId) === 'fresh-process-context7-query'
    ))
    const context7ResultEvent = inspection.events.find(event => (
      event.type === 'tool/result'
      && String(event.data.message.content[0]?.toolCallId) === 'fresh-process-context7-query'
    ))
    assert.ok(context7CallEvent?.type === 'tool/call')
    assert.ok(context7ResultEvent?.type === 'tool/result')
    const context7ResultBlock = context7ResultEvent.data.message.content[0]
    assert.equal(context7ResultBlock?.type, 'tool-result')
    const context7Definition = ctx.tools.get('search_call', handle.agent)
    const replayCard = context7Definition?.presentResult?.(
      JSON.parse(context7CallEvent.data.arguments),
      {
        content: context7ResultBlock.content,
        isError: context7ResultBlock.isError === true,
        ...(context7ResultEvent.data.meta === undefined ? {} : { meta: context7ResultEvent.data.meta }),
      },
    )
    assert.deepEqual(replayCard, state.phase1.context7_card)
    assert.deepEqual(context7ResultBlock.content, state.phase1.context7_model_content)

    const publicForks = []
    const createForkAgent = async id => {
      const seedSessionId = SessionId(`${id}-public-fork-seed`)
      let forked
      const forkPlugin = forkCtx => {
        forked = forkCtx.sessions.fork(handle.agent.session, state.forkBoundary, seedSessionId)
      }
      forkPlugin.inject = ['sessions']
      const forkFiber = ctx.plugin(forkPlugin)
      await forkFiber.await()
      assert.ok(forked, 'public sessions.fork did not return a Session')
      assert.equal(forked.header.seedLength, state.forkBoundary + 1)
      assert.equal(String(forked.header.parentSession), String(sessionId))
      const seed = structuredClone(forked.events.slice(0, forked.header.seedLength))
      const endSeed = forked.events[forked.header.seedLength]
      assert.equal(endSeed?.type, 'session/end-seed')
      assertContinuous(forked.events)
      assertSupported(forked.events)
      assertNoPluginEvents(forked.events)
      publicForks.push({
        boundary: state.forkBoundary,
        seed_length: forked.header.seedLength,
        marker: endSeed.type,
        event_types: [...new Set(forked.events.map(event => String(event.type)))],
      })
      await forkFiber.dispose()
      assert.equal(ctx.sessions.get(seedSessionId), undefined)

      const childHandle = await ctx.agents.create({
        sessionId: SessionId(id),
        seed,
        meta: {
          parentSession: sessionId,
          seedLength: seed.length,
        },
        agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
      })
      handles.push(childHandle)
      assert.equal(childHandle.agent.session.header.seedLength, seed.length)
      assert.equal(String(childHandle.agent.session.header.parentSession), String(sessionId))
      return childHandle.agent
    }

    const childAgent = await createForkAgent('fork-child-session')
    const siblingAgent = await createForkAgent('fork-sibling-session')
    const inheritedTools = coreTools
    assert.deepEqual(pluginToolsFor(childAgent), inheritedTools)
    assert.deepEqual(pluginToolsFor(siblingAgent), inheritedTools)

    const freshHandle = await ctx.agents.create({
      sessionId: SessionId('unrelated-fresh-session'),
      agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
    })
    handles.push(freshHandle)
    assert.deepEqual(pluginToolsFor(freshHandle.agent), coreTools)

    let operationCall = 0
    const callOperation = (agent, operation, argumentsValue) => ctx.tools.execute({
      callId: CallId(`recovery-operation-${++operationCall}`),
      name: 'search_call',
      arguments: { operation, arguments: argumentsValue },
      agent,
      signal: new AbortController().signal,
    })
    const unavailableCode = result => result.error?.info?.code

    const parentPlanningBefore = await callOperation(
      handle.agent,
      'research_plan',
      { question: 'parent planning before activation' },
    )
    const siblingPlanningBefore = await callOperation(
      siblingAgent,
      'research_plan',
      { question: 'sibling planning before activation' },
    )
    assert.equal(unavailableCode(parentPlanningBefore), 'SEARCH_OPERATION_UNAVAILABLE')
    assert.equal(unavailableCode(siblingPlanningBefore), 'SEARCH_OPERATION_UNAVAILABLE')

    await followup(childAgent, 'Activate child-only planning and source paging.')
    assert.deepEqual(pluginToolsFor(handle.agent), coreTools)
    assert.deepEqual(pluginToolsFor(siblingAgent), coreTools)
    const childPlan = await callOperation(
      childAgent,
      'research_plan',
      { question: 'child planning after activation' },
    )
    assert.equal(childPlan.isError, false)
    assert.equal(childPlan.value.research_plan.preflight.web_map_available, false)
    const childSourceRead = await callOperation(
      childAgent,
      'search_sources',
      { source_ref: state.sourceRef, offset: 0, limit: 1, format: 'compact' },
    )
    assert.equal(childSourceRead.isError, false)
    assert.deepEqual(childSourceRead.value, {
      state: 'not_found',
      code: 'SOURCE_REF_NOT_FOUND',
    })

    await followup(siblingAgent, 'Activate sibling-only diagnostics.')
    const siblingDiagnostics = await callOperation(siblingAgent, 'search_diagnostics', { action: 'show' })
    const childDiagnostics = await callOperation(childAgent, 'search_diagnostics', { action: 'show' })
    const parentDiagnostics = await callOperation(handle.agent, 'search_diagnostics', { action: 'show' })
    assert.equal(siblingDiagnostics.isError, false)
    assert.equal(unavailableCode(childDiagnostics), 'SEARCH_OPERATION_UNAVAILABLE')
    assert.equal(unavailableCode(parentDiagnostics), 'SEARCH_OPERATION_UNAVAILABLE')

    await followup(handle.agent, 'Activate parent-only planning after both forks.')
    const parentPlan = await callOperation(
      handle.agent,
      'research_plan',
      { question: 'parent planning after activation' },
    )
    const siblingPlanAfter = await callOperation(
      siblingAgent,
      'research_plan',
      { question: 'sibling planning remains inactive' },
    )
    const freshPlan = await callOperation(
      freshHandle.agent,
      'research_plan',
      { question: 'fresh planning remains inactive' },
    )
    assert.equal(parentPlan.isError, false)
    assert.equal(parentPlan.value.research_plan.preflight.web_map_available, true)
    assert.equal(unavailableCode(siblingPlanAfter), 'SEARCH_OPERATION_UNAVAILABLE')
    assert.equal(unavailableCode(freshPlan), 'SEARCH_OPERATION_UNAVAILABLE')
    assert.deepEqual(pluginToolsFor(childAgent), coreTools)
    assert.deepEqual(pluginToolsFor(siblingAgent), coreTools)
    assert.deepEqual(pluginToolsFor(handle.agent), coreTools)
    assert.deepEqual(pluginToolsFor(freshHandle.agent), coreTools)
    assert.equal(scriptedModule.remainingResponses(), 0)

    for (const agent of ctx.agents.list()) {
      assertContinuous(agent.session.events)
      assertSupported(agent.session.events)
      assertNoPluginEvents(agent.session.events)
    }

    await ctx.sessions.flush(handle.agent.session)
    const resumedRaw = await ctx.sessionPersistence.readRaw(sessionId)
    assert.ok(resumedRaw)
    assert.equal(resumedRaw.content.includes('search-enhance/'), false)
    assert.equal(resumedRaw.content.includes('fresh-process-search-secret'), false)
    assert.equal(resumedRaw.content.includes('fresh-process-context7-secret'), false)

    state.phase2 = {
      pid: process.pid,
      loaded_event_count: inspection.events.length,
      loaded_event_types: [...new Set(inspection.events.map(event => String(event.type)))],
      resumed_event_count: handle.agent.session.events.length,
      resumed_event_types: [...new Set(handle.agent.session.events.map(event => String(event.type)))],
      custom_event_types: ctx.agents.list()
        .flatMap(agent => agent.session.events.map(event => String(event.type)))
        .filter(type => type.startsWith('search-enhance/')),
      session_format_unsupported_error: false,
      sequences_contiguous: true,
      event_types_supported: true,
      tool_events: toolEvents,
      recovered_tools_before_first_request: recoveredBeforeRequest,
      first_request_tools: firstRequestTools,
      first_request_restored_before_assembly: true,
      source_page: page.value,
      private_source_record_restored: true,
      context7_cache: {
        state: cached.value.state,
        doc_ref: cached.value.doc_ref,
        library_id: cached.value.raw_envelope.library_id,
      },
      context7_cache_restored: true,
      context7_replay_card: replayCard,
      context7_model_content: context7ResultBlock.content,
      public_fork_used: true,
      public_forks: publicForks,
      fork_tools: {
        inherited: inheritedTools,
        child_after_activation: pluginToolsFor(childAgent),
        sibling_after_activation: pluginToolsFor(siblingAgent),
        parent_after_activation: pluginToolsFor(handle.agent),
        unrelated_fresh: pluginToolsFor(freshHandle.agent),
      },
      fork_operation_access: {
        parent_planning_before: unavailableCode(parentPlanningBefore),
        sibling_planning_before: unavailableCode(siblingPlanningBefore),
        child_planning_after: childPlan.isError ? 'error' : 'active',
        child_web_map_active: childPlan.value.research_plan.preflight.web_map_available,
        sibling_diagnostics_after: siblingDiagnostics.isError ? 'error' : 'active',
        child_diagnostics_after: unavailableCode(childDiagnostics),
        parent_diagnostics_after: unavailableCode(parentDiagnostics),
        parent_planning_after: parentPlan.isError ? 'error' : 'active',
        parent_web_map_active: parentPlan.value.research_plan.preflight.web_map_available,
        sibling_planning_after: unavailableCode(siblingPlanAfter),
        unrelated_planning: unavailableCode(freshPlan),
      },
      source_isolation: childSourceRead.value.state === 'not_found',
      no_additional_http_dispatch: true,
      loader_disposed: false,
    }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  for (const activeHandle of handles.reverse()) await activeHandle.dispose()
  handles.length = 0
  assert.equal(ctx.agents.list().length, 0, 'agent registry leaked after handle disposal')
  assert.equal(ctx.sessions.list().length, 0, 'session store leaked after handle disposal')
  await ctx.fiber.dispose()
  disposed = true
  assert.equal(ctx.get(sourceStorageModule.SOURCE_RECORD_SERVICE_KEY), undefined)
  assert.equal(ctx.get('agents'), undefined)
  assert.equal(ctx.get('sessions'), undefined)
  assert.equal(ctx.get('tools'), undefined)

  if (phase === 'reopen') {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.phase2.loader_disposed = true
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
} finally {
  for (const activeHandle of handles.reverse()) {
    try {
      await activeHandle.dispose()
    } catch {
      // Root disposal below remains the final owner after a failed assertion.
    }
  }
  handles.length = 0
  if (ctx !== undefined && !disposed) {
    await ctx.fiber.dispose()
  }
}

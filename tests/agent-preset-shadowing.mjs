import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const scriptedLlmPath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const nativeWebSearchPath = join(packageRoot, 'tests/fixtures/web-search-stub.mjs')
const codePresentationPath = join(packageRoot, 'tests/fixtures/code-presentation.mjs')
const hideWebSearchPath = join(packageRoot, 'tests/fixtures/hide-web-search.mjs')
const noopPath = join(packageRoot, 'tests/fixtures/noop.mjs')
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-presets-'))
const presetRoot = join(dshHome, 'agent-presets')
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const previousDshHome = process.env.DSH_HOME
const previousSearchKey = process.env.SEARCH_API_KEY
const sockets = new Set()
let searchCalls = 0

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (request.url === '/search/v1/models' && request.method === 'GET') {
      json(response, 200, { data: [{ id: 'preset-shadow-model' }] })
      return
    }
    if (request.url === '/search/v1/chat/completions' && request.method === 'POST') {
      searchCalls += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const query = body.messages?.at(-1)?.content
      json(response, 200, {
        choices: [{
          message: {
            content: `Scoped plugin answer for ${query}.\n\nSources:\n- [Preset shadow evidence](${origin}/evidence)`,
          },
        }],
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
if (address === null || typeof address === 'string') throw new Error('preset fixture server has no address')
const origin = `http://127.0.0.1:${address.port}`

async function writePreset(id, rows) {
  const directory = join(presetRoot, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'agent.cordis.yml'), `${rows.join('\n')}\n`, 'utf8')
}

await Promise.all([
  writePreset('standard', [
    '- id: native-web-search',
    `  name: ${JSON.stringify(nativeWebSearchPath)}`,
  ]),
  writePreset('code', [
    '- id: native-web-search',
    `  name: ${JSON.stringify(nativeWebSearchPath)}`,
    '- id: code-presentation',
    `  name: ${JSON.stringify(codePresentationPath)}`,
  ]),
  writePreset('missing', [
    '- id: noop',
    `  name: ${JSON.stringify(noopPath)}`,
  ]),
  writePreset('hidden', [
    '- id: hide-web-search',
    `  name: ${JSON.stringify(hideWebSearchPath)}`,
  ]),
])

process.env.DSH_HOME = dshHome
process.env.SEARCH_API_KEY = 'preset-shadow-secret'
let ctx
let disposed = false
let createdSelfLink = false
const handles = []
let disposeHostNative

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
    root: ${JSON.stringify(join(dshHome, 'storage'))}
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
  name: ${JSON.stringify(scriptedLlmPath)}
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
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    includeUserRoot: false
    roots:
      - path: ${JSON.stringify(presetRoot)}
        trust: system
- id: search-enhance
  name: dsh-search-enhance
  config:
    fallbackMode: off
    searchApi:
      baseUrl: ${JSON.stringify(`${origin}/search/v1`)}
      model: preset-shadow-model
      timeoutMs: 10000
    retry:
      maxAttempts: 1
      baseDelayMs: 0
      multiplier: 1
      maxDelayMs: 0
      maxTotalDelayMs: 0
      jitterRatio: 0
    extraDiscoverySources:
      auto: 0
`, 'utf8')

  const [{ boot }, nativeWebSearchModule] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(nativeWebSearchPath).href),
  ])
  nativeWebSearchModule.resetCalls()
  ctx = await boot(
    'dsh-search-enhance-agent-preset-shadowing',
    loaderConfig,
    undefined,
    undefined,
    packageJsonUrl,
  )
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
  assert.ok(pluginEntry?.fiber, 'Loader did not create the search-enhance fiber')
  await pluginEntry.fiber.await()

  async function createAgent(id, preset) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
    })
    handles.push(handle)
    return handle.agent
  }

  const missingAgent = await createAgent('preset-missing-session', 'missing')
  assert.equal(ctx.tools.get('web_search', missingAgent), undefined)
  assert.equal(ctx.tools.schemas(missingAgent).some(schema => schema.name === 'web_search'), false)
  const missingResult = await ctx.tools.execute({
    callId: CallId('missing-web-search'),
    name: 'web_search',
    arguments: { query: 'must remain absent' },
    agent: missingAgent,
    signal: new AbortController().signal,
  })
  assert.equal(missingResult.error?.info?.code, 'UNKNOWN_TOOL')
  await handles.pop().dispose()

  const standardAgent = await createAgent('preset-standard-session', 'standard')
  const codeAgent = await createAgent('preset-code-session', 'code')
  const standardPresetKey = await ctx.agentPresets.standingKeyFor('standard')
  const codePresetKey = await ctx.agentPresets.standingKeyFor('code')
  const standardNativeDefinition = ctx.tools.get('web_search', standardPresetKey)
  const codeNativeDefinition = ctx.tools.get('web_search', codePresetKey)
  assert.ok(standardNativeDefinition)
  assert.ok(codeNativeDefinition)

  const hostNativeDefinition = defineTool({
    name: 'web_search',
    description: 'Host-native web search used only for Preset deny verification.',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return `host:${args.query}` },
  })
  disposeHostNative = ctx.tools.register(hostNativeDefinition)
  const hiddenAgent = await createAgent('preset-hidden-session', 'hidden')
  assert.equal(ctx.tools.get('web_search', hiddenAgent), undefined)
  assert.equal(ctx.tools.schemas(hiddenAgent).some(schema => schema.name === 'web_search'), false)
  const hiddenResult = await ctx.tools.execute({
    callId: CallId('hidden-web-search'),
    name: 'web_search',
    arguments: { query: 'must remain hidden' },
    agent: hiddenAgent,
    signal: new AbortController().signal,
  })
  assert.equal(hiddenResult.error?.info?.code, 'UNKNOWN_TOOL')

  function richSchema(agent) {
    const schemas = ctx.tools.schemas(agent).filter(schema => schema.name === 'web_search')
    assert.equal(schemas.length, 1)
    assert.deepEqual(Object.keys(schemas[0].parameters.properties), ['query', 'profile', 'depth'])
    return schemas[0]
  }

  richSchema(standardAgent)
  richSchema(codeAgent)
  assert.notEqual(ctx.tools.get('web_search', standardAgent), standardNativeDefinition)
  assert.notEqual(ctx.tools.get('web_search', codeAgent), codeNativeDefinition)

  const standardResult = await ctx.tools.execute({
    callId: CallId('standard-rich-web-search'),
    name: 'web_search',
    arguments: { query: 'standard preset shadow', profile: 'auto', depth: 'compact' },
    agent: standardAgent,
    signal: new AbortController().signal,
  })
  assert.equal(standardResult.isError, false)
  assert.equal(standardResult.value.evidence_level, 'discovery')
  assert.equal(standardResult.value.state, 'complete')
  assert.equal(typeof standardResult.value.source_ref, 'string')
  assert.ok(Array.isArray(standardResult.value.warnings))
  assert.equal(standardResult.meta?.type, 'web_search')

  const codePromptModule = await import('@deepseek-ai/dsh-system-prompt')
  const codePrompt = codePromptModule.renderPrompt(await ctx.systemPrompt.assemble({
    scope: codeAgent,
    agent: codeAgent,
  }))
  const codeArgsBlock = codePrompt.split('interface ToolOutputMap {')[0]
  const codeOutputBlock = codePrompt.split('interface ToolOutputMap {')[1]
  assert.equal((codeArgsBlock.match(/\n  web_search: \{/g) ?? []).length, 1)
  assert.equal((codeOutputBlock.match(/\n  web_search: \{/g) ?? []).length, 1)
  assert.match(codePrompt, /profile\?: "auto"/)
  assert.match(codePrompt, /depth\?: "compact"/)
  const codeResult = await ctx.tools.execute({
    callId: CallId('code-rich-web-search'),
    name: 'run_code',
    arguments: {
      code: "return await tools.web_search({ query: 'code preset shadow', profile: 'fact_check', depth: 'compact' });",
      description: 'Execute the rich web_search binding through the generated Code Mode SDK',
    },
    agent: codeAgent,
    signal: new AbortController().signal,
  })
  assert.equal(codeResult.isError, false)
  assert.equal(codeResult.value.result.evidence_level, 'discovery')
  assert.equal(codeResult.value.result.state, 'complete')
  assert.equal(typeof codeResult.value.result.source_ref, 'string')
  assert.equal(searchCalls, 2)
  assert.equal(nativeWebSearchModule.callCount(), 0)

  const standardBeforeHmr = ctx.tools.get('web_search', standardAgent)
  await pluginEntry.fiber.restart()
  richSchema(standardAgent)
  richSchema(codeAgent)
  assert.notEqual(ctx.tools.get('web_search', standardAgent), standardNativeDefinition)
  assert.notEqual(ctx.tools.get('web_search', standardAgent), standardBeforeHmr)
  assert.notEqual(ctx.tools.get('web_search', codeAgent), codeNativeDefinition)
  assert.equal(ctx.tools.get('web_search', hiddenAgent), undefined)

  await pluginEntry.fiber.dispose()
  assert.equal(ctx.tools.get('web_search', standardAgent), standardNativeDefinition)
  assert.equal(ctx.tools.get('web_search', codeAgent), codeNativeDefinition)
  assert.equal(ctx.tools.get('web_search', hiddenAgent), undefined)
  const restoredNative = await ctx.tools.execute({
    callId: CallId('restored-native-web-search'),
    name: 'web_search',
    arguments: { query: 'restored after plugin disposal' },
    agent: standardAgent,
    signal: new AbortController().signal,
  })
  assert.equal(restoredNative.isError, false)
  assert.equal(restoredNative.value, 'stub:restored after plugin disposal')
  assert.equal(nativeWebSearchModule.callCount(), 1)

  for (const handle of handles.reverse()) await handle.dispose()
  handles.length = 0
  disposeHostNative()
  disposeHostNative = undefined
  await ctx.fiber.dispose()
  disposed = true
  process.stdout.write('agent preset shadowing: ok (standard/code rich web_search, missing/deny preservation, HMR/native restoration)\n')
} finally {
  for (const handle of handles.reverse()) {
    try { await handle.dispose() } catch {}
  }
  if (disposeHostNative !== undefined) disposeHostNative()
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) await ctx.fiber.dispose()
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  if (previousSearchKey === undefined) delete process.env.SEARCH_API_KEY
  else process.env.SEARCH_API_KEY = previousSearchKey
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ts from 'typescript'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(packageRoot, 'tests/fixtures/scripted-llm.mjs')
const webFetchFixturePath = join(packageRoot, 'tests/fixtures/web-fetch-stub.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/web-extract-consumer.json')
const packageJsonUrl = pathToFileURL(join(packageRoot, 'package.json')).href
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const tavilySecret = 'web-extract-tavily-secret-value'
const firecrawlSecret = 'web-extract-firecrawl-secret-value'
const credentialNames = ['SEARCH_API_KEY', 'CONTEXT7_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY']
const previousEnvironment = new Map([
  ['DSH_HOME', process.env.DSH_HOME],
  ...credentialNames.map(name => [name, process.env[name]]),
])
const longMiddle = 'MIDDLE_SHOULD_ONLY_BE_IN_SPILL'
const longContent = `HEAD-${'A'.repeat(2600)}${longMiddle}${'B'.repeat(2600)}-TAIL`
const httpRequests = []
const sockets = new Set()

async function assertIndependentProductionGraph() {
  const libRoot = join(packageRoot, 'lib')
  const files = (await readdir(libRoot, { recursive: true }))
    .filter(name => name.endsWith('.js'))
    .map(name => join(libRoot, name))
  assert.ok(files.length > 0, 'built production graph is empty')
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    )
    const visit = node => {
      if (ts.isStringLiteralLike(node) && node.text === 'web_fetch') {
        assert.fail(`production graph references official web_fetch: ${file}`)
      }
      if (
        ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'ctx'
        && node.name.text === 'web'
      ) {
        assert.fail(`production graph queries ctx.web: ${file}`)
      }
      if (
        ts.isElementAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'ctx'
        && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === 'web'
      ) {
        assert.fail(`production graph queries ctx['web']: ${file}`)
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'ctx'
        && node.expression.name.text === 'get'
        && node.arguments.some(argument => ts.isStringLiteralLike(argument) && argument.text === 'web')
      ) {
        assert.fail(`production graph queries ctx.get('web'): ${file}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

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

function targetPath(value) {
  return new URL(value).pathname
}

const server = createServer(async (request, response) => {
  try {
    const bodyText = await requestBody(request)
    const body = bodyText.length === 0 ? undefined : JSON.parse(bodyText)
    httpRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    })

    if (request.url === '/tavily/extract' && request.method === 'POST') {
      const target = body?.urls?.[0]
      const path = typeof target === 'string' ? targetPath(target) : ''
      if (path === '/target/tavily') {
        json(response, 200, {
          results: [{
            url: target,
            title: 'Tavily extracted fixture',
            raw_content: 'Tavily third-party extracted content.',
          }],
        })
        return
      }
      if (path === '/target/spill') {
        json(response, 200, {
          results: [{
            url: target,
            title: 'Long Tavily spill fixture',
            raw_content: longContent,
          }],
        })
        return
      }
      json(response, 200, { results: [] })
      return
    }

    if (request.url === '/firecrawl/v2/scrape' && request.method === 'POST') {
      const path = typeof body?.url === 'string' ? targetPath(body.url) : ''
      const format = body?.formats?.[0]
      if (path === '/target/firecrawl' && format === 'markdown') {
        json(response, 200, {
          success: true,
          data: {
            markdown: 'Firecrawl fallback extracted content.',
            metadata: {
              sourceURL: body.url,
              title: 'Firecrawl extracted fixture',
            },
          },
        })
        return
      }
      json(response, 200, {
        success: true,
        data: {
          markdown: '',
          html: '',
          rawHtml: '',
          metadata: { sourceURL: body?.url },
        },
      })
      return
    }

    if (request.url === '/target/smart') {
      const bodyValue = '<!doctype html><html><head><title>Smart fixture</title><meta name="author" content="Ada Smart"><link rel="canonical" href="/target/smart"></head><body><main><article><h1>Smart direct fixture</h1><p>This stable local HTML has enough meaningful words for Defuddle to select readable content without JavaScript or a login session.</p><p>A second paragraph keeps the deterministic extraction path non-empty and replayable.</p></article></main></body></html>'
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(bodyValue),
      })
      response.end(bodyValue)
      return
    }

    if (request.url === '/target/direct-json') {
      json(response, 200, { fixture: 'direct-json', unicode: '界🙂' })
      return
    }

    if (request.url === '/target/direct-raw') {
      const bodyValue = 'raw direct fixture <tag>preserved</tag>'
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(bodyValue),
      })
      response.end(bodyValue)
      return
    }

    if (request.url === '/target/all-fail') {
      request.socket.destroy()
      return
    }

    if (request.url === '/target/metadata-only') {
      const bodyValue = Buffer.from([0, 1, 2, 3, 4, 5])
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bodyValue.byteLength,
        'content-disposition': 'attachment; filename="fixture.bin"',
      })
      response.end(bodyValue)
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
if (address === null || typeof address === 'string') throw new Error('web extract fixture has no address')
const origin = `http://127.0.0.1:${address.port}`

function normalize(value, roots = []) {
  let serialized = JSON.stringify(value)
    .replaceAll(origin, '<fixture-origin>')
    .replaceAll(longContent, `<long-content:${Buffer.byteLength(longContent)}>`)
    .replace(/A{32,}/g, '<A-run>')
    .replace(/B{32,}/g, '<B-run>')
  for (const root of roots) serialized = serialized.replaceAll(root, '<temp-root>')
  const parsed = JSON.parse(serialized)
  const normalizedString = value => value
    .replace(/duration_ms=\d+/g, 'duration_ms=<duration-ms>')
    .replace(/"duration_ms": \d+/g, '"duration_ms": <duration-ms>')
    .replace(/Omitted \d+ bytes/g, 'Omitted <bytes> bytes')
    .replace(/<temp-root>\/spill\/session-[^/\s)]+\/[^\s)]+/g, '<spill-locator>')
  const visit = item => {
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (typeof item[index] === 'string') item[index] = normalizedString(item[index])
        else visit(item[index])
      }
      return
    }
    if (item === null || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      if (key === 'duration_ms' && typeof child === 'number') item[key] = '<duration-ms>'
      else if (key === 'bytes' && typeof child === 'number') item[key] = '<bytes>'
      else if (typeof child === 'string') item[key] = normalizedString(child)
      else visit(child)
    }
  }
  visit(parsed)
  return parsed
}

function loaderYaml(dshHome, withWebFetch, withSpill) {
  const optionalWebFetch = withWebFetch
    ? `- id: test-web-fetch\n  name: ${JSON.stringify(webFetchFixturePath)}\n`
    : ''
  const optionalSpill = withSpill
    ? `- id: spill-local\n  name: '@deepseek-ai/dsh-spill-local'\n  config:\n    root: ${JSON.stringify(join(dshHome, 'spill'))}\n- id: spill-policy\n  name: '@deepseek-ai/dsh-spill-policy'\n  config:\n    maxInlineBytes: 2048\n`
    : ''
  return `
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: ${JSON.stringify(join(dshHome, 'domain-storage'))}
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: ${JSON.stringify(join(dshHome, 'sessions'))}
    compression: none
    packChunks: false
    writeBatchMaxDelayMs: 1
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
${optionalWebFetch}${optionalSpill}- id: code-runtime
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
    fallbackMode: off
    providers:
      tavily:
        baseUrl: ${JSON.stringify(`${origin}/tavily`)}
        timeoutMs: 10000
      firecrawl:
        baseUrl: ${JSON.stringify(`${origin}/firecrawl/v2`)}
        timeoutMs: 10000
    retry:
      maxAttempts: 1
      baseDelayMs: 0
      multiplier: 1
      maxDelayMs: 0
      maxTotalDelayMs: 0
      jitterRatio: 0
    webExtract:
      timeoutMs: 30000
      modelTextMaxBytes: 4096
      tavily:
        timeoutMs: 10000
      firecrawl:
        timeoutMs: 10000
        maxEmptyAttempts: 1
        waitForBaseMs: 0
      smartDirect:
        timeoutMs: 15000
        connectTimeoutMs: 10000
        readTimeoutMs: 10000
        processingTimeoutMs: 10000
        maxRetries: 0
      direct:
        connectTimeoutMs: 10000
        firstByteTimeoutMs: 10000
        totalTimeoutMs: 15000
        maxRetries: 0
`
}

async function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

function toolResultEvent(session, callId) {
  const event = session.events.find(candidate => (
    candidate.type === 'tool/result'
    && String(candidate.data.message.content[0]?.toolCallId) === callId
  ))
  assert.ok(event && event.type === 'tool/result', `missing tool/result ${callId}`)
  return event
}

function toolCallEvent(session, callId) {
  const event = session.events.find(candidate => (
    candidate.type === 'tool/call' && String(candidate.data.callId) === callId
  ))
  assert.ok(event && event.type === 'tool/call', `missing tool/call ${callId}`)
  return event
}

function modelText(result) {
  const block = result.content[0]
  assert.equal(block?.type, 'text')
  return block.text
}

async function spillArtifacts(root) {
  try {
    const names = await readdir(root, { recursive: true })
    return (await Promise.all(names.map(async name => {
      const path = join(root, name)
      try {
        const content = await readFile(path, 'utf8')
        return { path, content, bytes: Buffer.byteLength(content) }
      } catch (error) {
        if (error?.code === 'EISDIR') return undefined
        throw error
      }
    }))).filter(Boolean)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function compactValue(value) {
  if (value?.content === longContent) {
    return { ...value, content: `<long-content:${Buffer.byteLength(longContent)}>` }
  }
  return value
}

async function runComposition({ withWebFetch, withSpill, full }) {
  const dshHome = await mkdtemp(join(tmpdir(), `dsh-web-extract-${withWebFetch ? 'stub' : 'none'}-`))
  const loaderConfig = join(dshHome, 'cordis.yml')
  const handles = []
  let ctx
  let disposed = false
  process.env.DSH_HOME = dshHome
  process.env.TAVILY_API_KEY = tavilySecret
  process.env.FIRECRAWL_API_KEY = firecrawlSecret
  for (const name of ['SEARCH_API_KEY', 'CONTEXT7_API_KEY', 'EXA_API_KEY']) delete process.env[name]

  try {
    await writeFile(loaderConfig, loaderYaml(dshHome, withWebFetch, withSpill), 'utf8')
    const [{ boot }, scriptedModule, webFetchModule] = await Promise.all([
      import('@deepseek-ai/dsh-app-boot'),
      import(pathToFileURL(fixturePath).href),
      import(pathToFileURL(webFetchFixturePath).href),
    ])
    webFetchModule.resetCalls()

    const directJsonUrl = `${origin}/target/direct-json`
    const spillUrl = `${origin}/target/spill`
    const shortScenarios = full
      ? [
          ['native-tavily', `${origin}/target/tavily`, 'markdown'],
          ['native-firecrawl', `${origin}/target/firecrawl`, 'markdown'],
          ['native-smart', `${origin}/target/smart`, 'markdown'],
          ['native-direct-json', directJsonUrl, 'json'],
          ['native-direct-raw', `${origin}/target/direct-raw`, 'raw'],
          ['native-metadata-only', `${origin}/target/metadata-only`, 'raw'],
          ['native-all-fail', `${origin}/target/all-fail`, 'markdown'],
          ['native-spill', spillUrl, 'markdown'],
        ]
      : [
          ['native-direct-json', directJsonUrl, 'json'],
          ['native-no-spill', spillUrl, 'markdown'],
        ]
    const script = shortScenarios.flatMap(([id, url, format]) => [
      { kind: 'tool', id, name: 'web_extract', arguments: { url, format } },
      { kind: 'text', text: `${id} complete.` },
    ])
    if (full) {
      const code = `return await tools.web_extract({ url: ${JSON.stringify(spillUrl)}, format: 'markdown' });`
      script.push(
        { kind: 'tool', id: 'code-spill', name: 'run_code', arguments: { code, description: 'Read the long fixture through web_extract' } },
        { kind: 'text', text: 'code spill complete.' },
      )
    }
    scriptedModule.setScript(script)

    ctx = await boot(
      `dsh-web-extract-${withWebFetch ? 'stub' : 'none'}`,
      loaderConfig,
      undefined,
      undefined,
      packageJsonUrl,
    )
    await ctx.loader.await()
    const pluginEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
    assert.ok(pluginEntry?.fiber, 'Loader did not create web-extract plugin fiber')
    await pluginEntry.fiber.await()

    const schemaNames = ctx.tools.schemas().map(schema => schema.name).sort()
    assert.equal(schemaNames.includes('web_extract'), true)
    assert.equal(schemaNames.includes('web_fetch'), withWebFetch)
    assert.equal(ctx.get('web'), undefined)
    assert.equal(ctx.get('spillStore') !== undefined, withSpill)

    const observed = []
    const cards = []
    ctx.on('tools/result', (exec, result) => {
      if (!['web_extract', 'run_code'].includes(exec.name)) return
      observed.push({
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
      if (card !== undefined) cards.push({ callId: String(exec.callId), card: structuredClone(card) })
    })

    const createAgent = async (id, setup) => {
      const handle = await ctx.agents.create({
        sessionId: SessionId(id),
        agentOptions: { provider: 'search-enhance-scripted', model: 'fixture-model' },
        ...(setup === undefined ? {} : { setup }),
      })
      handles.push(handle)
      return handle.agent
    }

    const nativeAgent = await createAgent(`web-extract-native-${withWebFetch ? 'stub' : 'none'}`)
    for (const [id] of shortScenarios) await followup(nativeAgent, `Run ${id}.`)

    let codeAgent
    if (full) {
      codeAgent = await createAgent('web-extract-code-stub', agentCtx => {
        agentCtx.tools.presentAs('code')
      })
      await followup(codeAgent, 'Run the Code Mode spill fixture.')
    }
    assert.equal(scriptedModule.remainingResponses(), 0)
    assert.equal(webFetchModule.callCount(), 0)

    await ctx.sessions.flush(nativeAgent.session)
    if (codeAgent !== undefined) await ctx.sessions.flush(codeAgent.session)

    const resultFor = (callId, name = 'web_extract') => {
      const item = observed.find(candidate => candidate.callId === callId && candidate.name === name)
      assert.ok(item, `missing observed result ${callId}/${name}`)
      assert.equal(item.result.isError, false)
      return item.result
    }
    const directJson = resultFor('native-direct-json').value
    assert.equal(directJson.retrieval_route, 'direct')
    assert.equal(directJson.evidence_level, 'direct_http_content')
    assert.equal(directJson.status_code, 200)
    assert.equal(directJson.final_url, directJsonUrl)

    let withoutSpillSummary
    if (!full) {
      const directText = modelText(resultFor('native-direct-json'))
      assert.doesNotMatch(directText, /Full formatted result stored at:/)
      assert.match(directText, /Route attempts/)

      const noSpill = resultFor('native-no-spill')
      const noSpillText = modelText(noSpill)
      assert.equal(noSpill.value.content, longContent)
      assert.equal(Buffer.byteLength(noSpillText), 4096)
      assert.match(noSpillText, /\[Model text truncated by model_text_max_bytes\.\]$/)
      assert.doesNotMatch(noSpillText, /Full formatted result stored at:/)
      withoutSpillSummary = {
        model_text_bytes: Buffer.byteLength(noSpillText),
        canonical_content_complete: noSpill.value.content === longContent,
        has_model_text_limit_marker: noSpillText.endsWith('[Model text truncated by model_text_max_bytes.]'),
        has_spill_locator: noSpillText.includes('Full formatted result stored at:'),
      }
    }

    let fullSnapshot
    if (full) {
      const routes = {
        tavily: resultFor('native-tavily'),
        firecrawl: resultFor('native-firecrawl'),
        smart: resultFor('native-smart'),
        direct_json: resultFor('native-direct-json'),
        direct_raw: resultFor('native-direct-raw'),
        metadata_only: resultFor('native-metadata-only'),
        spill: resultFor('native-spill'),
      }
      assert.equal(routes.tavily.value.retrieval_route, 'tavily_extract')
      assert.equal(routes.firecrawl.value.retrieval_route, 'firecrawl_scrape')
      assert.equal(routes.smart.value.retrieval_route, 'smart_direct')
      assert.equal(routes.direct_raw.value.retrieval_route, 'direct')
      assert.equal(routes.metadata_only.value.metadata_only_reason, 'attachment')
      assert.equal(routes.tavily.value.status_code, undefined)
      assert.equal(routes.firecrawl.value.status_code, undefined)
      assert.equal(cards.find(item => item.callId === 'native-tavily')?.card.card, 'generic')
      assert.deepEqual(cards.find(item => item.callId === 'native-smart')?.card, {
        card: 'web',
        kind: 'fetch',
        url: `${origin}/target/smart`,
        statusCode: 200,
        truncated: false,
      })

      const allFail = observed.find(item => item.callId === 'native-all-fail' && item.name === 'web_extract')
      assert.ok(allFail?.result.isError)
      assert.deepEqual(allFail.result.error.info, {
        name: 'WebExtractToolError',
        code: 'SEARCH_WEB_EXTRACT_FAILED',
      })
      const allFailText = modelText(allFail.result)
      assert.match(allFailText, /SEARCH_WEB_EXTRACT_FAILED: tavily_extract\[/)
      assert.match(allFailText, /firecrawl_scrape\[/)
      assert.match(allFailText, /smart_direct\[/)
      assert.match(allFailText, /direct\[/)
      assert.doesNotMatch(allFailText, /target\/all-fail|authorization|bearer/i)
      assert.deepEqual(cards.find(item => item.callId === 'native-all-fail')?.card, {
        card: 'generic',
        title: 'Web extraction failed',
      })

      const nativeSpillText = modelText(routes.spill)
      assert.match(nativeSpillText, /Full formatted result stored at:/)
      assert.doesNotMatch(nativeSpillText, new RegExp(longMiddle))
      assert.equal(routes.spill.value.content, longContent)

      const nestedCode = observed.find(item => (
        item.agentId === 'web-extract-code-stub' && item.name === 'web_extract' && item.nested
      ))
      const outerCode = observed.find(item => item.callId === 'code-spill' && item.name === 'run_code')
      assert.ok(nestedCode && !nestedCode.result.isError)
      assert.ok(outerCode && !outerCode.result.isError)
      assert.equal(nestedCode.result.meta, undefined)
      assert.deepEqual(
        normalize(compactValue(nestedCode.result.value)),
        normalize(compactValue(routes.spill.value)),
      )
      assert.deepEqual(
        normalize(compactValue(outerCode.result.value.result)),
        normalize(compactValue(routes.spill.value)),
      )
      assert.match(modelText(outerCode.result), /Full formatted result stored at:/)

      const codeDispatches = codeAgent.session.events.filter(event => event.type === 'tool/code-dispatch')
      assert.equal(codeDispatches.length, 1)
      assert.equal(codeDispatches[0].data.name, 'web_extract')
      assert.match(codeDispatches[0].data.content[0].text, /Full formatted result stored at:/)
      assert.equal('meta' in codeDispatches[0].data, false)

      const nativeRaw = await ctx.sessionPersistence.readRaw(nativeAgent.session.id)
      const codeRaw = await ctx.sessionPersistence.readRaw(codeAgent.session.id)
      assert.ok(nativeRaw && codeRaw)
      assert.match(nativeRaw.content, /"type":"tool\/call"/)
      assert.match(nativeRaw.content, /"type":"tool\/result"/)
      assert.match(codeRaw.content, /"type":"tool\/code-dispatch-start"/)
      assert.match(codeRaw.content, /"type":"tool\/code-dispatch"/)
      assert.match(codeRaw.content, /Full formatted result stored at:/)
      assert.equal(nativeRaw.content.includes(longMiddle), false)
      assert.equal(codeRaw.content.includes(longMiddle), false)

      const artifacts = await spillArtifacts(join(dshHome, 'spill'))
      assert.ok(artifacts.length >= 3)
      assert.ok(artifacts.some(item => item.content.includes(longMiddle)))
      assert.ok(artifacts.some(item => item.content.includes('Requested URL:') && item.content.includes('Route attempts')))

      const smartCall = toolCallEvent(nativeAgent.session, 'native-smart')
      const smartResult = toolResultEvent(nativeAgent.session, 'native-smart')
      const definition = ctx.tools.get('web_extract', nativeAgent)
      const replayCard = definition.presentResult(
        JSON.parse(smartCall.data.arguments),
        {
          content: smartResult.data.message.content[0].content,
          isError: smartResult.data.message.content[0].isError === true,
          meta: smartResult.data.meta,
        },
      )
      const liveCard = cards.find(item => item.callId === 'native-smart')?.card
      assert.deepEqual(replayCard, liveCard)

      const nativeSessionId = nativeAgent.session.id
      const nativeHandleIndex = handles.findIndex(handle => handle.agent === nativeAgent)
      const [nativeHandle] = handles.splice(nativeHandleIndex, 1)
      await nativeHandle.dispose()
      const loaded = await ctx.sessionPersistence.load(nativeSessionId)
      const replayCall = toolCallEvent({ events: loaded.events }, 'native-smart')
      const replayResult = toolResultEvent({ events: loaded.events }, 'native-smart')
      const diskReplayCard = definition.presentResult(
        JSON.parse(replayCall.data.arguments),
        {
          content: replayResult.data.message.content[0].content,
          isError: replayResult.data.message.content[0].isError === true,
          meta: replayResult.data.meta,
        },
      )
      assert.deepEqual(diskReplayCard, liveCard)

      const oldDefinition = ctx.tools.get('web_extract')
      await pluginEntry.fiber.restart()
      assert.notEqual(ctx.tools.get('web_extract'), oldDefinition)
      assert.equal(ctx.tools.schemas().filter(schema => schema.name === 'web_extract').length, 1)
      assert.equal(ctx.tools.get('web_fetch') !== undefined, withWebFetch)
      const postRestart = await ctx.tools.execute({
        callId: CallId('post-restart-direct-json'),
        name: 'web_extract',
        arguments: { url: directJsonUrl, format: 'json' },
        signal: new AbortController().signal,
      })
      assert.equal(postRestart.isError, false)
      assert.equal(postRestart.value.retrieval_route, 'direct')

      const modelRequests = scriptedModule.requests()
      assert.ok(modelRequests[0].tools.some(schema => schema.name === 'web_extract'))
      assert.ok(modelRequests[0].tools.some(schema => schema.name === 'web_fetch'))
      const codeRequest = modelRequests.at(-2)
      assert.deepEqual(codeRequest.tools.map(schema => schema.name), ['run_code'])
      assert.match(codeRequest.system, /web_extract:/)
      assert.match(codeRequest.system, /web_fetch:/)

      const eventExcerpt = [
        toolCallEvent(nativeAgent.session, 'native-spill'),
        toolResultEvent(nativeAgent.session, 'native-spill'),
        ...codeAgent.session.events.filter(event => [
          'tool/call',
          'tool/code-dispatch-start',
          'tool/code-dispatch',
          'tool/result',
        ].includes(event.type)),
      ].map(event => {
        if (event.type === 'tool/call') {
          return {
            type: event.type,
            callId: String(event.data.callId),
            name: event.data.name,
            arguments: JSON.parse(event.data.arguments),
          }
        }
        if (event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch') {
          return {
            type: event.type,
            rootCallId: String(event.data.rootCallId),
            parentCallId: String(event.data.parentCallId),
            subCallId: String(event.data.subCallId),
            name: event.data.name,
            arguments: event.data.arguments,
            ...('isError' in event.data ? { isError: event.data.isError, content: event.data.content } : {}),
          }
        }
        const block = event.data.message.content[0]
        return {
          type: event.type,
          callId: String(block.toolCallId),
          isError: block.isError === true,
          content: block.content,
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        }
      })

      fullSnapshot = {
        native_schema: modelRequests[0].tools,
        route_values: Object.fromEntries(Object.entries(routes).map(([key, result]) => [
          key,
          compactValue(result.value),
        ])),
        route_model_text: Object.fromEntries(Object.entries(routes).map(([key, result]) => [
          key,
          result.content,
        ])),
        cards: {
          tavily: cards.find(item => item.callId === 'native-tavily')?.card,
          firecrawl: cards.find(item => item.callId === 'native-firecrawl')?.card,
          smart_live: liveCard,
          smart_replay: replayCard,
          smart_disk_replay: diskReplayCard,
          direct_json: cards.find(item => item.callId === 'native-direct-json')?.card,
          metadata_only: cards.find(item => item.callId === 'native-metadata-only')?.card,
          all_fail: {
            card: cards.find(item => item.callId === 'native-all-fail')?.card,
            content: allFail.result.content,
            error_info: allFail.result.error.info,
          },
        },
        code: {
          nested_value: compactValue(nestedCode.result.value),
          outer_value: {
            ...outerCode.result.value,
            result: compactValue(outerCode.result.value.result),
          },
          outer_content: outerCode.result.content,
          dispatches: codeDispatches.map(event => ({
            rootCallId: String(event.data.rootCallId),
            parentCallId: String(event.data.parentCallId),
            subCallId: String(event.data.subCallId),
            name: event.data.name,
            arguments: event.data.arguments,
            isError: event.data.isError,
            content: event.data.content,
          })),
        },
        persisted_events: eventExcerpt,
        spill_artifacts: artifacts.map(item => ({
          bytes: item.bytes,
          kind: item.content.includes('Requested URL:') ? 'web_extract_render' : 'run_code_render',
          has_full_middle: item.content.includes(longMiddle),
          has_attempts: item.content.includes('Route attempts'),
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        post_restart_value: compactValue(postRestart.value),
      }
    }

    const allVisibleText = JSON.stringify({
      observed,
      cards,
      sessions: handles.map(handle => handle.agent.session.events),
      fullSnapshot,
    })
    for (const secret of [tavilySecret, firecrawlSecret]) assert.equal(allVisibleText.includes(secret), false)

    await pluginEntry.fiber.dispose()
    assert.equal(ctx.tools.get('web_extract'), undefined)
    assert.equal(ctx.tools.get('web_fetch') !== undefined, withWebFetch)
    for (const handle of handles.reverse()) await handle.dispose()
    handles.length = 0
    await ctx.fiber.dispose()
    disposed = true

    return {
      dshHome,
      schemaNames,
      directJson,
      fullSnapshot,
      stubCalls: webFetchModule.callCount(),
      withoutSpillSummary,
    }
  } finally {
    for (const handle of handles.reverse()) {
      try {
        await handle.dispose()
      } catch {
        // Root disposal below remains the final owner after an assertion failure.
      }
    }
    if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) await ctx.fiber.dispose()
    await rm(dshHome, { force: true, recursive: true })
  }
}

let createdSelfLink = false
try {
  await assertIndependentProductionGraph()
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }

  const withStub = await runComposition({ withWebFetch: true, withSpill: true, full: true })
  const withoutStub = await runComposition({ withWebFetch: false, withSpill: false, full: false })
  assert.equal(withStub.stubCalls, 0)
  assert.equal(withoutStub.stubCalls, 0)
  assert.deepEqual(
    normalize(withStub.directJson),
    normalize(withoutStub.directJson),
  )

  const safeRequests = httpRequests.map(request => ({
    method: request.method,
    url: request.url,
    authorization: request.authorization === undefined ? undefined : '<redacted>',
    target: request.url === '/tavily/extract'
      ? targetPath(request.body.urls[0])
      : request.url === '/firecrawl/v2/scrape'
        ? targetPath(request.body.url)
        : undefined,
    format: request.url === '/tavily/extract'
      ? request.body.format
      : request.url === '/firecrawl/v2/scrape'
        ? request.body.formats[0]
        : undefined,
  }))
  const snapshot = normalize({
    ...withStub.fullSnapshot,
    independence: {
      with_stub_tools: withStub.schemaNames,
      without_stub_tools: withoutStub.schemaNames,
      direct_canonical_equal: true,
      stub_calls: withStub.stubCalls,
      without_spill: withoutStub.withoutSpillSummary,
    },
    http_requests: safeRequests,
  }, [withStub.dshHome, withoutStub.dshHome])

  const serialized = JSON.stringify(snapshot)
  for (const secret of [tavilySecret, firecrawlSecret]) assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes(longMiddle), false)
  if (process.env.UPDATE_SEARCH_ENHANCE_SNAPSHOTS === '1') {
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } else {
    const expected = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert.deepEqual(snapshot, expected)
  }

  process.stdout.write('web_extract headless snapshot: ok (Loader, AgentLoop Native/Code, routes, cards, spill, persistence, web_fetch independence)\n')
} finally {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(() => resolve()))
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

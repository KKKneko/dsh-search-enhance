import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const phaseScript = join(packageRoot, 'tests/session-recovery-phase.mjs')
const snapshotPath = join(packageRoot, 'tests/snapshots/session-recovery.json')
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-session-recovery-'))
const loaderConfig = join(dshHome, 'cordis.yml')
const statePath = join(dshHome, 'recovery-state.json')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const searchSecret = 'fresh-process-search-secret'
const context7Secret = 'fresh-process-context7-secret'
const childOutputMaxBytes = 64 * 1024
const sockets = new Set()
const requests = []
let createdSelfLink = false

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
    const body = await requestBody(request)
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body.length === 0 ? undefined : JSON.parse(body),
    })
    if (request.url === '/search/v1/models' && request.method === 'GET') {
      json(response, 200, { data: [{ id: 'fresh-process-search-model' }] })
      return
    }
    if (request.url === '/search/v1/chat/completions' && request.method === 'POST') {
      json(response, 200, {
        choices: [{
          message: {
            content: `Fresh-process fixture answer.\n\nSources:\n- [Primary recovery evidence](${origin}/evidence/primary)`,
          },
        }],
      })
      return
    }
    const parsed = new URL(request.url ?? '/', origin)
    if (parsed.pathname === '/context7/api/v2/context' && request.method === 'GET') {
      json(response, 200, {
        codeSnippets: [{
          content: 'Create the client once and dispose it at the lifecycle boundary.',
          title: 'Lifecycle',
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
if (address === null || typeof address === 'string') {
  throw new Error('session recovery fixture server has no address')
}
const origin = `http://127.0.0.1:${address.port}`

async function waitForSocketsToClose(label) {
  const deadline = Date.now() + 5000
  while (sockets.size > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} left ${sockets.size} HTTP socket(s) open`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function runPhase(phase) {
  const credentialNames = [
    'SEARCH_API_KEY',
    'CONTEXT7_API_KEY',
    'EXA_API_KEY',
    'TAVILY_API_KEY',
    'FIRECRAWL_API_KEY',
  ]
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    SEARCH_API_KEY: searchSecret,
    CONTEXT7_API_KEY: context7Secret,
  }
  for (const name of credentialNames.slice(2)) delete env[name]

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [phaseScript, phase, loaderConfig, statePath],
      {
        cwd: packageRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let spawnError
    let timedOut = false
    const appendBounded = (current, chunk) => {
      const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)])
      return combined.subarray(Math.max(0, combined.length - childOutputMaxBytes)).toString('utf8')
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk) })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 45_000)
    child.once('error', error => { spawnError = error })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (spawnError !== undefined) {
        reject(spawnError)
        return
      }
      if (timedOut) {
        reject(new Error(`${phase} recovery process did not quiesce (bounded output)\n${stdout}\n${stderr}`))
        return
      }
      if (code !== 0) {
        reject(new Error(
          `${phase} recovery process failed (code=${String(code)}, signal=${String(signal)}; bounded output)\n${stdout}\n${stderr}`,
        ))
        return
      }
      resolve()
    })
  })
  await waitForSocketsToClose(`${phase} recovery process`)
}

function normalize(value, sourceRef, docRef) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'duration_ms' && typeof item === 'number') return '<duration-ms>'
    if (typeof item !== 'string') return item
    return item
      .replaceAll(origin, '<fixture-origin>')
      .replaceAll(sourceRef, '<source-ref>')
      .replaceAll(docRef, '<doc-ref>')
      .replace(/"duration_ms":\s*\d+/g, '"duration_ms":"<duration-ms>"')
  }))
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await filesUnder(path))
    else output.push(path)
  }
  return output
}

async function assertForbiddenEventAbsent() {
  const forbidden = 'search-enhance/' + 'auxiliary-request'
  const builtFiles = (await filesUnder(join(packageRoot, 'lib')))
    .filter(path => ['.js', '.ts', '.map'].includes(extname(path)))
  const snapshotFiles = (await filesUnder(join(packageRoot, 'tests/snapshots')))
    .filter(path => extname(path) === '.json')
  for (const path of [...builtFiles, ...snapshotFiles]) {
    const content = await readFile(path, 'utf8')
    assert.equal(content.includes(forbidden), false, `${path} retains the removed SessionEvent`)
  }
}

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
- id: native-web-search
  name: ${JSON.stringify(join(packageRoot, 'tests/fixtures/web-search-stub.mjs'))}
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: agents
  name: '@deepseek-ai/dsh-agent'
- id: scripted-llm
  name: ${JSON.stringify(join(packageRoot, 'tests/fixtures/scripted-llm.mjs'))}
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
    searchApi:
      baseUrl: ${JSON.stringify(`${origin}/search/v1`)}
      model: fresh-process-search-model
      timeoutMs: 10000
    providers:
      context7:
        baseUrl: ${JSON.stringify(`${origin}/context7`)}
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
    budgets:
      auto:
        compact:
          maxAnswerCharacters: 2000
          maxVisibleSources: 4
          maxModelTextBytes: 4096
`, 'utf8')

  await runPhase('create')
  assert.equal(requests.length, 3)
  const requestCountAfterCreate = requests.length
  await runPhase('reopen')
  assert.equal(
    requests.length,
    requestCountAfterCreate,
    'fresh-process reopen unexpectedly dispatched Provider HTTP',
  )

  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.notEqual(state.phase1.pid, state.phase2.pid, 'reopen reused the first process')
  assert.deepEqual(state.phase1.custom_event_types, [])
  assert.deepEqual(state.phase2.custom_event_types, [])
  assert.equal(state.phase2.loader_disposed, true)
  assert.equal(state.phase2.private_source_record_restored, true)
  assert.equal(state.phase2.context7_cache_restored, true)
  assert.equal(state.phase2.first_request_restored_before_assembly, true)
  assert.equal(state.phase2.public_fork_used, true)
  assert.equal(state.phase2.source_isolation, true)

  for (const path of await filesUnder(dshHome)) {
    const bytes = await readFile(path)
    assert.equal(bytes.includes(Buffer.from(searchSecret)), false, `${path} contains Search API credential`)
    assert.equal(bytes.includes(Buffer.from(context7Secret)), false, `${path} contains Context7 credential`)
  }

  const searchRequest = requests.find(item => item.url === '/search/v1/chat/completions')
  const context7Request = requests.find(item => item.url?.startsWith('/context7/api/v2/context?'))
  assert.ok(searchRequest)
  assert.ok(context7Request)
  assert.equal(searchRequest.authorization, `Bearer ${searchSecret}`)
  assert.equal(context7Request.authorization, `Bearer ${context7Secret}`)
  const searchMessages = searchRequest.body.messages
  assert.ok(Array.isArray(searchMessages))
  const snapshot = normalize({
    process_boundary: {
      independent_processes: true,
      first_loader_disposed_before_reopen: true,
      second_loader_disposed: state.phase2.loader_disposed,
      sockets_quiescent: sockets.size === 0,
    },
    phase1: {
      ...state.phase1,
      pid: '<first-process>',
    },
    phase2: {
      ...state.phase2,
      pid: '<second-process>',
    },
    provider_requests_observed_only_in_process_1: {
      search_api: {
        method: searchRequest.method,
        url: searchRequest.url,
        authorization: '<redacted>',
        model: searchRequest.body.model,
        query: searchMessages.at(-1)?.content,
        stream: searchRequest.body.stream,
      },
      context7: {
        method: context7Request.method,
        url: context7Request.url,
        authorization: '<redacted>',
      },
    },
  }, state.sourceRef, state.docRef)

  if (process.env.UPDATE_SEARCH_ENHANCE_SNAPSHOTS === '1') {
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } else {
    const expected = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert.deepEqual(snapshot, expected)
  }

  await assertForbiddenEventAbsent()
  process.stdout.write('session recovery snapshot: ok (two processes, cold first-request recovery, public fork isolation, cache/source restore)\n')
} finally {
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(() => resolve()))
  for (let attempt = 0; attempt < 100 && sockets.size > 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(sockets.size, 0)
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
}

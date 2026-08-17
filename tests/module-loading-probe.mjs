import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const loadLog = process.env.DSH_MODULE_LOAD_LOG
const scenario = process.argv[2]

assert.ok(loadLog, 'DSH_MODULE_LOAD_LOG is required')
assert.ok(scenario, 'module-loading scenario is required')

async function observedEvents() {
  try {
    const text = await readFile(loadLog, 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function matchingEvents(events, category, hook) {
  return events.filter(event => (
    event.category === category && (hook === undefined || event.hook === hook)
  ))
}

function assertRootExtractionComposition(events, label) {
  assertNoDefuddle(events, label)
  assert.deepEqual(
    matchingEvents(events, 'providers-barrel'),
    [],
    `${label} evaluated the public providers barrel`,
  )
  for (const category of [
    'linkedom',
    'smart-direct-runtime',
    'smart-direct-child-process',
    'direct-runtime',
  ]) {
    assert.ok(
      matchingEvents(events, category).length > 0,
      `${label} did not compose ${category}`,
    )
  }
}

function assertNoDefuddle(events, label) {
  assert.deepEqual(
    matchingEvents(events, 'defuddle'),
    [],
    `${label} loaded defuddle/node`,
  )
}

class FixtureHeaders {
  #entries

  constructor(values) {
    this.#entries = Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])
  }

  get(name) {
    return this.#entries.find(([candidate]) => candidate === name.toLowerCase())?.[1] ?? null
  }

  [Symbol.iterator]() {
    return this.#entries[Symbol.iterator]()
  }
}

const article = '<!doctype html><html><head><title>Lazy Defuddle fixture</title></head><body><main><article><h1>Lazy Defuddle fixture</h1><p>This deterministic production HTML contains enough meaningful words for readable extraction without any remote dependency.</p><p>A second stable paragraph verifies that the default Defuddle path returns non-empty content.</p></article></main></body></html>'

function defuddleResult(content) {
  return {
    author: '',
    content,
    description: '',
    domain: '',
    favicon: '',
    image: '',
    language: '',
    parseTime: 1,
    published: '',
    schemaOrgData: [],
    site: '',
    title: '',
    wordCount: 12,
  }
}

function fakeHtmlDependencies(extract, loadDefuddle, response = {}) {
  let closes = 0
  const transport = {
    async close() {
      closes += 1
    },
  }
  return {
    dependencies: {
      async createTransport() {
        return transport
      },
      async fetch(url) {
        const body = Buffer.from(response.body ?? article)
        return {
          body: { async cancel() {} },
          headers: new FixtureHeaders({
            'content-type': response.contentType ?? 'text/html; charset=utf-8',
          }),
          readable: () => Readable.from([body]),
          status: 200,
          url,
        }
      },
      ...(extract === undefined ? {} : { extract }),
      ...(loadDefuddle === undefined ? {} : { loadDefuddle }),
    },
    closeCount: () => closes,
  }
}

function adapterInput(
  Config,
  configOverrides = {},
  signal = new AbortController().signal,
  url = 'https://module-load.test/article',
) {
  return {
    config: Config({
      webExtract: {
        smartDirect: {
          timeoutMs: 2000,
          processingTimeoutMs: 1000,
          ...configOverrides,
        },
      },
    }),
    format: 'markdown',
    signal,
    url,
  }
}

async function importProviderRuntime() {
  const [{ Config }, smartDirect, providerRuntime] = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'lib/config.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/providers/smart-direct.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/provider-runtime/index.js')).href),
  ])
  return {
    Config,
    ProviderError: providerRuntime.ProviderError,
    SmartDirectProvider: smartDirect.SmartDirectProvider,
  }
}

async function complete(provider, input) {
  const outcome = await provider.extract(input)
  assert.equal(outcome.state, 'complete')
  return outcome.result
}

async function lazyLoadingScenario() {
  const pluginModule = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href)
  assert.deepEqual(Object.keys(pluginModule).sort(), ['Config', 'apply', 'inject', 'name'])
  assertRootExtractionComposition(await observedEvents(), 'root lib/index.js import')

  const { Config, SmartDirectProvider } = await importProviderRuntime()
  assertNoDefuddle(await observedEvents(), 'SmartDirectProvider module import')

  const plain = fakeHtmlDependencies(undefined, undefined, {
    body: 'plain production projection',
    contentType: 'text/plain; charset=utf-8',
  })
  const plainResult = await complete(
    new SmartDirectProvider(plain.dependencies),
    adapterInput(Config),
  )
  assert.equal(plainResult.content, 'plain production projection')
  assertNoDefuddle(await observedEvents(), 'plain MIME projection')

  const overDom = fakeHtmlDependencies()
  await assert.rejects(
    new SmartDirectProvider(overDom.dependencies).extract(adapterInput(
      Config,
      { maxDomNodes: 2 },
    )),
    error => error?.kind === 'budget_exceeded' && error?.provider === 'smart_direct',
  )
  assertNoDefuddle(await observedEvents(), 'HTML rejected before extraction')

  let injectedCalls = 0
  const injected = fakeHtmlDependencies(async () => {
    injectedCalls += 1
    return defuddleResult('injected extractor content')
  })
  const injectedResult = await complete(
    new SmartDirectProvider(injected.dependencies),
    adapterInput(Config),
  )
  assert.equal(injectedResult.content, 'injected extractor content')
  assert.equal(injectedCalls, 1)
  assert.equal(injected.closeCount(), 1)
  assertNoDefuddle(await observedEvents(), 'injected extract path')

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(article)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const production = new SmartDirectProvider()
  try {
    const first = await complete(
      production,
      adapterInput(Config, {}, undefined, `http://127.0.0.1:${address.port}/article`),
    )
    assert.match(first.content, /deterministic production HTML/)
    let events = await observedEvents()
    assert.equal(
      events.filter(event => event.hook === 'resolve-request' && event.specifier === 'defuddle/node').length,
      1,
      'the first default HTML extraction must request defuddle/node exactly once',
    )
    assert.equal(
      events.filter(event => event.hook === 'load' && event.url?.endsWith('/node_modules/defuddle/dist/node.js')).length,
      1,
      'the first default HTML extraction must load the public defuddle/node entry',
    )

    await complete(
      production,
      adapterInput(Config, {}, undefined, `http://127.0.0.1:${address.port}/article`),
    )
    events = await observedEvents()
    assert.equal(
      events.filter(event => event.hook === 'resolve-request' && event.specifier === 'defuddle/node').length,
      1,
      'the cached production extractor must not issue a second dynamic import',
    )
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    })
  }

  const [providers, webExtract] = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'lib/providers/index.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/web-extract/index.js')).href),
  ])
  for (const name of [
    'Context7RemoteClient',
    'ExaProvider',
    'FirecrawlSearchProvider',
    'TavilySearchProvider',
    'SmartDirectProvider',
    'DirectFetchProvider',
  ]) {
    assert.equal(typeof providers[name], 'function', `providers public export ${name} is missing`)
  }
  assert.equal(webExtract.SmartDirectProvider, providers.SmartDirectProvider)
  assert.equal(webExtract.DirectFetchProvider, providers.DirectFetchProvider)
}

async function pureResearchPlanScenario() {
  const [{ Config }, planner] = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'lib/config.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/research-plan/index.js')).href),
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('pure research planner must not call fetch')
  }
  try {
    const value = planner.buildResearchPlan(
      {
        question: 'Plan an offline documentation comparison',
        known_urls: ['https://module-load.test/one'],
      },
      {
        config: Config({}).researchPlan,
        webMapAvailable: false,
        siteMapMaxLinks: 500,
      },
    )
    assert.equal(value.plan_complete, true)
    assert.equal(value.research_plan.preflight.network_access, 'not_used')
    assert.equal(value.research_plan.steps[0].tool, 'web_extract')
  } finally {
    globalThis.fetch = originalFetch
  }
  const events = await observedEvents()
  assert.deepEqual(
    events.filter(event => event.category === 'defuddle' || event.category === 'providers-barrel'),
    [],
    'pure research planner imported the Provider barrel or Defuddle module',
  )
}

async function importFailureScenario() {
  const { Config, ProviderError, SmartDirectProvider } = await importProviderRuntime()
  assertNoDefuddle(await observedEvents(), 'pre-extraction import-failure setup')
  const seam = fakeHtmlDependencies()
  let caught
  try {
    await new SmartDirectProvider(seam.dependencies).extract(adapterInput(Config))
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ProviderError)
  assert.equal(caught.kind, 'invalid_response')
  assert.equal(caught.provider, 'smart_direct')
  assert.equal(caught.message, 'smart_direct: response could not be validated')
  assert.equal('cause' in caught, false)
  const blockedDetail = process.env.DSH_BLOCK_DEFUDDLE_DETAIL
  assert.ok(blockedDetail, 'blocked import detail is required')
  const exposed = `${caught.message}\n${JSON.stringify(caught)}`
  assert.equal(exposed.includes(blockedDetail), false)
  assert.equal(seam.closeCount(), 1)
  assert.equal(
    (await observedEvents()).filter(event => (
      event.hook === 'resolve-request' && event.specifier === 'defuddle/node'
    )).length,
    1,
  )
}

async function delayedImportScenario(kind) {
  const { Config, ProviderError, SmartDirectProvider } = await importProviderRuntime()
  let loadCalls = 0
  let extractorCalls = 0
  let releaseLoader
  const loader = new Promise(resolve => { releaseLoader = resolve })
  const seam = fakeHtmlDependencies(undefined, async () => {
    loadCalls += 1
    return loader
  })
  const controller = new AbortController()
  const operation = new SmartDirectProvider(seam.dependencies).extract(adapterInput(
    Config,
    kind === 'timeout' ? { processingTimeoutMs: 20, timeoutMs: 1000 } : {},
    controller.signal,
  ))
  let settled = false
  void operation.then(
    () => { settled = true },
    () => { settled = true },
  )

  const loaderDeadline = Date.now() + 1000
  while (loadCalls === 0) {
    if (Date.now() >= loaderDeadline) throw new Error('Defuddle loader seam was not called')
    await delay(5)
  }
  let reason
  if (kind === 'cancel') {
    reason = new Error('cancel while Defuddle import is settling')
    controller.abort(reason)
    await delay(30)
  } else {
    await delay(80)
  }
  const settledBeforeImport = settled
  releaseLoader(async () => {
    extractorCalls += 1
    return defuddleResult('must not run after cancellation or timeout')
  })

  if (kind === 'cancel') {
    await assert.rejects(operation, error => error === reason)
  } else {
    await assert.rejects(operation, error => (
      error instanceof ProviderError
      && error.kind === 'timeout'
      && error.provider === 'smart_direct'
      && error.message === 'smart_direct: operation timed out'
    ))
  }
  assert.equal(settledBeforeImport, false, `${kind} raced away from the dynamic import`)
  assert.equal(loadCalls, 1)
  assert.equal(extractorCalls, 0)
  assert.equal(seam.closeCount(), 1)
  assertNoDefuddle(await observedEvents(), `${kind} injected Defuddle loader`)
}

if (scenario === 'lazy-loading') await lazyLoadingScenario()
else if (scenario === 'pure-research-plan') await pureResearchPlanScenario()
else if (scenario === 'import-failure') await importFailureScenario()
else if (scenario === 'cancel-import') await delayedImportScenario('cancel')
else if (scenario === 'timeout-import') await delayedImportScenario('timeout')
else throw new Error(`unknown module-loading scenario: ${scenario}`)

process.stdout.write(`module loading probe: ${scenario} ok\n`)

import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-context7-'))
const exampleConfig = join(packageRoot, 'examples/headless/cordis.yml')
const loaderConfig = join(dshHome, 'cordis.yml')
const selfLink = join(packageRoot, 'node_modules', 'dsh-search-enhance')
const originalConfig = await readFile(exampleConfig, 'utf8')
const expectedGlobalTools = [
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
const previousFetch = globalThis.fetch

process.env.DSH_HOME = dshHome
for (const name of credentialNames) delete process.env[name]

let ctx
let secondCtx
let createdSelfLink = false
let disposed = false
let secondDisposed = false
const requests = []

globalThis.fetch = async (input, init) => {
  const url = String(input)
  requests.push({ headers: init?.headers, url })
  if (url.startsWith('https://context7.com/api/v2/search?')) {
    return new Response(JSON.stringify({
      results: [{
        benchmarkScore: 90,
        description: 'React official documentation',
        id: '/reactjs/react.dev',
        title: 'React',
        totalSnippets: 7000,
        trustScore: 10,
      }],
    }), { headers: { 'content-type': 'application/json' } })
  }
  if (url.startsWith('https://context7.com/api/v2/context?')) {
    return new Response(JSON.stringify({
      codeSnippets: [{ content: 'durable loader cache snippet', title: 'Cleanup' }],
    }), { headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`Unexpected local fixture URL: ${url}`)
}

try {
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }
  await writeFile(loaderConfig, originalConfig)

  const [{ boot }, documentation] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import('dsh-search-enhance/documentation'),
  ])

  ctx = await boot(
    'dsh-search-enhance-context7-cache-loader',
    loaderConfig,
    undefined,
    undefined,
    pathToFileURL(join(packageRoot, 'package.json')).href,
  )
  await ctx.loader.await()
  const pluginEntry = [...ctx.loader.entries()].find(
    entry => entry.options.name === 'dsh-search-enhance',
  )
  assert.ok(pluginEntry?.fiber, 'Loader did not create the package fiber')
  await pluginEntry.fiber.await()
  assert.equal(
    ctx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME),
    undefined,
    'the Context7 cache opened before a documentation route used it',
  )
  assert.equal(typeof ctx.searchEnhanceDocumentation.search, 'function')
  assert.equal(typeof ctx.searchEnhanceDocumentation.resolveContext7, 'function')
  assert.equal(typeof ctx.searchEnhanceDocumentation.queryContext7Docs, 'function')
  assert.equal(typeof ctx.searchEnhanceDocumentation.findContext7Doc, 'function')
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), expectedGlobalTools)

  const firstService = ctx.searchEnhanceDocumentation
  const first = await firstService.search({
    maxResults: 5,
    provider: 'context7',
    query: 'React useEffect API docs',
    signal: new AbortController().signal,
  })
  assert.deepEqual(
    { docs: first.cache.docs.state, resolve: first.cache.resolve.state },
    { docs: 'miss', resolve: 'miss' },
  )
  assert.match(first.docRef, /^ctx7d_[A-Za-z0-9_-]{43}$/)
  const matched = await firstService.findContext7Doc({
    query: 'durable loader cache snippet',
    maxScanRecords: documentation.CONTEXT7_CACHE_QUERY_MAX_SCAN_RECORDS,
    signal: new AbortController().signal,
  })
  assert.equal(matched.state, 'found')
  assert.equal(matched.state === 'found' ? matched.entry.docRef : undefined, first.docRef)
  assert.equal(matched.scannedRecords, 1)
  assert.equal(requests.length, 2, 'cache query unexpectedly dispatched to Context7')
  assert.ok(ctx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME))

  const storageFile = join(
    dshHome,
    'search-enhance-storage',
    `${documentation.CONTEXT7_CACHE_DOMAIN_NAME}.json`,
  )
  const storageText = await readFile(storageFile, 'utf8')
  assert.match(storageText, /durable loader cache snippet/)
  assert.doesNotMatch(storageText, /React useEffect API docs/)
  assert.doesNotMatch(storageText, /Authorization|Bearer|API_KEY/)

  await pluginEntry.fiber.restart()
  assert.notEqual(ctx.searchEnhanceDocumentation, firstService)
  assert.equal(
    ctx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME),
    undefined,
    'reload retained the old open Context7 cache domain',
  )
  await assert.rejects(
    firstService.search({
      maxResults: 5,
      provider: 'context7',
      query: 'React useEffect API docs',
      signal: new AbortController().signal,
    }),
    error => error?.name === 'AbortError',
  )

  const second = await ctx.searchEnhanceDocumentation.search({
    maxResults: 5,
    provider: 'context7',
    query: 'React useEffect API docs',
    signal: new AbortController().signal,
  })
  assert.deepEqual(
    { docs: second.cache.docs.state, resolve: second.cache.resolve.state },
    { docs: 'hit', resolve: 'hit' },
  )
  assert.equal(second.docRef, first.docRef)
  assert.equal(requests.length, 2, 'restart cache hit unexpectedly dispatched to Context7')

  await pluginEntry.fiber.dispose()
  assert.equal(ctx.get(documentation.DOCUMENTATION_SEARCH_SERVICE_KEY), undefined)
  assert.equal(ctx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas(), [])
  await ctx.fiber.dispose()
  disposed = true

  const damaged = JSON.parse(await readFile(storageFile, 'utf8'))
  const firstKey = Object.keys(damaged.tables.entries)[0]
  assert.ok(firstKey, 'Context7 cache file had no entry to damage')
  damaged.tables.entries[firstKey].createdAtMs = -1
  await writeFile(storageFile, `${JSON.stringify(damaged, null, 2)}\n`)

  // Explicit entry disposal persists as disabled. Restore the test composition
  // before proving lazy cache corruption does not prevent the plugin from loading.
  await writeFile(loaderConfig, originalConfig)
  secondCtx = await boot(
    'dsh-search-enhance-context7-cache-corrupt',
    loaderConfig,
    undefined,
    undefined,
    pathToFileURL(join(packageRoot, 'package.json')).href,
  )
  await secondCtx.loader.await()
  assert.deepEqual(secondCtx.tools.schemas().map(schema => schema.name), expectedGlobalTools)
  assert.equal(secondCtx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME), undefined)
  await assert.rejects(
    secondCtx.searchEnhanceDocumentation.search({
      maxResults: 5,
      provider: 'context7',
      query: 'React useEffect API docs',
      signal: new AbortController().signal,
    }),
    error => error?.code === 'DOCUMENTATION_SEARCH_FAILED',
  )
  assert.equal(
    secondCtx.storageDomain.get(documentation.CONTEXT7_CACHE_DOMAIN_NAME),
    undefined,
    'a corrupt cache became an open usable domain',
  )
  await secondCtx.fiber.dispose()
  secondDisposed = true

  process.stdout.write('context7 cache loader: ok (lazy open, durable restart hit, HMR cleanup, corrupt fail-closed)\n')
} finally {
  if (ctx !== undefined && !disposed && ctx.fiber.uid !== null) await ctx.fiber.dispose()
  if (secondCtx !== undefined && !secondDisposed && secondCtx.fiber.uid !== null) {
    await secondCtx.fiber.dispose()
  }
  globalThis.fetch = previousFetch
  await rm(dshHome, { force: true, recursive: true })
  if (createdSelfLink) await unlink(selfLink)
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-web-loader-'))
const loaderConfig = join(dshHome, 'cordis.yml')
const settingsFile = join(dshHome, 'settings.yaml')
const exampleConfig = join(packageRoot, 'examples/headless/cordis.yml')
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
  ...credentialNames.map(name => [name, process.env[name]]),
])

let ctx
let createdSelfLink = false

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function loadWithOfficialClientModuleSystem(row, origin) {
  const require = createRequire(import.meta.url)
  const officialBundle = await readFile(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8')
  const sandbox = { console }
  sandbox.window = sandbox
  let officialHandoff
  sandbox.__ModuleLoader__ = {
    load(handoff) {
      officialHandoff = handoff
    },
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(officialBundle, context, { filename: 'dsh-client-modules/client.js' })
  assert.equal(officialHandoff?.id, '@deepseek-ai/dsh-client-modules')
  const official = officialHandoff.factory(specifier => {
    throw new Error(`unexpected official loader dependency: ${specifier}`)
  })
  delete sandbox.__ModuleLoader__

  const React = await import('react')
  const jsxRuntime = await import('react/jsx-runtime')
  const modules = new official.ClientModuleSystem({
    modules: [{ id: row.id, url: row.url, rev: row.rev }],
    staticModules: {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      '@deepseek-ai/dsh-client-ui-primitives': {
        Button: () => null,
        StateDot: () => null,
      },
    },
    async loadBundle(url) {
      const response = await fetch(`${origin}${url}`)
      assert.equal(response.status, 200)
      vm.runInContext(await response.text(), context, { filename: 'dsh-search-enhance/client.js' })
    },
  })
  return modules.import('dsh-search-enhance')
}

process.env.DSH_HOME = dshHome
for (const name of credentialNames) delete process.env[name]

try {
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(packageRoot, selfLink, 'junction')
    createdSelfLink = true
  }

  const source = await readFile(exampleConfig, 'utf8')
  const configured = source.replace(
    '- id: search-enhance\n  name: dsh-search-enhance',
    `- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 0
- id: client-modules
  name: '@deepseek-ai/dsh-client-modules'
- id: search-enhance
  name: dsh-search-enhance`,
  )
  await writeFile(loaderConfig, configured)
  await symlink(join(packageRoot, 'node_modules'), join(dshHome, 'node_modules'), 'junction')
  await writeFile(settingsFile, `search-enhance:
  searchApi:
    baseUrl: https://grok-gateway.example/v1
    protocol: completions
    model: grok-4.20-beta
`)

  const [{ boot }, manifest] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import(pathToFileURL(join(packageRoot, 'package.json')).href, { with: { type: 'json' } }),
  ])
  ctx = await boot(
    'dsh-search-enhance-web-config-loader',
    loaderConfig,
    undefined,
    undefined,
    pathToFileURL(join(packageRoot, 'package.json')).href,
  )
  await ctx.loader.await()

  const pluginEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-search-enhance')
  assert.ok(pluginEntry?.fiber, 'Loader did not create the Search Enhance fiber')
  await pluginEntry.fiber.await()
  assert.equal(ctx.get('webServer') !== undefined, true)
  assert.equal(ctx.get('settings') !== undefined, true)
  assert.equal(ctx.get('credentials') !== undefined, true)

  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const first = await fetch(`${origin}/dsh-search-enhance/config`)
  assert.equal(first.status, 200)
  const firstSnapshot = await first.json()
  assert.equal(firstSnapshot.value.searchApi.baseUrl, 'https://grok-gateway.example/v1')
  assert.equal(firstSnapshot.value.searchApi.model, 'grok-4.20-beta')
  assert.equal(firstSnapshot.applies, 'restart')

  await waitFor(
    () => ctx.clientModules.graph().entries.some(entry => entry.id === 'dsh-search-enhance'),
    'client module registry did not discover dsh-search-enhance',
  )
  const rows = ctx.clientModules.graph().entries.filter(entry => entry.id === 'dsh-search-enhance')
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.deepEqual(row.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
  ])
  assert.equal(ctx.clientModules.clientPath('dsh-search-enhance'), join(packageRoot, 'client/client.js'))

  const served = await fetch(`${origin}${row.url}`)
  assert.equal(served.status, 200)
  assert.match(served.headers.get('content-type') ?? '', /^text\/javascript/u)
  assert.match(await served.text(), /^window\.__ModuleLoader__\.load\(\{\s*id: "dsh-search-enhance"/u)
  const sourceMap = await fetch(`${origin}/plugins/dsh-search-enhance/client.js.map`)
  assert.equal(sourceMap.status, 200)

  const loaded = await loadWithOfficialClientModuleSystem(row, origin)
  assert.equal(loaded.name, 'dsh-search-enhance-client')
  assert.deepEqual([...loaded.inject], ['slots', 'locale'])
  assert.equal(typeof loaded.apply, 'function')
  assert.equal(typeof loaded.SearchEnhancePluginCard, 'function')
  assert.equal('default' in loaded, false)

  const packageManifest = manifest.default
  assert.equal(packageManifest.dsh.client.platform, 'web')
  assert.equal(packageManifest.exports['./client'].default, './client/client.js')
  assert.equal(packageManifest.exports['./client'].types, './client/types/client/index.d.ts')
  assert.deepEqual(packageManifest.files, [
    'lib/**/*.js',
    'lib/**/*.d.ts',
    'client/client.js',
    'client/types/**/*.d.ts',
    'cordis.patch.yml',
    'README.md',
  ])
  await lstat(join(packageRoot, 'client/types/client/index.d.ts'))

  await pluginEntry.fiber.restart()
  await pluginEntry.fiber.await()
  const restarted = await fetch(`${origin}/dsh-search-enhance/config`)
  assert.equal(restarted.status, 200)
  assert.equal((await restarted.json()).value.searchApi.baseUrl, 'https://grok-gateway.example/v1')
  assert.equal(
    ctx.clientModules.graph().entries.filter(entry => entry.id === 'dsh-search-enhance').length,
    1,
    'restart duplicated the client graph row',
  )

  await pluginEntry.fiber.dispose()
  assert.equal((await fetch(`${origin}/dsh-search-enhance/config`)).status, 404)
  await waitFor(
    () => !ctx.clientModules.graph().entries.some(entry => entry.id === 'dsh-search-enhance'),
    'client graph row survived plugin disposal',
  )
  assert.equal((await fetch(`${origin}${row.url}`)).status, 404)

  process.stdout.write('web config loader: ok (real Host services/routes, rc.6 client discovery/module load, restart/dispose)\n')
} finally {
  await ctx?.fiber.dispose()
  if (createdSelfLink) await unlink(selfLink)
  await rm(dshHome, { recursive: true, force: true })
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

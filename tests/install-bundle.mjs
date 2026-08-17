import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = await realpath(dirname(dirname(fileURLToPath(import.meta.url))))
const profileName = 'search-enhance-install-acceptance'
const MAX_CAPTURE_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 180_000
const credentialNames = [
  'SEARCH_API_KEY',
  'CONTEXT7_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
]

async function commandAvailable(command) {
  return new Promise(resolve => {
    const child = spawn(command, ['--version'], {
      cwd: packageRoot,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

const [hasDsh, hasPnpm] = await Promise.all([
  commandAvailable('dsh'),
  commandAvailable('pnpm'),
])
if (!hasDsh || !hasPnpm) {
  const missing = [
    ...(!hasDsh ? ['dsh'] : []),
    ...(!hasPnpm ? ['pnpm'] : []),
  ]
  process.stdout.write(`bundle install acceptance: skipped (${missing.join(' and ')} not available on PATH)\n`)
  process.exit(0)
}

function appendBounded(current, chunk) {
  const next = current + chunk
  if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new Error('subprocess output exceeded the install-test capture limit')
  }
  return next
}

async function run(command, args, options) {
  let stdout = ''
  let stderr = ''
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let captureFailure
  child.stdout.on('data', chunk => {
    try {
      stdout = appendBounded(stdout, chunk)
    } catch (error) {
      captureFailure = error
      child.kill('SIGKILL')
    }
  })
  child.stderr.on('data', chunk => {
    try {
      stderr = appendBounded(stderr, chunk)
    } catch (error) {
      captureFailure = error
      child.kill('SIGKILL')
    }
  })

  const result = await new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, COMMAND_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut })
    })
  })
  if (captureFailure !== undefined) throw captureFailure
  if (result.timedOut) throw new Error(`${options.label} timed out`)
  if (result.code !== 0) {
    throw new Error([
      `${options.label} failed (${result.signal ?? `exit ${result.code}`})`,
      stdout.trim().length === 0 ? undefined : `stdout:\n${stdout.trim()}`,
      stderr.trim().length === 0 ? undefined : `stderr:\n${stderr.trim()}`,
    ].filter(Boolean).join('\n'))
  }
  return { stdout, stderr }
}

async function readManifest(profileDir) {
  return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
}

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-install-'))
const profileDir = join(dshHome, 'profiles', profileName)
const childEnvironment = { ...process.env, DSH_HOME: dshHome }
for (const name of credentialNames) delete childEnvironment[name]

try {
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'npm_execpath is unavailable')
  await run(process.execPath, [npmCli, 'run', 'build'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'npm run build',
  })

  await run('dsh', ['plugin', '--profile', profileName, 'add', packageRoot], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh plugin add',
  })

  const installed = await readManifest(profileDir)
  const dependency = installed.dependencies?.['dsh-search-enhance']
  assert.equal(typeof dependency, 'string')
  assert.ok(dependency.startsWith('link:'), 'profile dependency is not a local checkout link')
  assert.ok(installed.dsh?.profile?.bundles?.includes('dsh-search-enhance'))

  const addedDump = await run('dsh', ['--profile', profileName, '--dump-config'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh --dump-config after add',
  })
  const addedConfig = `${addedDump.stdout}\n${addedDump.stderr}`
  assert.match(addedConfig, /^# == dsh-search-enhance(?:\s|$)/m)
  assert.match(addedConfig, /^\s*name:\s*dsh-search-enhance\s*$/m)

  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const resolvedEntry = profileRequire.resolve('dsh-search-enhance')
  assert.equal(await realpath(resolvedEntry), await realpath(join(packageRoot, 'lib/index.js')))
  const resolvedClient = profileRequire.resolve('dsh-search-enhance/client')
  assert.equal(await realpath(resolvedClient), await realpath(join(packageRoot, 'client/client.js')))
  assert.match(await readFile(resolvedClient, 'utf8'), /^window\.__ModuleLoader__\.load\(\{\s*id: "dsh-search-enhance"/u)
  const installedPackage = JSON.parse(await readFile(profileRequire.resolve('dsh-search-enhance/package.json'), 'utf8'))
  assert.deepEqual(installedPackage.dsh.client, {
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    ],
    platform: 'web',
  })
  assert.equal(
    await realpath(join(packageRoot, installedPackage.exports['./client'].types)),
    await realpath(join(packageRoot, 'client/types/client/index.d.ts')),
  )
  const plugin = await import(`${pathToFileURL(resolvedEntry).href}?install-acceptance=1`)
  assert.deepEqual(Object.keys(plugin).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.equal('default' in plugin, false)
  assert.equal(typeof plugin.name, 'string')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
  const installedProxyConfig = plugin.Config({
    webExtract: {
      smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
      direct: { proxyUrl: 'http://127.0.0.1:7891' },
    },
  })
  assert.equal(installedProxyConfig.webExtract.smartDirect.proxyUrl, 'http://127.0.0.1:7890')
  assert.equal(installedProxyConfig.webExtract.direct.proxyUrl, 'http://127.0.0.1:7891')

  await run('dsh', ['plugin', '--profile', profileName, 'remove', 'dsh-search-enhance'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh plugin remove',
  })

  const removed = await readManifest(profileDir)
  assert.equal(removed.dependencies?.['dsh-search-enhance'], undefined)
  assert.equal(removed.dsh?.profile?.bundles?.includes('dsh-search-enhance'), false)
  const removedDump = await run('dsh', ['--profile', profileName, '--dump-config'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh --dump-config after remove',
  })
  const removedConfig = `${removedDump.stdout}\n${removedDump.stderr}`
  assert.doesNotMatch(removedConfig, /^# == dsh-search-enhance(?:\s|$)/m)
  assert.doesNotMatch(removedConfig, /^\s*name:\s*dsh-search-enhance\s*$/m)

  process.stdout.write('bundle install acceptance: ok (temporary DSH_HOME add/dump/import/client/remove)\n')
} finally {
  await rm(dshHome, { force: true, recursive: true })
}

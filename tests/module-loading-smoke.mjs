import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hookPath = join(packageRoot, 'tests/module-load-hook.mjs')
const probePath = join(packageRoot, 'tests/module-loading-probe.mjs')
const loaderSmokePath = join(packageRoot, 'tests/loader-smoke.mjs')

async function loadEvents(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function runObserved(label, entryArguments, environment = {}) {
  const root = await mkdtemp(join(tmpdir(), `dsh-module-load-${label}-`))
  const logPath = join(root, 'loads.jsonl')
  let stdout = ''
  let stderr = ''
  try {
    const child = spawn(process.execPath, [
      '--no-warnings',
      '--experimental-loader',
      hookPath,
      ...entryArguments,
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        DSH_MODULE_LOAD_LOG: logPath,
        ...environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    const result = await new Promise((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 60_000)
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, timedOut })
      })
    })
    assert.equal(result.timedOut, false, `${label} timed out`)
    assert.equal(
      result.code,
      0,
      `${label} failed (${result.signal ?? `exit ${result.code}`})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
    process.stdout.write(stdout)
    return await loadEvents(logPath)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

function assertLoaderComposedStage3(events) {
  assert.deepEqual(
    events.filter(event => event.category === 'defuddle'),
    [],
    'the Loader startup loaded defuddle/node before an applicable HTML extraction',
  )
  assert.deepEqual(
    events.filter(event => event.category === 'providers-barrel'),
    [],
    'the Loader startup evaluated the public providers barrel',
  )
  for (const category of [
    'linkedom',
    'smart-direct-runtime',
    'smart-direct-child-process',
    'direct-runtime',
  ]) {
    assert.ok(
      events.some(event => event.category === category),
      `the Loader startup did not compose ${category}`,
    )
  }
}

await runObserved('lazy', [probePath, 'lazy-loading'])

await runObserved('pure-research-plan', [probePath, 'pure-research-plan'])

const loaderEvents = await runObserved('loader', [loaderSmokePath])
assertLoaderComposedStage3(loaderEvents)

const blockedDetail = '/private/module-loader/defuddle-import-secret.mjs'
await runObserved('failure', [probePath, 'import-failure'], {
  DSH_BLOCK_DEFUDDLE_DETAIL: blockedDetail,
  DSH_BLOCK_DEFUDDLE_IMPORT: '1',
})

for (const scenario of ['cancel-import', 'timeout-import']) {
  await runObserved(scenario, [probePath, scenario])
}

process.stdout.write('module loading smoke: ok (root/Loader disclosure composition, lazy cached Defuddle, safe failure, cooperative settle)\n')

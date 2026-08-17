import { appendFileSync } from 'node:fs'

const logPath = process.env.DSH_MODULE_LOAD_LOG

function moduleCategory(specifier, url, parentURL) {
  const resolved = url ?? ''
  const parent = parentURL ?? ''
  if (
    specifier === 'defuddle/node'
    || resolved.endsWith('/node_modules/defuddle/dist/node.js')
  ) {
    return 'defuddle'
  }
  if (
    specifier === 'linkedom'
    || resolved.endsWith('/node_modules/linkedom/esm/index.js')
  ) {
    return 'linkedom'
  }
  if (resolved.endsWith('/lib/providers/index.js')) return 'providers-barrel'
  if (
    resolved.endsWith('/lib/providers/smart-direct.js')
    || resolved.endsWith('/lib/providers/smart-direct-child.js')
    || resolved.endsWith('/lib/providers/smart-direct-transport.js')
  ) {
    return 'smart-direct-runtime'
  }
  if (
    resolved.endsWith('/lib/providers/direct-fetch.js')
    || resolved.endsWith('/lib/providers/direct-http.js')
    || resolved.endsWith('/lib/providers/direct-content.js')
  ) {
    return 'direct-runtime'
  }
  if (specifier === 'node:child_process' && parent.includes('/lib/providers/smart-direct-child.js')) {
    return 'smart-direct-child-process'
  }
  return undefined
}

function record(value) {
  if (logPath === undefined) return
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, 'utf8')
}

export async function resolve(specifier, context, nextResolve) {
  const requestedCategory = moduleCategory(specifier, undefined, context.parentURL)
  if (requestedCategory !== undefined) {
    record({
      category: requestedCategory,
      hook: 'resolve-request',
      parentURL: context.parentURL,
      specifier,
    })
  }

  if (specifier === 'defuddle/node') {
    if (process.env.DSH_BLOCK_DEFUDDLE_IMPORT === '1') {
      const detail = process.env.DSH_BLOCK_DEFUDDLE_DETAIL ?? 'blocked Defuddle import'
      throw new Error(detail)
    }
  }

  const result = await nextResolve(specifier, context)
  const resolvedCategory = moduleCategory(specifier, result.url, context.parentURL)
  if (resolvedCategory !== undefined) {
    record({
      category: resolvedCategory,
      hook: 'resolve',
      parentURL: context.parentURL,
      specifier,
      url: result.url,
    })
  }
  return result
}

export async function load(url, context, nextLoad) {
  const category = moduleCategory(undefined, url, context.parentURL)
  if (category !== undefined) record({ category, hook: 'load', url })
  return nextLoad(url, context)
}

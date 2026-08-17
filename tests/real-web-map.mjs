import assert from 'node:assert/strict'

import { Config } from '../lib/config.js'
import { TavilyMapProvider } from '../lib/providers/index.js'

const apiKey = process.env.TAVILY_API_KEY?.trim()
if (!apiKey) {
  process.stdout.write('real web_map e2e: skipped (TAVILY_API_KEY is absent)\n')
  process.exit(0)
}

const url = process.env.WEB_MAP_E2E_URL?.trim() || 'https://docs.tavily.com/'
const config = Config({
  retry: {
    maxAttempts: 2,
    baseDelayMs: 1000,
    multiplier: 2,
    maxDelayMs: 3000,
    maxTotalDelayMs: 3000,
    jitterRatio: 0,
  },
  siteMap: {
    timeoutMs: 30_000,
    maxLinks: 5,
  },
})
const credentials = {
  async resolve(ref) {
    return String(ref) === 'TAVILY_API_KEY'
      ? { source: 'real-e2e-environment', value: apiKey }
      : undefined
  },
}
const provider = new TavilyMapProvider({ credentials })

const cancelled = new AbortController()
const reason = new Error('cancel real web_map before dispatch')
cancelled.abort(reason)
await assert.rejects(provider.map({
  url,
  maxDepth: 1,
  maxBreadth: 5,
  limit: 5,
  config,
  signal: cancelled.signal,
}), error => error === reason)

const result = await provider.map({
  url,
  instructions: 'Find documentation pages',
  maxDepth: 1,
  maxBreadth: 5,
  limit: 5,
  config,
  signal: new AbortController().signal,
})
assert.ok(Array.isArray(result.results))
assert.ok(result.results.length > 0, 'Tavily Map returned no discovered URL')
assert.ok(result.results.length <= 5)
for (const resultUrl of result.results) {
  const parsed = new URL(resultUrl)
  assert.ok(parsed.protocol === 'http:' || parsed.protocol === 'https:')
  assert.equal(parsed.username, '')
  assert.equal(parsed.password, '')
}
assert.ok(Number.isSafeInteger(result.attempts) && result.attempts >= 1)
assert.ok(Number.isSafeInteger(result.responseBytes) && result.responseBytes > 0)
assert.equal(JSON.stringify(result).includes(apiKey), false)
process.stdout.write(`real web_map e2e: Tavily Map ok (${result.results.length} discovered URLs)\n`)

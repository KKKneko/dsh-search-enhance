import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { Config } from '../lib/config.js'
import {
  FirecrawlScrapeProvider,
  SmartDirectProvider,
  TavilyExtractProvider,
} from '../lib/providers/index.js'

const targetUrl = process.env.WEB_EXTRACT_E2E_URL?.trim() || 'https://example.com/'
const keys = {
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
}

const configured = Object.entries(keys).filter(([, value]) => typeof value === 'string' && value.length > 0)

const credentials = {
  async resolve(ref) {
    const value = keys[String(ref)]
    return typeof value === 'string' && value.length > 0
      ? { source: 'real-e2e-environment', value }
      : undefined
  },
}
const config = Config({})

function input(url, format, signal = new AbortController().signal) {
  return {
    config,
    format,
    signal,
    url,
  }
}

async function verifyCancellation(provider, url, format, label) {
  const controller = new AbortController()
  const reason = new Error(`cancel ${label} before dispatch`)
  controller.abort(reason)
  await assert.rejects(provider.extract(input(url, format, controller.signal)), error => error === reason)
}

async function verifyProvider(provider, url, format, label) {
  await verifyCancellation(provider, url, format, label)
  const outcome = await provider.extract(input(url, format))
  assert.equal(outcome.state, 'complete', `${label} did not return complete content`)
  assert.equal(typeof outcome.result.content, 'string')
  assert.ok(outcome.result.content.trim().length > 0, `${label} returned empty content`)
  const serialized = JSON.stringify(outcome)
  for (const [, value] of configured) assert.equal(serialized.includes(value), false)
  process.stdout.write(`real web extract e2e: ${label} ok (${outcome.result.content.length} characters)\n`)
}

const localServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html><head><title>Built smart_direct</title></head><body><article><p>The built production smart direct adapter extracts this local deterministic article with enough useful words.</p><p>No external site is required for this check.</p></article></body></html>')
})
await new Promise((resolve, reject) => {
  localServer.once('error', reject)
  localServer.listen(0, '127.0.0.1', resolve)
})
try {
  const address = localServer.address()
  assert.ok(address && typeof address === 'object')
  await verifyProvider(
    new SmartDirectProvider(),
    `http://127.0.0.1:${address.port}/article`,
    'markdown',
    'smart_direct local built adapter',
  )
} finally {
  await new Promise((resolve, reject) => {
    localServer.close(error => error === undefined ? resolve() : reject(error))
  })
}

if (configured.length === 0) {
  process.stdout.write('real web extract e2e: remote adapters skipped (TAVILY_API_KEY and FIRECRAWL_API_KEY are absent)\n')
  process.exit(0)
}

if (keys.TAVILY_API_KEY) {
  await verifyProvider(
    new TavilyExtractProvider({ credentials }),
    targetUrl,
    'markdown',
    'Tavily Extract',
  )
} else {
  process.stdout.write('real web extract e2e: Tavily Extract skipped (TAVILY_API_KEY is absent)\n')
}

if (keys.FIRECRAWL_API_KEY) {
  await verifyProvider(
    new FirecrawlScrapeProvider({ credentials }),
    targetUrl,
    'markdown',
    'Firecrawl Scrape',
  )
} else {
  process.stdout.write('real web extract e2e: Firecrawl Scrape skipped (FIRECRAWL_API_KEY is absent)\n')
}

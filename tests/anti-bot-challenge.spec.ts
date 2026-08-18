import { describe, expect, it } from 'vitest'

import {
  parseFirecrawlScrapeResponse,
  parseTavilyExtractResponse,
} from '../src/providers/index.js'
import { isLikelyAntiBotChallenge } from '../src/providers/web-extract-common.js'

const SCAN_BYTES = 32 * 1024
const CLOUDFLARE_SCRIPT = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'

function utf8Filler(bytes: number): string {
  return `${'界'.repeat(Math.floor(bytes / 3))}${'a'.repeat(bytes % 3)}`
}

describe('anti-bot challenge detection', () => {
  it.each([
    ['Cloudflare script path', CLOUDFLARE_SCRIPT],
    ['Cloudflare runtime variable', '<script>window._cf_chl_opt = { cType: "managed" }</script>'],
    ['Cloudflare title', '<title>Just a moment...</title>'],
    ['PerimeterX container', '<div id="px-captcha"></div>'],
    ['Imperva resource', '<script src="/_Incapsula_Resource?SWJIYLWA=1"></script>'],
    ['DataDome endpoint', '<script src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></script>'],
  ])('recognizes the exact %s marker', (_label, content) => {
    expect(isLikelyAntiBotChallenge(content)).toBe(true)
  })

  it('recognizes paired Cloudflare copy after a text extractor removes HTML markers', () => {
    expect(isLikelyAntiBotChallenge(
      'Just a moment...\n\nEnable JavaScript and cookies to continue',
    )).toBe(true)
    expect(isLikelyAntiBotChallenge(
      'Checking your browser before accessing example.test\nDDoS protection by Cloudflare',
    )).toBe(true)
  })

  it.each([403, 429, 503])(
    'requires a strong challenge signal alongside blocked HTTP status %s',
    statusCode => {
      expect(isLikelyAntiBotChallenge(
        '<main>Performing security verification. Verify you are human.</main>',
        statusCode,
      )).toBe(true)
      expect(isLikelyAntiBotChallenge(
        '<article>This guide discusses access denied errors, challenge design, and rate limits.</article>',
        statusCode,
      )).toBe(false)
    },
  )

  it('does not classify ordinary discussion, titles, widgets, or JavaScript notices', () => {
    expect(isLikelyAntiBotChallenge(
      '<title>Cloudflare challenge design</title><article>This article explains access denied responses.</article>',
    )).toBe(false)
    expect(isLikelyAntiBotChallenge(
      '<title>Access denied errors in APIs</title><article>A challenge can protect an endpoint.</article>',
      403,
    )).toBe(false)
    expect(isLikelyAntiBotChallenge(
      '<form><div class="cf-turnstile">Verify you are human before submitting this form.</div></form>',
    )).toBe(false)
    expect(isLikelyAntiBotChallenge(
      '<noscript>Enable JavaScript and cookies to continue using all site features.</noscript>',
    )).toBe(false)
    expect(isLikelyAntiBotChallenge('')).toBe(false)
  })

  it('uses the explicit Cloudflare mitigation header as a body-independent signal', () => {
    expect(isLikelyAntiBotChallenge('', 200, ' Challenge ')).toBe(true)
    expect(isLikelyAntiBotChallenge('', 503, 'not-a-challenge')).toBe(false)
  })

  it('inspects exactly a 32 KiB UTF-8 prefix', () => {
    const markerBytes = Buffer.byteLength(CLOUDFLARE_SCRIPT, 'utf8')
    expect(isLikelyAntiBotChallenge(
      `${'a'.repeat(SCAN_BYTES - markerBytes)}${CLOUDFLARE_SCRIPT}`,
    )).toBe(true)
    expect(isLikelyAntiBotChallenge(
      `${'a'.repeat(SCAN_BYTES)}${CLOUDFLARE_SCRIPT}`,
    )).toBe(false)
  })

  it('applies the 32 KiB boundary without splitting multibyte content', () => {
    const markerBytes = Buffer.byteLength(CLOUDFLARE_SCRIPT, 'utf8')
    expect(isLikelyAntiBotChallenge(
      `${utf8Filler(SCAN_BYTES - markerBytes)}${CLOUDFLARE_SCRIPT}`,
    )).toBe(true)
    expect(Buffer.byteLength(utf8Filler(SCAN_BYTES), 'utf8')).toBe(SCAN_BYTES)
    expect(isLikelyAntiBotChallenge(
      `${utf8Filler(SCAN_BYTES)}${CLOUDFLARE_SCRIPT}`,
    )).toBe(false)
  })

  it('rejects remote challenge content before the configured output truncation', () => {
    const challenge = `ordinary-prefix${CLOUDFLARE_SCRIPT}anti-bot-page-secret`
    let tavilyError: unknown
    let firecrawlError: unknown
    try {
      parseTavilyExtractResponse(
        JSON.stringify({
          results: [{ raw_content: challenge, status: 200, url: 'https://secret.example/tavily' }],
        }),
        'markdown',
        2048,
        1,
      )
    } catch (error) {
      tavilyError = error
    }
    try {
      parseFirecrawlScrapeResponse(
        JSON.stringify({
          data: {
            markdown: challenge,
            metadata: { sourceURL: 'https://secret.example/firecrawl', statusCode: 403 },
          },
        }),
        'markdown',
        2048,
        1,
      )
    } catch (error) {
      firecrawlError = error
    }

    expect(tavilyError).toMatchObject({
      code: 'SEARCH_PROVIDER_UNAVAILABLE',
      kind: 'unavailable',
      provider: 'tavily_extract',
      retryable: false,
    })
    expect(firecrawlError).toMatchObject({
      code: 'SEARCH_PROVIDER_UNAVAILABLE',
      kind: 'unavailable',
      provider: 'firecrawl_scrape',
      retryable: false,
    })
    const visible = `${String(tavilyError)}\n${JSON.stringify(tavilyError)}\n${String(firecrawlError)}\n${JSON.stringify(firecrawlError)}`
    expect(visible).not.toContain('anti-bot-page-secret')
    expect(visible).not.toContain('secret.example')
  })

  it('keeps blocked-status content that only discusses challenge vocabulary', () => {
    const discussion = 'A technical article about access denied errors, challenge flows, and rate limits.'
    expect(parseTavilyExtractResponse(
      JSON.stringify({ results: [{ raw_content: discussion, status: 403 }] }),
      'text',
      2048,
      10_000,
    )).toMatchObject({ content: discussion, statusCode: 403 })
    expect(parseFirecrawlScrapeResponse(
      JSON.stringify({ data: { markdown: discussion, metadata: { statusCode: 503 } } }),
      'markdown',
      2048,
      10_000,
    )).toMatchObject({ content: discussion, statusCode: 503 })
  })
})

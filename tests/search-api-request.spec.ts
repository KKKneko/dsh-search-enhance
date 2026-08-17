import { describe, expect, it } from 'vitest'

import {
  Config,
  SEARCH_API_PROTOCOLS,
  THINKING_LEVELS,
  type SearchApiProtocol,
  type ThinkingLevel,
} from '../src/config.js'
import {
  buildSearchApiRequest,
  normalizeSearchApiModel,
  reasoningEffort,
  searchApiEndpoint,
  searchApiModelsEndpoint,
} from '../src/providers/search-api-request.js'
import { resolveSearchStrategy } from '../src/search/index.js'

const resolveConfig = (input: unknown) => Config(input as never)

function prepare(protocol: SearchApiProtocol, thinkingLevel: ThinkingLevel) {
  const config = resolveConfig({
    searchApi: {
      baseUrl: 'https://search.example.test/v1/',
      credentialRef: 'ROTATING_SEARCH_KEY',
      model: 'search-model',
      protocol,
      thinkingLevel,
    },
  })
  return buildSearchApiRequest({
    config: config.searchApi,
    query: '  bounded query  ',
    strategy: resolveSearchStrategy(config, { depth: 'normal', profile: 'coding_docs' }),
  })
}

describe('credential-free Search API request construction', () => {
  it.each(SEARCH_API_PROTOCOLS)('selects the required %s endpoint', (protocol) => {
    const request = prepare(protocol, 'off')
    expect(request.endpoint).toBe(protocol === 'responses'
      ? 'https://search.example.test/v1/responses'
      : 'https://search.example.test/v1/chat/completions')
    expect(request).toMatchObject({
      body: request.body,
      endpoint: request.endpoint,
      model: 'search-model',
      protocol,
    })
    expect(request.serializedBody).toBe(JSON.stringify(request.body))
    expect(JSON.stringify(request.body)).toContain('# Search Profile: Coding Docs')
    expect(JSON.stringify(request.body)).toContain('Mode: normal')
    expect(JSON.stringify(request)).not.toContain('ROTATING_SEARCH_KEY')
    expect(request).not.toHaveProperty('credentialRef')
  })

  it.each(THINKING_LEVELS)(
    'maps completions reasoning level %s without aliases',
    (thinkingLevel) => {
      const request = prepare('completions', thinkingLevel)
      const body = request.body as Record<string, unknown>
      expect(body).toMatchObject({
        messages: [
          { content: expect.stringContaining('# Core Instruction'), role: 'system' },
          { content: 'bounded query', role: 'user' },
        ],
        model: 'search-model',
        stream: true,
      })
      if (thinkingLevel === 'off') {
        expect(body).not.toHaveProperty('reasoning_effort')
      } else {
        expect(body.reasoning_effort).toBe(thinkingLevel)
      }
    },
  )

  it.each(THINKING_LEVELS)(
    'maps Responses reasoning level %s without aliases',
    (thinkingLevel) => {
      const request = prepare('responses', thinkingLevel)
      const body = request.body as Record<string, unknown>
      expect(body).toMatchObject({
        input: 'bounded query',
        instructions: expect.stringContaining('# Search Profile: Coding Docs'),
        model: 'search-model',
        store: false,
        stream: true,
      })
      expect(body).not.toHaveProperty('messages')
      if (thinkingLevel === 'off') expect(body).not.toHaveProperty('reasoning')
      else expect(body.reasoning).toEqual({ effort: thinkingLevel })
    },
  )

  it('includes the exact injected time context in the wire body', () => {
    const config = resolveConfig({
      searchApi: {
        model: 'search-model',
        protocol: 'responses',
      },
    })
    const request = buildSearchApiRequest({
      config: config.searchApi,
      query: 'latest release',
      strategy: resolveSearchStrategy(config),
      timeContext: {
        date: '2026-01-02',
        time: '03:04:05',
        timeZone: 'UTC',
      },
    })

    expect((request.body as Record<string, unknown>).input).toBe(
      '[Current Time Context]\n'
      + '- Date: 2026-01-02\n'
      + '- Time: 03:04:05\n'
      + '- Timezone: UTC\n\n'
      + 'latest release',
    )
    expect(request.serializedBody).toBe(JSON.stringify(request.body))
  })

  it('normalizes terminal paths and preserves the configured Grok model id', () => {
    expect(searchApiEndpoint('https://host.test/v1/responses', 'completions'))
      .toBe('https://host.test/v1/chat/completions')
    expect(searchApiEndpoint('https://host.test/v1/chat/completions', 'responses'))
      .toBe('https://host.test/v1/responses')
    expect(searchApiModelsEndpoint('https://host.test/v1/chat/completions'))
      .toBe('https://host.test/v1/models')
    expect(normalizeSearchApiModel('  grok-search-model  ')).toBe('grok-search-model')
  })

  it('rejects every unknown protocol/thinking enum and empty model/query', () => {
    expect(() => searchApiEndpoint('https://host.test/v1', 'chat' as SearchApiProtocol))
      .toThrow(TypeError)
    expect(() => searchApiEndpoint('https://secret@host.test/v1', 'completions'))
      .toThrow('must not contain credentials')
    expect(() => searchApiModelsEndpoint('https://host.test/v1?key=secret'))
      .toThrow('must not contain credentials, query, or fragment')
    expect(() => reasoningEffort('none' as ThinkingLevel)).toThrow(TypeError)
    expect(() => normalizeSearchApiModel('  ')).toThrow(RangeError)

    const config = resolveConfig({ searchApi: { model: 'model' } })
    expect(() => buildSearchApiRequest({
      config: config.searchApi,
      query: '  ',
      strategy: resolveSearchStrategy(config),
    })).toThrow(RangeError)
  })
})

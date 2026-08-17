import { describe, expect, it } from 'vitest'

import {
  parseSearchAnswerText,
  parseSearchApiResponse,
  SearchResponseParseError,
} from '../src/search/index.js'

function completionsJson(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content }, unknown: { ignored: true } }],
    unknown: ['bounded by the complete response byte limit'],
  })
}

describe('Search API answer and source parsing', () => {
  it('extracts an English Sources section with Markdown and bare links', () => {
    const result = parseSearchAnswerText(`The bounded answer.

## Sources:
- [Official docs](https://docs.example.test/api)
- https://status.example.test/current`, { maxSources: 2 })

    expect(result).toEqual({
      answer: 'The bounded answer.',
      sources: [
        {
          provider: 'search-api',
          title: 'Official docs',
          url: 'https://docs.example.test/api',
        },
        {
          provider: 'search-api',
          url: 'https://status.example.test/current',
        },
      ],
      sourcesTruncated: false,
    })
  })

  it('extracts a Chinese reference heading and preserves stable order', () => {
    const result = parseSearchAnswerText(`答案。

**参考资料：**
1. [公告](https://example.test/notice)
2. [记录](https://example.test/record)`)

    expect(result.answer).toBe('答案。')
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://example.test/notice',
      'https://example.test/record',
    ])
  })

  it('keeps inline Markdown citations in the answer and returns structured sources', () => {
    const input = 'Use the [versioned API](https://docs.example.test/v2) for this call.'
    const result = parseSearchAnswerText(input)

    expect(result.answer).toBe(input)
    expect(result.sources).toEqual([{
      provider: 'search-api',
      title: 'versioned API',
      url: 'https://docs.example.test/v2',
    }])
    expect(result.sourcesTruncated).toBe(false)
  })

  it('prioritizes inline citations when a trailing list exactly fills the limit', () => {
    const answer = 'Use the [official API](https://official.example.test/api) for this call.'
    const result = parseSearchAnswerText(`${answer}\n\nSources:\n- [One](https://tail.example.test/1)\n- [Two](https://tail.example.test/2)`, {
      maxSources: 2,
    })

    expect(result.answer).toBe(answer)
    expect(result.sources.map(source => source.url)).toEqual([
      'https://official.example.test/api',
      'https://tail.example.test/1',
    ])
    expect(result.sourcesTruncated).toBe(true)
  })

  it('fills an over-limit trailing list only after all inline citations', () => {
    const answer = [
      'Compare the [official API](https://official.example.test/api)',
      'with the [release notes](https://official.example.test/releases).',
    ].join(' ')
    const trailing = Array.from(
      { length: 4 },
      (_, index) => `- [Tail ${index + 1}](https://tail.example.test/${index + 1})`,
    ).join('\n')
    const result = parseSearchAnswerText(`${answer}\n\nSources:\n${trailing}`, { maxSources: 3 })

    expect(result.sources.map(source => source.url)).toEqual([
      'https://official.example.test/api',
      'https://official.example.test/releases',
      'https://tail.example.test/1',
    ])
    expect(result.sourcesTruncated).toBe(true)
  })

  it('deduplicates an exact trailing-slash citation across answer and source block', () => {
    const result = parseSearchAnswerText(`Use the [official API](https://official.example.test/api/).

Sources:
- [Duplicate](https://official.example.test/api/)
- [Secondary](https://secondary.example.test/page)`)

    expect(result.sources).toEqual([
      {
        provider: 'search-api',
        title: 'official API',
        url: 'https://official.example.test/api/',
      },
      {
        provider: 'search-api',
        title: 'Secondary',
        url: 'https://secondary.example.test/page',
      },
    ])
    expect(result.sourcesTruncated).toBe(false)
  })

  it('keeps trailing-slash URL variants distinct under exact deduplication', () => {
    const result = parseSearchAnswerText(`Use the [API](https://official.example.test/api).

Sources:
- [Slash variant](https://official.example.test/api/)`)

    expect(result.sources.map(source => source.url)).toEqual([
      'https://official.example.test/api',
      'https://official.example.test/api/',
    ])
    expect(result.sourcesTruncated).toBe(false)
  })

  it('parses function-call source lists, Python literals, aliases, and metadata', () => {
    const result = parseSearchAnswerText(`Verified answer.
sources({'sources': [
  {'title': 'Primary record', 'href': 'https://records.example.test/a', 'description': 'Original filing', 'publishedDate': '2026-01-02'},
  ['Official mirror', 'https://official.example.test/a'],
  {'ignored': True, 'value': None}
]})`)

    expect(result).toEqual({
      answer: 'Verified answer.',
      sources: [
        {
          provider: 'search-api',
          publishedAt: '2026-01-02',
          snippet: 'Original filing',
          title: 'Primary record',
          url: 'https://records.example.test/a',
        },
        {
          provider: 'search-api',
          title: 'Official mirror',
          url: 'https://official.example.test/a',
        },
      ],
      sourcesTruncated: false,
    })
  })

  it.each([
    ['citation_card', 'citation_card'],
    ['source_cards', 'source_cards'],
    ['references', 'references'],
  ])('accepts the %s function-call source alias', (_label, functionName) => {
    const result = parseSearchAnswerText(
      `Answer\n${functionName}([{"url":"https://example.test/${functionName}"}])`,
    )
    expect(result.sources[0]?.url).toBe(`https://example.test/${functionName}`)
  })

  it('extracts a trailing block only when at least two link-only lines exist', () => {
    const result = parseSearchAnswerText(`Answer with no heading.

- [One](https://one.example.test/path)
- https://two.example.test/path`)

    expect(result.answer).toBe('Answer with no heading.')
    expect(result.sources).toHaveLength(2)
  })

  it('retains Pi-compatible trailing details source blocks', () => {
    const result = parseSearchAnswerText(`Answer.
<details><summary>References</summary>
[One](https://one.example.test)
[Two](https://two.example.test)
</details>`)

    expect(result.answer).toBe('Answer.')
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://one.example.test',
      'https://two.example.test',
    ])
  })

  it('leaves an empty trailing source block unchanged and untruncated', () => {
    const input = 'Answer.\n\nSources:'
    expect(parseSearchAnswerText(input)).toEqual({
      answer: input,
      sources: [],
      sourcesTruncated: false,
    })
  })

  it('deduplicates exact URLs and applies a stable source-count prefix limit', () => {
    const result = parseSearchAnswerText(`Answer.

Sources:
- [First](https://example.test/one)
- [Duplicate](https://example.test/one)
- [Second](https://example.test/two)`, { maxSources: 1 })

    expect(result.sources).toEqual([{
      provider: 'search-api',
      title: 'First',
      url: 'https://example.test/one',
    }])
    expect(result.sourcesTruncated).toBe(true)
  })
})

describe('bounded OpenAI-compatible response parsing', () => {
  it('assembles completions SSE before parsing answer and sources', () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Answer.\\n\\nSources:\\n"}}]}',
      'data: {"choices":[{"delta":{"content":"- [Docs](https://docs.example.test)"}}]}',
      'data: [DONE]',
      '',
    ].join('\n\n')

    expect(parseSearchApiResponse(body, 'completions')).toEqual({
      answer: 'Answer.',
      sources: [{
        provider: 'search-api',
        title: 'Docs',
        url: 'https://docs.example.test',
      }],
      sourcesTruncated: false,
    })
  })

  it('supports Responses SSE deltas, completed envelopes, and chat-style proxies', () => {
    const native = [
      'data: {"type":"response.created","response":{"ignored":true}}',
      'data: {"type":"response.output_text.delta","delta":"Hello "}',
      'data: {"type":"response.output_text.delta","delta":"world"}',
      'data: [DONE]',
    ].join('\n\n')
    const completed = [
      'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"Completed response"}]}]}}',
      'data: [DONE]',
    ].join('\n\n')
    const proxy = 'data: {"choices":[{"delta":{"content":"Proxy response"}}]}\n\ndata: [DONE]\n'

    expect(parseSearchApiResponse(native, 'responses').answer).toBe('Hello world')
    expect(parseSearchApiResponse(completed, 'responses').answer).toBe('Completed response')
    expect(parseSearchApiResponse(proxy, 'responses').answer).toBe('Proxy response')
  })

  it('supports non-streaming completions and Responses JSON envelopes', () => {
    expect(parseSearchApiResponse(completionsJson('Complete answer'), 'completions').answer)
      .toBe('Complete answer')

    const responses = JSON.stringify({
      output: [{
        type: 'message',
        content: [
          { type: 'output_text', text: 'Part one. ' },
          { type: 'output_text', text: 'Part two.' },
        ],
      }],
      unknown: { ignored: true },
    })
    expect(parseSearchApiResponse(responses, 'responses').answer).toBe('Part one. Part two.')
  })

  it.each([
    [completionsJson(''), 'completions' as const],
    [JSON.stringify({ output_text: '' }), 'responses' as const],
    ['data: [DONE]\n\n', 'completions' as const],
  ])('returns a valid empty result for a recognized empty envelope', (body, protocol) => {
    expect(parseSearchApiResponse(body, protocol)).toEqual({
      answer: '',
      sources: [],
      sourcesTruncated: false,
    })
  })

  it.each([
    ['', 'completions' as const],
    ['not json', 'completions' as const],
    ['{}', 'responses' as const],
    ['{"choices":"broken"}', 'completions' as const],
    ['data: {not-json}\n\n', 'responses' as const],
    ['{"output":[42]}', 'responses' as const],
  ])('rejects malformed protocol input %#', (body, protocol) => {
    expect(() => parseSearchApiResponse(body, protocol)).toThrowError(
      expect.objectContaining({ code: 'SEARCH_RESPONSE_MALFORMED' }),
    )
  })

  it('enforces exact UTF-8 response bytes without splitting multibyte content', () => {
    const body = completionsJson('边界🙂')
    const exactBytes = Buffer.byteLength(body, 'utf8')

    expect(parseSearchApiResponse(body, 'completions', { maxResponseBytes: exactBytes }).answer)
      .toBe('边界🙂')
    expect(() => parseSearchApiResponse(body, 'completions', {
      maxResponseBytes: exactBytes - 1,
    })).toThrowError(expect.objectContaining({
      actual: exactBytes,
      code: 'SEARCH_RESPONSE_LIMIT',
      maximum: exactBytes - 1,
    }))
  })

  it('bounds SSE event count, source nesting, and known source fields', () => {
    const twoEvents = [
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      'data: {"choices":[{"delta":{"content":"b"}}]}',
    ].join('\n\n')
    expect(() => parseSearchApiResponse(twoEvents, 'completions', { maxSseEvents: 1 }))
      .toThrow(SearchResponseParseError)

    expect(() => parseSearchAnswerText(
      'Answer\nsources({"sources":{"sources":{"sources":["https://example.test"]}}})',
      { maxSourceNesting: 1 },
    )).toThrowError(expect.objectContaining({ code: 'SEARCH_RESPONSE_LIMIT' }))

    expect(() => parseSearchAnswerText(
      'Answer\nsources([{"url":"https://example.test","title":"太长了"}])',
      { maxTitleCharacters: 2 },
    )).toThrowError(expect.objectContaining({ code: 'SEARCH_RESPONSE_LIMIT' }))
  })
})

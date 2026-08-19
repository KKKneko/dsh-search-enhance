import { describe, expect, it } from 'vitest'

import {
  extractMarkdownCitationUrls,
  parseSearchAnswerText,
  parseSearchApiResponse,
  SearchResponseParseError,
} from '../src/search/parse.js'

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

  it('does not rescan URL-looking Markdown labels as bare sources', () => {
    const input = `Answer.

Sources:
- [https://docs.example.test/api](https://docs.example.test/api)
- https://status.example.test/current`
    const result = parseSearchAnswerText(input, { maxSources: 2 })

    expect(result).toEqual({
      answer: 'Answer.',
      sources: [
        {
          provider: 'search-api',
          title: 'https://docs.example.test/api',
          url: 'https://docs.example.test/api',
        },
        {
          provider: 'search-api',
          url: 'https://status.example.test/current',
        },
      ],
      sourcesTruncated: false,
    })
    expect(result.sources.some(source => source.url.includes(']('))).toBe(false)

    const bounded = parseSearchAnswerText(
      'Answer.\n\nSources:\n- [https://docs.example.test/api](https://docs.example.test/api)',
      { maxSources: 1 },
    )
    expect(bounded.sources).toHaveLength(1)
    expect(bounded.sourcesTruncated).toBe(false)
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

  it('keeps semantic labels but omits single- and double-bracket citation ordinals', () => {
    const answer = [
      '[Guide](https://docs.example.test/guide)',
      '[1](https://docs.example.test/single-ordinal)',
      '[[2]](https://docs.example.test/double-ordinal)',
      '[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)',
      '[React 19](https://react.dev/blog/2024/12/05/react-19)',
    ].join(' ')
    const result = parseSearchAnswerText(answer)

    expect(result.answer).toBe(answer)
    expect(result.sources).toEqual([
      { provider: 'search-api', title: 'Guide', url: 'https://docs.example.test/guide' },
      { provider: 'search-api', url: 'https://docs.example.test/single-ordinal' },
      { provider: 'search-api', url: 'https://docs.example.test/double-ordinal' },
      { provider: 'search-api', title: 'RFC 9110', url: 'https://www.rfc-editor.org/rfc/rfc9110' },
      { provider: 'search-api', title: 'React 19', url: 'https://react.dev/blog/2024/12/05/react-19' },
    ])
  })

  it('extracts ordinary and numeric double-bracket citations in answer order', () => {
    const input = [
      '[Guide](https://docs.example.test/guide)',
      '[[2]](https://docs.example.test/reference)',
      '[[3]](https://docs.example.test/guide)',
      '[[bad]](https://docs.example.test/malformed)',
      '[[[4]](https://docs.example.test/extra-bracket)',
    ].join(' ')

    expect(extractMarkdownCitationUrls(input)).toEqual([
      'https://docs.example.test/guide',
      'https://docs.example.test/reference',
    ])
    expect(parseSearchAnswerText(input).sources.map(source => source.url)).toEqual([
      'https://docs.example.test/guide',
      'https://docs.example.test/reference',
    ])
    const rejectedTail = parseSearchAnswerText('Answer.\n\nSources:\n- [[bad]](https://docs.example.test/bad)\n- [[[4]](https://docs.example.test/triple)')
    expect(rejectedTail.sources).toEqual([])
    expect(rejectedTail.answer).toContain('[[bad]]')
  })

  it('parses double-bracket citations once without malformed bare-URL fallthrough', () => {
    const answer = 'Use [[1]](https://docs.example.test/api) with [Guide](https://docs.example.test/guide).'
    const result = parseSearchApiResponse(completionsJson(
      `${answer}\n\nSources:\n- [[1]](https://docs.example.test/api)\n- [Guide](https://docs.example.test/guide)\n- [[2]](https://docs.example.test/overflow)`,
    ), 'completions', { maxSources: 2 })

    expect(result.answer).toBe(answer)
    expect(result.sources).toEqual([
      { provider: 'search-api', url: 'https://docs.example.test/api' },
      { provider: 'search-api', title: 'Guide', url: 'https://docs.example.test/guide' },
    ])
    expect(result.sources.some(source => source.url.includes(']('))).toBe(false)
    expect(result.sourcesTruncated).toBe(true)
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

  it('preserves Lancet, Wikipedia, and nested balanced parentheses in Markdown URLs', () => {
    const lancet = 'https://www.thelancet.com/journals/lanonc/article/PIIS1470-2045(16)30239-X/abstract'
    const wikipedia = 'https://en.wikipedia.org/wiki/Function_(mathematics)'
    const nested = 'https://example.test/archive/a_(b_(c)_d)_e'
    const answer = [
      `[Lancet](${lancet})`,
      `[[1]](${wikipedia})`,
      `[Nested](${nested})`,
    ].join(' ')
    const result = parseSearchAnswerText(answer)

    expect(result.answer).toBe(answer)
    expect(result.sources).toEqual([
      { provider: 'search-api', title: 'Lancet', url: lancet },
      { provider: 'search-api', url: wikipedia },
      { provider: 'search-api', title: 'Nested', url: nested },
    ])
    expect(extractMarkdownCitationUrls(answer)).toEqual([lancet, wikipedia, nested])
    expect(result.sources.some(source => source.url.includes(']('))).toBe(false)
  })

  it('keeps balanced bare URLs while removing only prose closers and sentence punctuation', () => {
    const lancet = 'https://www.thelancet.com/journals/lanonc/article/PIIS1470-2045(16)30239-X/abstract'
    const wikipedia = 'https://en.wikipedia.org/wiki/Function_(mathematics)'
    const encoded = 'https://example.test/report%28final%29?q=%28kept%29#part_%28one%29'
    const result = parseSearchAnswerText(`Answer.

Sources:
- ${lancet}
- ${wikipedia}.
- See (${encoded}).`)

    expect(result.answer).toBe('Answer.')
    expect(result.sources.map(source => source.url)).toEqual([lancet, wikipedia, encoded])
  })

  it('does not alter balanced parentheses inside bare query or fragment content', () => {
    const url = 'https://example.test/path_(x)?next=a(b)&encoded=%28c%29#section_(d)'
    const result = parseSearchAnswerText(`Answer.\n\nSources:\n- See (${url})).`)

    expect(result.sources).toEqual([{ provider: 'search-api', url }])
  })

  it('enriches an earlier exact citation from later structured source metadata', () => {
    const url = 'https://example.test/reports/annual(2024)'
    const answer = `Use [[1]](${url}) for the result.`
    const result = parseSearchAnswerText(`${answer}\nsources([{\"url\":${JSON.stringify(url)},\"title\":\"Annual report\",\"description\":\"Audited results\",\"publishedAt\":\"2025-02-03\"}])`)

    expect(result.answer).toBe(answer)
    expect(result.sources).toEqual([{
      provider: 'search-api',
      publishedAt: '2025-02-03',
      snippet: 'Audited results',
      title: 'Annual report',
      url,
    }])
    expect(result.sourcesTruncated).toBe(false)
  })

  it('retains the first non-empty metadata field for each exact URL', () => {
    const url = 'https://example.test/reports/first(2024)'
    const result = parseSearchAnswerText(`Use [[1]](${url}).\nsources(${JSON.stringify([
      { url, title: 'First title' },
      { url, title: 'Second title', snippet: 'First snippet' },
      { url, snippet: 'Second snippet', publishedAt: '2025-01-01' },
      { url, publishedAt: '2026-01-01' },
    ])})`)

    expect(result.sources).toEqual([{
      provider: 'search-api',
      publishedAt: '2025-01-01',
      snippet: 'First snippet',
      title: 'First title',
      url,
    }])
  })

  it('enforces tiny, exact, and over-limit URL characters by Unicode code point', () => {
    const url = 'https://example.test/界🙂_(x)'
    const exactCharacters = Array.from(url).length
    const answer = `[Unicode](${url})`

    expect(parseSearchAnswerText(answer, { maxUrlCharacters: exactCharacters }).sources[0]?.url)
      .toBe(url)
    for (const maximum of [1, exactCharacters - 1]) {
      expect(() => parseSearchAnswerText(answer, { maxUrlCharacters: maximum }))
        .toThrowError(expect.objectContaining({
          actual: exactCharacters,
          code: 'SEARCH_RESPONSE_LIMIT',
          maximum,
        }))
    }
  })

  it('parses function-call source lists, Python literals, aliases, and metadata', () => {
    const result = parseSearchAnswerText(`Verified answer.
sources({'sources': [
  {'title': 'Primary record', 'href': 'https://records.example.test/a_(b)', 'description': 'Original filing', 'publishedDate': '2026-01-02'},
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
          url: 'https://records.example.test/a_(b)',
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

- [One](https://one.example.test/path_(one))
- https://two.example.test/path_(two)`)

    expect(result.answer).toBe('Answer with no heading.')
    expect(result.sources.map(source => source.url)).toEqual([
      'https://one.example.test/path_(one)',
      'https://two.example.test/path_(two)',
    ])
  })

  it('retains Pi-compatible trailing details source blocks', () => {
    const result = parseSearchAnswerText(`Answer.
<details><summary>References</summary>
[One](https://one.example.test/Function_(one))
[Two](https://two.example.test/Function_(two))
</details>`)

    expect(result.answer).toBe('Answer.')
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://one.example.test/Function_(one)',
      'https://two.example.test/Function_(two)',
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
  it('does not charge exact duplicates against maxSources and preserves truncation semantics', () => {
    const first = 'https://example.test/report(2024)'
    const second = 'https://example.test/second'
    const third = 'https://example.test/third'
    const answer = `Use [[1]](${first}).`
    const items = [
      { url: first, title: 'Report' },
      { url: first, snippet: 'Metadata enrichment' },
      { url: second, title: 'Second' },
    ]
    const exact = parseSearchAnswerText(`${answer}\nsources(${JSON.stringify(items)})`, {
      maxSources: 2,
    })

    expect(exact.sources).toEqual([
      { provider: 'search-api', title: 'Report', snippet: 'Metadata enrichment', url: first },
      { provider: 'search-api', title: 'Second', url: second },
    ])
    expect(exact.sourcesTruncated).toBe(false)

    const over = parseSearchAnswerText(
      `${answer}\nsources(${JSON.stringify([...items, { url: third }])})`,
      { maxSources: 2 },
    )
    expect(over.sources).toEqual(exact.sources)
    expect(over.sourcesTruncated).toBe(true)
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

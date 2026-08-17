import { describe, expect, it } from 'vitest'

import {
  assertUtf8WithinLimit,
  OutputLimitError,
  retainJsonPrefix,
  truncateCharacters,
  truncateUtf8,
  utf8ByteLength,
} from '../src/provider-runtime/index.js'

describe('output protection at exact value boundaries', () => {
  it('handles tiny, exact, over-limit, and multibyte UTF-8 boundaries', () => {
    const value = 'A猫🙂'
    expect(utf8ByteLength(value)).toBe(8)
    expect(truncateUtf8(value, 0)).toEqual({
      outputBytes: 0,
      text: '',
      totalBytes: 8,
      truncated: true,
    })
    expect(truncateUtf8(value, 4)).toMatchObject({ outputBytes: 4, text: 'A猫', truncated: true })
    expect(truncateUtf8(value, 7)).toMatchObject({ outputBytes: 4, text: 'A猫', truncated: true })
    expect(truncateUtf8(value, 8)).toEqual({
      outputBytes: 8,
      text: value,
      totalBytes: 8,
      truncated: false,
    })
  })

  it('counts Unicode characters without splitting surrogate pairs', () => {
    expect(truncateCharacters('a🙂b', 2)).toEqual({
      outputCharacters: 2,
      text: 'a🙂',
      totalCharacters: 3,
      truncated: true,
    })
    expect(truncateCharacters('a🙂b', 3).truncated).toBe(false)
  })

  it('accepts exact byte limits and throws one byte over', () => {
    const value = '界'
    expect(() => assertUtf8WithinLimit(value, 3, 'answer')).not.toThrow()
    expect(() => assertUtf8WithinLimit(value, 2, 'answer')).toThrowError(OutputLimitError)
  })

  it('measures the complete JSON envelope while retaining a stable prefix', () => {
    const sources = [
      { title: 'one', url: 'https://one.example' },
      { title: '二', url: 'https://two.example' },
    ]
    const project = (retained: readonly (typeof sources)[number][], total: number) => ({
      sources: retained,
      total,
      truncated: retained.length < total,
    })
    const fullEnvelope = project(sources, sources.length)
    const fullBytes = utf8ByteLength(JSON.stringify(fullEnvelope))
    const oneBytes = utf8ByteLength(JSON.stringify(project(sources.slice(0, 1), sources.length)))
    const emptyBytes = utf8ByteLength(JSON.stringify(project([], sources.length)))

    const exact = retainJsonPrefix(sources, {
      label: 'source record',
      maxBytes: fullBytes,
      maxItems: sources.length,
      project,
    })
    expect(exact.retained).toEqual(sources)
    expect(exact.outputBytes).toBe(fullBytes)
    expect(exact.truncated).toBe(false)

    const over = retainJsonPrefix(sources, {
      label: 'source record',
      maxBytes: oneBytes,
      maxItems: sources.length,
      project,
    })
    expect(over.retained).toEqual(sources.slice(0, 1))
    expect(over.outputBytes).toBe(oneBytes)
    expect(over.truncated).toBe(true)
    expect(over.value).toEqual(project(sources.slice(0, 1), sources.length))

    expect(() => retainJsonPrefix(sources, {
      label: 'source record',
      maxBytes: emptyBytes - 1,
      maxItems: sources.length,
      project,
    })).toThrowError(OutputLimitError)
  })

  it('applies the item bound independently from the byte bound', () => {
    const result = retainJsonPrefix(['a', 'b'], {
      label: 'source record',
      maxBytes: 10_000,
      maxItems: 1,
      project: (items, total) => ({ items, total }),
    })

    expect(result.retained).toEqual(['a'])
    expect(result.truncated).toBe(true)
  })

  it('rejects values that JSON would silently change', () => {
    expect(() => retainJsonPrefix([new Date(0)], {
      label: 'source record',
      maxBytes: 10_000,
      maxItems: 1,
      project: (items) => ({ items }),
    })).toThrow(/lossless JSON/)
  })
})

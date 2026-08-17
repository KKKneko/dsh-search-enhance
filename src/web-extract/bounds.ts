import {
  OutputLimitError,
  truncateCharacters,
  utf8ByteLength,
} from '../provider-runtime/index.js'
import type {
  WebExtractResult,
  WebExtractResultCandidate,
} from './types.js'

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function project(
  result: WebExtractResultCandidate,
  content: string,
  truncated: boolean,
): Readonly<WebExtractResult> {
  return Object.freeze({
    ...result,
    attempts: Object.freeze(result.attempts.map(attempt => Object.freeze({ ...attempt }))),
    content,
    truncated,
  })
}

function envelopeBytes(result: WebExtractResult): number {
  return utf8ByteLength(JSON.stringify(result))
}

/**
 * Enforce the content-character and complete-envelope byte limits independently.
 * The complete envelope (including metadata, route status, and truncation fact)
 * is measured after every candidate projection. Unicode prefixes never split a
 * code point. A successful result may not be reduced to an empty body; if even
 * the minimum truthful non-empty projection cannot fit, this function fails.
 */
export function boundWebExtractResult(
  result: WebExtractResultCandidate,
  maximumContentCharacters: number,
  maximumEnvelopeBytes: number,
): Readonly<WebExtractResult> {
  nonNegativeSafeInteger(maximumContentCharacters, 'maximumContentCharacters')
  nonNegativeSafeInteger(maximumEnvelopeBytes, 'maximumEnvelopeBytes')
  if (typeof result.content !== 'string' || result.content.trim().length === 0) {
    throw new OutputLimitError('web_extract content', maximumContentCharacters, 0)
  }

  const limited = truncateCharacters(result.content, maximumContentCharacters)
  if (limited.text.length === 0) {
    throw new OutputLimitError(
      'web_extract content',
      maximumContentCharacters,
      limited.totalCharacters,
    )
  }
  const contentTruncated = result.truncated || limited.truncated
  const initial = project(result, limited.text, contentTruncated)
  if (envelopeBytes(initial) <= maximumEnvelopeBytes) return initial

  const codePoints = Array.from(limited.text)
  let low = 1
  let high = codePoints.length
  let best: Readonly<WebExtractResult> | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = project(
      result,
      codePoints.slice(0, middle).join(''),
      result.truncated || middle < codePoints.length,
    )
    if (envelopeBytes(candidate) <= maximumEnvelopeBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (best === undefined) {
    throw new OutputLimitError(
      'web_extract envelope',
      maximumEnvelopeBytes,
      envelopeBytes(project(result, '', true)),
    )
  }
  return best
}

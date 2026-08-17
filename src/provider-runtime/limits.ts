import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

export class OutputLimitError extends RangeError {
  readonly code = 'SEARCH_OUTPUT_LIMIT'
  readonly label: string
  readonly maximum: number
  readonly actual: number

  constructor(label: string, maximum: number, actual: number) {
    super(`${label} requires ${actual} bytes but its limit is ${maximum}`)
    this.name = 'OutputLimitError'
    this.label = label
    this.maximum = maximum
    this.actual = actual
  }
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export interface TruncatedText {
  readonly text: string
  readonly truncated: boolean
  readonly totalBytes: number
  readonly outputBytes: number
}

/** Keep the longest stable prefix that fits, without splitting a Unicode code point. */
export function truncateUtf8(value: string, maxBytes: number): TruncatedText {
  nonNegativeSafeInteger(maxBytes, 'maxBytes')
  const totalBytes = utf8ByteLength(value)
  if (totalBytes <= maxBytes) {
    return { outputBytes: totalBytes, text: value, totalBytes, truncated: false }
  }

  let bytes = 0
  let codeUnits = 0
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint)
    if (bytes + codePointBytes > maxBytes) break
    bytes += codePointBytes
    codeUnits += codePoint.length
  }

  return {
    outputBytes: bytes,
    text: value.slice(0, codeUnits),
    totalBytes,
    truncated: true,
  }
}

export interface TruncatedCharacters {
  readonly text: string
  readonly truncated: boolean
  readonly totalCharacters: number
  readonly outputCharacters: number
}

/** Character bound measured in Unicode code points, not UTF-16 code units. */
export function truncateCharacters(value: string, maxCharacters: number): TruncatedCharacters {
  nonNegativeSafeInteger(maxCharacters, 'maxCharacters')
  let totalCharacters = 0
  let retainedCodeUnits = 0
  for (const codePoint of value) {
    if (totalCharacters < maxCharacters) retainedCodeUnits += codePoint.length
    totalCharacters += 1
  }
  const truncated = totalCharacters > maxCharacters
  return {
    outputCharacters: truncated ? maxCharacters : totalCharacters,
    text: truncated ? value.slice(0, retainedCodeUnits) : value,
    totalCharacters,
    truncated,
  }
}

export function assertUtf8WithinLimit(value: string, maxBytes: number, label: string): void {
  nonNegativeSafeInteger(maxBytes, 'maxBytes')
  const actual = utf8ByteLength(value)
  if (actual > maxBytes) throw new OutputLimitError(label, maxBytes, actual)
}

export interface JsonPrefixOptions<T> {
  readonly maxItems: number
  readonly maxBytes: number
  readonly label: string
  /** Build the complete event/output envelope for this retained prefix. */
  readonly project: (retained: readonly T[], totalItems: number) => unknown
}

export interface JsonPrefixResult<T> {
  readonly retained: readonly T[]
  readonly totalItems: number
  readonly truncated: boolean
  readonly outputBytes: number
  /** Detached, lossless JSON snapshot of the exact measured envelope. */
  readonly value: JsonValue
}

function snapshotAndMeasure(value: unknown, label: string): { value: JsonValue; bytes: number } {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError(`${label} is not lossless JSON`)
  return { bytes: utf8ByteLength(JSON.stringify(snapshot)), value: snapshot as JsonValue }
}

/**
 * Retain a stable item prefix while measuring the caller's complete projected JSON envelope.
 * The empty envelope must itself fit; otherwise a structured success cannot be represented.
 */
export function retainJsonPrefix<T>(
  items: readonly T[],
  options: JsonPrefixOptions<T>,
): JsonPrefixResult<T> {
  const maxItems = nonNegativeSafeInteger(options.maxItems, 'maxItems')
  const maxBytes = nonNegativeSafeInteger(options.maxBytes, 'maxBytes')
  const itemLimit = Math.min(items.length, maxItems)
  let retained: readonly T[] = Object.freeze([])
  let measured = snapshotAndMeasure(options.project(retained, items.length), options.label)
  if (measured.bytes > maxBytes) {
    throw new OutputLimitError(options.label, maxBytes, measured.bytes)
  }

  for (let count = 1; count <= itemLimit; count += 1) {
    const candidate = Object.freeze(items.slice(0, count))
    const candidateMeasured = snapshotAndMeasure(
      options.project(candidate, items.length),
      options.label,
    )
    if (candidateMeasured.bytes > maxBytes) break
    retained = candidate
    measured = candidateMeasured
  }

  return {
    outputBytes: measured.bytes,
    retained,
    totalItems: items.length,
    truncated: retained.length < items.length,
    value: measured.value,
  }
}

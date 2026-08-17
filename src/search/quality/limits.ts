export interface SourceQualityLimits {
  /** Maximum source records whose quality fields may participate in reranking. */
  readonly maxComparableSources: number
  /** Maximum query code points inspected for temporal and version intent. */
  readonly maxQueryCharacters: number
  /** Maximum URL code points parsed and compared per source. */
  readonly maxUrlCharacters: number
  /** Maximum title code points compared per source. */
  readonly maxTitleCharacters: number
  /** Maximum snippet code points compared per source. */
  readonly maxSnippetCharacters: number
  /** Maximum Provider date code points parsed per source. */
  readonly maxPublishedAtCharacters: number
  /** Aggregate code-point budget for all quality comparisons in one operation. */
  readonly maxTotalComparisonCharacters: number
}

/**
 * Fixed defensive bounds for the pure quality stage. Provider and persistence
 * limits remain independent; exceeding one of these limits disables reranking
 * rather than truncating source metadata.
 */
export const DEFAULT_SOURCE_QUALITY_LIMITS: Readonly<SourceQualityLimits> = Object.freeze({
  maxComparableSources: 2_048,
  maxPublishedAtCharacters: 128,
  maxQueryCharacters: 4_096,
  maxSnippetCharacters: 2_048,
  maxTitleCharacters: 512,
  maxTotalComparisonCharacters: 256 * 1024,
  maxUrlCharacters: 4_096,
})

export function resolveSourceQualityLimits(
  overrides: Partial<SourceQualityLimits>,
): Readonly<SourceQualityLimits> {
  const limits = Object.freeze({ ...DEFAULT_SOURCE_QUALITY_LIMITS, ...overrides })
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  return limits
}

export interface BoundedComparisonText {
  readonly characters: number
  readonly exceeded: boolean
  readonly text: string
}

/** Read at most `maximum + 1` Unicode code points without materializing an unbounded array. */
export function boundedComparisonText(
  value: string,
  maximum: number,
): BoundedComparisonText {
  const codePoints: string[] = []
  let characters = 0
  for (const codePoint of value) {
    if (characters === maximum) {
      return Object.freeze({ characters, exceeded: true, text: codePoints.join('') })
    }
    codePoints.push(codePoint)
    characters += 1
  }
  return Object.freeze({ characters, exceeded: false, text: codePoints.join('') })
}

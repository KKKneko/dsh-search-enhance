import type { Config } from '../config.js'
import type { CanonicalSource } from '../contracts/index.js'
import {
  OutputLimitError,
  ProviderError,
  retainJsonPrefix,
  utf8ByteLength,
  type ProviderCapability,
} from '../provider-runtime/index.js'
import type { BoundedSourceProviderResult, DocumentationSnippet } from './types.js'

export interface BoundSourceProviderResultInput {
  readonly capability: Extract<ProviderCapability, 'docs_search' | 'web_search'>
  readonly provider: string
  readonly sources: readonly CanonicalSource[]
  readonly snippets?: readonly DocumentationSnippet[]
  readonly responseBytes: number
  readonly requestedSources: number
  readonly config: Config
  /** True when a scalar parser already shortened a complete upstream value. */
  readonly inputTruncated?: boolean
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function resultEnvelope(
  sources: readonly CanonicalSource[],
  snippets: readonly DocumentationSnippet[],
  totals: { readonly sources: number; readonly snippets: number },
  responseBytes: number,
  inputTruncated: boolean,
): BoundedSourceProviderResult {
  return {
    responseBytes,
    returnedSnippets: snippets.length,
    returnedSources: sources.length,
    snippets,
    sources,
    totalSnippets: totals.snippets,
    totalSources: totals.sources,
    truncated: inputTruncated || sources.length < totals.sources || snippets.length < totals.snippets,
  }
}

/**
 * Keep stable source/snippet prefixes while measuring the complete canonical
 * Provider envelope. Source count and JSON-byte limits remain independent.
 */
export function boundSourceProviderResult(
  input: BoundSourceProviderResultInput,
): Readonly<BoundedSourceProviderResult> {
  const requestedSources = nonNegativeInteger(input.requestedSources, 'requestedSources')
  const responseBytes = nonNegativeInteger(input.responseBytes, 'responseBytes')
  const maximumSources = Math.min(requestedSources, input.config.retention.providerMaxSources)
  const maximumSnippets = Math.min(requestedSources, input.config.retention.providerMaxSources)
  const snippets = input.snippets ?? []
  const totals = Object.freeze({ sources: input.sources.length, snippets: snippets.length })
  const maximumBytes = input.config.retention.providerResultMaxBytes

  try {
    const sourcePrefix = retainJsonPrefix(input.sources, {
      label: `${input.provider} canonical result`,
      maxBytes: maximumBytes,
      maxItems: maximumSources,
      project: retained => resultEnvelope(
        retained,
        [],
        totals,
        responseBytes,
        input.inputTruncated === true,
      ),
    })
    const snippetPrefix = retainJsonPrefix(snippets, {
      label: `${input.provider} canonical result`,
      maxBytes: maximumBytes,
      maxItems: maximumSnippets,
      project: retained => resultEnvelope(
        sourcePrefix.retained,
        retained,
        totals,
        responseBytes,
        input.inputTruncated === true,
      ),
    })
    const result = Object.freeze(resultEnvelope(
      Object.freeze([...sourcePrefix.retained]),
      Object.freeze([...snippetPrefix.retained]),
      totals,
      responseBytes,
      input.inputTruncated === true,
    ))
    if (utf8ByteLength(JSON.stringify(result)) > maximumBytes) {
      throw new OutputLimitError(
        `${input.provider} canonical result`,
        maximumBytes,
        utf8ByteLength(JSON.stringify(result)),
      )
    }
    return result
  } catch (error) {
    if (!(error instanceof OutputLimitError)) throw error
    throw new ProviderError({
      capability: input.capability,
      cause: error,
      kind: 'budget_exceeded',
      provider: input.provider,
    })
  }
}

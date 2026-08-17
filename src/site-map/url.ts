import { ProviderError } from '../provider-runtime/index.js'
import { canonicalHttpUrl } from '../providers/helpers.js'

function validCharacterLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

/** Preserve a trimmed absolute HTTP(S) spelling when it is safe for the site-map contract. */
export function canonicalSiteMapUrl(
  value: unknown,
  maximumCharacters: number,
): string | undefined {
  validCharacterLimit(maximumCharacters, 'maximumCharacters')
  return typeof value === 'string'
    ? canonicalHttpUrl(value, maximumCharacters)
    : undefined
}

/** Validate the model-requested root URL without connecting to that target from the host. */
export function normalizeSiteMapUrl(value: unknown, maximumCharacters: number): string {
  const url = canonicalSiteMapUrl(value, maximumCharacters)
  if (url === undefined) {
    throw new ProviderError({
      capability: 'site_map',
      kind: 'invalid_request',
      provider: 'tavily',
    })
  }
  return url
}

/** Trim optional instructions, omit blank input, and enforce a Unicode code-point limit. */
export function normalizeSiteMapInstructions(
  value: unknown,
  maximumCharacters: number,
): string | undefined {
  validCharacterLimit(maximumCharacters, 'maximumCharacters')
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ProviderError({
      capability: 'site_map',
      kind: 'invalid_request',
      provider: 'tavily',
    })
  }
  const instructions = value.trim()
  if (instructions.length === 0) return undefined
  if (Array.from(instructions).length > maximumCharacters) {
    throw new ProviderError({
      capability: 'site_map',
      kind: 'invalid_request',
      provider: 'tavily',
    })
  }
  return instructions
}

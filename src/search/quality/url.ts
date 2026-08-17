import { boundedComparisonText } from './limits.js'

/** Fixed, deliberately narrow list of query keys that carry attribution rather than resource identity. */
export const SOURCE_TRACKING_QUERY_PARAMETERS = Object.freeze([
  '_ga',
  '_gl',
  'dclid',
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'yclid',
] as const)

const TRACKING_QUERY_PARAMETER_SET = new Set<string>(SOURCE_TRACKING_QUERY_PARAMETERS)

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || TRACKING_QUERY_PARAMETER_SET.has(lower)
}

function sortedSemanticParameters(url: URL): readonly (readonly [string, string, number])[] {
  const parameters: Array<readonly [string, string, number]> = []
  let index = 0
  for (const [name, value] of url.searchParams) {
    if (!isTrackingParameter(name)) parameters.push(Object.freeze([name, value, index]))
    index += 1
  }
  parameters.sort((left, right) => (
    compareCodeUnits(left[0], right[0])
    || compareCodeUnits(left[1], right[1])
    || left[2] - right[2]
  ))
  return Object.freeze(parameters)
}

/**
 * Normalize one bounded HTTP(S) source URL. The returned spelling is the
 * deterministic representative retained by the quality pipeline.
 *
 * Ordinary query parameters are never removed. Non-HTTP(S), malformed,
 * userinfo-bearing, and over-limit inputs return `undefined`.
 */
export function normalizeSourceUrl(
  value: string,
  maximumCharacters: number,
): string | undefined {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
    throw new RangeError('maximumCharacters must be a non-negative safe integer')
  }
  const trimmed = value.trim()
  const bounded = boundedComparisonText(trimmed, maximumCharacters)
  if (bounded.exceeded || bounded.text.length === 0) return undefined

  let parsed: URL
  try {
    parsed = new URL(bounded.text)
  } catch {
    return undefined
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) return undefined

  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase()
  if (
    (parsed.protocol === 'http:' && parsed.port === '80')
    || (parsed.protocol === 'https:' && parsed.port === '443')
  ) parsed.port = ''
  parsed.hash = ''

  if (parsed.pathname.length === 0) parsed.pathname = '/'
  else if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, '')

  const parameters = sortedSemanticParameters(parsed)
  parsed.search = ''
  for (const [name, parameterValue] of parameters) {
    parsed.searchParams.append(name, parameterValue)
  }
  return parsed.href
}

/**
 * Over-limit Provider URLs are opaque: retain only an obvious HTTP(S) spelling
 * whose inspected prefix contains a complete, non-userinfo authority, then
 * exclude it from normalization, deduplication, and ranking. This bounded
 * fallback is intentionally conservative and never upgrades or repairs a URL.
 */
export function retainOpaqueHttpUrl(
  value: string,
  inspectedPrefix: string,
): string | undefined {
  const scheme = /^https?:\/\//i.exec(inspectedPrefix)?.[0]
  if (scheme === undefined) return undefined
  const authorityAndPath = inspectedPrefix.slice(scheme.length)
  const boundaryIndexes = [
    authorityAndPath.indexOf('/'),
    authorityAndPath.indexOf('?'),
    authorityAndPath.indexOf('#'),
  ].filter(index => index >= 0)
  if (boundaryIndexes.length === 0) return undefined
  const authority = authorityAndPath.slice(0, Math.min(...boundaryIndexes))
  if (authority.length === 0 || authority.includes('@')) return undefined
  return value.trim()
}

import { ProviderError } from '../provider-runtime/index.js'

/**
 * Normalize the small URL preflight shared by every web-extract route.
 *
 * This intentionally checks only the constraints approved for stage 3:
 * trimming, an absolute HTTP/HTTPS URL, no userinfo, and a Unicode-code-point
 * length cap. It does **not** reject localhost, loopback, link-local, private,
 * metadata, reserved, or DNS-rebinding targets. That is an accepted SSRF risk
 * for the future local routes; deployments must use network isolation or tool
 * visibility controls when model-supplied URLs are not trusted. Remote Tavily
 * and Firecrawl results therefore never claim local direct-HTTP evidence.
 */
export function normalizeWebExtractUrl(value: string, maximumCharacters: number): string {
  if (typeof value !== 'string') {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'invalid_request',
      provider: 'web-extract-orchestrator',
    })
  }
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new RangeError('maximumCharacters must be a positive safe integer')
  }

  const trimmed = value.trim()
  const authority = /^https?:\/\/([^/?#]*)/i.exec(trimmed)?.[1]
  if (
    trimmed.length === 0
    || Array.from(trimmed).length > maximumCharacters
    || authority === undefined
    || authority.includes('@')
  ) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'invalid_request',
      provider: 'web-extract-orchestrator',
    })
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw new ProviderError({
      capability: 'web_extract',
      cause: error,
      kind: 'invalid_request',
      provider: 'web-extract-orchestrator',
    })
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'invalid_request',
      provider: 'web-extract-orchestrator',
    })
  }

  // Preserve the caller's post-trim spelling. No network-category inspection
  // or DNS lookup belongs in this preflight.
  return trimmed
}

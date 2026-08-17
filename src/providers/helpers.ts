import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

import { ProviderError, throwIfAborted, type ProviderCapability } from '../provider-runtime/index.js'

export type ProviderCredentials = Pick<CredentialProvider, 'describe' | 'resolve'>
export type ProviderCredentialResolver = Pick<CredentialProvider, 'resolve'>

/** Validate and append one Provider path without permitting credential-bearing URL metadata. */
export function providerEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new RangeError('Provider base URL must be an absolute HTTP(S) URL')
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(trimmed)?.[1]
  if (
    authority === undefined
    || authority.includes('@')
    || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new RangeError('Provider base URL must not contain credentials, query, or fragment')
  }
  return `${trimmed.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Return a trimmed scalar from the first supported response key. */
export function firstString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse a complete response exactly once, mapping syntax errors to a safe Provider category. */
export function parseProviderJson(
  body: string,
  provider: string,
  capability: ProviderCapability,
): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new ProviderError({
      capability,
      cause: error,
      kind: 'invalid_response',
      provider,
    })
  }
}

/** Preserve the response spelling while accepting only bounded credential-free HTTP(S) URLs. */
export function canonicalHttpUrl(value: string | undefined, maximumCharacters: number): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  const authority = /^https?:\/\/([^/?#]*)/i.exec(trimmed)?.[1]
  if (
    trimmed.length === 0
    || Array.from(trimmed).length > maximumCharacters
    || authority === undefined
    || authority.includes('@')
  ) return undefined
  try {
    const parsed = new URL(trimmed)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/** Probe configured state through the secret-free Credentials surface. */
export async function credentialIsConfigured(
  credentials: ProviderCredentials,
  ref: CredentialRef,
  provider: string,
  capability: ProviderCapability,
): Promise<boolean> {
  try {
    return (await credentials.describe(ref)).configured
  } catch (error) {
    throw new ProviderError({
      capability,
      cause: error,
      kind: 'unavailable',
      provider,
    })
  }
}

/** Resolve a credential once for this operation; absence is a non-error optional state. */
export async function resolveOptionalCredential(
  credentials: ProviderCredentialResolver,
  ref: CredentialRef,
  signal: AbortSignal,
  provider: string,
  capability: ProviderCapability,
): Promise<ResolvedCredential | undefined> {
  throwIfAborted(signal)
  let resolved: ResolvedCredential | undefined
  try {
    resolved = await credentials.resolve(ref)
  } catch (error) {
    throwIfAborted(signal)
    throw new ProviderError({
      capability,
      cause: error,
      kind: 'credential_missing',
      provider,
    })
  }
  throwIfAborted(signal)
  if (resolved === undefined || resolved.value.length === 0) return undefined
  return resolved
}

export function positiveLimit(value: number, provider: string, capability: ProviderCapability): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderError({
      capability,
      kind: 'invalid_request',
      provider,
    })
  }
  return value
}

export function nonEmptyQuery(value: string, provider: string, capability: ProviderCapability): string {
  const query = value.trim()
  if (query.length === 0) {
    throw new ProviderError({
      capability,
      kind: 'invalid_request',
      provider,
    })
  }
  return query
}

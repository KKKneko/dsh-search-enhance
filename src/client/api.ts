import {
  WEB_CONFIG_PATH,
  WEB_CREDENTIALS_PATH,
  type WebBridgeErrorBody,
  type WebConfigSnapshot,
  type WebCredentialDeleteRequest,
  type WebCredentialSlot,
  type WebCredentialWriteRequest,
  type WebCredentialWriteResult,
  type WebSettingsMutationRequest,
} from '../web-config/contracts.js'

const MAX_CLIENT_RESPONSE_CHARACTERS = 256 * 1024

export class WebConfigClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly actualRevision?: number,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseError(value: unknown, status: number): WebConfigClientError {
  if (isRecord(value) && isRecord(value['error'])) {
    const error = value['error'] as WebBridgeErrorBody['error']
    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return new WebConfigClientError(
        status,
        error.code,
        error.message,
        typeof error.actualRevision === 'number' ? error.actualRevision : undefined,
      )
    }
  }
  return new WebConfigClientError(status, 'invalid-response', 'The Host returned an invalid error response.')
}

function parseSnapshot(value: unknown): WebConfigSnapshot {
  if (
    !isRecord(value)
    || value['namespace'] !== 'search-enhance'
    || value['applies'] !== 'restart'
    || !Number.isSafeInteger(value['revision'])
    || typeof value['writable'] !== 'boolean'
    || !isRecord(value['value'])
    || !isRecord(value['credentials'])
    || !isRecord(value['options'])
    || !isRecord(value['diagnostics'])
  ) {
    throw new WebConfigClientError(502, 'invalid-response', 'The Host returned an invalid configuration response.')
  }
  return value as unknown as WebConfigSnapshot
}

async function requestJson(
  path: string,
  init: RequestInit,
): Promise<{ response: Response; value: unknown }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      accept: 'application/json',
      ...init.headers,
    },
  })
  const text = await response.text()
  if ([...text].length > MAX_CLIENT_RESPONSE_CHARACTERS) {
    throw new WebConfigClientError(502, 'response-too-large', 'The Host response exceeded the client limit.')
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new WebConfigClientError(502, 'invalid-response', 'The Host returned invalid JSON.')
  }
  if (!response.ok) throw parseError(value, response.status)
  return { response, value }
}

export async function loadWebConfig(signal?: AbortSignal): Promise<WebConfigSnapshot> {
  const { value } = await requestJson(WEB_CONFIG_PATH, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  return parseSnapshot(value)
}

export async function saveWebConfig(
  request: WebSettingsMutationRequest,
  signal?: AbortSignal,
): Promise<WebConfigSnapshot> {
  const { value } = await requestJson(WEB_CONFIG_PATH, {
    method: 'PATCH',
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(request),
  })
  return parseSnapshot(value)
}

export async function writeWebCredential(
  credential: WebCredentialSlot,
  value: string,
  signal?: AbortSignal,
): Promise<WebCredentialWriteResult> {
  const request: WebCredentialWriteRequest = { credential, value }
  const response = await requestJson(WEB_CREDENTIALS_PATH, {
    method: 'PUT',
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(request),
  })
  if (!isRecord(response.value) || response.value['credential'] !== credential || !isRecord(response.value['state'])) {
    throw new WebConfigClientError(502, 'invalid-response', 'The Host returned an invalid credential response.')
  }
  return response.value as unknown as WebCredentialWriteResult
}

export async function deleteWebCredential(
  credential: WebCredentialSlot,
  signal?: AbortSignal,
): Promise<WebCredentialWriteResult> {
  const request: WebCredentialDeleteRequest = { credential }
  const response = await requestJson(WEB_CREDENTIALS_PATH, {
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(request),
  })
  if (!isRecord(response.value) || response.value['credential'] !== credential || !isRecord(response.value['state'])) {
    throw new WebConfigClientError(502, 'invalid-response', 'The Host returned an invalid credential response.')
  }
  return response.value as unknown as WebCredentialWriteResult
}

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

import * as client from '../src/client/index.js'
import {
  SearchEnhancePluginCard,
  type SearchEnhancePluginCardProps,
} from '../src/client/SearchEnhancePluginCard.js'
import { en, type SearchEnhanceLocaleKey } from '../src/client/locales.js'
import type {
  WebConfigSnapshot,
  WebCredentialSlot,
  WebCredentialState,
} from '../src/web-config/contracts.js'

function t(
  key: SearchEnhanceLocaleKey,
  params: Record<string, unknown> = {},
): string {
  return Object.entries(params).reduce<string>(
    (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
    String(en[key]),
  )
}

const credentialState = (
  ref: string,
  configured = false,
  source?: string,
): WebCredentialState => ({
  ref,
  configured,
  writable: true,
  available: true,
  ...(source === undefined ? {} : { source }),
})

function snapshot(overrides: Partial<WebConfigSnapshot> = {}): WebConfigSnapshot {
  return {
    namespace: 'search-enhance',
    revision: 0,
    applies: 'restart',
    writable: true,
    value: {
      defaultProfile: 'auto',
      defaultDepth: 'compact',
      toolTimeoutMs: 180_000,
      toolDiscovery: { mode: 'progressive' },
      searchApi: {
        baseUrl: 'https://grok-gateway.example/v1',
        protocol: 'completions',
        model: 'grok-4.20-beta',
        thinkingLevel: 'off',
        credentialRef: 'TEST_GROK_SEARCH_KEY',
        timeoutMs: 120_000,
      },
      providers: {
        context7: { baseUrl: 'https://context7.com', credentialRef: 'CONTEXT7_API_KEY', timeoutMs: 120_000 },
        exa: { baseUrl: 'https://api.exa.ai', credentialRef: 'EXA_API_KEY', timeoutMs: 120_000 },
        tavily: { baseUrl: 'https://api.tavily.com', credentialRef: 'TAVILY_API_KEY', timeoutMs: 120_000 },
        firecrawl: { baseUrl: 'https://api.firecrawl.dev/v2', credentialRef: 'FIRECRAWL_API_KEY', timeoutMs: 120_000 },
      },
      webExtract: {
        smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
        direct: { proxyUrl: 'http://127.0.0.1:7891' },
      },
    },
    base: {
      searchApi: { baseUrl: 'https://api.x.ai/v1', model: 'base-model' },
    },
    user: {
      searchApi: {
        baseUrl: 'https://grok-gateway.example/v1',
        model: 'grok-4.20-beta',
        credentialRef: 'TEST_GROK_SEARCH_KEY',
      },
      webExtract: {
        smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
        direct: { proxyUrl: 'http://127.0.0.1:7891' },
      },
    },
    options: {
      profiles: ['auto', 'coding_docs', 'code_examples', 'project_research', 'academic', 'fact_check'],
      depths: ['compact', 'normal', 'deep'],
      protocols: ['completions', 'responses'],
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      toolDiscoveryModes: ['progressive', 'all'],
      proxyUrlMaxCharacters: 2048,
    },
    credentials: {
      searchApi: credentialState('TEST_GROK_SEARCH_KEY', true, 'file'),
      context7: credentialState('CONTEXT7_API_KEY'),
      exa: credentialState('EXA_API_KEY'),
      tavily: credentialState('TAVILY_API_KEY'),
      firecrawl: credentialState('FIRECRAWL_API_KEY'),
    },
    diagnostics: {
      capabilities: [{
        capability: 'main_search',
        available: true,
        required: true,
        providers: [{ provider: 'search_api', state: 'configured' }],
      }],
      minimumProfile: { profile: 'standard', satisfied: true },
      missingProviders: 4,
      unavailableProviders: 0,
    },
    ...overrides,
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestPath(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.pathname
  return new URL(input.url).pathname
}

function requestMethod(init?: RequestInit): string {
  return init?.method ?? 'GET'
}

async function openCard(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
  await screen.findByDisplayValue('https://grok-gateway.example/v1')
}

class TestLocale extends Service {
  readonly namespaces = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(namespace: string): () => void {
    this.namespaces.add(namespace)
    return () => { this.namespaces.delete(namespace) }
  }

  bind() {
    return t
  }
}

interface TestSlotEntry {
  options: Record<string, unknown>
  component: unknown
}

class TestSlots extends Service {
  readonly entries: TestSlotEntry[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, register: () => unknown): void {
    this.ctx.effect(register as () => () => void, 'test slot injection')
  }

  register(options: Record<string, unknown>, component: unknown): () => void {
    const entry = { options, component }
    this.entries.push(entry)
    return () => {
      const index = this.entries.indexOf(entry)
      if (index !== -1) this.entries.splice(index, 1)
    }
  }
}

const contexts = new Set<Context>()

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

describe('Search Enhance browser contribution', () => {
  it('registers exactly one stable settings.plugin.item card and cleans it across restart/dispose', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(TestSlots)
    await ctx.plugin(TestLocale)
    const plugin = await ctx.plugin({
      name: client.name,
      inject: client.inject,
      apply: client.apply,
    })
    const slots = ctx.get('slots') as unknown as TestSlots
    const locale = ctx.get('locale') as unknown as TestLocale

    expect(slots.entries).toHaveLength(1)
    expect(slots.entries[0]?.options).toMatchObject({
      name: 'settings.plugin.item',
      id: 'dsh-search-enhance',
      order: 25,
      locale: 'settings.search-enhance',
    })
    expect(locale.namespaces).toEqual(new Set(['settings.search-enhance']))

    await plugin.restart()
    expect(slots.entries).toHaveLength(1)
    expect(locale.namespaces).toEqual(new Set(['settings.search-enhance']))

    await plugin.dispose()
    expect(slots.entries).toHaveLength(0)
    expect(locale.namespaces).toHaveLength(0)
  })

  it('loads an existing third-party Grok configuration and saves only the edited path with restart feedback', async () => {
    const initial = snapshot()
    let patchBody: unknown
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(requestPath(input)).toBe('/dsh-search-enhance/config')
      if (requestMethod(init) === 'GET') return response(initial)
      patchBody = JSON.parse(String(init?.body)) as unknown
      const next = snapshot({
        revision: 1,
        value: {
          ...initial.value,
          searchApi: { ...initial.value.searchApi, model: 'grok-custom-next' },
        },
      })
      return response(next)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()

    expect((screen.getByLabelText(en.baseUrl) as HTMLInputElement).value).toBe('https://grok-gateway.example/v1')
    expect((screen.getByLabelText(en.model) as HTMLInputElement).value).toBe('grok-4.20-beta')
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en.independentNote)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'grok-custom-next' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.savedRestart)).toBeTruthy()
    expect(patchBody).toEqual({
      expectedRevision: 0,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: 'grok-custom-next' }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((screen.getByLabelText(en.baseUrl) as HTMLInputElement).value).toBe('https://grok-gateway.example/v1')

    fireEvent.click(screen.getByText(en.providersSummary))
    expect(screen.getByLabelText(`${en.context7} ${en.baseUrl}`)).toBeTruthy()
    expect(screen.getByLabelText(`${en.firecrawl} ${en.timeoutMs}`)).toBeTruthy()
  })

  it('edits both extraction proxies and translates a blank optional proxy into an unset mutation', async () => {
    const initial = snapshot()
    let patchBody: unknown
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (requestMethod(init) === 'GET') return response(initial)
      patchBody = JSON.parse(String(init?.body)) as unknown
      return response(snapshot({
        revision: 1,
        value: {
          ...initial.value,
          webExtract: {
            smartDirect: { proxyUrl: 'http://127.0.0.1:7892' },
            direct: { proxyUrl: '' },
          },
        },
        user: {
          ...initial.user,
          webExtract: {
            smartDirect: { proxyUrl: 'http://127.0.0.1:7892' },
            direct: {},
          },
        },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()
    fireEvent.click(screen.getByText(en.providersSummary))

    const smartDirect = screen.getByLabelText(en.smartDirectProxy) as HTMLInputElement
    const direct = screen.getByLabelText(en.directProxy) as HTMLInputElement
    expect(smartDirect.value).toBe('http://127.0.0.1:7890')
    expect(direct.value).toBe('http://127.0.0.1:7891')
    expect(smartDirect.maxLength).toBe(2048)

    fireEvent.change(smartDirect, { target: { value: 'http://127.0.0.1:7892' } })
    fireEvent.change(direct, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.savedRestart)).toBeTruthy()
    expect(patchBody).toEqual({
      expectedRevision: 0,
      mutations: [
        { op: 'set', path: ['webExtract', 'smartDirect', 'proxyUrl'], value: 'http://127.0.0.1:7892' },
        { op: 'unset', path: ['webExtract', 'direct', 'proxyUrl'] },
      ],
    })
  })

  it('keeps the draft and shows a revision conflict instead of retrying over newer settings', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (requestMethod(init) === 'GET') return response(snapshot())
      return response({
        error: {
          code: 'settings-conflict',
          message: 'The Settings document changed after this form was loaded.',
          actualRevision: 7,
        },
      }, 409)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'unsaved-conflicting-model' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.conflict)).toBeTruthy()
    expect((screen.getByLabelText(en.model) as HTMLInputElement).value).toBe('unsaved-conflicting-model')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows credential state, writes a non-empty secret without displaying it, and clears through DELETE', async () => {
    const secret = 'browser-only-secret-value'
    const calls: Array<{ method: string; body: unknown }> = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = requestMethod(init)
      if (method === 'GET') return response(snapshot())
      const body = JSON.parse(String(init?.body)) as { credential: WebCredentialSlot; value?: string }
      calls.push({ method, body })
      return response({
        credential: body.credential,
        changed: true,
        state: credentialState('TEST_GROK_SEARCH_KEY', method === 'PUT', method === 'PUT' ? 'file' : undefined),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()

    const keyInput = screen.getByLabelText(t('keyValue', { name: en.searchApiCredential })) as HTMLInputElement
    const row = keyInput.closest('div[style]')
    expect(row).not.toBeNull()
    const rowQueries = within(row as HTMLElement)
    expect(keyInput.value).toBe('')
    expect(rowQueries.getByText(en.configured)).toBeTruthy()
    expect((rowQueries.getByRole('button', { name: en.updateKey }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(keyInput, { target: { value: secret } })
    fireEvent.click(rowQueries.getByRole('button', { name: en.updateKey }))
    expect(await screen.findByText(t('keySaved', { name: en.searchApiCredential }))).toBeTruthy()
    expect(keyInput.value).toBe('')
    expect(document.body.textContent).not.toContain(secret)
    expect(calls[0]).toEqual({ method: 'PUT', body: { credential: 'searchApi', value: secret } })

    fireEvent.click(rowQueries.getByRole('button', { name: en.clearKey }))
    expect(await screen.findByText(t('keyCleared', { name: en.searchApiCredential }))).toBeTruthy()
    expect(calls[1]).toEqual({ method: 'DELETE', body: { credential: 'searchApi' } })
  })

  it('surfaces load errors, retries without Provider probes, and aborts a pending load on unmount', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: { code: 'internal-error', message: 'failed' } }, 500))
      .mockResolvedValueOnce(response(snapshot()))
    vi.stubGlobal('fetch', fetchMock)

    const rendered = render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    expect(await screen.findByText(en.loadFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByDisplayValue('https://grok-gateway.example/v1')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText(en.offlineOnly)).toBeTruthy()
    rendered.unmount()

    let pendingSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      pendingSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return new Promise<Response>(() => undefined)
    }))
    const pending = render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    await act(async () => undefined)
    pending.unmount()
    expect(pendingSignal?.aborted).toBe(true)
  })
})

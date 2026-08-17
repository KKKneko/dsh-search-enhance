import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import {
  WEB_BASE_URL_MAX_CHARACTERS,
  WEB_CREDENTIAL_REF_MAX_CHARACTERS,
  WEB_CREDENTIAL_SLOTS,
  WEB_CREDENTIAL_VALUE_MAX_CHARACTERS,
  WEB_EDITABLE_PATHS,
  WEB_MODEL_MAX_CHARACTERS,
  type WebConfigLayer,
  type WebConfigSnapshot,
  type WebCredentialSlot,
  type WebDiscoveryProviderConfig,
  type WebEditableConfig,
  type WebSettingsMutation,
} from '../web-config/contracts.js'
import {
  deleteWebCredential,
  loadWebConfig,
  saveWebConfig,
  WebConfigClientError,
  writeWebCredential,
} from './api.js'
import type { SearchEnhanceLocaleKey } from './locales.js'

export const SEARCH_ENHANCE_LOCALE_NAMESPACE = 'settings.search-enhance'

export interface SearchEnhancePluginCardProps {
  t: TranslateNS<typeof SEARCH_ENHANCE_LOCALE_NAMESPACE>
}

type Translate = SearchEnhancePluginCardProps['t']
type ProviderId = Exclude<WebCredentialSlot, 'searchApi'>
type Feedback = 'idle' | 'saved' | 'conflict' | 'error'

const PROVIDERS: readonly ProviderId[] = ['context7', 'exa', 'tavily', 'firecrawl']
const PROXY_ROUTES = [
  ['smartDirect', 'smartDirectProxy'],
  ['direct', 'directProxy'],
] as const
const CREDENTIAL_NAME_KEYS: Record<WebCredentialSlot, SearchEnhanceLocaleKey> = {
  searchApi: 'searchApiCredential',
  context7: 'context7',
  exa: 'exa',
  tavily: 'tavily',
  firecrawl: 'firecrawl',
}

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const bodyContainerStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }
const sectionDividerStyle: CSSProperties = { ...sectionStyle, marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--dsw-alias-border-l2)' }
const headingStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }
const fieldStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 6 }
const labelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const labelStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const layerStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }
const controlStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 36,
  padding: '7px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
}
const noteStyle: CSSProperties = { ...bodyStyle, padding: '9px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' }
const detailsStyle: CSSProperties = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 12px' }
const summaryStyle: CSSProperties = { cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const credentialListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const credentialStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 9, padding: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }
const credentialHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }
const stateStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const credentialActionsStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' }
const actionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)' }
const buttonsStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const successStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-success-primary, #16825d)' }

function cloneConfig(config: WebEditableConfig): WebEditableConfig {
  return {
    defaultProfile: config.defaultProfile,
    defaultDepth: config.defaultDepth,
    toolTimeoutMs: config.toolTimeoutMs,
    toolDiscovery: { ...config.toolDiscovery },
    searchApi: { ...config.searchApi },
    providers: {
      context7: { ...config.providers.context7 },
      exa: { ...config.providers.exa },
      tavily: { ...config.providers.tavily },
      firecrawl: { ...config.providers.firecrawl },
    },
    webExtract: {
      smartDirect: { ...config.webExtract.smartDirect },
      direct: { ...config.webExtract.direct },
    },
  }
}

function scalarAt(value: unknown, path: readonly string[]): string | number | undefined {
  let current = value
  for (const part of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' || typeof current === 'number' ? current : undefined
}

function mutationsFor(current: WebEditableConfig, draft: WebEditableConfig): WebSettingsMutation[] {
  return WEB_EDITABLE_PATHS.flatMap<WebSettingsMutation>(path => {
    const before = scalarAt(current, path)
    const after = scalarAt(draft, path)
    if (Object.is(before, after) || after === undefined) return []
    return path.at(-1) === 'proxyUrl' && after === ''
      ? [{ op: 'unset' as const, path: [...path] }]
      : [{ op: 'set' as const, path: [...path], value: after }]
  })
}

function isOverridden(layer: WebConfigLayer | undefined, path: readonly string[]): boolean {
  return scalarAt(layer, path) !== undefined
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function validTimeouts(config: WebEditableConfig): boolean {
  return [
    config.toolTimeoutMs,
    config.searchApi.timeoutMs,
    ...PROVIDERS.map(provider => config.providers[provider].timeoutMs),
  ].every(positiveInteger)
}

function credentialRef(config: WebEditableConfig, slot: WebCredentialSlot): string {
  return slot === 'searchApi' ? config.searchApi.credentialRef : config.providers[slot].credentialRef
}

function Field({
  label,
  overridden,
  t,
  hint,
  children,
}: {
  label: string
  overridden: boolean
  t: Translate
  hint?: string
  children: ReactNode
}) {
  return (
    <label style={fieldStyle}>
      <span style={labelRowStyle}>
        <span style={labelStyle}>{label}</span>
        <span style={layerStyle}>{t(overridden ? 'overridden' : 'inherited')}</span>
      </span>
      {children}
      {hint === undefined ? null : <span style={bodyStyle}>{hint}</span>}
    </label>
  )
}

function Select({ value, options, onChange, disabled }: {
  value: string
  options: readonly string[]
  onChange(value: string): void
  disabled: boolean
}) {
  return (
    <select
      style={controlStyle}
      value={value}
      disabled={disabled}
      onChange={event => { onChange(event.currentTarget.value) }}
    >
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  )
}

function NumberInput({ value, onChange, disabled, label }: {
  value: number
  onChange(value: number): void
  disabled: boolean
  label: string
}) {
  return (
    <input
      aria-label={label}
      style={controlStyle}
      type="number"
      min={1}
      step={1}
      value={Number.isFinite(value) ? value : ''}
      disabled={disabled}
      onChange={event => { onChange(event.currentTarget.valueAsNumber) }}
    />
  )
}

function ProviderEditor({
  provider,
  value,
  disabled,
  user,
  t,
  onChange,
}: {
  provider: ProviderId
  value: WebDiscoveryProviderConfig
  disabled: boolean
  user: WebConfigLayer | undefined
  t: Translate
  onChange(value: WebDiscoveryProviderConfig): void
}) {
  const prefix = ['providers', provider] as const
  return (
    <section style={sectionDividerStyle} aria-labelledby={`${provider}-provider-title`}>
      <h4 id={`${provider}-provider-title`} style={headingStyle}>{t(CREDENTIAL_NAME_KEYS[provider])}</h4>
      <div style={gridStyle}>
        <Field label={t('baseUrl')} overridden={isOverridden(user, [...prefix, 'baseUrl'])} t={t}>
          <input
            aria-label={`${t(CREDENTIAL_NAME_KEYS[provider])} ${t('baseUrl')}`}
            style={controlStyle}
            value={value.baseUrl}
            maxLength={WEB_BASE_URL_MAX_CHARACTERS}
            disabled={disabled}
            onChange={event => { onChange({ ...value, baseUrl: event.currentTarget.value }) }}
          />
        </Field>
        <Field label={t('timeoutMs')} overridden={isOverridden(user, [...prefix, 'timeoutMs'])} t={t}>
          <NumberInput
            label={`${t(CREDENTIAL_NAME_KEYS[provider])} ${t('timeoutMs')}`}
            value={value.timeoutMs}
            disabled={disabled}
            onChange={timeoutMs => { onChange({ ...value, timeoutMs }) }}
          />
        </Field>
        <Field label={t('credentialRef')} overridden={isOverridden(user, [...prefix, 'credentialRef'])} t={t}>
          <input
            aria-label={`${t(CREDENTIAL_NAME_KEYS[provider])} ${t('credentialRef')}`}
            style={controlStyle}
            value={value.credentialRef}
            maxLength={WEB_CREDENTIAL_REF_MAX_CHARACTERS}
            disabled={disabled}
            onChange={event => { onChange({ ...value, credentialRef: event.currentTarget.value }) }}
          />
        </Field>
      </div>
    </section>
  )
}

export function SearchEnhancePluginCard({ t }: SearchEnhancePluginCardProps) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [snapshot, setSnapshot] = useState<WebConfigSnapshot | undefined>()
  const [draft, setDraft] = useState<WebEditableConfig | undefined>()
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>('idle')
  const [credentialDrafts, setCredentialDrafts] = useState<Partial<Record<WebCredentialSlot, string>>>({})
  const [credentialBusy, setCredentialBusy] = useState<WebCredentialSlot | undefined>()
  const [credentialFeedback, setCredentialFeedback] = useState<string | undefined>()
  const controllers = useRef(new Set<AbortController>())

  const run = useCallback(async <Result,>(operation: (signal: AbortSignal) => Promise<Result>): Promise<Result> => {
    const controller = new AbortController()
    controllers.current.add(controller)
    try {
      return await operation(controller.signal)
    } finally {
      controllers.current.delete(controller)
    }
  }, [])

  useEffect(() => () => {
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    setFeedback('idle')
    try {
      const next = await run(signal => loadWebConfig(signal))
      setSnapshot(next)
      setDraft(cloneConfig(next.value))
      setPhase('ready')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setPhase('error')
    }
  }, [run])

  useEffect(() => {
    if (open && phase === 'idle') void load()
  }, [load, open, phase])

  const mutations = useMemo(
    () => snapshot === undefined || draft === undefined ? [] : mutationsFor(snapshot.value, draft),
    [draft, snapshot],
  )
  const dirty = mutations.length > 0
  const valid = draft !== undefined && validTimeouts(draft)
  const editable = phase === 'ready' && snapshot?.writable === true && !saving

  const updateProvider = (provider: ProviderId, value: WebDiscoveryProviderConfig): void => {
    setDraft(current => current === undefined ? current : {
      ...current,
      providers: { ...current.providers, [provider]: value },
    })
    setFeedback('idle')
  }

  const updateProxy = (route: keyof WebEditableConfig['webExtract'], proxyUrl: string): void => {
    setDraft(current => current === undefined ? current : {
      ...current,
      webExtract: {
        ...current.webExtract,
        [route]: { proxyUrl },
      },
    })
    setFeedback('idle')
  }

  const save = async (): Promise<void> => {
    if (snapshot === undefined || draft === undefined || !dirty || !valid || !snapshot.writable) return
    setSaving(true)
    setFeedback('idle')
    try {
      const next = await run(signal => saveWebConfig({
        expectedRevision: snapshot.revision,
        mutations,
      }, signal))
      setSnapshot(next)
      setDraft(cloneConfig(next.value))
      setFeedback('saved')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setFeedback(error instanceof WebConfigClientError && error.code === 'settings-conflict' ? 'conflict' : 'error')
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    if (snapshot === undefined) return
    setDraft(cloneConfig(snapshot.value))
    setFeedback('idle')
  }

  const applyCredentialState = (
    slot: WebCredentialSlot,
    state: WebConfigSnapshot['credentials'][WebCredentialSlot],
  ): void => {
    setSnapshot(current => current === undefined ? current : {
      ...current,
      credentials: { ...current.credentials, [slot]: state },
    })
  }

  const updateCredential = async (slot: WebCredentialSlot): Promise<void> => {
    const value = credentialDrafts[slot] ?? ''
    if (value === '' || credentialBusy !== undefined) return
    setCredentialBusy(slot)
    setCredentialFeedback(undefined)
    try {
      const result = await run(signal => writeWebCredential(slot, value, signal))
      applyCredentialState(slot, result.state)
      setCredentialDrafts(current => ({ ...current, [slot]: '' }))
      setCredentialFeedback(t('keySaved', { name: t(CREDENTIAL_NAME_KEYS[slot]) }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setCredentialFeedback(t('keyFailed'))
    } finally {
      setCredentialBusy(undefined)
    }
  }

  const clearCredential = async (slot: WebCredentialSlot): Promise<void> => {
    if (credentialBusy !== undefined) return
    setCredentialBusy(slot)
    setCredentialFeedback(undefined)
    try {
      const result = await run(signal => deleteWebCredential(slot, signal))
      applyCredentialState(slot, result.state)
      setCredentialDrafts(current => ({ ...current, [slot]: '' }))
      setCredentialFeedback(t('keyCleared', { name: t(CREDENTIAL_NAME_KEYS[slot]) }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setCredentialFeedback(t('keyFailed'))
    } finally {
      setCredentialBusy(undefined)
    }
  }

  const title = t('title')
  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(current => !current) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{title}</span>
          <span style={descriptionStyle}>{t('intro')}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {!open ? null : (
        <div style={bodyContainerStyle}>
          {phase === 'loading' ? <p style={bodyStyle} role="status">{t('loading')}</p> : null}
          {phase === 'error' ? (
            <div style={sectionStyle} role="alert">
              <p style={errorStyle}>{t('loadFailed')}</p>
              <span><Button type="button" size="sm" variant="outline" onClick={() => { void load() }}>{t('retry')}</Button></span>
            </div>
          ) : null}
          {phase !== 'ready' || snapshot === undefined || draft === undefined ? null : (
            <>
              <section style={sectionStyle} aria-labelledby="search-enhance-grok-heading">
                <div>
                  <h3 id="search-enhance-grok-heading" style={headingStyle}>{t('grokHeading')}</h3>
                  <p style={{ ...bodyStyle, marginTop: 4 }}>{t('grokIntro')}</p>
                </div>
                <p style={noteStyle}>{t('independentNote')}</p>
                <div style={gridStyle}>
                  <Field label={t('baseUrl')} overridden={isOverridden(snapshot.user, ['searchApi', 'baseUrl'])} t={t} hint={t('thirdPartyHint')}>
                    <input
                      aria-label={t('baseUrl')}
                      style={controlStyle}
                      value={draft.searchApi.baseUrl}
                      maxLength={WEB_BASE_URL_MAX_CHARACTERS}
                      disabled={!editable}
                      onChange={event => {
                        const baseUrl = event.currentTarget.value
                        setDraft(current => current === undefined ? current : {
                          ...current,
                          searchApi: { ...current.searchApi, baseUrl },
                        })
                        setFeedback('idle')
                      }}
                    />
                  </Field>
                  <Field label={t('protocol')} overridden={isOverridden(snapshot.user, ['searchApi', 'protocol'])} t={t}>
                    <Select
                      value={draft.searchApi.protocol}
                      options={snapshot.options.protocols}
                      disabled={!editable}
                      onChange={protocol => {
                        setDraft(current => current === undefined ? current : {
                          ...current,
                          searchApi: { ...current.searchApi, protocol },
                        })
                        setFeedback('idle')
                      }}
                    />
                  </Field>
                  <Field label={t('model')} overridden={isOverridden(snapshot.user, ['searchApi', 'model'])} t={t}>
                    <input
                      aria-label={t('model')}
                      style={controlStyle}
                      value={draft.searchApi.model}
                      maxLength={WEB_MODEL_MAX_CHARACTERS}
                      disabled={!editable}
                      onChange={event => {
                        const model = event.currentTarget.value
                        setDraft(current => current === undefined ? current : {
                          ...current,
                          searchApi: { ...current.searchApi, model },
                        })
                        setFeedback('idle')
                      }}
                    />
                  </Field>
                  <Field label={t('thinkingLevel')} overridden={isOverridden(snapshot.user, ['searchApi', 'thinkingLevel'])} t={t}>
                    <Select
                      value={draft.searchApi.thinkingLevel}
                      options={snapshot.options.thinkingLevels}
                      disabled={!editable}
                      onChange={thinkingLevel => {
                        setDraft(current => current === undefined ? current : {
                          ...current,
                          searchApi: { ...current.searchApi, thinkingLevel },
                        })
                        setFeedback('idle')
                      }}
                    />
                  </Field>
                  <Field label={t('timeoutMs')} overridden={isOverridden(snapshot.user, ['searchApi', 'timeoutMs'])} t={t}>
                    <NumberInput
                      label={`Grok ${t('timeoutMs')}`}
                      value={draft.searchApi.timeoutMs}
                      disabled={!editable}
                      onChange={timeoutMs => {
                        setDraft(current => current === undefined ? current : {
                          ...current,
                          searchApi: { ...current.searchApi, timeoutMs },
                        })
                        setFeedback('idle')
                      }}
                    />
                  </Field>
                  <Field label={t('credentialRef')} overridden={isOverridden(snapshot.user, ['searchApi', 'credentialRef'])} t={t}>
                    <input
                      aria-label={`Grok ${t('credentialRef')}`}
                      style={controlStyle}
                      value={draft.searchApi.credentialRef}
                      maxLength={WEB_CREDENTIAL_REF_MAX_CHARACTERS}
                      disabled={!editable}
                      onChange={event => {
                        const credentialRef = event.currentTarget.value
                        setDraft(current => current === undefined ? current : {
                          ...current,
                          searchApi: { ...current.searchApi, credentialRef },
                        })
                        setFeedback('idle')
                      }}
                    />
                  </Field>
                </div>
              </section>

              <section style={sectionDividerStyle} aria-labelledby="search-enhance-strategy-heading">
                <div>
                  <h3 id="search-enhance-strategy-heading" style={headingStyle}>{t('strategyHeading')}</h3>
                  <p style={{ ...bodyStyle, marginTop: 4 }}>{t('strategyIntro')}</p>
                </div>
                <div style={gridStyle}>
                  <Field label={t('defaultProfile')} overridden={isOverridden(snapshot.user, ['defaultProfile'])} t={t}>
                    <Select
                      value={draft.defaultProfile}
                      options={snapshot.options.profiles}
                      disabled={!editable}
                      onChange={defaultProfile => { setDraft(current => current === undefined ? current : { ...current, defaultProfile }); setFeedback('idle') }}
                    />
                  </Field>
                  <Field label={t('defaultDepth')} overridden={isOverridden(snapshot.user, ['defaultDepth'])} t={t}>
                    <Select
                      value={draft.defaultDepth}
                      options={snapshot.options.depths}
                      disabled={!editable}
                      onChange={defaultDepth => { setDraft(current => current === undefined ? current : { ...current, defaultDepth }); setFeedback('idle') }}
                    />
                  </Field>
                  <Field label={t('toolDiscoveryMode')} overridden={isOverridden(snapshot.user, ['toolDiscovery', 'mode'])} t={t}>
                    <Select
                      value={draft.toolDiscovery.mode}
                      options={snapshot.options.toolDiscoveryModes}
                      disabled={!editable}
                      onChange={mode => { setDraft(current => current === undefined ? current : { ...current, toolDiscovery: { mode } }); setFeedback('idle') }}
                    />
                  </Field>
                  <Field label={t('toolTimeoutMs')} overridden={isOverridden(snapshot.user, ['toolTimeoutMs'])} t={t}>
                    <NumberInput
                      label={t('toolTimeoutMs')}
                      value={draft.toolTimeoutMs}
                      disabled={!editable}
                      onChange={toolTimeoutMs => { setDraft(current => current === undefined ? current : { ...current, toolTimeoutMs }); setFeedback('idle') }}
                    />
                  </Field>
                </div>
              </section>

              <section style={sectionDividerStyle} aria-labelledby="search-enhance-providers-heading">
                <div>
                  <h3 id="search-enhance-providers-heading" style={headingStyle}>{t('providersHeading')}</h3>
                  <p style={{ ...bodyStyle, marginTop: 4 }}>{t('providersIntro')}</p>
                </div>
                <details style={detailsStyle}>
                  <summary style={summaryStyle}>{t('providersSummary')}</summary>
                  {PROVIDERS.map(provider => (
                    <ProviderEditor
                      key={provider}
                      provider={provider}
                      value={draft.providers[provider]}
                      disabled={!editable}
                      user={snapshot.user}
                      t={t}
                      onChange={value => { updateProvider(provider, value) }}
                    />
                  ))}
                  <section style={sectionDividerStyle} aria-labelledby="search-enhance-proxy-heading">
                    <h4 id="search-enhance-proxy-heading" style={headingStyle}>{t('proxyHeading')}</h4>
                    <p style={bodyStyle}>{t('proxyIntro')}</p>
                    <div style={gridStyle}>
                      {PROXY_ROUTES.map(([route, label]) => (
                        <Field
                          key={route}
                          label={t(label)}
                          overridden={isOverridden(snapshot.user, ['webExtract', route, 'proxyUrl'])}
                          t={t}
                        >
                          <input
                            aria-label={t(label)}
                            style={controlStyle}
                            value={draft.webExtract[route].proxyUrl}
                            maxLength={snapshot.options.proxyUrlMaxCharacters}
                            placeholder="http://127.0.0.1:7890"
                            disabled={!editable}
                            onChange={event => { updateProxy(route, event.currentTarget.value) }}
                          />
                        </Field>
                      ))}
                    </div>
                    <p style={noteStyle}>{t('proxyHint')}</p>
                  </section>
                </details>
              </section>

              <section style={sectionDividerStyle} aria-labelledby="search-enhance-credentials-heading">
                <div>
                  <h3 id="search-enhance-credentials-heading" style={headingStyle}>{t('credentialsHeading')}</h3>
                  <p style={{ ...bodyStyle, marginTop: 4 }}>{t('credentialsIntro')}</p>
                </div>
                <div style={credentialListStyle}>
                  {WEB_CREDENTIAL_SLOTS.map(slot => {
                    const name = t(CREDENTIAL_NAME_KEYS[slot])
                    const state = snapshot.credentials[slot]
                    const keyDraft = credentialDrafts[slot] ?? ''
                    const refChanged = credentialRef(draft, slot) !== state.ref
                    const busy = credentialBusy === slot
                    const disabled = busy || credentialBusy !== undefined || refChanged || !state.available || !state.writable
                    return (
                      <div key={slot} style={credentialStyle}>
                        <div style={credentialHeaderStyle}>
                          <div>
                            <strong style={labelStyle}>{name}</strong>
                            <div style={bodyStyle}>{t('referenceLabel', { ref: state.ref })}</div>
                          </div>
                          <span style={stateStyle}>
                            <StateDot state={!state.available ? 'error' : state.configured ? 'done' : 'warning'} />
                            {!state.available ? t('unavailable') : state.configured ? t('configured') : t('missing')}
                          </span>
                        </div>
                        {state.source === undefined ? null : <p style={bodyStyle}>{t('sourceLabel', { source: state.source })}</p>}
                        {refChanged ? <p style={errorStyle}>{t('saveConfigFirst')}</p> : null}
                        {!state.writable && state.available ? <p style={bodyStyle}>{t('credentialReadOnly')}</p> : null}
                        <label style={fieldStyle}>
                          <span style={labelStyle}>{t('keyValue', { name })}</span>
                          <input
                            style={controlStyle}
                            type="password"
                            autoComplete="off"
                            value={keyDraft}
                            maxLength={WEB_CREDENTIAL_VALUE_MAX_CHARACTERS}
                            placeholder={t('keyPlaceholder')}
                            disabled={disabled}
                            onChange={event => {
                              const value = event.currentTarget.value
                              setCredentialDrafts(current => ({ ...current, [slot]: value }))
                              setCredentialFeedback(undefined)
                            }}
                          />
                        </label>
                        <div style={credentialActionsStyle}>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled || keyDraft === ''}
                            onClick={() => { void updateCredential(slot) }}
                          >
                            {t('updateKey')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={disabled || !state.configured}
                            onClick={() => { void clearCredential(slot) }}
                          >
                            {t('clearKey')}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {credentialFeedback === undefined ? null : <p style={bodyStyle} role="status">{credentialFeedback}</p>}
              </section>

              <section style={sectionDividerStyle} aria-labelledby="search-enhance-diagnostics-heading">
                <div>
                  <h3 id="search-enhance-diagnostics-heading" style={headingStyle}>{t('diagnosticsHeading')}</h3>
                  <p style={{ ...bodyStyle, marginTop: 4 }}>{t('diagnosticsIntro')}</p>
                </div>
                <p style={noteStyle}>{t('offlineOnly')}</p>
                <div style={stateStyle}>
                  <StateDot state={snapshot.diagnostics.minimumProfile.satisfied ? 'done' : 'warning'} />
                  {t(snapshot.diagnostics.minimumProfile.satisfied ? 'minimumReady' : 'minimumMissing')}
                </div>
                <p style={bodyStyle}>{t('missingCount', { count: snapshot.diagnostics.missingProviders })}</p>
                <p style={bodyStyle}>{t('unavailableCount', { count: snapshot.diagnostics.unavailableProviders })}</p>
                <span>
                  <Button type="button" size="sm" variant="outline" onClick={() => { void load() }}>{t('refreshStatus')}</Button>
                </span>
              </section>

              {!valid ? <p style={errorStyle} role="alert">{t('invalidNumber')}</p> : null}
              {!snapshot.writable ? <p style={errorStyle} role="alert">{t('readOnly')}</p> : null}
              <div style={actionsStyle}>
                <span aria-live="polite">
                  {feedback === 'saved' ? <span style={successStyle}>{t('savedRestart')}</span> : null}
                  {feedback === 'conflict' ? <span style={errorStyle}>{t('conflict')}</span> : null}
                  {feedback === 'error' ? <span style={errorStyle}>{t('saveFailed')}</span> : null}
                </span>
                <span style={buttonsStyle}>
                  <Button type="button" size="sm" variant="ghost" disabled={!dirty || saving} onClick={discard}>{t('discard')}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => { void load() }}>{t('reload')}</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={!dirty || !valid || !snapshot.writable || saving}
                    onClick={() => { void save() }}
                  >
                    {saving ? t('saving') : t('save')}
                  </Button>
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  )
}

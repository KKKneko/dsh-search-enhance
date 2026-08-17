import type { CanonicalSource, SourceCategory } from '../../contracts/index.js'
import { needsTimeContext } from '../time-context.js'
import {
  boundedComparisonText,
  resolveSourceQualityLimits,
  type BoundedComparisonText,
  type SourceQualityLimits,
} from './limits.js'
import { normalizeSourceUrl, retainOpaqueHttpUrl } from './url.js'

const TECHNICAL_VERSION_CONTEXT = /(?:\b(?:api|changelog|docs?|framework|library|migration|package|release|sdk|version)\b|版本|发行版)/iu
const PREFIXED_VERSION_PATTERN = /(?:^|[^\p{L}\p{N}])v(\d+(?:\.\d+){0,3}(?:-(?:alpha|beta|preview|rc)\.?\d+)?)(?=$|[^\p{L}\p{N}])/giu
const DOTTED_VERSION_PATTERN = /(?:^|[^\p{L}\p{N}])(\d+\.\d+(?:\.\d+){0,2}(?:-(?:alpha|beta|preview|rc)\.?\d+)?)(?=$|[^\p{L}\p{N}])/giu
const RELEASE_CANDIDATE_PATTERN = /(?:^|[^\p{L}\p{N}])((?:alpha|beta|preview|rc)[.-]?\d+)(?=$|[^\p{L}\p{N}])/giu
const REPRINT_TEXT_PATTERN = /(?:\b(?:aggregated from|republished from|reprinted from|syndicated from|translated from|translation of)\b|转载(?:自)?|转自|编译自|译自|聚合(?:自)?)/iu
const REPRINT_PATH_PATTERN = /\/(?:aggregate|aggregator|reprints?|syndicated)(?:\/|$)/iu
const SUPPORT_STANCE_PATTERN = /(?:\b(?:agrees?|backs?|confirms?|supports?)\b|同意|支持|证实|确认)/iu
const OPPOSE_STANCE_PATTERN = /(?:\b(?:denies?|disputes?|opposes?|rejects?|refutes?)\b|否认|反对|质疑|驳斥)/iu
const GITHUB_CODE_PATH_PATTERN = /^\/[^/]+\/[^/]+\/(?:commit|commits|releases?|tree)(?:\/|$)|^\/[^/]+\/[^/]+\/blob\/[^/]+\/(?:changelog|changes|history|readme)(?:[./]|$)/iu
const GITHUB_CODE_TEXT_PATTERN = /\b(?:changelog|readme|release|source)\b/iu
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u

interface PreparedSource {
  readonly source: Readonly<CanonicalSource>
  readonly index: number
  readonly title: BoundedComparisonText
  readonly snippet: BoundedComparisonText
  readonly publishedAt: BoundedComparisonText
  readonly normalizedUrl: URL | undefined
  readonly versions: ReadonlySet<string>
  readonly identityKey: string
  readonly comparable: boolean
  readonly comparisonCharacters: number
}

interface RankedSource extends PreparedSource {
  readonly score: number
  readonly publishedEpoch: number | undefined
}

type VersionRelation = 'match' | 'conflict' | 'neutral'
type StanceSignal = 'both' | 'neutral' | 'oppose' | 'support'

function normalizedVersion(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(alpha|beta|preview|rc)[.-]?(\d+)$/u, '$1.$2')
    .replace(/-(alpha|beta|preview|rc)(\d+)$/u, '-$1.$2')
}

function addVersionMatches(target: Set<string>, text: string, pattern: RegExp): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[1]
    if (value !== undefined) target.add(normalizedVersion(value))
  }
}

function extractVersions(text: string, allowBareDotted: boolean): ReadonlySet<string> {
  const versions = new Set<string>()
  addVersionMatches(versions, text, PREFIXED_VERSION_PATTERN)
  addVersionMatches(versions, text, RELEASE_CANDIDATE_PATTERN)
  if (allowBareDotted) addVersionMatches(versions, text, DOTTED_VERSION_PATTERN)
  return versions
}

function mergeVersions(...groups: ReadonlyArray<ReadonlySet<string>>): ReadonlySet<string> {
  const merged = new Set<string>()
  for (const group of groups) {
    for (const version of group) merged.add(version)
  }
  return merged
}

function queryVersions(query: string): ReadonlySet<string> {
  return extractVersions(query, TECHNICAL_VERSION_CONTEXT.test(query))
}

function sourceVersions(
  url: URL,
  title: string,
  snippet: string,
): ReadonlySet<string> {
  const sourceText = `${title}\n${snippet}`
  return mergeVersions(
    extractVersions(`${url.pathname}\n${url.search}`, true),
    extractVersions(sourceText, TECHNICAL_VERSION_CONTEXT.test(sourceText)),
  )
}

function versionsMatch(queryVersion: string, sourceVersion: string): boolean {
  return queryVersion === sourceVersion
    || (/^\d+$/u.test(queryVersion) && sourceVersion.startsWith(`${queryVersion}.`))
    || (/^\d+(?:\.\d+)+$/u.test(queryVersion) && sourceVersion.startsWith(`${queryVersion}.`))
}

function versionRelation(
  wanted: ReadonlySet<string>,
  available: ReadonlySet<string>,
): VersionRelation {
  if (wanted.size === 0 || available.size === 0) return 'neutral'
  for (const wantedVersion of wanted) {
    for (const availableVersion of available) {
      if (versionsMatch(wantedVersion, availableVersion)) return 'match'
    }
  }
  return 'conflict'
}

function titleFingerprint(value: string): string | undefined {
  const fingerprint = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  return fingerprint.length >= 16 ? fingerprint : undefined
}

function stanceSignal(title: string, snippet: string): StanceSignal {
  const text = `${title}\n${snippet}`
  const supports = SUPPORT_STANCE_PATTERN.test(text)
  const opposes = OPPOSE_STANCE_PATTERN.test(text)
  if (supports && opposes) return 'both'
  if (supports) return 'support'
  if (opposes) return 'oppose'
  return 'neutral'
}

function parsedPublishedEpoch(value: string): number | undefined {
  const dateMatch = ISO_DATE_PATTERN.exec(value)
  if (dateMatch !== null) {
    const year = Number(dateMatch[1])
    const month = Number(dateMatch[2])
    const day = Number(dateMatch[3])
    const epoch = Date.UTC(year, month - 1, day)
    const roundTrip = new Date(epoch)
    if (
      roundTrip.getUTCFullYear() === year
      && roundTrip.getUTCMonth() === month - 1
      && roundTrip.getUTCDate() === day
    ) return epoch
    return undefined
  }
  if (!ISO_INSTANT_PATTERN.test(value)) return undefined
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : undefined
}

function dateIdentity(value: BoundedComparisonText): string {
  if (value.exceeded) return 'over-limit'
  if (value.text.length === 0) return 'missing'
  const epoch = parsedPublishedEpoch(value.text)
  return epoch === undefined ? `raw:${value.text}` : `epoch:${epoch}`
}

function sourceIdentityKey(
  title: BoundedComparisonText,
  snippet: BoundedComparisonText,
  publishedAt: BoundedComparisonText,
  versions: ReadonlySet<string>,
  index: number,
): string {
  if (title.exceeded || snippet.exceeded || publishedAt.exceeded) return `opaque:${index}`
  const versionIdentity = [...versions].sort().join(',') || 'none'
  const titleIdentity = titleFingerprint(title.text) ?? `literal:${title.text}`
  return [
    versionIdentity,
    dateIdentity(publishedAt),
    stanceSignal(title.text, snippet.text),
    titleIdentity,
  ].join('\u0000')
}

function inferredBaseScore(source: PreparedSource): number {
  const categoryScores: Readonly<Record<SourceCategory, number>> = {
    academic: 300,
    aggregate: 80,
    code: 400,
    community: 190,
    documentation: 590,
    news: 210,
    official: 600,
    primary: 500,
    unknown: 100,
  }
  const category = source.source.category ?? 'unknown'
  if (category !== 'unknown') return categoryScores[category]

  const url = source.normalizedUrl
  if (url === undefined) return categoryScores.unknown
  const text = `${source.title.text}\n${source.snippet.text}`
  if (
    url.hostname === 'github.com'
    && (GITHUB_CODE_PATH_PATTERN.test(url.pathname) || GITHUB_CODE_TEXT_PATTERN.test(text))
  ) return categoryScores.code
  if (
    url.hostname === 'doi.org'
    || url.hostname === 'arxiv.org'
    || url.hostname === 'pubmed.ncbi.nlm.nih.gov'
  ) return categoryScores.academic
  return categoryScores.unknown
}

function isReprint(source: PreparedSource): boolean {
  if (source.source.category === 'aggregate') return true
  const text = `${source.title.text}\n${source.snippet.text}`
  return REPRINT_TEXT_PATTERN.test(text)
    || (source.normalizedUrl !== undefined && REPRINT_PATH_PATTERN.test(source.normalizedUrl.pathname))
}

function qualityScore(
  source: PreparedSource,
  wantedVersions: ReadonlySet<string>,
  temporal: boolean,
  originalPresent: boolean,
  repeatedTitle: boolean,
): RankedSource {
  const relation = versionRelation(wantedVersions, source.versions)
  const reprint = isReprint(source)
  const publishedEpoch = source.publishedAt.exceeded
    ? undefined
    : parsedPublishedEpoch(source.publishedAt.text)
  let score = inferredBaseScore(source)
  if (relation === 'match') score += 220
  else if (relation === 'conflict') score -= 240
  if (reprint) score -= originalPresent ? 140 : 80
  if (repeatedTitle) score -= 20
  if (temporal && publishedEpoch !== undefined) score += 10
  return Object.freeze({ ...source, publishedEpoch, score })
}

function prepareSource(
  source: CanonicalSource,
  index: number,
  limits: Readonly<SourceQualityLimits>,
): PreparedSource | undefined {
  const rawUrl = boundedComparisonText(source.url.trim(), limits.maxUrlCharacters)
  if (rawUrl.exceeded) {
    const retained = retainOpaqueHttpUrl(source.url, rawUrl.text)
    if (retained === undefined) return undefined
    const empty = Object.freeze({ characters: 0, exceeded: false, text: '' })
    return Object.freeze({
      comparable: false,
      comparisonCharacters: limits.maxUrlCharacters,
      identityKey: `opaque-url:${index}`,
      index,
      normalizedUrl: undefined,
      publishedAt: empty,
      snippet: empty,
      source: Object.freeze({ ...source, url: retained }),
      title: empty,
      versions: new Set<string>(),
    })
  }

  const url = normalizeSourceUrl(rawUrl.text, limits.maxUrlCharacters)
  if (url === undefined) return undefined
  const normalizedUrl = new URL(url)
  const title = boundedComparisonText(source.title ?? '', limits.maxTitleCharacters)
  const snippet = boundedComparisonText(source.snippet ?? '', limits.maxSnippetCharacters)
  const publishedAt = boundedComparisonText(
    source.publishedAt ?? '',
    limits.maxPublishedAtCharacters,
  )
  const comparable = !title.exceeded && !snippet.exceeded && !publishedAt.exceeded
  const versions = comparable
    ? sourceVersions(normalizedUrl, title.text, snippet.text)
    : new Set<string>()
  return Object.freeze({
    comparable,
    comparisonCharacters: rawUrl.characters
      + title.characters
      + snippet.characters
      + publishedAt.characters,
    identityKey: sourceIdentityKey(title, snippet, publishedAt, versions, index),
    index,
    normalizedUrl,
    publishedAt,
    snippet,
    source: Object.freeze({ ...source, url }),
    title,
    versions,
  })
}

function deduplicateNormalizedSources(
  prepared: readonly PreparedSource[],
): readonly PreparedSource[] {
  const identitiesByUrl = new Map<string, Set<string>>()
  const retained: PreparedSource[] = []
  for (const source of prepared) {
    if (source.normalizedUrl === undefined || !source.comparable) {
      retained.push(source)
      continue
    }
    const url = source.source.url
    const identities = identitiesByUrl.get(url)
    if (identities?.has(source.identityKey) === true) continue
    if (identities === undefined) identitiesByUrl.set(url, new Set([source.identityKey]))
    else identities.add(source.identityKey)
    retained.push(source)
  }
  return Object.freeze(retained)
}

function repeatedTitleIndexes(sources: readonly PreparedSource[]): ReadonlySet<number> {
  const firstByTitle = new Map<string, number>()
  const repeated = new Set<number>()
  for (const source of sources) {
    const fingerprint = titleFingerprint(source.title.text)
    if (fingerprint === undefined) continue
    if (firstByTitle.has(fingerprint)) repeated.add(source.index)
    else firstByTitle.set(fingerprint, source.index)
  }
  return repeated
}

/**
 * Pure stage-1 source-quality pipeline. Call it only after the compatibility
 * merge has preserved Provider order and removed exact URL duplicates.
 *
 * The pipeline normalizes bounded HTTP(S) URLs, merges only same-identity URL
 * variants, and reranks with conservative category/path/text signals. It never
 * reads a clock, changes source prose, or removes a distinct normalized URL.
 */
export function applySourceQuality(
  query: string,
  sources: readonly CanonicalSource[],
  limitOverrides: Partial<SourceQualityLimits> = {},
): readonly CanonicalSource[] {
  const limits = resolveSourceQualityLimits(limitOverrides)
  const boundedQuery = boundedComparisonText(query, limits.maxQueryCharacters)
  let comparisonsWithinBudget = !boundedQuery.exceeded
    && sources.length <= limits.maxComparableSources
  let comparisonCharacters = boundedQuery.characters
  const prepared: PreparedSource[] = []

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]
    if (source === undefined) continue
    const candidate = prepareSource(source, index, limits)
    if (candidate === undefined) continue
    prepared.push(candidate)
    comparisonsWithinBudget &&= candidate.comparable
    if (comparisonCharacters > limits.maxTotalComparisonCharacters - candidate.comparisonCharacters) {
      comparisonsWithinBudget = false
    } else {
      comparisonCharacters += candidate.comparisonCharacters
    }
  }

  const deduplicated = deduplicateNormalizedSources(prepared)
  if (!comparisonsWithinBudget) {
    return Object.freeze(deduplicated.map(source => source.source))
  }

  const temporal = needsTimeContext(boundedQuery.text)
  const wantedVersions = queryVersions(boundedQuery.text)
  const originalPresent = deduplicated.some(source => (
    !isReprint(source) && inferredBaseScore(source) >= 500
  ))
  const repeatedTitles = repeatedTitleIndexes(deduplicated)
  const ranked = deduplicated.map(source => qualityScore(
    source,
    wantedVersions,
    temporal,
    originalPresent,
    repeatedTitles.has(source.index),
  ))
  ranked.sort((left, right) => {
    const score = right.score - left.score
    if (score !== 0) return score
    if (temporal) {
      if (left.publishedEpoch !== undefined && right.publishedEpoch === undefined) return -1
      if (left.publishedEpoch === undefined && right.publishedEpoch !== undefined) return 1
      if (left.publishedEpoch !== undefined && right.publishedEpoch !== undefined) {
        const freshness = right.publishedEpoch - left.publishedEpoch
        if (freshness !== 0) return freshness
      }
    }
    return left.index - right.index
  })
  return Object.freeze(ranked.map(source => source.source))
}

const CHINESE_RECENCY_TERMS = [
  '当前',
  '现在',
  '今天',
  '明天',
  '昨天',
  '本周',
  '上周',
  '下周',
  '本月',
  '上月',
  '下月',
  '今年',
  '去年',
  '明年',
  '最新',
  '最近',
  '近期',
  '刚刚',
  '刚才',
  '实时',
  '目前',
] as const

const ENGLISH_RECENCY_TERMS = [
  'current',
  'now',
  'today',
  'tomorrow',
  'yesterday',
  'this week',
  'last week',
  'next week',
  'this month',
  'last month',
  'next month',
  'this year',
  'last year',
  'next year',
  'latest',
  'recent',
  'recently',
  'just now',
  'real-time',
  'up-to-date',
] as const

const CHINESE_VERSION_RECENCY = [
  /(?:当前|现在|目前|最新|最新版|稳定版|推荐).{0,12}(?:版本|版号|发行版)/u,
  /(?:版本|版号|发行版).{0,12}(?:当前|现在|目前|最新|是多少|更新|发布)/u,
  /(?:什么|哪个|哪一).{0,6}(?:版本|版号|发行版)/u,
] as const

const ENGLISH_VERSION_RECENCY = [
  /\b(?:current|latest|newest|stable|supported|recommended)\s+(?:version|release)\b/i,
  /\b(?:version|release)\s+(?:is\s+)?(?:current|latest|newest|stable|supported)\b/i,
  /\bwhat(?:'s| is)\s+(?:the\s+)?(?:current\s+|latest\s+|newest\s+)?version\b/i,
  /\b(?:which|what)\s+version\s+of\b/i,
] as const

/** Pi-compatible recency detection, extended for explicit Chinese/English version freshness intent. */
export function needsTimeContext(query: string): boolean {
  const lower = query.toLowerCase()
  return CHINESE_RECENCY_TERMS.some((term) => query.includes(term))
    || ENGLISH_RECENCY_TERMS.some((term) => lower.includes(term))
    || CHINESE_VERSION_RECENCY.some((pattern) => pattern.test(query))
    || ENGLISH_VERSION_RECENCY.some((pattern) => pattern.test(query))
}

export interface CurrentTimeContext {
  readonly date: string
  readonly time: string
  readonly timeZone: string
}

export type SearchClock = () => Date
export type TimeZoneSource = string | (() => string)

export interface TimeContextDependencies {
  readonly clock?: SearchClock
  readonly timeZone?: TimeZoneSource
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function resolveTimeZone(source: TimeZoneSource | undefined): string {
  const value = typeof source === 'function' ? source() : source ?? defaultTimeZone()
  if (value.trim().length === 0) throw new RangeError('timeZone must not be empty')
  return value
}

function part(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((candidate) => candidate.type === type)?.value
  if (value === undefined) throw new RangeError(`time formatter did not produce ${type}`)
  return value
}

/** Format one already-captured operation timestamp in the selected IANA time zone. */
export function formatCurrentTimeContext(now: Date, timeZone: string): CurrentTimeContext {
  const epochMilliseconds = now.getTime()
  if (!Number.isFinite(epochMilliseconds)) throw new RangeError('clock returned an invalid Date')

  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  })
  const parts = formatter.formatToParts(new Date(epochMilliseconds))
  return Object.freeze({
    date: `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`,
    time: `${part(parts, 'hour')}:${part(parts, 'minute')}:${part(parts, 'second')}`,
    timeZone,
  })
}

/**
 * Resolve automatic time context. A non-temporal query reads neither dependency;
 * a temporal operation calls its clock exactly once and reuses that instant.
 */
export function resolveAutomaticTimeContext(
  query: string,
  dependencies: TimeContextDependencies = {},
): CurrentTimeContext | undefined {
  if (!needsTimeContext(query)) return undefined
  const clock = dependencies.clock ?? (() => new Date())
  const now = clock()
  const timeZone = resolveTimeZone(dependencies.timeZone)
  return formatCurrentTimeContext(now, timeZone)
}

/** Exact user-message prefix sent to the Search API model. */
export function renderCurrentTimeContext(context: CurrentTimeContext): string {
  return `[Current Time Context]\n- Date: ${context.date}\n- Time: ${context.time}\n- Timezone: ${context.timeZone}\n\n`
}

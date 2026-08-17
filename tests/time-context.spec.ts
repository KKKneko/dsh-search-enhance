import { describe, expect, it, vi } from 'vitest'

import {
  needsTimeContext,
  renderCurrentTimeContext,
  resolveAutomaticTimeContext,
} from '../src/search/index.js'

describe('automatic Search API time context', () => {
  it.each([
    '今天有什么重要新闻？',
    '本周发布了什么？',
    '目前的支持状态',
    'What is the latest security advisory?',
    'news from this year',
    'Is this API up-to-date?',
    'Node.js 当前版本是什么？',
    '这个框架最新版是多少？',
    'What is the current version of React?',
    'Which version of Python is supported?',
  ])('detects temporal intent in %j', (query) => {
    expect(needsTimeContext(query)).toBe(true)
  })

  it.each([
    'Explain electricity in a conductor without live measurements',
    'Explain semantic versioning',
    '语义化版本规范是什么？',
    'How does useEffect cleanup work?',
    '比较两种排序算法',
  ])('does not inject time for non-temporal intent in %j', (query) => {
    expect(needsTimeContext(query)).toBe(false)
  })

  it('uses an injected clock and time zone with exactly one clock read', () => {
    const clock = vi.fn(() => new Date('2026-01-02T03:04:05.678Z'))
    const timeZone = vi.fn(() => 'Asia/Shanghai')

    const context = resolveAutomaticTimeContext('今天 React 有什么更新？', {
      clock,
      timeZone,
    })

    expect(clock).toHaveBeenCalledTimes(1)
    expect(timeZone).toHaveBeenCalledTimes(1)
    expect(context).toEqual({
      date: '2026-01-02',
      time: '11:04:05',
      timeZone: 'Asia/Shanghai',
    })
    expect(renderCurrentTimeContext(context!)).toBe(
      '[Current Time Context]\n'
      + '- Date: 2026-01-02\n'
      + '- Time: 11:04:05\n'
      + '- Timezone: Asia/Shanghai\n\n',
    )
  })

  it('formats the same captured instant in the injected operation time zone', () => {
    const context = resolveAutomaticTimeContext('What happened today?', {
      clock: () => new Date('2026-01-02T03:04:05Z'),
      timeZone: 'America/Los_Angeles',
    })

    expect(context).toEqual({
      date: '2026-01-01',
      time: '19:04:05',
      timeZone: 'America/Los_Angeles',
    })
  })

  it('reads neither clock nor time zone for a non-temporal query', () => {
    const clock = vi.fn(() => new Date())
    const timeZone = vi.fn(() => 'UTC')

    expect(resolveAutomaticTimeContext('Explain TypeScript generics.', { clock, timeZone }))
      .toBeUndefined()
    expect(clock).not.toHaveBeenCalled()
    expect(timeZone).not.toHaveBeenCalled()
  })

  it('rejects an invalid injected clock or time zone for temporal work', () => {
    expect(() => resolveAutomaticTimeContext('today', {
      clock: () => new Date(Number.NaN),
      timeZone: 'UTC',
    })).toThrow('invalid Date')
    expect(() => resolveAutomaticTimeContext('today', {
      clock: () => new Date(0),
      timeZone: 'not/a-zone',
    })).toThrow()
  })
})

import { describe, expect, it } from 'vitest'

import {
  Config,
  SEARCH_DEPTHS,
  SEARCH_PROFILES,
  type SearchDepth,
  type SearchProfile,
} from '../src/config.js'
import {
  parseSearchDepth,
  parseSearchProfile,
  resolveSearchStrategy,
} from '../src/search/index.js'

const resolveConfig = (input: unknown) => Config(input as never)

const EXPECTED_BUDGETS = {
  auto: {
    compact: [6000, 8, 12 * 1024],
    normal: [12000, 12, 20 * 1024],
    deep: [24000, 20, 32 * 1024],
  },
  coding_docs: {
    compact: [3500, 6, 9000],
    normal: [7000, 10, 14 * 1024],
    deep: [14000, 16, 24 * 1024],
  },
  code_examples: {
    compact: [4000, 8, 10000],
    normal: [8000, 12, 16 * 1024],
    deep: [16000, 20, 26 * 1024],
  },
  project_research: {
    compact: [6000, 10, 12 * 1024],
    normal: [12000, 16, 20 * 1024],
    deep: [24000, 24, 32 * 1024],
  },
  academic: {
    compact: [12000, 20, 24 * 1024],
    normal: [18000, 30, 32 * 1024],
    deep: [32000, 40, 48 * 1024],
  },
  fact_check: {
    compact: [7000, 12, 16 * 1024],
    normal: [12000, 18, 24 * 1024],
    deep: [22000, 28, 36 * 1024],
  },
} as const satisfies Record<SearchProfile, Record<SearchDepth, readonly [number, number, number]>>

const PROFILE_SEMANTICS = {
  auto: [
    'Infer the best search strategy from the query.',
    'prefer official docs and GitHub',
    'Lead with the most probable answer or solution.',
    'do not broaden the task unless necessary',
  ],
  coding_docs: [
    'Find precise technical documentation for programming tasks.',
    '1. Official documentation',
    '- Direct answer first',
    '- Unverified snippets',
  ],
  code_examples: [
    'Find real-world code examples or official sample implementations.',
    '1. Official example repositories',
    '- File path or direct URL when possible',
    '- Large code dumps',
  ],
  project_research: [
    'Research a project, library, framework, tool, or ecosystem.',
    '1. Official website or docs',
    '- Current state and maintenance signal',
    '- Overclaiming popularity or stability without evidence',
  ],
  academic: [
    'Find accurate, citeable research material.',
    '1. Peer-reviewed papers',
    '- Main claim, method, and evidence',
    '- Single-source conclusions',
  ],
  fact_check: [
    'Verify factual claims using independent and timely sources.',
    '1. Primary sources',
    '- Verdict first: likely true, likely false, mixed, or unresolved',
    '- Hiding conflicting evidence',
  ],
} as const satisfies Record<SearchProfile, readonly [string, string, string, string]>

describe('Search API profile and depth policy', () => {
  it('resolves all 6 x 3 default budgets exactly', () => {
    const config = resolveConfig({})
    for (const profile of SEARCH_PROFILES) {
      for (const depth of SEARCH_DEPTHS) {
        const strategy = resolveSearchStrategy(config, { depth, profile })
        const expected = EXPECTED_BUDGETS[profile][depth]
        expect(strategy.budget, `${profile}/${depth}`).toEqual({
          maxAnswerCharacters: expected[0],
          maxModelTextBytes: expected[2],
          maxVisibleSources: expected[1],
        })
      }
    }
  })

  it('uses layered settings defaults and exact per-cell overrides', () => {
    const config = resolveConfig({
      budgets: {
        academic: {
          deep: {
            maxAnswerCharacters: 12345,
            maxModelTextBytes: 23456,
            maxVisibleSources: 17,
          },
        },
      },
      defaultDepth: 'deep',
      defaultProfile: 'academic',
      retention: {
        providerMaxSources: 23,
      },
    })

    const strategy = resolveSearchStrategy(config)
    expect(strategy).toMatchObject({
      budget: {
        maxAnswerCharacters: 12345,
        maxModelTextBytes: 23456,
        maxVisibleSources: 17,
      },
      depth: 'deep',
      maxCollectedSources: 23,
      profile: 'academic',
    })
    expect(strategy.profilePrompt).toContain('Keep the answer under 12345 characters.')
    expect(strategy.profilePrompt).toContain('Return at most 23 source links')
    expect(strategy.profilePrompt).not.toContain('Return at most 17 source links')
  })

  it.each(SEARCH_PROFILES)('pins the complete %s Search API policy', (profile) => {
    const strategy = resolveSearchStrategy(resolveConfig({}), { depth: 'normal', profile })
    for (const semantic of PROFILE_SEMANTICS[profile]) {
      expect(strategy.profilePrompt).toContain(semantic)
    }
    expect(strategy.profilePrompt).toMatchSnapshot()
  })

  it.each(SEARCH_PROFILES)('accepts the exact profile enum %s', (profile) => {
    expect(parseSearchProfile(profile)).toBe(profile)
  })

  it.each([undefined, null, '', 'AUTO', 'coding-docs', 'sources_only', 'unknown']) (
    'rejects invalid profile value %j',
    (profile) => {
      expect(() => parseSearchProfile(profile)).toThrow(TypeError)
    },
  )

  it.each(SEARCH_DEPTHS)('accepts the exact depth enum %s', (depth) => {
    expect(parseSearchDepth(depth)).toBe(depth)
  })

  it.each([undefined, null, '', 'Compact', 'sources_only', 'wide', 1])(
    'rejects invalid depth value %j',
    (depth) => {
      expect(() => parseSearchDepth(depth)).toThrow(TypeError)
    },
  )
})

import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'

import {
  SOURCE_PROVIDERS,
  type SourceRef,
  type StoredSourceRecord,
} from '../src/contracts/index.js'

describe('public stage 0 contracts', () => {
  it('keeps provider names explicit and provider-neutral', () => {
    expect(SOURCE_PROVIDERS).toEqual([
      'search-api',
      'context7',
      'exa',
      'tavily',
      'firecrawl',
      'smart-direct',
      'direct',
    ])
  })

  it('keeps plugin records out of SessionEventMap', () => {
    expectTypeOf<StoredSourceRecord['sourceRef']>().toEqualTypeOf<SourceRef>()
    expectTypeOf<'search-enhance/auxiliary-request'>().not.toMatchTypeOf<keyof SessionEventMap>()
    expectTypeOf<'search-enhance/sources-recorded'>().not.toMatchTypeOf<keyof SessionEventMap>()
  })
})

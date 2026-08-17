import type { SearchProfile } from '../config.js'
import type { DiscoveryBudgetAllocation } from './types.js'

const DOCUMENTATION_INTENT = /(?:\b(?:api|sdk|docs?|documentation|reference|framework|library|github|readme|releases?|release notes?|changelog|migration|typescript|javascript|python|react|vue|next\.js|node\.js)\b|文档|框架|软件库|迁移|发布说明|变更日志|源码仓库)/i

/** Decide documentation enhancement from the resolved profile and stable intent vocabulary. */
export function shouldEnhanceDocumentation(profile: SearchProfile, query: string): boolean {
  if (['auto', 'coding_docs', 'code_examples', 'project_research'].includes(profile)) return true
  return DOCUMENTATION_INTENT.test(query)
}

/**
 * Split one shared discovery-source budget exactly once. The 60/40 ceiling is
 * the Pi-compatible rule; unavailable Providers receive zero and cannot dilute
 * the budget of the sole available Provider.
 */
export function splitDiscoveryBudget(
  total: number,
  tavilyAvailable: boolean,
  firecrawlAvailable: boolean,
): Readonly<DiscoveryBudgetAllocation> {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('extra discovery budget must be a non-negative safe integer')
  }
  if (total === 0 || (!tavilyAvailable && !firecrawlAvailable)) {
    return Object.freeze({ firecrawl: 0, tavily: 0 })
  }
  if (tavilyAvailable && firecrawlAvailable) {
    const tavily = Math.ceil(total * 0.6)
    return Object.freeze({ firecrawl: total - tavily, tavily })
  }
  return Object.freeze({
    firecrawl: firecrawlAvailable ? total : 0,
    tavily: tavilyAvailable ? total : 0,
  })
}

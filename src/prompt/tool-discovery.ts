import type { Context } from '@deepseek-ai/cordis'

export const TOOL_DISCOVERY_GUIDANCE = [
  'Search Enhance keeps a fixed model-facing surface: web_search, docs_search, web_extract, search_tools, and search_call.',
  'Use search_tools only when the resident search tools cannot complete the task. It returns append-only capability and operation manifests; do not activate every capability preemptively.',
  'Run a manifested deferred operation with search_call({ operation, arguments }). A newly disclosed capability is callable on the next model step, and search_call fails closed while it is inactive.',
  'Activate planning only for explicit deep research, multi-source verification, or complex comparison. Activate diagnostics only when the user asks about Provider configuration or connectivity.',
  'A successful web_search or docs_search result with source_ref activates the sources capability. Use the appended search_sources manifest, or call search_tools for sources to replay that manifest before search_call.',
].join('\n')

export const EVIDENCE_DISCIPLINE_GUIDANCE = [
  'For current or external factual questions, start with one focused web_search (use docs_search for SDK/API documentation); do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.',
  'Treat web_search/docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.',
  'Before asserting decisive factual or causal conclusions, inspect selected authoritative URLs with web_extract; never present an inferred mechanism as source-stated fact, and label unestablished mechanisms as inference or unconfirmed.',
].join('\n')

/** Register deterministic guidance that never reads Agent state or tool visibility. */
export function registerToolDiscoveryGuidance(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'search-enhance:tool-discovery',
    order: 121,
    text: TOOL_DISCOVERY_GUIDANCE,
  })
  ctx.systemPrompt.section({
    name: 'search-enhance:evidence-discipline',
    order: 122,
    text: EVIDENCE_DISCIPLINE_GUIDANCE,
  })
}

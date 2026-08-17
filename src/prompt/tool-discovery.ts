import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

import type { ToolDiscoveryMode } from '../config.js'
import { CAPABILITY_GROUPS } from '../tool-discovery/capabilities.js'
import { foldToolDisclosureEvents } from '../tool-discovery/fold.js'

const EVIDENCE_DISCOVERY_TOOLS = ['web_search', 'docs_search'] as const

type EvidenceDiscoveryTool = (typeof EVIDENCE_DISCOVERY_TOOLS)[number]

function evidenceDisciplineText(
  visibleDiscoveryTools: readonly EvidenceDiscoveryTool[],
  webExtractVisible: boolean,
): string {
  if (visibleDiscoveryTools.length === 0) return ''
  const route = visibleDiscoveryTools.length === 2
    ? 'For current or external factual questions, start with one focused web_search (use docs_search for SDK/API documentation); do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
    : visibleDiscoveryTools[0] === 'web_search'
      ? 'For current or external factual questions, start with one focused web_search; do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
      : 'For current or external SDK/API documentation questions, start with one focused docs_search; do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.'
  return [
    route,
    `Treat ${visibleDiscoveryTools.join('/')} answers, snippets, and source metadata as discovery, not claim-level evidence.`,
    webExtractVisible
      ? 'Before asserting decisive factual or causal conclusions, inspect selected authoritative URLs with web_extract; never present an inferred mechanism as source-stated fact, and label unestablished mechanisms as inference or unconfirmed.'
      : 'Never present an inferred mechanism as source-stated fact; label unestablished mechanisms as inference or unconfirmed.',
  ].join('\n')
}

/** Register scope-aware disclosure and evidence guidance for Search Enhance tools. */
export function registerToolDiscoveryGuidance(
  ctx: Context,
  mode: ToolDiscoveryMode,
): void {
  ctx.systemPrompt.section({
    name: 'search-enhance:tool-discovery',
    order: 121,
    text: context => {
      if (
        mode === 'all'
        || context.agent === undefined
        || ctx.tools.get('search_tools', context.scope) === undefined
      ) return ''
      const active = new Set(
        foldToolDisclosureEvents(context.agent.session.events).activeGroups,
      )
      const remaining = CAPABILITY_GROUPS.filter(group => !active.has(group))
      if (remaining.length === 0) return ''
      return [
        `Additional Search Enhance capabilities are deferred for this Agent: ${remaining.join(', ')}.`,
        'Use search_tools only when web_search, docs_search, and web_extract cannot complete the task; do not activate every group preemptively.',
        'Activate planning only for explicit deep research, multi-source verification, or complex comparison. Activate diagnostics only when the user asks about Provider configuration or connectivity.',
        'A successful disclosure applies on the next model step and cannot bypass another Preset restriction. In Code Mode, call search_tools through the current run_code SDK and wait for the next step before using newly disclosed bindings.',
        'Successful source-producing searches disclose sources automatically, so do not request it again when already active.',
      ].join('\n')
    },
  })
  ctx.systemPrompt.section({
    name: 'search-enhance:evidence-discipline',
    order: 122,
    text: context => evidenceDisciplineText(
      EVIDENCE_DISCOVERY_TOOLS.filter(
        tool => ctx.tools.get(tool, context.scope) !== undefined,
      ),
      ctx.tools.get('web_extract', context.scope) !== undefined,
    ),
  })
}

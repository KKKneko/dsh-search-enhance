import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import type { Config } from '../config.js'
import {
  buildResearchPlan,
  type ResearchPlanBuildOptions,
} from '../research-plan/index.js'
import {
  throwIfAborted,
} from '../provider-runtime/index.js'
import {
  presentResearchPlanCall,
  presentResearchPlanResult,
  researchPlanPresentationMeta,
} from '../presentation/research-plan-card.js'
import { renderResearchPlanText } from '../presentation/render.js'
import type { ForegroundOperationScope } from './operations.js'
import {
  RESEARCH_PLAN_OUTPUT_SCHEMA,
  RESEARCH_PLAN_PARAMETERS,
  type ResearchPlanArgs,
  type ResearchPlanOutput,
} from './schemas.js'

export interface ResearchPlanToolDependencies {
  /** Read one resolved Settings snapshot for this pure operation. */
  readonly getConfig: () => Config
  /** Resolve whether web_map is active through the fixed gateway for this Agent. */
  readonly isWebMapAvailable?: (agent: ToolRunContext['agent']) => boolean
  readonly operations: ForegroundOperationScope
}

function plannerOptions(
  config: Config,
  webMapAvailable: boolean,
): ResearchPlanBuildOptions {
  return {
    config: config.researchPlan,
    webMapAvailable,
    siteMapMaxLinks: config.siteMap.maxLinks,
  }
}

async function executeResearchPlan(
  args: ResearchPlanArgs,
  dependencies: ResearchPlanToolDependencies,
  agent: ToolRunContext['agent'],
  signal: AbortSignal,
): Promise<ResearchPlanOutput> {
  const config = dependencies.getConfig()
  throwIfAborted(signal)
  const value = buildResearchPlan(
    args,
    plannerOptions(
      config,
      dependencies.isWebMapAvailable?.(agent) ?? true,
    ),
  )
  throwIfAborted(signal)
  return value
}

/** Build the deferred, network-free research planner Consumer. */
export function createResearchPlanTool(
  dependencies: ResearchPlanToolDependencies,
): ToolDefinition {
  return defineTool({
    name: 'research_plan',
    description: 'Generate one offline research plan only for explicit deep research, multi-source verification, or complex comparison. It does not search, fetch, or verify claims. Call resident web_search/docs_search/web_extract directly; invoke a listed web_map step through search_call only when site_map is active.',
    parameters: RESEARCH_PLAN_PARAMETERS,
    output: {
      schema: RESEARCH_PLAN_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResearchPlanText(value) }],
      presentationMeta: researchPlanPresentationMeta,
    },
    async execute(args, exec: ToolRunContext) {
      return dependencies.operations.run(
        exec.signal,
        signal => executeResearchPlan(args, dependencies, exec.agent, signal),
        exec.agent,
      )
    },
    isConcurrencySafe: () => true,
    presentCall: presentResearchPlanCall,
    presentResult: presentResearchPlanResult,
  })
}

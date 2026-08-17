import {
  SEARCH_DEPTHS,
  SEARCH_PROFILES,
  type Config,
  type OutputBudget,
  type SearchDepth,
  type SearchProfile,
} from '../config.js'

/** Common Search API policy retained from Pi Search. */
export const SEARCH_PROMPT_BASE = `# Core Instruction

1. Infer the user's intent from the query, but do not broaden the task unless necessary.
2. Verify factual claims with authoritative sources before answering.
3. Prefer official documentation, academic databases, reputable media, and primary sources.
4. Cite sources at paragraph or table-row level. Do not cite every sentence.
5. Be concise and stay within the output budget.

# Output Style

1. Lead with the most probable answer or solution.
2. Use polished Markdown.
3. Define technical terms only when they are necessary for understanding.
4. State limitations when evidence is incomplete or conflicting.
`

/**
 * Full, profile-specific Search API policies migrated independently from Pi Search.
 * Keep these as six explicit prompts: their goals, source priorities, outputs, and
 * prohibitions are product behavior, not substitutions in a generic template.
 */
export const SEARCH_PROFILE_PROMPTS = Object.freeze({
  auto: `# Search Profile: Auto

Infer the best search strategy from the query.
If it is about programming, prefer official docs and GitHub.
If it is about academic or research material, prioritize papers, reports, and multi-source evidence.
If it is about factual claims, verify with independent sources.
Keep the result compact unless the query explicitly asks for depth.`,
  coding_docs: `# Search Profile: Coding Docs

Goal:
Find precise technical documentation for programming tasks.

Source priority:
1. Official documentation
2. Versioned API reference
3. Official examples
4. GitHub README, release notes, or changelog
5. High-quality community articles only as fallback

Output:
- Direct answer first
- API names, function signatures, config keys, and version notes when relevant
- Minimal example if useful
- Mention whether the source is official
- Return only the most relevant links

Avoid:
- Long background explanations
- Blog-first answers when official docs exist
- Unverified snippets`,
  code_examples: `# Search Profile: Code Examples

Goal:
Find real-world code examples or official sample implementations.

Source priority:
1. Official example repositories
2. Framework or library GitHub repos
3. Well-known open-source projects
4. Gists or blogs only as fallback

Output:
- Repository name
- File path or direct URL when possible
- Short reason why the example is relevant
- Small snippet or usage summary
- License caution if the user may copy code

Avoid:
- Large code dumps
- Toy examples unless official
- Sources without clear file paths`,
  project_research: `# Search Profile: Project Research

Goal:
Research a project, library, framework, tool, or ecosystem.

Source priority:
1. Official website or docs
2. GitHub README
3. Release notes or changelog
4. Issues or discussions
5. Reputable comparisons or articles

Output:
- What it is
- Current state and maintenance signal
- Strengths and limitations
- Relevant links
- Mention stale or uncertain information

Avoid:
- Overclaiming popularity or stability without evidence`,
  academic: `# Search Profile: Academic Research

Goal:
Find accurate, citeable research material.

Source priority:
1. Peer-reviewed papers
2. Academic databases
3. Official reports or white papers
4. Books or institutional publications
5. Reputable secondary sources only as context

Output:
- Author, year, title, and venue if available
- DOI or stable URL if available
- Main claim, method, and evidence
- Limitations
- Conflicting findings if present
- Separate confirmed facts from uncertain claims

Avoid:
- Single-source conclusions
- Blog-style summaries as primary evidence
- Missing citation metadata when available`,
  fact_check: `# Search Profile: Fact Check

Goal:
Verify factual claims using independent and timely sources.

Source priority:
1. Primary sources
2. Official announcements or public records
3. Reputable media
4. Independent expert analysis
5. Wikipedia only as background, not primary proof

Output:
- Verdict first: likely true, likely false, mixed, or unresolved
- Evidence for and against
- Source freshness
- Known uncertainty
- Confidence level
- If a key numeric claim lacks sufficient independent support, label that number \`unverified\` or \`unresolved\`.

Avoid:
- Treating repeated syndicated reports as independent sources
- Hiding conflicting evidence`,
} satisfies Readonly<Record<SearchProfile, string>>)

const DEPTH_INSTRUCTIONS = Object.freeze({
  compact: 'Mode: compact. Return a short answer, key evidence, and only the most relevant sources.',
  normal: 'Mode: normal. Return a complete but bounded answer with concise evidence and sources.',
  deep: 'Mode: deep. Explore multiple angles, but still respect the output budget and avoid unnecessary background.',
} satisfies Readonly<Record<SearchDepth, string>>)

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

/** Parse one exact model-visible profile enum; aliases and silent fallback are rejected. */
export function parseSearchProfile(value: unknown): SearchProfile {
  if (!isOneOf(SEARCH_PROFILES, value)) {
    throw new TypeError(`profile must be one of: ${SEARCH_PROFILES.join(', ')}`)
  }
  return value
}

/** Parse one exact depth enum. The retired Pi `sources_only` mode is rejected. */
export function parseSearchDepth(value: unknown): SearchDepth {
  if (!isOneOf(SEARCH_DEPTHS, value)) {
    throw new TypeError(`depth must be one of: ${SEARCH_DEPTHS.join(', ')}`)
  }
  return value
}

function assertBudgetValue(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`)
  }
}

/** Validate a resolved deployment budget before it becomes an execution policy. */
export function validateOutputBudget(budget: OutputBudget): void {
  assertBudgetValue(budget.maxAnswerCharacters, 'maxAnswerCharacters', true)
  assertBudgetValue(budget.maxVisibleSources, 'maxVisibleSources', true)
  assertBudgetValue(budget.maxModelTextBytes, 'maxModelTextBytes', false)
}

/** Build the exact profile/depth Search API system prompt for one operation. */
export function buildSearchProfilePrompt(
  profile: SearchProfile,
  depth: SearchDepth,
  budget: OutputBudget,
  maxCollectedSources: number = budget.maxVisibleSources,
): string {
  validateOutputBudget(budget)
  assertBudgetValue(maxCollectedSources, 'maxCollectedSources', false)
  const answerLimit = budget.maxAnswerCharacters > 0
    ? `Keep the answer under ${budget.maxAnswerCharacters} characters.`
    : 'Do not write a prose answer; return only source links with terse labels.'
  const sourceLimit = `Return at most ${maxCollectedSources} source links in the final source/reference block.`

  return `${SEARCH_PROMPT_BASE}\n${SEARCH_PROFILE_PROMPTS[profile]}\n\n# Search Budget\n\n${DEPTH_INSTRUCTIONS[depth]}\n${answerLimit}\n${sourceLimit}\n`
}

export interface SearchStrategyOverrides {
  /** Undefined inherits the DSH setting; any supplied value is parsed strictly. */
  readonly profile?: unknown
  /** Undefined inherits the DSH setting; any supplied value is parsed strictly. */
  readonly depth?: unknown
}

export interface ResolvedSearchStrategy {
  readonly profile: SearchProfile
  readonly depth: SearchDepth
  readonly budget: Readonly<OutputBudget>
  /** Provider collection cap, independent from the ordinary visible-source cap. */
  readonly maxCollectedSources: number
  readonly profilePrompt: string
}

/**
 * Resolve call overrides over already-layered DSH Settings. No default is hidden
 * in the Provider: schema defaults, Loader base, and user overrides have already
 * produced `config` before this pure step runs.
 */
export function resolveSearchStrategy(
  config: Config,
  overrides: SearchStrategyOverrides = {},
): ResolvedSearchStrategy {
  const profile = overrides.profile === undefined
    ? parseSearchProfile(config.defaultProfile)
    : parseSearchProfile(overrides.profile)
  const depth = overrides.depth === undefined
    ? parseSearchDepth(config.defaultDepth)
    : parseSearchDepth(overrides.depth)
  const configuredBudget = config.budgets[profile][depth]
  validateOutputBudget(configuredBudget)
  const budget = Object.freeze({ ...configuredBudget })

  const maxCollectedSources = config.retention.providerMaxSources
  assertBudgetValue(maxCollectedSources, 'providerMaxSources', false)
  return Object.freeze({
    budget,
    depth,
    maxCollectedSources,
    profile,
    profilePrompt: buildSearchProfilePrompt(profile, depth, budget, maxCollectedSources),
  })
}

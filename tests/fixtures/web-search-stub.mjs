import { defineTool } from '@deepseek-ai/dsh-tools'

let calls = 0

export const name = 'search-enhance-test-web-search-stub'
export const inject = ['tools']

export function resetCalls() {
  calls = 0
}

export function callCount() {
  return calls
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'web_search',
    description: 'Test-only native web search stub.',
    parameters: {
      query: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      calls += 1
      return `stub:${args.query}`
    },
  }))
}

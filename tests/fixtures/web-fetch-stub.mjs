import { defineTool } from '@deepseek-ai/dsh-tools'

let calls = 0

export const name = 'search-enhance-test-web-fetch-stub'
export const inject = ['tools']

export function resetCalls() {
  calls = 0
}

export function callCount() {
  return calls
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'Test-only independent native web fetch stub.',
    parameters: {
      url: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      calls += 1
      return `stub:${args.url}`
    },
  }))
}

export const name = 'search-enhance-test-hide-web-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.restrict({ deny: ['web_search'] })
}

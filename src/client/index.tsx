/** Browser half: Search Enhance configuration under Settings → Plugins. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

import {
  SEARCH_ENHANCE_LOCALE_NAMESPACE,
  SearchEnhancePluginCard,
} from './SearchEnhancePluginCard.js'
import { en, zh, type SearchEnhanceLocaleKey } from './locales.js'

export { SearchEnhancePluginCard } from './SearchEnhancePluginCard.js'
export {
  deleteWebCredential,
  loadWebConfig,
  saveWebConfig,
  WebConfigClientError,
  writeWebCredential,
} from './api.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.search-enhance': SearchEnhanceLocaleKey
  }
}

export const name = 'dsh-search-enhance-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(SEARCH_ENHANCE_LOCALE_NAMESPACE, { zh, en }),
    'dsh-search-enhance: settings dictionaries',
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'dsh-search-enhance',
    order: 25,
    locale: SEARCH_ENHANCE_LOCALE_NAMESPACE,
  }, SearchEnhancePluginCard))
}

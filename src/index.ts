import type { Context } from '@deepseek-ai/cordis'

import {
  Context7ResolveDiagnosticProbe,
  SearchApiModelListDiagnosticProbe,
  SearchDiagnostics,
  SourceSearchDiagnosticProbe,
} from './diagnostics/index.js'

import {
  Config as SearchEnhanceConfig,
  SEARCH_ENHANCE_SETTINGS_NAMESPACE,
  type Config as SearchEnhanceConfigValue,
} from './config.js'
import {
  Context7CachedOperations,
  DocumentationContext7Provider,
  DocumentationSearchService,
  PersistentContext7Cache,
} from './documentation/index.js'
import { SearchOrchestrator } from './orchestration/index.js'
import { registerToolDiscoveryGuidance } from './prompt/tool-discovery.js'
import { Context7RemoteClient } from './providers/context7.js'
import { ExaProvider } from './providers/exa.js'
import { FirecrawlSearchProvider } from './providers/firecrawl.js'
import { FirecrawlScrapeProvider } from './providers/firecrawl-scrape.js'
import { DirectFetchProvider } from './providers/direct-fetch.js'
import { SearchApiProvider } from './providers/search-api.js'
import { SmartDirectProvider } from './providers/smart-direct.js'
import { TavilySearchProvider } from './providers/tavily.js'
import { TavilyExtractProvider } from './providers/tavily-extract.js'
import { TavilyMapProvider } from './providers/tavily-map.js'
import {
  SOURCE_RECORD_DOMAIN_SPEC,
  SOURCE_RECORD_TABLE_NAME,
  SearchEnhanceSourceService,
  SourceRecordStore,
} from './source-storage/index.js'
import {
  installAgentToolDisclosure,
  isDeferredToolName,
} from './tool-discovery/index.js'
import {
  ForegroundOperationScope,
  createContext7Tools,
  createDocsSearchTool,
  createWebSearchTool,
  createResearchPlanTool,
  createSearchDiagnosticsTool,
  createSearchSourcesTool,
  createSearchToolsTool,
  createWebExtractTool,
  createWebMapTool,
} from './tools/index.js'
import { WebExtractOrchestrator } from './web-extract/orchestrator.js'
import { installWebConfigBridge } from './web-config/host.js'

export const name = 'search-enhance'
export const inject = ['agents', 'credentials', 'settings', 'storageDomain', 'systemPrompt', 'tools']
export const Config = SearchEnhanceConfig

export async function apply(ctx: Context, config: SearchEnhanceConfigValue): Promise<void> {
  const settings = ctx.settings.register(
    SEARCH_ENHANCE_SETTINGS_NAMESPACE,
    SearchEnhanceConfig,
    { applies: 'restart', base: config },
  )
  const effective = settings.get()
  const domain = await ctx.storageDomain.open(SOURCE_RECORD_DOMAIN_SPEC)
  const store = new SourceRecordStore(domain.table(SOURCE_RECORD_TABLE_NAME), {
    maxBytes: effective.retention.sourceEventMaxBytes,
    maxRecords: effective.retention.sourceStoreMaxRecords,
    maxSources: effective.retention.sourceEventMaxSources,
    maxPageSize: effective.retention.searchSourcesMaxPageSize,
    maxPageBytes: effective.retention.searchSourcesPageMaxBytes,
    maxSnippetCharacters: effective.retention.searchSourcesSnippetMaxCharacters,
  })

  const operations = new ForegroundOperationScope()
  const getConfig = (): SearchEnhanceConfigValue => settings.get()
  const providerDependencies = { credentials: ctx.credentials }
  const context7Cache = new PersistentContext7Cache(ctx.storageDomain, {
    maxEntries: effective.cache.maxEntries,
    maxEntryBytes: effective.cache.context7EntryMaxBytes,
  })
  const cachedContext7 = new Context7CachedOperations(context7Cache)
  const context7Remote = new Context7RemoteClient(providerDependencies)
  const exa = new ExaProvider(providerDependencies)
  let documentation: DocumentationSearchService | undefined

  // Keep dependent shutdown in one ordered disposer: stop both public-tool and
  // service calls, close the lazy docs cache, then drain source writes/domain.
  ctx.effect(() => async () => {
    await Promise.all([
      operations.stop(),
      documentation?.stop() ?? Promise.resolve(),
    ])
    await context7Cache.close()
    store.stop()
    await store.drain()
    await domain.close()
  })
  new SearchEnhanceSourceService(ctx, store)
  documentation = new DocumentationSearchService(ctx, {
    context7: context7Remote,
    context7Cache: cachedContext7,
    exa,
    getConfig,
  })

  const searchApi = new SearchApiProvider({
    credentials: ctx.credentials,
    getConfig,
  })
  const firecrawl = new FirecrawlSearchProvider(providerDependencies)
  const tavily = new TavilySearchProvider(providerDependencies)
  const diagnostics = new SearchDiagnostics({
    credentials: ctx.credentials,
    probes: [
      new SearchApiModelListDiagnosticProbe(searchApi),
      new Context7ResolveDiagnosticProbe(context7Remote),
      new SourceSearchDiagnosticProbe('docs_search', 'exa', exa),
      new SourceSearchDiagnosticProbe('main_search', 'tavily_search', tavily),
      new SourceSearchDiagnosticProbe('main_search', 'firecrawl_search', firecrawl),
    ],
  })
  const orchestrator = new SearchOrchestrator({
    context7: new DocumentationContext7Provider(documentation),
    exa,
    firecrawl,
    getConfig,
    mainSearch: searchApi,
    tavily,
  })
  const webExtract = new WebExtractOrchestrator({
    tavilyExtract: new TavilyExtractProvider(providerDependencies),
    firecrawlScrape: new FirecrawlScrapeProvider(providerDependencies),
    smartDirect: new SmartDirectProvider(),
    direct: new DirectFetchProvider(),
    getConfig,
  })

  const webSearchDefinition = createWebSearchTool({
    getConfig,
    operations,
    orchestrator,
    sources: ctx.searchEnhanceSources,
  })
  const globalToolDefinitions = [
    createDocsSearchTool({
      documentation,
      getConfig,
      operations,
      sources: ctx.searchEnhanceSources,
    }),
    createWebExtractTool({
      getConfig,
      operations,
      orchestrator: webExtract,
    }),
    createSearchToolsTool({ mode: effective.toolDiscovery.mode }),
    createSearchSourcesTool({
      getConfig,
      operations,
      sources: ctx.searchEnhanceSources,
    }),
    createWebMapTool({
      getConfig,
      operations,
      provider: new TavilyMapProvider(providerDependencies),
    }),
    createResearchPlanTool({
      getConfig,
      isWebMapAvailable: agent => ctx.tools.get('web_map', agent) !== undefined,
      operations,
    }),
    createSearchDiagnosticsTool({
      getConfig,
      operations,
      reporter: diagnostics,
    }),
    ...createContext7Tools({
      documentation,
      getConfig,
      operations,
    }),
  ]
  for (const definition of globalToolDefinitions) ctx.tools.register(definition)

  installAgentToolDisclosure(ctx, {
    mode: effective.toolDiscovery.mode,
    deferredToolNames: globalToolDefinitions
      .map(definition => definition.name)
      .filter(isDeferredToolName),
    webSearchDefinition,
  })
  registerToolDiscoveryGuidance(ctx, effective.toolDiscovery.mode)
  installWebConfigBridge(ctx)
}

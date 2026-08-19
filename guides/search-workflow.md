# Search workflow architecture

English | [简体中文](search-workflow.zh.md)

This document describes how Search Enhance routes a request from discovery to source retention and page verification. Installation and configuration stay in the main [README](../README.md).

## Overview

```text
User request
  │
  ▼
DSH Agent
  │
  ├─ web_search ──────> Grok-compatible Search API
  │                       ├─ Exa for documentation-oriented discovery
  │                       ├─ Tavily / Firecrawl within the supplementary budget
  │                       └─ answer + normalized sources + optional source_ref
  │
  ├─ docs_search ─────> Context7 with an explicit library identity
  │                       └─ Exa for broad or unknown-library discovery
  │                          └─ snippets + sources + optional source_ref
  │
  ├─ web_extract ─────> Tavily → Firecrawl → smart_direct → direct
  │                       └─ first usable fetched page body + route metadata
  │
  ├─ search_tools ────> capability and operation manifests on demand
  │
  └─ search_call ─────> an active deferred operation
                          ├─ granular Context7 lookup
                          ├─ complete source pagination
                          ├─ site mapping
                          ├─ offline research planning
                          └─ read-only diagnostics
```

The plugin keeps discovery, retention, and verification separate:

1. **Discovery:** `web_search` and `docs_search` find answers, snippets, and candidate URLs. This material is discovery metadata, not proof that a page contains a claim.
2. **Retention:** complete bounded source records can be stored under a `source_ref`, independent of how many links fit in the first tool result.
3. **Verification:** `web_extract` retrieves selected pages. The Agent can then distinguish “a Provider found this” from “the fetched page states this.”

## Fixed model-facing surface

The model sees the same five search tools throughout an Agent run:

| Tool | Role |
| --- | --- |
| `web_search` | Run the main Grok-compatible search and merge policy-selected supplementary sources. |
| `docs_search` | Query Context7 with an explicit library identity, or use Exa for broader discovery. |
| `web_extract` | Retrieve one selected page through the fixed extraction route. |
| `search_tools` | Return manifests for deferred capabilities without registering more model tools. |
| `search_call` | Execute a deferred operation after it becomes active. |

`web_search` is installed through the Agent integration so existing DSH Presets and tool guards remain authoritative. The plugin does not add a second general-search tool or re-enable search where the Agent has disabled it.

Native Tool Mode and Code Mode use the same schemas, operation policy, and canonical outputs. Disclosure changes operation availability, not the model-facing tool list or its ordering.

## Deferred capabilities

`search_tools` can disclose one or more of five capability groups:

| Capability | Deferred operations | Purpose |
| --- | --- | --- |
| `context7` | `context7_resolve_library_id`, `context7_query_docs`, `context7_get_library_docs`, `context7_get_cached_doc_raw` | Resolve an exact library, query its docs, or inspect a cached document. |
| `sources` | `search_sources` | Page through a retained source record. |
| `site_map` | `web_map` | Discover bounded candidate URLs below a known site. |
| `planning` | `research_plan` | Build an offline plan for explicit deep or multi-source research. |
| `diagnostics` | `search_diagnostics` | Show masked configuration or explicitly test Provider connectivity. |

Activation follows these rules:

1. In the default `progressive` mode, a newly disclosed capability becomes callable on the next model step.
2. In `all` mode, deferred operations are active immediately, but they still run through `search_call`.
3. `search_call` rejects an inactive or unknown operation; it does not bypass the registry.
4. When `web_search` or `docs_search` returns a `source_ref`, the plugin activates `sources` and appends the real `search_sources` manifest automatically.
5. Disclosure never registers each operation as another model tool. The five-tool surface stays fixed.

## End-to-end flow

A typical sourced answer proceeds as follows:

1. The Agent sends a general current-information request to `web_search`, or a documentation request to `docs_search`.
2. `web_search` obtains the main answer and sources from the Grok-compatible endpoint. Documentation-oriented policy may add Exa; Tavily and Firecrawl participate only within their configured shared budget.
3. Search sources are bounded and normalized. The web-search quality pipeline de-duplicates equivalent URLs and can prioritize official, primary, version-matching, and fresher sources.
4. `docs_search` uses a supplied `library_id` directly, resolves a supplied `library_name` through Context7, or uses Exa when no library identity is known and `provider: "auto"` is selected.
5. If a complete source record is retained, the result includes `source_ref`. The Agent can use `search_sources` through `search_call` on the next step in `progressive` mode.
6. For important claims, the Agent selects authoritative URLs and calls `web_extract`. The orchestrator skips unavailable routes and stops at the first usable result in Tavily → Firecrawl → `smart_direct` → `direct` order.
7. Site mapping, granular Context7 work, research planning, and diagnostics are disclosed only when the task requires them.
8. The Agent writes the final response from the main answer, retained sources, and any page bodies it actually retrieved, preserving source links and the distinction between discovery and fetched evidence.

A `source_ref` points to a source list; it is not page content. Claim-level conclusions should rely on selected pages retrieved with `web_extract` whenever practical.

## Implementation map

- Plugin assembly and lifecycle: [`src/index.ts`](../src/index.ts)
- Main search orchestration: [`src/orchestration/orchestrator.ts`](../src/orchestration/orchestrator.ts)
- Documentation routing: [`src/documentation/service.ts`](../src/documentation/service.ts)
- Source retention and pagination: [`src/source-storage/`](../src/source-storage/)
- Capability mapping: [`src/tool-discovery/capabilities.ts`](../src/tool-discovery/capabilities.ts)
- Extraction fallback: [`src/web-extract/orchestrator.ts`](../src/web-extract/orchestrator.ts)

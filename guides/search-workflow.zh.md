# 搜索链路架构

[English](search-workflow.md) | 简体中文

本文说明 Search Enhance 如何将一次请求从来源发现推进到来源保留和原文核对。安装与配置仍以主 [README](../README.zh.md) 为准。

## 整体流程

```text
用户请求
  │
  ▼
DSH Agent
  │
  ├─ web_search ──────> Grok-compatible Search API
  │                       ├─ Exa：文档型问题的来源发现
  │                       ├─ Tavily / Firecrawl：配置预算内的补充来源
  │                       └─ 回答 + 标准化来源 + 可选 source_ref
  │
  ├─ docs_search ─────> Context7：使用明确的库身份
  │                       └─ Exa：广泛或未知库身份的文档发现
  │                          └─ 文档片段 + 来源 + 可选 source_ref
  │
  ├─ web_extract ─────> Tavily → Firecrawl → smart_direct → direct
  │                       └─ 首个可用的网页正文 + 提取路径元数据
  │
  ├─ search_tools ────> 按需返回 capability / operation manifest
  │
  └─ search_call ─────> 调用已激活的延迟 operation
                          ├─ Context7 精细查询
                          ├─ 完整来源分页
                          ├─ 站点映射
                          ├─ 离线研究计划
                          └─ 只读诊断
```

插件将发现、保留和核对分成三个阶段：

1. **来源发现：** `web_search` 和 `docs_search` 查找回答、文档片段和候选 URL。这些内容属于发现元数据，并不能证明页面确实包含某项声明。
2. **来源保留：** 完整且有界的来源记录可以保存在 `source_ref` 下，不受首次工具结果能够展示多少链接的影响。
3. **原文核对：** `web_extract` 读取选中的页面，使 Agent 能区分“Provider 找到了这个结果”和“实际读取的页面写了这些内容”。

## 固定模型工具入口

在一次 Agent 运行期间，模型始终看到相同的五个搜索工具：

| 工具 | 职责 |
| --- | --- |
| `web_search` | 执行 Grok-compatible 主搜索，并合并策略选中的补充来源。 |
| `docs_search` | 使用明确库身份查询 Context7，或使用 Exa 进行广泛发现。 |
| `web_extract` | 通过固定提取路径读取一个选中页面。 |
| `search_tools` | 返回延迟能力的 manifest，不注册更多模型工具。 |
| `search_call` | 在延迟 operation 激活后执行它。 |

`web_search` 通过 Agent 集成安装，因此现有 DSH Preset 和工具 guard 仍然拥有最终决定权。插件不会增加第二个普通搜索工具，也不会在 Agent 已禁用搜索时强行重新开启。

Native Tool Mode 与 Code Mode 使用相同的 schema、operation 策略和规范输出。披露状态只改变 operation 是否可调用，不改变模型工具列表及其顺序。

## 延迟能力

`search_tools` 可以披露以下五组能力中的一组或多组：

| 能力组 | 延迟 operation | 用途 |
| --- | --- | --- |
| `context7` | `context7_resolve_library_id`、`context7_query_docs`、`context7_get_library_docs`、`context7_get_cached_doc_raw` | 解析精确库身份、查询文档或读取缓存文档。 |
| `sources` | `search_sources` | 分页读取已保留的完整来源记录。 |
| `site_map` | `web_map` | 在已知网站下发现数量受限的候选 URL。 |
| `planning` | `research_plan` | 为明确的深度研究或多来源研究生成离线计划。 |
| `diagnostics` | `search_diagnostics` | 查看掩码后的配置，或显式测试 Provider 连通性。 |

激活规则如下：

1. 默认 `progressive` 模式下，新披露的能力从下一模型 step 开始可调用。
2. `all` 模式下，延迟 operation 立即处于 active 状态，但仍统一通过 `search_call` 执行。
3. `search_call` 会拒绝未激活或未知的 operation，不会绕过内部 registry。
4. `web_search` 或 `docs_search` 返回 `source_ref` 时，插件会自动激活 `sources`，并追加真实的 `search_sources` manifest。
5. 披露不会把每个 operation 注册成新的模型工具；模型工具入口始终保持五个。

## 一次完整搜索

一次带来源的回答通常按以下流程完成：

1. Agent 将普通时效性问题交给 `web_search`，将文档问题交给 `docs_search`。
2. `web_search` 从 Grok-compatible 端点取得主要回答和来源。文档型策略可以补充 Exa；Tavily 与 Firecrawl 只在配置的共享预算内参与。
3. 搜索来源会受到数量和体积限制并经过标准化。网页搜索质量流程会合并等价 URL，并可优先展示官方、第一方、版本匹配和较新的来源。
4. `docs_search` 直接使用传入的 `library_id`，通过 Context7 解析传入的 `library_name`；当库身份未知且选择 `provider: "auto"` 时则使用 Exa。
5. 完整来源记录成功保留后，结果包含 `source_ref`。在 `progressive` 模式下，Agent 可以从下一 step 通过 `search_call` 调用 `search_sources`。
6. 对重要结论，Agent 选择权威 URL 并调用 `web_extract`。编排器跳过不可用路径，并按 Tavily → Firecrawl → `smart_direct` → `direct` 顺序在首个可用结果处停止。
7. 站点映射、Context7 精细操作、研究计划和诊断只在任务确实需要时披露。
8. Agent 综合主搜索、保留来源和实际读取的网页正文生成最终回答，同时保留来源链接，并区分来源发现与已读取证据。

`source_ref` 指向来源列表，不等同于网页正文。在条件允许时，结论级事实应由 `web_extract` 读取选中页面后再确认。

## 实现位置

- 插件装配与生命周期：[`src/index.ts`](../src/index.ts)
- 主搜索编排：[`src/orchestration/orchestrator.ts`](../src/orchestration/orchestrator.ts)
- 文档路由：[`src/documentation/service.ts`](../src/documentation/service.ts)
- 来源保留与分页：[`src/source-storage/`](../src/source-storage/)
- 能力映射：[`src/tool-discovery/capabilities.ts`](../src/tool-discovery/capabilities.ts)
- 网页提取回退：[`src/web-extract/orchestrator.ts`](../src/web-extract/orchestrator.ts)

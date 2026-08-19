# DeepSeek Harness Search Enhance

[English](README.md) | 简体中文

`dsh-search-enhance` 是 DeepSeek Harness 的搜索增强插件。它使用 Grok-compatible Search API 生成普通网页搜索的主要回答，并可选用 Context7、Exa、Tavily 和 Firecrawl 完成文档检索、补充来源、网页正文提取和站点页面发现。

插件将搜索、来源保留和页面读取作为不同步骤处理。`web_search` 和 `docs_search` 返回搜索回答或文档片段以及可见来源；完整来源记录可通过 `source_ref` 保存并继续分页读取；需要核对重要内容时，再由 `web_extract` 获取选中页面。因此，搜索 snippet 与实际读取的网页正文会保持明确区分。

> 你需要自行提供所选服务的端点和凭据，插件不内置任何 API Key。`web_search` 需要 Grok-compatible 端点；Context7、Exa、Tavily 和 Firecrawl 均为可选 Provider。

![DSH Web 会话：搜索、检索文档、提取官方页面并生成带来源的回答](https://raw.githubusercontent.com/KKKneko/dsh-search-enhance/main/assets/search-workflow.png)

## 主要特点

- `web_search` 使用 Grok-compatible 端点生成主要回答，对文档型问题补充 Exa 来源，并在配置的补充预算内使用 Tavily 或 Firecrawl。
- 来源在展示前会经过 URL 标准化、去重，并根据来源类别、目标版本和发布时间信号重新排序。
- `source_ref` 将完整来源记录保存在插件私有持久存储中，Agent 可以继续分页读取首次结果未展示的来源。
- `docs_search` 只在提供明确 `library_name` 或 `library_id` 时使用 Context7；没有库身份的请求使用 Exa 发现。
- `web_extract` 按 Tavily → Firecrawl → `smart_direct` → `direct` 的固定路径执行，并报告提取路径、证据等级和可用的页面元数据。
- 来源分页、Context7 精细操作、站点映射、研究计划和诊断通过 `search_tools` 与 `search_call` 按需披露。
- Native Tool Mode 与 Code Mode 使用相同的固定工具入口和规范输出。DSH Settings、Credentials、Agent Preset、guard 和生命周期清理继续生效。
- 未配置的可选 Provider 会被跳过。Tavily 和 Firecrawl 的补充搜索预算默认是 `0`，可选 Provider 失败也会在结果中显示。

完整的路由、证据处理和渐进披露流程见[搜索链路架构](https://github.com/KKKneko/dsh-search-enhance/blob/main/guides/search-workflow.zh.md)。

## 快速开始

### 1. 安装

将已发布的 bundle 安装到 DSH `web` profile：

```bash
dsh plugin --profile web add dsh-search-enhance@latest
```

### 2. 启动 DSH Web

```bash
dsh web
```

### 3. 配置搜索

打开：

```text
设置 → 插件 → 插件配置 → dsh-search-enhance
```

在 **Grok 搜索后端** 中配置：

1. xAI 端点或明确的 Grok-compatible 网关；
2. 与服务匹配的 `completions` 或 `responses` 协议；
3. 该端点支持的模型；
4. 设置卡片“凭据”区域中的 Grok 密钥。

默认凭据引用名是 `SEARCH_API_KEY`。密钥值通过 DSH Credentials 保存，不会暴露为模型参数。

保存设置并重启 DSH，然后询问一个需要当前信息的问题。成功时会看到 `Search` 工具行、回答和来源链接。

## 使用示例

直接使用自然语言即可，插件会为 Agent 提供路由指引。

- “查找 React 19 最重要的用户可见变化，优先引用官方发布说明并附上来源链接。”
- “查找 FastAPI 当前 JWT 认证 API，并根据官方文档给出最小示例。”
- “读取并总结 `https://example.com/article`，区分页面原文与推断。”

需要完整来源分页、站点发现、研究计划或 Provider 诊断时，请明确提出。

## Provider

只配置你实际需要的路径。

| Provider | 用途 | 默认凭据引用名 | 是否必需 |
| --- | --- | --- | --- |
| Grok-compatible Search API | `web_search` 的主要回答和来源 | `SEARCH_API_KEY` | 使用 `web_search` 时 |
| Context7 | 明确库身份的文档检索 | `CONTEXT7_API_KEY` | 否 |
| Exa | 广泛文档发现和补充发现 | `EXA_API_KEY` | 否 |
| Tavily | 补充搜索、网页提取和站点映射 | `TAVILY_API_KEY` | 否 |
| Firecrawl | 补充搜索和网页提取 | `FIRECRAWL_API_KEY` | 否 |

未配置的可选 Provider 会被跳过。所有搜索 profile 的 Tavily/Firecrawl 补充搜索预算默认都是 `0`；显式的 `web_extract` 和 `web_map` 请求使用各自的执行路径。

对于 `docs_search`，Context7 需要明确的 `library_name` 或 `library_id`。两者都未提供时，`provider: "auto"` 使用 Exa，不会根据完整问题猜测包名。

## 工具披露

模型可见入口始终是五个工具：`web_search`、`docs_search`、`web_extract`、`search_tools` 和 `search_call`。高级 operation 通过 manifest 披露，不会注册成更多模型工具。

默认 `progressive` 模式下，新披露的能力从下一模型 step 开始可调用。`all` 模式让延迟 operation 立即处于 active 状态。Native Tool Mode 与 Code Mode 使用相同 schema、执行策略和规范输出。

`web_search` 或 `docs_search` 返回 `source_ref` 时，插件会自动激活来源分页，并追加对应的真实 operation manifest。

## 更新与卸载

更新时重新运行上面的安装命令。卸载插件：

```bash
dsh plugin --profile web remove dsh-search-enhance
```

更新或卸载 bundle 后请重启 DSH。

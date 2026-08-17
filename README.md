# dsh-search-enhance

`dsh-search-enhance` 是 DeepSeek Harness（DSH）的增强搜索插件。它使用 Grok 完成主搜索，并按需要补充文档、网页和站点信息，最后返回回答和来源链接。

## 架构与搜索流程

### 整体架构

```text
用户问题
  │
  ▼
DSH Agent
  │
  ├─ web_search ──────> Grok 主搜索
  │                      ├─ 按需要补充 Context7 / Exa
  │                      ├─ 按需要补充 Tavily / Firecrawl
  │                      └─ 返回回答、来源，必要时返回 source_ref
  │
  ├─ docs_search ─────> Context7 / Exa 文档检索
  │                      └─ 返回文档片段、来源，必要时返回 source_ref
  │
  ├─ web_extract ─────> Tavily → Firecrawl → smart_direct → direct
  │                      └─ 读取选中网页的正文
  │
  └─ search_tools ────> 按需开放更多工具
                         ├─ Context7 精细查询
                         ├─ 完整来源分页
                         ├─ 站点页面发现
                         ├─ 研究计划
                         └─ 配置诊断
```

插件继续使用 DSH 原有的 `web_search` 名称，不会再增加第二个普通搜索入口。在本来可以使用 `web_search` 的 Agent 中，插件提供增强后的搜索；如果某个 Agent 已经禁用网页搜索，插件不会强行重新开启。

普通搜索以 Grok 为主。其他服务只负责补充文档、来源或网页内容，不会替代 Grok 的主搜索位置。

### 初始可用工具

默认使用渐进式披露。每个新 Agent 开始时，插件提供的搜索工具中只显示以下四个：

| 工具 | 用途 |
| --- | --- |
| `web_search` | 通用搜索。使用 Grok 生成主要回答，并按搜索类型补充其他来源 |
| `docs_search` | 面向库、框架、SDK、API 和源码仓库的文档检索 |
| `web_extract` | 读取指定网页正文，用于核对搜索摘要中的重要内容 |
| `search_tools` | 当前四个工具不足时，按需要开放后续工具 |

这样可以避免一开始向模型展示全部工具，同时保留深度搜索所需的完整能力。

### 渐进式披露

`search_tools` 一次可以选择一到五组能力：

| 能力组 | 开放的工具 | 适用场景 |
| --- | --- | --- |
| `context7` | `context7_resolve_library_id`、`context7_query_docs`、`context7_get_library_docs`、`context7_get_cached_doc_raw` | 需要精确选择库版本或进一步读取 Context7 文档 |
| `sources` | `search_sources` | 搜索结果中的来源较多，需要继续分页读取完整来源 |
| `site_map` | `web_map` | 已知一个网站，需要继续发现该站点下的相关页面 |
| `planning` | `research_plan` | 明确要求深度研究、多来源核对或复杂比较时先制定计划 |
| `diagnostics` | `search_diagnostics` | 用户明确要求检查搜索配置或连接状态 |

渐进式披露遵循以下规则：

1. 新工具不会在 `search_tools` 调用的同一步立即出现，而会从下一步开始可用。
2. 开放范围只属于当前 Agent；已经开放的能力会保留，重复开放不会产生第二套工具。
3. `web_search` 或 `docs_search` 成功返回 `source_ref` 后，`sources` 会自动开放，不需要再次调用 `search_tools`。
4. 插件只会减少自己设置的隐藏范围，不能绕过 DSH 原有的工具限制。
5. 不应预先开放全部能力；只有初始四个工具无法完成任务时才按需增加。

如果希望插件一开始就显示全部 12 个工具，可以在配置页把“工具披露模式”改为 `all`。默认的 `progressive` 更适合普通使用；无论选择哪种模式，DSH 原有的工具限制仍然有效。

### 一次完整搜索如何进行

1. 通用问题先使用 `web_search`，文档问题优先使用 `docs_search`。
2. 当搜索产生来源时，会同时返回可见来源和一个可继续读取完整来源的 `source_ref`。
3. 需要更多来源时使用自动开放的 `search_sources` 分页读取。
4. 对重要结论，选择权威链接并使用 `web_extract` 获取网页正文。
5. 如果任务需要站点内发现、研究计划或连接检查，再通过 `search_tools` 开放对应能力。
6. 最终回答综合主搜索、补充来源和已经读取的网页正文，并保留来源链接。

`source_ref` 只是完整来源列表的引用，不等同于网页正文；重要事实仍应通过 `web_extract` 读取原页面后再下结论。

## 安装

确保 `dsh` 和 `pnpm` 已经可以使用，然后直接安装到默认的 `web` 配置：

```bash
dsh plugin --profile web add dsh-search-enhance@latest
```

安装完成后启动或重启 DSH：

```bash
dsh web
```

如果 DSH 已经在运行，请重启后再对浏览器执行一次强制刷新。

## 配置

启动 DSH 后，打开：

```text
设置 → 插件 → 插件配置 → dsh-search-enhance
```

第一次使用时，优先完成 Grok 搜索配置；其他选项可以先保持默认。

### 1. 配置 Grok 搜索

至少确认以下三项：

| 配置项 | 说明 |
| --- | --- |
| 接口地址 | xAI 官方地址或第三方 Grok 服务地址 |
| 模型 | 该服务实际支持的 Grok 模型名称 |
| Grok 密钥 | 在页面的“凭据”区域填写 |

页面还可以选择请求协议、思考等级和超时时间。请求协议需要与所使用的服务保持一致：

- `completions`：使用聊天补全接口；
- `responses`：使用 Responses 接口。

默认的 Grok 密钥名称是 `SEARCH_API_KEY`。密钥值只填写在“凭据”区域，不要写进接口地址或普通配置项。

### 2. 配置补充来源

这些服务不是完成主搜索的必要条件，可以按需要配置：

| 服务 | 用途 | 默认密钥名称 |
| --- | --- | --- |
| Context7 | 查找库和框架文档 | `CONTEXT7_API_KEY` |
| Exa | 补充文档和网页结果 | `EXA_API_KEY` |
| Tavily | 补充搜索、读取网页和发现站点页面 | `TAVILY_API_KEY` |
| Firecrawl | 补充搜索和读取网页 | `FIRECRAWL_API_KEY` |

在“补充 Provider”中填写服务地址，在“凭据”中填写对应密钥。没有配置的服务会被跳过，不影响已经配置好的搜索来源。

### 3. 配置搜索方式

页面可以设置默认搜索类型和搜索深度：

- `compact`：结果更简短；
- `normal`：信息量适中；
- `deep`：适合需要更多来源的问题。

不确定时保持默认值即可，也可以在单次搜索中临时选择其他设置。

“工具披露模式”建议保持 `progressive`，让工具按任务需要逐步出现；只有明确希望一开始显示全部搜索工具时才选择 `all`。

### 4. 配置网页代理

代理设置位于：

```text
补充 Provider → 高级 Provider 设置 → 网页提取代理
```

`smart_direct` 和 `direct` 可以分别填写代理地址，例如：

```text
http://127.0.0.1:7890
```

留空表示不使用该项代理。这里只支持不带账号密码的 `http://` 地址，不支持 HTTPS 或 SOCKS 代理，也不会自动读取 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`。

`direct` 使用代理时需要 Node.js 24.5 或更高版本。

### 5. 保存并重启

点击“保存配置”后重启 DSH：

```bash
dsh web
```

重启后，新配置才会用于搜索。

## 使用

安装并配置完成后，直接在 DSH 中描述需求即可，例如：

```text
搜索最近的相关信息，并列出来源。
```

```text
查找这个库当前版本的官方 API 用法。
```

```text
读取并总结 https://example.com/page 的正文。
```

```text
对这个问题做多来源核对，并说明各来源是否一致。
```

## 更新与卸载

更新到 npm 上的最新版本：

```bash
dsh plugin --profile web add dsh-search-enhance@latest
```

卸载插件：

```bash
dsh plugin --profile web remove dsh-search-enhance
```

## 使用提示

- 网页正文读取不会执行页面 JavaScript，也不能处理登录、验证码或浏览器会话。
- 网页读取可以访问 DSH 所在机器能够访问的地址；在敏感网络中只处理可信链接，并配合网络访问限制。
- 如果配置页面没有出现，先用 `dsh plugin --profile web list --depth 0` 确认 npm 包已经安装，然后重启 DSH 并强制刷新浏览器。

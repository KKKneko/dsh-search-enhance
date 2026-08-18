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
  └─ 固定模型工具 surface（schema 与顺序不随披露状态变化）
      ├─ web_search ──────> Grok 主搜索
      │                      ├─ 按需要补充 Context7 / Exa
      │                      ├─ 按需要补充 Tavily / Firecrawl
      │                      └─ 返回回答、来源；有 source_ref 时追加 search_sources manifest
      │
      ├─ docs_search ─────> Context7 / Exa 文档检索
      │                      └─ 返回文档片段、来源；有 source_ref 时追加 search_sources manifest
      │
      ├─ web_extract ─────> Tavily → Firecrawl → smart_direct → direct
      │                      └─ 读取选中网页的正文
      │
      ├─ search_tools ────> 按需返回 capability / operation manifest
      │
      └─ search_call ─────> 调用已经激活的延迟 operation
                             ├─ Context7 精细查询
                             ├─ 完整来源分页
                             ├─ 站点页面发现
                             ├─ 研究计划
                             └─ 配置诊断
```

插件继续使用 DSH 原有的 `web_search` 名称，不会再增加第二个普通搜索入口。在本来可以使用 `web_search` 的 Agent 中，插件提供增强后的搜索；如果某个 Agent 已经禁用网页搜索，插件不会强行重新开启。

普通搜索以 Grok 为主。其他服务只负责补充文档、来源或网页内容，不会替代 Grok 的主搜索位置。

### 固定模型工具 surface

默认使用 `progressive`。在 DSH 未另行限制的 Agent 中，插件在初始步骤和后续步骤提供的五个固定搜索入口（Native tool / Code Mode SDK）是：

| 工具 | 调用方式与用途 |
| --- | --- |
| `web_search` | 直接调用。使用 Grok 生成通用搜索的主要回答，并按搜索类型补充其他来源 |
| `docs_search` | 直接调用。检索库、框架、SDK、API 和源码仓库文档 |
| `web_extract` | 直接调用。读取指定网页正文，用于核对搜索摘要中的重要内容 |
| `search_tools` | 直接调用。按需返回延迟能力的 operation manifest，不注册新的模型工具 |
| `search_call` | 固定网关。通过 `search_call({ operation, arguments })` 调用已经激活的延迟 operation |

这里的“延迟”指 operation 是否处于 active 状态，而不是工具是否出现在列表中。延迟 operation 的参数 schema 通过工具结果中的 manifest 披露；输出 schema 只保存在内部 registry，用于校验规范执行结果，不会追加到模型历史，也不会作为独立工具加入模型 surface。

### 渐进式披露

`search_tools` 一次可以选择一到五组能力：

| 能力组 | 按需返回 manifest 的 operation | 适用场景 |
| --- | --- | --- |
| `context7` | `context7_resolve_library_id`、`context7_query_docs`、`context7_get_library_docs`、`context7_get_cached_doc_raw` | 需要精确选择库版本或进一步读取 Context7 文档 |
| `sources` | `search_sources` | 搜索结果中的来源较多，需要继续分页读取完整来源 |
| `site_map` | `web_map` | 已知一个网站，需要继续发现该站点下的相关页面 |
| `planning` | `research_plan` | 明确要求深度研究、多来源核对或复杂比较时先制定计划 |
| `diagnostics` | `search_diagnostics` | 用户明确要求检查搜索配置或连接状态 |

披露与调用遵循以下规则：

1. `search_tools` 返回所请求能力组的 operation manifest，其中包含真实的参数 schema 和 `search_call` 路由，但不包含内部输出 schema；它不会增加、删除或改写模型工具 schema。`search_call` 仍使用 registry 保存的输出 schema 校验规范结果。
2. 在 `progressive` 模式下，新披露的能力组从下一模型 step 开始 active；同一步内提前调用会失败。激活范围属于当前 Agent，重复请求会再次返回同一 manifest，但不会创建第二套状态或入口。
3. 在 `all` 模式下，唯一变化是所有延迟 operation 从一开始就 active；`search_tools` 仍按需返回 manifest。`all` 不会“显示全部 12 个工具”，两种模式的五个模型工具及其 schema 完全相同。
4. 延迟 operation 只能通过 `search_call({ operation, arguments })` 调用，不能直接调用 `search_sources`、`web_map` 等名称；resident 的 `web_search`、`docs_search` 和 `web_extract` 仍然直接调用。
5. `web_search` 或 `docs_search` 成功返回 `source_ref` 时，插件会自动激活 `sources`，并在结果中追加 `search_sources` manifest；在 `progressive` 模式下可从下一 step 通过 `search_call` 使用它。
6. 固定 surface 仍受 DSH 原有 Preset、guard 和工具限制约束，插件不会绕过这些限制。

这种固定网关设计保留了按需披露，同时避免插件因披露状态变化而改写发送给 DeepSeek 的 system 文本、tool schema/顺序或 Code Mode SDK 前缀，从而消除插件自身造成的前缀变化。

### 一次完整搜索如何进行

1. 通用问题直接调用 `web_search`，文档问题直接调用 `docs_search`。
2. 当搜索产生来源时，结果会包含可见来源、`source_ref` 和追加的 `search_sources` manifest，同时自动激活 `sources`。
3. 在下一 step 需要更多来源时，调用 `search_call({ operation: 'search_sources', arguments: { source_ref, offset: 0, limit: 20, format: 'compact' } })` 分页读取，而不是直接调用 `search_sources`。
4. 对重要结论，选择权威链接并直接调用 `web_extract` 获取网页正文。
5. 如果任务需要站点内发现、研究计划、精细 Context7 查询或连接检查，先调用例如 `search_tools({ capabilities: ['site_map'] })` 取得 manifest；`progressive` 模式从下一 step、`all` 模式立即通过 `search_call({ operation: 'web_map', arguments: { url: 'https://example.com' } })` 调用相应 operation。
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

Tavily 和 Firecrawl 参与普通搜索的数量由“每次搜索的补充来源数量”控制，默认值为 `0`，不会自动发起补充搜索。需要时按搜索类型显式设置非零数量；只配置了其中一个服务时，该服务获得全部数量。

### 3. 配置搜索方式

页面可以设置默认搜索类型和搜索深度：

- `compact`：结果更简短；
- `normal`：信息量适中；
- `deep`：适合需要更多来源的问题。

不确定时保持默认值即可，也可以在单次搜索中临时选择其他设置。

同一页面还可以设置“每次搜索的补充来源数量”，逐个搜索类型控制 Tavily/Firecrawl 的补充数量。

“工具披露模式”建议保持 `progressive`，让延迟 operation 按需披露并从下一模型 step 激活；`all` 只让所有延迟 operation 从一开始处于 active 状态。两种模式都保留同一组五个模型工具及相同 schema，不会显示额外的独立工具。

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

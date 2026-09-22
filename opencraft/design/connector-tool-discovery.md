# Connector Capability Runtime Charter

状态：已实现（2026-09-18）。

## 目标

连接器工具是一个可能很大的、可变的能力目录。模型按用户任务逐步发现并调用工具；任何一次发现请求都必须有界、可续读，不能因为某个连接器暴露大量 JSON Schema 而使整个目录不可用。

本章程只定义发现、加载、handle 和调用边界。连接、账号授权、会话选择、审批与实际 MCP 调用仍由既有 owner 管理。

这里的 `Connector Capability Runtime` 不是第三套连接或会话真源。它是
`AgentCapabilityRuntime` 的 Connector provider/projection slice：从既有 `ConnectorRuntime`
读取当前 Thread 的选择、授权、目录代次与执行入口，产出统一的 capability view，再由不同
Engine Adapter 投影到各自协议。产品层、Connector 层和 Composer 不得按 DSH、Codex、Hermes
等引擎名称分支。

## 参考事实与适用边界

| 实现 | 已验证做法 | 能借鉴什么 | 不能直接照搬什么 |
|---|---|---|---|
| `ref/workbuddy` | 产品特性 `DeferToolLoading` 默认开启；MCP 工具通过 `ToolSearch` 按需激活；meta tools 保留 MCP 所有者边界，物理工具使用 `mcp__server__tool` 身份 | 搜索优先、延迟加载；不把全部工具放进首轮上下文；不丢失能力所有者 | 恢复的前端/协议代码没有完整后端检索排序实现，不能假定其精确分页和权限模型 |
| `ref/codex` | DynamicToolFunctionSpec 有 `deferLoading`；存在 `tool_search_always_defer_mcp_tools`；线程启动时提供动态工具目录，延迟工具由运行时搜索 | `deferLoading` 是工具目录属性；线程能力与 UI 列表分开；运行时原生 ToolSearch 优先 | OpenCraft 的 DSH/其他 Host 不一定都实现 Codex ToolSearch，不能只设置布尔字段就宣称完成 |
| `ref/octop` | 腾讯文档 catalog 只允许 10 个工具；自定义 MCP 在 turn 前按选择加载，按 user/server/config fingerprint 缓存并注入 Agent | 仅用于解释它为何没有触发 224-tool 全量问题；本章程不借鉴该产品收敛策略 | 固定白名单会静默移除已连接服务的能力，与 OpenCraft 要求的完整可发现目录冲突；不得进入目标设计 |
| OpenCraft 当前 | 会话先选择连接，再 `discover()` 所有工具，为每个完整 schema 生成 handle，一次 JSON 返回；总文本超过 262144 字符则整批失败 | 已有 scope、授权、approval、stale-handle 和 provider 生命周期可保留 | 全量 list 不是可扩展发现协议；MCP 的 cursor 只用于 Host 拉取，到了模型边界已经被彻底展开 |

用户现场报告腾讯文档 MCP 暴露 224 个工具。当前 `ConnectorMcp.inventory` 允许最多 256 个，因此该目录会被完整接受；随后完整 `description + inputSchema + connectorId + handle` 一次性序列化，超过 256 KiB 后只返回通用错误，模型无法续读。这是协议建模问题，不是连接器未连接或某个工具执行失败。

## 运行时分层与不变量

```text
ConnectorRuntime                         # 连接、授权事实、Thread 选择、实际调用 owner
  -> Connector Capability Provider       # inventory -> Capability Spec/Offering
  -> CapabilityCatalog / DisclosureBroker
       -> scoped view + digest + search/detail/handle
       -> Engine Capability Adapter
            Codex/AppServer: thread/start.dynamicTools + deferLoading
            DSH:             原生 scope/pre-step 投影
            other engine:    其声明并验证过的原生投影
  -> CapabilityExecutionRouter
       -> ConnectorRuntime.call(...)      # 重新校验授权、选择、代次与审批
```

必须保持以下不变量：

1. **一个能力模型**：搜索、分页、detail、handle、失效和执行语义只在 Capability Runtime 定义一次；Engine Adapter 不另建目录语义。
2. **一个连接真源**：Connector Capability Provider 不保存账号、token、选择或物理 MCP 连接；它只消费 `ConnectorRuntime` 的权威快照和执行 port。
3. **引擎中立**：Workbench/Composer/Connector 代码不判断引擎名字。adapter 通过显式 capability negotiation 声明能否原生 deferred search、在哪个安全边界刷新。
4. **投影不等于授权**：模型看见 capability 不能替代调用时的授权、选择、连接 generation 和审批复核。
5. **协议字段不伪造**：AppServer 只在标准 `thread/start.dynamicTools` 投影动态工具；`thread/resume` 当前没有该字段，不得把私有刷新伪装成标准 resume 语义。
6. **视图可复现**：每次模型请求使用确定的 scoped capability view/digest；目录变化在 adapter 声明的下一安全边界生效，不在一次执行中途静默换 schema。

`runtime/capabilities/register` 是 OpenCraft 当前 Host 扩展，不是 AppServer 标准字段。它可以作为
协商后的 adapter 机制存在，但不能成为 Connector 产品契约，也不能让其他引擎被迫实现同名
RPC。长期公共边界是 capability view 与 refresh contract，而不是这条 RPC 的名字。

## 对象与所有权

| 对象 | Owner | 生命周期 |
|---|---|---|
| Connector selection | Conversation/Thread ConnectorRuntime | Thread scope；用户显式选择，关闭 Thread 释放 |
| Native inventory | Connector provider / MCP Host | Connection revision；可分页拉取和缓存，失效通知重建 |
| Search index | AgentCapabilityRuntime / Connector provider | 由已选择且可用连接的 compact metadata 派生，不是第二配置真源 |
| Tool summary | Search result | `{connectorId, toolId/name, title/description, readOnly}`；不默认携带完整 schema |
| Tool detail | Exact tool descriptor | 按精确 identity/revision 读取完整 input schema；单项也有尺寸上限 |
| Invocation handle | CapabilityExecutionRouter + ConnectorRuntime | Thread + connection + inventory revision + tool identity；短期、不可持久化，失效后重新搜索 |
| Approval | Existing approval port | 非只读调用的一次性用户决策；搜索结果不能绕过 |

## 统一语义

### 1. Capability view 统一，Engine 投影不同

Capability Runtime 始终提供同一套有界 catalog/search/detail/handle 语义。Engine Adapter 再根据
显式协商结果选择投影，不能在 Connector 工具或 UI 中形成“Codex 原生、DSH 兜底”两条产品路径。

- AppServer 明确支持 deferred dynamic tools 时，在新 Thread 的标准
  `thread/start.dynamicTools` 中投影 `deferLoading: true`，由 AppServer 的 ToolSearch 激活精确 schema。
- 其他 Engine 若有原生能力目录/搜索机制，由 adapter 投影同一个 capability view，并证明搜索、
  失效、执行和历史语义等价。
- Engine 没有原生 ToolSearch 时，adapter 可把 Capability Runtime 的通用搜索/detail operation
  暴露为少量稳定 meta tools；这是协议投影差异，不是该 Engine 专属的 Connector 实现。

通用两阶段 disclosure operation 为：

1. `connectors.search_tools`：按关键词、可选 connector filter 和 cursor 搜索 compact summaries；返回固定上限的匹配项和 `nextCursor`。
2. `connectors.get_tool` 或搜索结果的显式 detail 请求：只为少量精确候选返回完整 schema 和临时 handle。
3. `connectors.call_tool`：使用 exact handle 调用；stale handle 明确要求重新搜索。

`connectors` namespace 是 Capability Runtime 在 AppServer/DSH 投影中的稳定 owner。不提供 null namespace 的全局别名，也不保留 list 兼容入口；空 query 的 `search_tools` 已等价提供有界 browse page。
AppServer 原生传递 namespace；DSH 的模型工具名不支持点分 identity，因此 adapter 确定性投影为 `connectors__search_tools` / `connectors__get_tool` / `connectors__call_tool`。双下划线是 engine 编码，内部权威身份仍是 `connectors.*`。

### 2. 搜索与分页

- 搜索单位是当前 Thread 已选择、已授权、实际可用的连接器工具。
- query 匹配稳定 tool name、connector display name、工具标题/description；服务端确定性排序，cursor 绑定 scope、selection generation、inventory digest、query/filter 和方向。
- 默认 limit 8，最大 20；响应字节预算 64 KiB。达到数量或字节预算即停止，并提供 `nextCursor`；不能先构建无限数组再截断序列化文本。
- 空 query 返回 compact browse page，而非全部 schema。模型说“腾讯文档工具”时用 connector filter；说“创建文档”时用 query 搜索。
- cursor 不透明、带版本并校验 Thread/目录代次；跨 scope、selection 或 inventory 变化返回 stale cursor，不静默混页。

### 3. Schema 与 handle

- 搜索页默认不复制完整 input schema。精确详情一次最多返回少量工具（建议 1–4）。
- 单个 schema 必须独立校验深度、节点数和编码字节；单项超限返回 `tool-schema-too-large`，不能拖垮其他结果。
- handle 只在完整 detail 成功后签发；搜索 compact summary 不为数百个未使用工具制造 handle。
- handle 绑定 connector connection identity/revision、tool inventory digest、Thread scope 和工具名。授权、选择、schema 或连接变化后失效。
- inventory digest 使用稳定工具名排序与 canonical JSON；MCP Server 的返回顺序或 schema object key 顺序变化不构成 catalog 变化，重复工具名则失败关闭。
- 工具输出大小限制与工具目录大小限制分开；调用输出超限应使用资源引用/分页或明确的 `tool-output-too-large`，不能复用目录错误。

### 4. 能力完整性

- 已选择且已授权连接器暴露的全部合法工具都必须可通过搜索/分页到达；不能为规避响应上限静默裁剪为产品白名单。
- 目录过滤只来自用户显式连接器选择、服务端实际授权/可用性以及既有写工具审批策略。产品不得硬编码腾讯文档等特定连接器的允许工具集合。
- 推荐、排序和关键词召回可以优先展示常用工具，但不能改变能力全集；低排名工具仍可通过精确名称和分页发现。
- Provider 自身明确返回的权限范围属于上游事实，不等于 OpenCraft 产品白名单。搜索和调用边界都必须复核同一权限事实。

## 错误语义

错误必须结构化、可恢复，并归属于发现步骤：

| code | 含义 | 模型下一步 |
|---|---|---|
| `stale-cursor` | 选择或目录已变化 | 从第一页重新搜索 |
| `stale-handle` | handle 对应连接/schema 已变化 | 重新搜索并取 detail |
| `tool-schema-too-large` | 单个工具 schema 不可安全传输 | 换工具或提示该工具暂不可用 |
| `discovery-budget-exhausted` | 本页到达数量/字节预算 | 使用 nextCursor 继续；不是失败 |
| `authorization-required` / `approval-denied` | 既有权限语义 | 请求用户完成对应动作 |
| `connector-unavailable` | provider/connection 不可用 | 报告连接问题，不伪装成“列表太长” |

不得把 `Connector output exceeded the supported response limit` 作为正常目录控制流；不能建议 Agent 绕过产品协议读取本机数据库、凭据或私有接口。

## 数据流

```text
Thread selection
  → provider inventory pages / invalidation
  → compact scoped search index
  → search(query, filter, cursor, limit, byteBudget)
  → small result page + nextCursor
  → exact detail (schema validation + handle issue)
  → call(handle, arguments)
  → approval / provider execution / bounded output
```

## 已实施迁移

1. `ConnectorRuntime.inspectCapabilities/openCapability` 构成 Connector provider seam；连接、授权、选择、审批和调用仍由原 Runtime 唯一持有。
2. `ConnectorCapabilityRuntime` 实现 compact view、确定性排序、cursor、toolRef、search/detail 预算和 scope/revision fence。
3. AppServer Adapter 只暴露 `connectors` namespace 下的 search/detail/call meta tools，并在标准 `thread/start.dynamicTools` 中声明 `deferLoading`；DSH adapter 投影同一 capability identity，不进入产品分支。
4. 空 query 的 `connectors.search_tools` 提供有界 browse page；生产模型路径不再调用旧的全量 `discover()` 或在完整 JSON 生成后才检查 256 KiB。
5. MCP inventory 仍由 Host 完整持有，模型只看到 compact page；单 schema、detail page 与实际 tool output 使用独立预算和结构化错误。

## 验收矩阵

- 224 个工具、每项大 schema：首个搜索页小于预算、有 nextCursor，精确工具可取 schema/call；不会整批失败。
- query/connector filter/empty browse、0/1/20/256 工具、重复名称、多连接器同名工具、排序稳定。
- schema 单项超限、总页预算边界、多字节字符、循环/异常 schema、恶意 description。
- selection/auth/inventory 在搜索与 detail/call 之间变化：cursor/handle 失效且不误调。
- readOnly 与写工具审批、取消、disconnect/thread close、并发搜索/调用、provider invalidation。
- 原生 ToolSearch Host 与通用 fallback 的可见语义一致；不声明 capability 的 Host 不走原生路径。
- 腾讯文档 224 个合法工具的全集可通过精确名称/分页遍历到达；排序优化不得导致永久不可发现。
- 对真实腾讯文档目录只做只读 inventory/search 验证；不读取凭据、不调用写工具、不绕过官方协议。

## 非目标

- 不采用 Octop 的腾讯文档 10 项白名单，也不引入其他固定产品白名单。
- 不把 connector catalog UI 的筛选器当模型工具发现协议。
- 不保证无限工具目录一次性可见；保证可搜索、可分页、可恢复。
- 不通过提高 256 KiB 上限或压缩整包 JSON 解决建模错误。

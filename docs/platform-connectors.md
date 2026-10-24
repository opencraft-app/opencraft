# 平台级 Connector：连接、授权与执行

状态：已实现第一方 SPI、应用级运行时、Host 原生 MCP OAuth 适配、Composer 入口、逐次写审批及配置持久化。使用隔离 Host/授权服务验收，未连接真实第三方账号。

## 设计结论

### 第三阶段用户确认与当前实现

连接器目录提供 23 个服务的接入引导，视觉仅使用 OpenCraft token 与现有控件。Skills 页面新增连接器 Tab，与技能/技能包同层；Composer 保留会话选择，目录浏览不要求登录。

新增 `connector-core`（引擎中立目录/contract）→ `connector-host`（Node Host 的 SQLite、OAuth、MCP/API 执行）→ Workbench controller/provider → Skills/Composer。原生 MCP adapter 保持独立兼容；执行与凭据由 Host 持有，不把凭据塞入 Skill。

用户指定“只存数据库”：本机执行 Host 的私有 SQLite 分表保存连接实例、凭据和授权事务，不引入 Keychain/凭据 JSON 文件，不宣称数据库内容已加密。原有 Renderer/Main 配置 store 仍只保存非敏感的选择引用；它不是新凭据真源。多个同类账号使用独立实例 ID。

OAuth 由 Host 使用 MCP SDK 的 DCR/PKCE 流程执行；临时 verifier/client 信息也在 Host 数据库。回调仅一次消费，完成后清除临时敏感数据并保存凭据；前端只拿授权 URL/operation 状态，不领取 token。进程重启取消无监听器的未完成事务，过期事务清理，refresh 在 Host 内合并执行；UI 不自动恢复会话执行权限。本机回调监听仅用于同机浏览器；其他部署需另有明确 callback transport，不能把远端 loopback 当成本机。

接入说明、格式通过、授权有效、工具发现成功是不同状态。HTTP API 初始检测不发起可能计费/读取用户内容的查询；明确报告 format-only。未知/写工具仍走既有逐次审批，删除只移除 Host 配置/凭据，不冒充已撤销第三方授权。网络凭据不跨 origin 重定向，Host 固定 DNS 解析并屏蔽元数据地址；用户显式填写的自托管地址允许访问目标 Host 的局域网。

第三阶段已实现目录/引导、数据库凭据、Host RPC 和 Skills 入口。目录含 23 项服务；当前 19 项接通 adapter：10 项远端 MCP（腾讯文档/会议/微云/乐享、有道、滴滴、Dify、Notion、Ardot、滴答）和 9 项 HTTP API（IMA、新闻、读书、音乐、百度地图、美团旅游、携程问道、元典、WeKnora）。这是实现范围，不等于真实账号逐项验收。

暂仅展示接入说明、不允许保存成可用连接：个人邮箱、飞猪、飞书 CLI、企微 CLI。CLI 接入尚需解决凭据只存 Host 数据库的约束；邮箱协议和飞猪签名适配尚未实现。不得把目录覆盖数称作全部服务可用。

源码拓扑：

- `packages/connector-core/src/{contract,catalog}.ts`：稳定 DTO、23 项目录和字段/步骤；第三方许可见 [NOTICE](../packages/connector-core/NOTICE.md)。
- `packages/connector-host/src/store.ts`：Host SQLite，实例/凭据/授权事务分表，revision CAS、敏感字段白名单、删除和过期清理。
- `packages/connector-host/src/{oauth,mcp,api,api-knowledge,network,service}.ts`：SDK 协议、各服务请求映射、网络边界和窄 RPC 分发，独立于 DSH。
- `packages/workbench-runtime/src/connectors/{managed-controller,managed-provider}.ts`：无凭据的 UI 状态与既有 ConnectorRuntime 对接，通知按实例失效。
- `apps/workbench-web/src/components/connectors/{connector-library,connector-setup}.tsx`：目录和配置流程；借用共享控件和 Modal。
- Skills 的 Hermes 插件包装层只接平台 `ConnectorLibrary(hostId)` slot，不依赖执行实现、不改生成的官网页面。Header portal 保留统一 tab，隐藏技能正文时不丢技能页状态。

协议以 `connectors/managed/` 为前缀：list/save/delete/setEnabled/probe/tools/call，以及 oauth/start/status/cancel；变更通知只携带实例 ID。list/save 不返回凭据，call 绑定实例 revision 和工具目录摘要；OAuth 刷新复用同一实例权限，重新登录提升 revision。工具调用前重新比较目录，不能让旧审批接管新 schema。

新增界面验收分别使用真实 React/Radix+WebSocket+SQLite 与当前源码 Electron；外部 API 响应用隔离替身，OAuth 用真实 loopback 协议服务，不使用真实账号。最后证据见实施账本；下文第二阶段证据仍独立保留。

第三阶段验证：24 项 Connector 专项、真实 MCP SDK HTTP 链路、OAuth DCR/code/refresh/cancel、SQLite 重开与 CAS、真实 DSH 13 秒延迟批准、`smoke:connector-library`、`smoke:connector-desktop` 及完整 OpenCraft gate 通过。页面复用 Settings/Modal 原语；窄屏无图标列表和弹窗检测结果滚动亦有实际截图与几何断言。未覆盖正式发行包、远端 OAuth callback 转发或真实第三方账号。

### 呈现整改：目录不是设置列表

后续用户否定第三阶段的全宽列表与通用文案。现将它替换为限宽品牌卡片目录，保留全部服务/已配置两个浏览视图、同一工具栏内的分类和搜索；单张卡片集中呈现服务身份、用途及真实配置状态。服务通过名称和已许可的分类图标识别；当前目录不包含服务品牌图片。

详情使用共享 Modal 的 `inspector` 呈现：Web/Electron 靠边面板、窄屏铺满；Native 投影为现有 sheet。平台拥有位置、层级和 Radix 焦点，业务只提供内容。详情由品牌/用途、服务专属接入准备、连接信息、内联检测结果组成；正文独立滚动，底部只保留当前有效操作。格式检测和真实认证仍明确区分，工具清单按需展开。

清理不是保留两套布局：删除目录的 SettingsListItem 渲染、旧全宽列表 CSS、统一拼接给每项服务的两段说明，以及 Composer 中仅测试曾使用的发现/配置分支。原生 MCP 发现只有独立 `ConnectorNativeServices` 一个实现，生产页面与验收共同消费。存储、协议、审批和会话权限规则不改变。

文案必须与实际动作对应：当前 HTTP API adapter 的纯格式检查称“检查配置”，MCP 的远端连通/工具发现称“测试连接”；结果不把格式通过当作认证通过。凭据重填提示由实际变化的非敏感字段生成（例如 IMA 的 Client ID），不向所有服务套用“服务地址”。

错误反馈只识别白名单中的平台错误与具体操作阶段，不回显异常文本、URL 或凭据；未知写入结果提示核对，不声称保存/删除已失败。嵌套授权流程先保存时，错误仍归保存阶段；提供“查看已配置”读取权威列表，避免重复创建。授权轮询暂时失败时继续检查，恢复即清除旧警告；“取消等待”不宣称撤销第三方权限。用户文案统一称设备，保留 API Key、Client ID、MCP 等必要字段/协议名称。

沿用 [存量会话能力设计](session-capability-refresh.md) 的对象与所有权，但首轮不实现整套 Capability Fabric。Connector 是外部集成，贡献可以是工具或 Skill；账号会话、文件安装、原生 MCP 连接各保留已有 owner。

本轮收敛三项实现选择：

1. 先复用 ExtensionSupervisor 内部 `connectorProvider` 通道，不冻结新的公开插件 manifest。
2. 模型使用 `connectors` Capability Namespace 下的 `search_tools` / `get_tool` / `call_tool` 渐进披露。统一 capability view 由 Engine Adapter 投影，不要求各引擎支持热换工具 schema。
3. 登录、连接、会话选择、写操作批准是四个不同意图。明确声明只读的工具可直接执行；写操作与未知副作用进入一次性确认，没有审批 port 的客户端不发现这些工具。

`readOnly`/MCP `readOnlyHint` 是声明和保守筛选条件，不是沙箱或服务端权限保证。第一方 Provider 必须兑现声明并验证业务参数，Host/MCP 服务仍负责真实访问控制；不能把不可信服务的自报属性当成权限隔离。

## 责任与拓扑

| 对象 | 唯一职责 |
|---|---|
| ExtensionSupervisor | Provider 的原子激活、回滚与卸载 |
| AuthenticationService / Provider | 当前账号状态、epoch、登录和凭据；Connector 不保存 token |
| ConnectorRuntime | 逻辑连接意图、贡献准备结果、显式会话选择、实际调用和撤销 |
| ConnectorCapabilityRuntime | scoped capability view、确定性搜索、cursor、按需 schema 与短期 handle；不持有连接或凭据 |
| ConnectorManager | 保存的配置和选择意图、原生 Provider 注册、用户连接操作及 Conversation Scope owner 取消 |
| ConnectorApprovalQueue | 一次调用的一次决定；不是账号权限或永久授权 |
| ConnectorConfigurationStore | 严格白名单配置、CAS revision；不是 UI preference 或凭据仓库 |
| 具体贡献 Provider | 原生工具客户端、参数验证、安装事务、服务端访问复核 |
| Workbench AppServer handler | 从真实 Host/Thread 获取调用身份、返回结果与取消 |
| Engine | 自己的会话历史与模型执行，不进入 Connector 公共类型 |

```text
first-party extension
  → connectorProvider transaction
  → ConnectorRuntime（应用生命周期，不是页面 Store）
      ├─ AuthenticationService：借用 session epoch
      ├─ Provider：分别准备 tools / skills
      └─ 显式 Thread 选择 → capability view → search/detail → 调用时复核
  → AppServer item/tool/call → Engine 原生执行与历史
```

物理 MCP 连接仍归 Host。Web/Electron 的应用 Supervisor 装配 ConnectorRuntime、注册适配器和模型 handler，hostless 状态也可以维护声明；页面卸载不销毁共享账号或 Host。Expo 尚未装配这个入口，不宣称全部客户端均已接通。

Composer 采用渐进披露，不把完整管理页缩进一个 Modal：未确认连接器时，Add 菜单提供 Connector 子菜单；确认后显示最多三个品牌图标的状态 Chip；两者复用同一紧凑 Radix 列表完成连接、授权跳转、显式会话选择、取消和原位错误反馈。完整安装、凭据、删除仍进入管理页，一次写审批仍进入确认层。连接操作 owner 绑定 `(hostId, scopeId)`，关闭 Popover 不得取消；只有用户显式取消、Scope 退出或运行时撤销才终止。

实现文件：

- [contract](../packages/workbench-runtime/src/connectors/contract.ts)：目标、贡献、状态和窄 SPI。
- [runtime](../packages/workbench-runtime/src/connectors/runtime.ts)：连接、选择与调用生命周期。
- [capability runtime](../packages/workbench-runtime/src/connectors/capability-runtime.ts)：引擎中立的 scoped view、搜索/分页、按需 schema、toolRef/handle 失效与预算。
- [lifetime](../packages/workbench-runtime/src/connectors/lifetime.ts)：取消和边界输入。
- [AppServer MCP adapter](../packages/workbench-runtime/src/connectors/appserver-mcp-provider.ts)：借用 Host 原生 MCP RPC。
- [模型工具 adapter](../packages/workbench-runtime/src/connectors/dynamic-tools.ts)：固定发现/调用入口。
- [扩展注册 adapter](../apps/workbench-web/src/runtime/connector-contributions.ts)：第一方命名空间与事务接入。
- [manager](../packages/workbench-runtime/src/connectors/manager.ts)、[OAuth](../packages/workbench-runtime/src/connectors/oauth.ts)、[审批](../packages/workbench-runtime/src/connectors/approvals.ts)、[配置 contract](../packages/workbench-runtime/src/connectors/configuration.ts)：各自独立领域模块，不把协议、存储或 React 塞进 runtime。
- [用户入口](../apps/workbench-web/src/components/connectors/connector-panel.tsx) 与 [快速选择](../apps/workbench-web/src/components/connectors/connector-quick-picker.tsx)：只消费领域快照/action；Add menu、Popover、焦点与确认由共享 Radix/Modal 持有。
- [Web store](../apps/workbench-web/src/runtime/connector-configuration-store.ts)、[Desktop store](../apps/workbench-electron/src/connector-configuration-store.ts)：IndexedDB 与 Main SQLite 的平台投影。

## 连接、授权与通知

`connect(connectorId, hostId, operationId)` 是显式产品操作，不向模型暴露。发现工具不会自动安装、登录或连接。

- Provider 需要账号而账号未认证：返回 `authorization-required`，不执行任何贡献准备。产品 Manager 借用已有 AuthenticationService 注册 Host 原生 OAuth Provider；用户完成授权后仍须明确连接和选择，不在 callback 中授予会话访问。
- 已认证：冻结该授权 provider 的 epoch，开始准备。工具与 Skill 分别返回结果；一项失败可保留其他已准备能力，快照为 `partial`。
- 相同 operationId 是同一次意图的重试，不复活已取消操作；新意图需要新 ID。新 connect 会使旧连接代次失效。
- 状态通过 `subscribe/getSnapshot` 发布；快照在变化前保持引用稳定，不由 UI 写入。通知不携带凭据和未过滤的底层异常。
- 账号 epoch 改变、注销或 Provider 消失立即撤销原连接，不把新账号隐式绑定到旧选择。
- 原生 MCP 启动/登录状态事件或 Host generation 改变使旧连接进入 `refresh-required`；再次发现/调用也复核实际状态，不能仅靠事件。

连接准备、发现和执行有期限与 AbortSignal。取消后迟到的准备结果不会发布，产生的资源会被交还 Provider 释放。断开首先撤销逻辑访问；底层资源清理由 Provider 的 `dispose` 承担，必须有界，不能用断开状态声称外部副作用已经回滚。

### Host 原生 OAuth 的真实边界

普通用户从 Composer 的 Add 菜单进入“连接器”紧凑子菜单，发现当前 Host 已配置的 MCP 服务并保存连接；已选服务通过 Composer 状态 Chip 重新打开 Popover。这里不创建远端 MCP 配置、不安装服务器、不要求下游产品登录。发现失败在当前控件反馈，不阻塞聊天；没有原生方法的 Host 明确失败。

```text
发现并保存 → 连接 / 授权 → 用户打开授权页
  → Host 原生 completion → reload + 重读状态 → 确认连接
  → 用户勾选“用于当前会话” → 模型可发现工具
```

- 请求为 `mcpServer/oauth/login`，完成事件为 `mcpServer/oauthLogin/completed`，之后使用 `config/mcpServer/reload` 与 `mcpServerStatus/list`。订阅先于请求，覆盖完成先于响应。
- PKCE、state、callback listener、code/token 的交换与持久化全部由原生 Host 负责。Workbench 不实现第二套 OAuth 服务、不接收 token；authorization URL 只留在当前等待操作的内存中，不进入模型上下文、存储或日志。
- 只允许 HTTPS 或 HTTP loopback 授权页，禁止带用户名/密码的 URL。真实浏览器页面由用户点击打开；Electron 沿用已有外部浏览器跳转策略。
- 原生完成事件没有 Workbench operationId，仅按 server（及适用的 Thread）标识，不能声称精确关联账号或登录尝试。它只是重新查询 Host 的依据，不是自动连接/授权凭证。确认连接、勾选会话是后续新用户意图。
- 单个 server/Host 同时最多一个 OAuth flight。关闭窗口、换 Host/会话、取消会使 View 意图失效，但不声称取消了 Host 内部 OAuth。旧 flight 在原生完成或连接代次变化前隔离，不让新点击消费旧完成；重复完成只处理一次。超时保守提示重连 Host/等待原操作结束，不重试未知提交结果。
- 默认请求 Host 60 秒期限，桥接等待 65 秒。失败信息不透传原始 URL/异常。账号 epoch、Host generation 或原生 MCP 状态变化撤销已用连接，用户需重连并重新勾选。
- `oAuth`/`bearerToken` 与 `unsupported`+可用工具是 Host 的凭据/可用性报告，不是 Workbench 得到了真实第三方 accountId。当前不能宣称识别静默更换且原生 Host 不通知的同类账号；服务端权限与每次目录复核仍必需。

## 会话选择与执行

首轮采用默认空集合、显式选择，不自动继承全部已连接服务：

```ts
const connection = await connectors.connect(connectorId, hostId, operationId);
// 先处理 authorization-required / failed；partial 仅使用已准备贡献。
connectors.select({ hostId, threadId }, [connection.connectionId]);
```

这是产品/第一方扩展的调用入口，不是模型工具。Composer 面板消费 Manager，默认不启用任何服务；第一方扩展也可以直接使用窄运行时 SPI。

- `connectors.search_tools` 只搜索当前 Host/Thread 显式选择的就绪工具，返回有界 compact summaries、`toolRef` 与 `nextCursor`，不返回 schema 或 handle；不返回未选择账号的能力。
- `connectors.get_tool` 一次只加载 1–4 个精确 `toolRef` 的 schema，并在尺寸/深度/节点预算通过后签发短期 handle。空 query 的 `search_tools` 就是有界 browse page，不存在全量 list 别名。
- handle 绑定连接对象、原生实现、授权 epoch 和 Host/Thread。重新连接、取消选择、卸载、撤销或 `thread/closed` 均使旧 handle 失效；同名新实现不能接管旧调用。
- 每次调用再次验证当前授权、会话选择以及 Provider 的服务端访问条件。开始后撤销会中断等待并丢弃迟到结果，不能保证不配合取消的远端已经停止运行。
- `serverRequest/resolved` 与 handler disposal 传播调用取消。Provider 异常仅返回安全的稳定错误，避免泄漏 callback URL/token。
- Tool schema 是准备时的副本；调用和处置函数绑定原对象，修改注册对象不能替换正在使用的实现。
- 运行时限制：最多 128 个连接键、4096 个会话选择和4096 个活跃发现 handle、单贡献256 个工具；输入/模型输出有大小边界。被淘汰的 handle 明确失效，重新发现即可。

发现入口本身不等于主动给模型推送新目录。`connectors` namespace 在 AppServer 标准 `thread/start.dynamicTools` 中拥有三个 `deferLoading` meta tools；DSH 等其他 Engine Adapter 消费同一 capability identity/contract。模型调用发现时读取当前选择；不会在每个模型步骤注入所有 Connector schema，不承诺自动替换历史中已加载的 Skill 正文。`thread/resume` 当前没有 `dynamicTools`，OpenCraft 私有注册 RPC 不能冒充 AppServer 标准恢复字段。
DSH 模型工具层将这三个身份投影为 `connectors__search_tools` / `connectors__get_tool` / `connectors__call_tool`，但 Host broker、租约和调用路由始终使用权威的 `connectors.*` identity。

### 逐次写审批

`readOnlyHint !== true` 的原生工具按有副作用处理。运行时先冻结 JSON 参数，再检查访问条件，产生绑定 Host、Thread、连接对象、工具与原参数的一次审批。UI 展示服务名、工具、目标会话及脱敏参数；密钥类字段不展示，超长/深层内容有界。凭据不应作为模型参数传入，这个预览规则不是任意秘密的自动识别保证。

共享 AlertDialog 默认聚焦“拒绝”，用户可拒绝/Escape 或“仅允许这一次”。批准后仍核验连接、选择、epoch、取消信号和原生 schema/权限，随后调用冻结参数。批准不缓存、不持久化；撤销、断线、卸载、取消请求或关闭应用使等待失效。已经发往不支持取消的远端写操作不能保证回滚，未知结果不能自动重试。

队列上限 32、审批默认 60 秒、Connector 调用总期限 120 秒。本机 Host 在能力注册时为 `connectors.call_tool` 计算 150 秒期限，经内部 contract 传给 broker 和引擎插件，原生 tool envelope 再留 2 秒返回余量；其余动态工具仍为 10 秒。期限不取自模型参数。其他引擎若提前取消，审批会随取消信号关闭，不伪装成已完成写入。这是 Connector 执行面的审批，不取代引擎独立原生工具或远端权限系统。

### 保存意图，而不是保存授权

配置仅包含 schema version、Connector ID、Host ID、原生 server、标题，以及 `(Host, ConversationScope)` 对应的期望 Connector IDs。复用 ConversationBindingStore 的持久 scope→Thread 别名，草稿晋升后同一选择自然绑定真实 Thread，不再另建一份会话身份。

- Web：产品命名空间内独立 IndexedDB；Electron：隔离 profile 内 `opencraft-connectors.sqlite`，仅 Main 持有数据库，Preload 暴露 load/CAS/changed 窄接口。它是执行配置，不进入 UI Preferences。
- 保存使用单事务 compare-and-set；跨窗口变化刷新，冲突返回最新版本但不覆盖新数据。输入只接受白名单 DTO，拒绝额外字段、重复 ID 和跨 Host 引用。损坏或不可用时只关闭该功能写入并提供重试，不清空原数据，不阻塞 Chat 启动。
- 不保存 token、授权 URL、连接 ID、handle 或审批决定。重新打开应用只加载配置，不联系 Host、不弹登录、不自动重建授权。
- 已记住的选择显示“待确认”：用户连接当前 Host 后再次勾选本会话才获得访问。连接/授权失效也撤销内存确认；保存过程中连接被替换，晚到保存不能复活旧权限。取消选择先立即撤销访问，再保存意图。
- 普通面板关闭只取消该 View 尚未完成的连接/授权意图，不断开已经连接的服务或清除已明确启用的会话。会话关闭、账号撤销或显式断开走领域撤销路径。

## AppServer MCP 接入

`createAppServerMcpConnectorProvider` 消费现有 `mcpServerStatus/list` 与 `mcpServer/tool/call`。适配器不写远端配置、不创建另一条 MCP transport、不接管 OAuth token，也不关闭借用的 AppServerClient。

第一方注册者必须明确指定共享的 `authenticationProviderId`，或者明确声明该服务 `public: true`；不能从 MCP 的 `unsupported` OAuth 状态猜测服务无需账号。私有服务的账号切换必须通过对应授权 Provider 的 epoch 表达，不能用下游产品登录状态冒充另一个第三方账号的授权。

准备时确认精确 Host、connectionGeneration、server 名称和目录，投影所有工具并将未知副作用视为写操作，由运行时审批 policy 决定可发现/调用范围。发现/调用前按实际 Thread 重读状态；授权不明、未登录、schema 改变或连接代次变化均拒绝。缺少方法的 Host 准备失败，不靠占位响应冒充支持。

当前采用保守的同 schema 校验：Thread 目录与准备时不同则要求重新准备，不自动接受扩大后的工具集合。Provider 返回顺序和 JSON object key 顺序不是 schema 语义；Host 在 authority 边界按稳定工具名排序并对 schema 做 canonical JSON 后计算 digest，重复工具名失败关闭。只有工具集合、description、readOnly 或 schema 的语义变化才能触发 conflict，不能把同一 224 项目录的顺序抖动误判为变更。此适配器可复用于提供这些原生方法的 Host；它没有给 DSH 或 Hermes 凭空增加 MCP 方法。DSH 只作为通用动态工具执行通道的真实验证对象。

## Skill 贡献边界

Skill contribution 目前接收已有安装服务提供的 `installationId + refresh` 回执，区分 `applied/pending/unsupported`，并与工具贡献分别准备。它不会启动 MCP，也不会自动将 `pending` 宣称模型可见。

这层不是新安装器：具体发行物选择、目标根/Profile、来源验证和写入仍由对应 Provider/安装服务负责。本轮没有新增内置 Skill 安装 Provider；该分支完成协议与生命周期回归，而非全部引擎的真实安装验收。连接选择约束 Connector 工具调用；不能将它描述为已限制原生引擎独立读取已安装 Skill。断开不删除用户文件，凭据禁止写入 Skill。

## 验证与剩余范围

2026-09-18 Connector Capability Runtime 已完成；验证与前序阶段一起在 [实施账本](../design/platform-connectors/progress.md) 记录。证据严格区分模型、真实组件、Desktop IPC 与第三方服务，不把构建通过当真实账号授权完成。

本阶段最终 `npm run gate`、17 项 Connector 专项、226 项 DSH 回归、隔离浏览器授权和 Electron 配置重启验收通过。仓库根 context validator/4 项治理测试仍因已有文档问题失败，记录在账本；不把 OpenCraft gate 通过表述为全仓零问题。未提交或发布。

- `npm run test:connectors`：32 项通过，覆盖授权缺失、显式选择、跨 Host/Thread 拒绝、部分成功、迟到准备、在途撤销、原生 MCP 状态/schema 变化，以及 224 个大 schema 的完整分页、精确检索、按需 detail、cursor/toolRef 失效和单 schema 预算。
- `npm run smoke:connectors`：真实 ExtensionSupervisor → ConnectorRuntime → ConnectorCapabilityRuntime → 真实 DSH/AppServer → 受控 HTTP 服务 → 真实模型请求回传；模型实际执行 search → detail → call，等待 13 秒逐次写审批，断开后原会话复用 handle 被拒绝，HTTP 调用计数不增加。模型是本地合成服务，不使用真实账号或付费推理。
- `npm run gate`：边界、全 workspace typecheck、Connector/AppServer/DSH/Chat/Workbench 测试及 Web、Expo Web、Expo iOS 构建通过。
- MCP adapter 使用真实 AppServer codec/handler 与受控 MCP 协议端点，服务调用经过真实 loopback HTTP；没有验证用户现有远端 MCP 配置或第三方 OAuth。
- `npm run smoke:connector-controls`：真实 OpenCraftComposer Add 子菜单、状态 Chip、紧凑 Popover、Runtime/Authentication/IndexedDB + WebSocket AppServer，与隔离 HTTP 授权页进行实际浏览器弹窗交互，验证明确连接/选择、关闭 Popover 不取消 Scope owner、逐次允许/拒绝/Escape、刷新恢复待确认、浅深色/窄屏/焦点。实际 presentation hook 卸载时，Application 的 Manager/Runtime 保持存活； pending OAuth 必须取消，迟到 native completion 与重新挂载都不能授予工具，新的明确连接可以复用当前 Host 认证。禁用实际 hook cleanup 必须使同一浏览器序列失败；不能以源码出现 cancelOwner 代替此证据。仅 native Host/OAuth authority 为替身。通过 `OPENCRAFT_PLAYWRIGHT_MODULE` / `OPENCRAFT_CHROMIUM_EXECUTABLE` 指定已有测试环境。
- `scripts/smoke/extensions/smoke-connector-desktop.ts`：当前源码 Electron Main/Preload IPC 保存、通知、CAS 冲突、字段白名单与真实进程重启，随后从新任务 Composer 的 Add 子菜单打开已保存但未连接的配置，并验证不支持托管连接器的 Host 不暴露凭据表单。使用独立 profile，不覆盖 `/Applications`，不代表签名发行包或真实 OAuth 已验收。
- `platform-connectors-lifecycle.test.ts`：原生 completion 去重、取消隔离、View owner 退出、草稿晋升、持久化 CAS/重开、保存期间撤销、精确参数审批与撤销。SQLite 使用真实数据库文件，不使用用户 profile。

尚未交付：真实第三方账号接入与各服务权限范围验收、远端 MCP 配置/安装器、内置 Skill 安装 Provider、Expo 装配。Host 需要实际实现原生 MCP/OAuth 方法；本轮未给 DSH/Hermes 新增这些方法。恢复的是配置和期望选择，不是旧连接或执行授权。

已取消的正文版本更新与 Hermes 自动热刷新不恢复。参考 [实施任务](../design/platform-connectors/task_plan.md)；上述剩余项要按具体产品接入逐项推进，不以“机制建立”冒充全部 Connector 已上线。

## Headless 运行所有权

共享的 `packages/connector-runtime` 复用原运行时、渐进披露、临时 handle、撤销和逐次写审批，不依赖 Workbench、引擎或 Node。Workbench 原路径保留兼容导出。

Headless 装配 `HeadlessConnectors`，每个人类 Actor 的配置由既有 `ManagedConnectorService` 存入独立 managed SQLite；不复制另一份 OAuth、凭据或外部协议实现。`/__opencraft_connectors` 只提供管理、连接、显式会话选择、状态与审批，没有公开原始工具调用端口。所有修改要求当前人类身份与同源 JSON，模型参数不能选择 Actor、Host 或 Thread。数据库没有凭据加密承诺。

已协商的本机 Codex/Pi/DSH 使用统一 SessionCapabilities 出口，按 `(canonical serverId, threadId)` 注入 `connectors_search_tools`、`connectors_get_tool`、`connectors_call_tool`。只有明确选择的当前连接可见，工具引用和调用 handle 仍按 scope、目录摘要与连接代次隔离。每次调用以及审批后复核原授予者的当前身份和实例权限；停用、删除、变更身份或撤销登录使旧调用失效。外部效果已发出后的取消不保证撤销，不自动重试。

网页对这些托管实例只读后端状态并发送管理意图。关闭浏览器不撤销已明确授予的会话使用权；写审批仍由服务端限时等待，网页重连能看到同一个待批准项。进程重启恢复配置，不恢复会话使用授权、临时 handle 或一次性审批。原生引擎 MCP 与旧 Host 仍由原适配器运行；它们与 Headless 托管实例具有不同 owner，不会把同一托管实例注册到浏览器运行时。

本阶段不提供任意远端 MCP URL 配置、连接池、自动迁移旧机器级凭据或所有账户共享连接器。现有机器级数据库保持原 owner，不猜测其所属人类；新 Headless 配置按已验证的人类 Actor 隔离。匿名模式仍可使用原工作区，但不能创建人类名下的后端连接器授权。

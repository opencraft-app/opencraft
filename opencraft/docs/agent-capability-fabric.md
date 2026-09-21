# OpenCraft Agent 能力运行时架构

> 状态：Proposed  
> 架构修订：R3（Extension-first，Agent capability projection）  
> 适用平台：Vite Web、Electron、Expo iOS/iPadOS、Expo Web、SSH/Durable Host  
> 本文定义 Agent 可发现、可租用、可执行和可演化的能力模型。

## 1. 结论

OpenCraft 的产品中心仍然是 **Workbench + Extension Platform**。用户安装、启用、配置和卸载的
公开单位是 Extension；开发者主要编写的也是传统 Extension。Capability 只是在 Agent
需要发现、选择和调用功能时使用的语义投影，不取代 Command、View、Theme、Renderer、
Settings 和 Workspace integration。

- Plugin/Extension/Bundle 是面向用户与开发者的发行、配置和装载单位；
- Capability Spec 是人或 Agent 能理解、搜索和组合的稳定语义契约；
- Provider 是执行实现；Offering 是某个 Provider 在某个 Host 上对 Spec 的精确供给；
- Lease 是一次任务在明确范围内使用能力的权限；
- Invocation 是一次可取消、可恢复、可审计的执行；
- Receipt 是进入 Session/Replica 的权威执行事实；
- View 是 Receipt 和实时状态的呈现投影。

传统插件架构回答“怎样安装代码、在启动时注册命令、卸载时清理”。AI 原生架构还必须
回答：

1. Agent 如何在成百上千项能力中只发现当前需要的几项；
2. 如何避免把全部 Tool Schema、Skill body 和插件文档塞进每次模型请求；
3. 能力如何按 Host、Workspace、Thread、Turn、数据范围和预算获得临时授权；
4. 远端、MCP、内建、用户编写和 Agent 临时生成的实现如何使用同一个执行协议；
5. 工具改变、审批、重试、外部副作用和结果如何进入可恢复历史；
6. Agent 如何生成临时能力，又不会静默获得持久化或全局权限。

因此：

> `ExtensionSupervisor` 是公开生态的主干；`AgentCapabilityRuntime` 是它的一个消费者，
> 同时聚合 AppServer、MCP 和内建能力。Agent 面向 Capability Spec 或已冻结的调用 Handle，
> 但普通 UI 与用户操作无需经过 Capability Resolver。

生成式扩展是高级、可选能力，不是插件生态 MVP。启用时仍遵守：**优先组合已有能力，
其次生成声明式 Adapter/Workflow，最后才生成隔离代码。** “模型会写代码”不是让任意代码
成为默认扩展协议的理由。

## 2. 传统 Extension 与 Agent Capability 的分工

传统插件设计不是错误，也不是需要被替代的“前 AI 遗产”。它正确处理 manifest、配置、
权限上限、进程隔离、Contribution owner、确定性 UI 和逆序清理。它只是在 Agent 需要动态
发现和调用功能时，还缺少另一层投影：

| 传统假设 | AI 原生问题 | 修订 |
| --- | --- | --- |
| 用户先安装插件，功能才存在 | Agent 经常先遇到任务，再发现可用能力或缺口 | Catalog 可展示未安装能力；Resolver 返回 availability 与 setup intent |
| `onCommand/onView/onStartup` 决定激活 | Agent 的真实触发是当前意图、上下文与策略 | Capability search/selection + task-scoped lease 决定本次可见性 |
| 插件是最小授权单位 | 一个 Bundle 内可能同时有只读搜索和高风险写操作 | 授权落实到 Capability/Invocation，Bundle grant 只是最大上限 |
| 注册后把全部工具暴露给模型 | Schema 数量直接消耗 Token 并破坏 KV cache | 渐进披露：摘要 → 详情 → Schema → 执行 |
| Provider ID 是业务身份 | 同一能力可由 local、SSH、MCP、云服务多种实现 | Agent 请求稳定 Capability；Resolver 选择 Provider revision |
| 插件更新只是 Artifact 切换 | Tool set 的变化会改变模型行为与恢复结果 | 每次模型请求记录确定的 capability view digest |
| 插件只能由开发者预先编写 | Agent 会在任务中生成一次性工具、工作流和 UI | Draft → inspect → eval → approve → session run → promote |

Extension 负责完整产品体验和生命周期；AgentCapabilityRuntime 只负责那些被显式声明为
`agentCapabilities` 的入口。绝大多数 UI Contribution 永远不需要进入 Agent Catalog。

用户直接点击 Command、打开 View 或调整 Setting 时，沿传统 Extension API 执行；只有模型
发起调用时才经过 Resolver、Lease、Invocation 和 Receipt。两条路径可以复用同一个 Domain
Service，但不能强迫全部人工交互绕行 Agent 协议。

## 3. 参考系统给出的 AI 原生证据

### 3.1 Codex / AppServer

Codex 当前的 Plugin 已经是能力聚合包，不是单个 Renderer 模块：一个 listing 可包含
Skills、Connected Apps 和 App Templates，安装并不自动获得 App 数据权限。OpenCraft 已同步的
AppServer 协议还提供：

```text
plugin/search
plugin/skill/read
plugin/install / plugin/uninstall
PluginAuthPolicy = ON_INSTALL | ON_USE
McpServerStatus = tools + resources + resourceTemplates + authStatus
mcpServer/tool/call
```

这说明搜索、读取说明、安装、连接授权和实际调用是不同阶段。`ON_USE` 尤其证明认证可以
推迟到能力真正被选择时。

Codex Renderer 侧的 first-party bridge 只在对应 Plugin 已安装、启用且当前 Host 策略
允许时才创建；MCP App UI 则通过 sandbox origin 与 RPC 呈现。它没有把 npm 包的 React
组件直接变成 Agent 能力。

参考：

- `reference://codex/.runtime/source-tree-build-r2030-eager-immediate-compact/shared/create-plugin-bridge-manager-07301.js`；
- `reference://codex/.runtime/source-tree-build-r2030-eager-immediate-compact/service/mcp-app-sandbox-renderer-07461.js`；
- `packages/appserver-protocol/src/generated/ClientRequest.ts`；
- [ChatGPT 与 Codex Plugins](https://help.openai.com/en/articles/20001256-plugins-in-codexOpenAI)。

### 3.2 MCP

MCP 把 Tools 定义为 model-controlled 能力。Tool 集合可变化、可分页、按授权范围过滤，
并要求确定性排序以改善缓存；调用可以返回 structured content、resource link，或进入
`input_required` 多轮交互。新协议还让 list/read 结果携带 TTL/cache scope，并要求有状态
操作显式返回 handle，而不是把状态藏在 transport session。

采用这些思想，但不把 MCP 当成 OpenCraft 唯一内部协议：

- [MCP Tools](https://modelcontextprotocol.io/specification/draft/server/tools)；
- [MCP 2026-07-28 变更](https://blog.modelcontextprotocol.io/posts/2026-07-28/)。

### 3.3 DeepSeek Harness / Cordis

本地 Harness 已证明三项关键机制：

1. **Capability seam**：Service Definition、Provider、Consumer 分开；工具只是一个
   model-facing Consumer，不等于底层实现；
2. **Agent scope**：`agent.ctx` 让 Tool、Prompt、变量和事件同时获得 per-agent visibility
   与 lifetime；
3. **生成式临时扩展**：模型可以先 inspect 真实 API，再 define 不可变 Package、run、
   update、stop、undefine；定义 session-scoped/process-local，浏览器 half 需要用户批准，
   Tool set 变化会进入请求历史。

参考：

- `/root/decode-codex/deepseek-harness/docs/architecture.md`；
- `/root/decode-codex/deepseek-harness/packages/core/scope/README.md`；
- `/root/decode-codex/deepseek-harness/packages/extensions/tool-cordis/README.md`；
- `/root/decode-codex/deepseek-harness/packages/extensions/cordis-host-runner/README.md`。

OpenCraft 应采用这些语义，但不能把 `node:vm` 或 scoped Context 宣传成安全边界。若系统允许
Agent 自动定义并立即执行 Draft code，它进入真正隔离的 Capability Host；若 Agent 生成的
是一个经过用户审阅、构建并明确安装的 Trusted Extension，则遵守 Extension Platform 的
Trusted policy，不强制细粒度沙箱。

## 4. 核心身份

```ts
export type CapabilityId = string & { readonly __brand: "CapabilityId" };
export type CapabilityRevision = string & { readonly __brand: "CapabilityRevision" };
export type CapabilityIssuerId = string & { readonly __brand: "CapabilityIssuerId" };
export type ProviderId = string & { readonly __brand: "ProviderId" };
export type ProviderRevision = string & { readonly __brand: "ProviderRevision" };
export type CapabilityOfferingId = string & { readonly __brand: "CapabilityOfferingId" };
export type CapabilityLeaseId = string & { readonly __brand: "CapabilityLeaseId" };
export type CapabilityInvocationId = string & { readonly __brand: "CapabilityInvocationId" };
```

身份不变量：

- `CapabilityId` 描述稳定业务能力，例如 `github.issue.create`，其命名空间必须有明确 issuer；
- `ProviderId` 描述一个实现来源，例如 `mcp:github-enterprise`；
- `CapabilityOfferingId` 描述“这个 Provider revision 在这个 Host 上提供这个 Spec revision”；
- Capability Spec 可以升级，但每次调用钉住 exact `CapabilityRevision`；
- Provider 可以重连或替换，每次调用钉住 exact `ProviderRevision`；
- Bundle/Extension ID 不进入业务命令参数；它只用于来源、安装和诊断；
- 远端能力身份至少包含 `hostId`，不能在多 Host 聚合时抹掉来源；
- Invocation ID 同时是 idempotency、取消、审批、日志和 UI 关联键。

Capability ID 不能采用“谁先注册谁占坑”。只有 Core、已验证域所有者或明确的组织管理员能
发行 canonical namespace。普通 MCP Server、Workspace Extension 和 Agent Draft 默认使用
自己的来源命名空间，例如 `mcp.github-enterprise.issue.create`、
`workspace.acme.deploy.preview`、`draft.<thread-id>.csv.profile`。它们只有经过 compatibility
adapter/eval 验证，才能声明自己是某 canonical Spec 的 Offering。

## 5. Capability Spec 与 Offering

R1 把 Provider 放进 Capability Descriptor，仍然把业务语义与部署实例耦合。R2 拆成两个
对象：

- `CapabilitySpec`：稳定、可理解、可组合的语义与 effect contract；
- `CapabilityOffering`：某个 Provider 在某 Host 上提供的精确可执行实现。

Spec 不是一份巨大 Tool Schema，而是渐进披露目录的稳定元数据：

```ts
export interface CapabilitySpec {
  readonly id: CapabilityId;
  readonly revision: CapabilityRevision;
  readonly issuer: CapabilityIssuerId;
  readonly kind:
    | "instruction"
    | "resource"
    | "tool"
    | "workflow"
    | "delegate"
    | "interactive-app";
  readonly title: string;
  readonly summary: string;
  readonly whenToUse?: readonly string[];
  readonly whenNotToUse?: readonly string[];
  readonly effectContract: CapabilityEffectContract;
  readonly inputSchemaRef?: string;
  readonly outputSchemaRef?: string;
  readonly composition?: CapabilityCompositionContract;
}

export interface CapabilityOffering {
  readonly id: CapabilityOfferingId;
  readonly capability: {
    readonly id: CapabilityId;
    readonly revision: CapabilityRevision;
  };
  readonly provider: {
    readonly id: ProviderId;
    readonly revision: ProviderRevision;
    readonly hostId: string | null;
    readonly trust: "builtin" | "verified" | "workspace" | "untrusted";
  };
  readonly availability: CapabilityAvailability;
  readonly additionalEffectContract: CapabilityEffectContract;
  readonly execution: {
    readonly locality: "client" | "host" | "remote-service";
    readonly idempotency: "none" | "keyed" | "inherent";
    readonly concurrency: "exclusive" | "parallel";
    readonly resumability: "none" | "handle" | "task";
    readonly expectedLatencyMs?: readonly [number, number];
    readonly estimatedCost?: CapabilityCost;
  };
  readonly ui?: CapabilityUiDescriptor;
  readonly provenance: CapabilityProvenance;
}
```

Effect 不能只是一组静态字符串，因为路径、origin、账号和写入对象通常来自输入。
`CapabilityEffectContract` 是可验证模板：用 JSON Pointer 从标准化输入导出具体资源，再由
Policy Broker 在 Invocation preflight 计算
`Spec effects ∪ Offering additional effects ∪ Host-observed effects`。Offering 只能增加实现
带来的网络、数据位置或系统副作用，不能把 Spec 的最低风险删掉；运行时出现未声明 effect
必须暂停审批或失败，不能先执行后补日志。

`summary/whenToUse` 是检索提示，不是安全事实。外部 Provider 的 description 与 annotations
都按不可信输入处理并限制长度；effects、权限、数据边界和审批策略来自 issuer、Host
policy、Verified metadata 或管理员覆盖，不能由插件自报后直接放行。模型生成的说明文字
不能修改 Policy。

能力种类的控制方不同：

| Kind | 默认控制方 | 进入模型的方式 |
| --- | --- | --- |
| `instruction` / Skill | 用户或 Agent 选择 | 先见摘要，选中后加载正文 |
| `resource` | 应用/Agent 选择 | URI/摘要，按需 read/subscribe |
| `tool` | Agent 选择，Policy/用户批准 | 选中后加载 input/output schema |
| `workflow` | Agent 或用户启动 | 加载入口与 checkpoint/handle 语义 |
| `delegate` | Agent 选择，预算约束 | 子 Agent/外部 Agent capability |
| `interactive-app` | 用户/Agent 打开 | sandbox View + capability RPC |

Command、菜单、主题、编辑器扩展仍是传统 UI Contribution，不自动成为 Capability。只有
显式 adapter 才能把一个 Contribution 暴露给 Agent。

## 6. Agent Capability Runtime 拓扑

```text
ApplicationSupervisor
├─ HostRuntimeRegistry
│  └─ HostRuntime(hostId)
│     ├─ AppServer / Resume / Replica
│     └─ Host Capability Adapter
├─ RendererRuntime
├─ BrowserRuntime
├─ QueryClient
└─ EcosystemSupervisor
   ├─ ExtensionSupervisor                 # Artifact 与 Provider 生命周期底座
   │  ├─ Trusted Cordis runtime
   │  ├─ Isolated Capability Host
   │  └─ Sandboxed UI Host
   └─ AgentCapabilityRuntime
      ├─ CapabilityCatalog                # Spec、Offering 与来源命名权
      ├─ CapabilityResolver               # requirement → resolution
      ├─ CapabilityDisclosureBroker       # 渐进披露与模型视图 digest
      ├─ CapabilityPolicyBroker           # grant、approval、budget
      ├─ CapabilityLeaseRegistry          # Task/request-series scoped leases
      ├─ CapabilityExecutionRouter        # frozen Offering 调用、取消、reconcile
      ├─ CapabilityJournal                # append-only events、receipt 与 projection
      └─ DraftCapabilityLab
         ├─ CompositionCompiler           # Alias/Workflow/Adapter 优先
         ├─ IsolatedCodeCompiler          # 最后手段
         ├─ DeterministicEvaluator
         └─ PromotionPipeline
```

依赖方向：

- ExtensionSupervisor 向 Catalog 注册 Spec/Offering/Provider，不向 Agent 暴露 Context；
- AgentCapabilityRuntime 借用 HostRuntime/ExtensionHost 的窄调用 Port，不拥有物理连接或进程；
- Renderer 订阅 Catalog、Lease 和 Receipt projection，不参与执行决策；
- TanStack Query 缓存 catalog/search/install/read；Lease、Invocation 与 streaming 状态不放
  Query cache；
- Cordis 负责可信 Provider 的组合、Fiber 生命周期和内部 scoped registration，不负责
  Capability 授权或隔离。

从运行责任看，它分成四个平面：

| 平面 | 回答的问题 | 主要组件 |
| --- | --- | --- |
| Distribution | 代码/资源从哪里来、如何装卸 | ExtensionSupervisor、Artifact Store、Host |
| Semantic/Control | 任务需要什么、有哪些候选、是否获准 | Catalog、Resolver、Disclosure、Policy、Lease |
| Execution/Data | 精确调用谁、如何流式、取消、恢复和审计 | Router、Provider Port、Journal、Resource Store |
| Generative | 缺能力时如何组合、生成、验证和晋升 | Draft Lab、Compiler、Evaluator、Promotion |

四个平面不能合并成一个 `PluginManager`。尤其不能让“已装载 Artifact”直接等价于“模型
可见”或“本次 Invocation 已获权”。

## 7. 发现与渐进披露

### 7.1 不把整个生态塞进 Prompt

定义五级披露：

```text
L0 Inventory digest       只说明 capability view 版本/变化
L1 Search summaries       id/title/summary/kind/availability/risk 概览
L2 Spec + Offering        effects/location/cost/auth/provenance
L3 Invocation contract    exact input/output schema + examples + UI contract
L4 Result resources       执行后按需读取的资源、artifact 和详情
```

模型默认只得到一个稳定、内建的 capability search/inspect surface。只有选中的能力进入下一
次 request tool view。Skill body、MCP schema、截图、长说明和远端资源都不得在 L1 eager
加载。

### 7.2 Resolver 不是一个向量数据库

Resolver 的输入不是 Provider 名，而是一个结构化需求：

```ts
interface CapabilityRequirement {
  readonly intent: string;
  readonly preferredCapabilityIds?: readonly CapabilityId[];
  readonly requiredEffects?: readonly CapabilityEffect[];
  readonly forbiddenEffects?: readonly CapabilityEffect[];
  readonly constraints: {
    readonly hostId?: string;
    readonly workspaceId?: string;
    readonly dataLocality?: "client" | "host" | "remote-ok";
    readonly maxCost?: number;
    readonly deadlineMs?: number;
  };
}
```

Resolver 分四步：

1. **Hard filter**：Host、平台、workspace policy、授权可达性、数据位置、健康状态；
2. **Recall**：名称、关键词、语义检索和用户显式 mention；
3. **Rank**：任务相关性、风险、延迟、费用、历史成功率和用户偏好；
4. **Select**：产生可解释 Resolution，钉住 Spec/Offering revision，必要时请求 setup/install/auth。

向量相似度只能参与 recall/rank，不能绕过 hard filter。Resolver 返回选择原因和拒绝原因，
不能只返回一个黑盒分数。

未安装能力可以出现在搜索结果，但状态必须是 `install-required`；搜索本身不能自动下载、
连接账号或授予权限。

Resolver 不总是返回“可执行”。返回值必须区分：

```text
ready(offering)
setup-required(artifact)
auth-required(account/provider)
approval-required(effect set)
composable(existing capability graph)
draft-required(missing adapter/code)
unsupported(reason)
```

每次决策记录 `CapabilityResolutionReceipt`：候选、hard-filter 拒绝原因、最终 Offering、
revision、排序策略版本和用户覆盖。历史成功率只能改善同风险候选的排序，不能让流行度抵消
权限、数据位置或安全约束；Provider 也不能通过模型生成的描述自我抬高排名。

### 7.3 稳定 Model View

每个 Step 在请求前冻结：

```ts
interface ModelCapabilityView {
  readonly viewId: string;
  readonly digest: string;
  readonly capabilities: readonly {
    readonly id: CapabilityId;
    readonly revision: CapabilityRevision;
    readonly offeringId: CapabilityOfferingId;
    readonly providerRevision: ProviderRevision;
    readonly schemaDigest: string;
  }[];
}
```

排序必须确定。任何 Capability/Schema/Policy 变化都产生新的 digest，并把完整或可验证的
request header 记录进 Session log。恢复、Replay 和故障复现不能用“现在的插件列表”猜
当时模型看见了什么。模型实际调用的 Tool 名是由 View 确定性生成、在同一 request series
保持稳定的 Handle；它映射到冻结 Offering，模型不能在调用参数里偷偷切换 Provider。

## 8. Task-scoped Capability Lease

安装和连接授权只是最大权限。一次 Agent 使用还需要更窄的 Lease：

```ts
export interface CapabilityLease {
  readonly id: CapabilityLeaseId;
  readonly capabilityId: CapabilityId;
  readonly capabilityRevision: CapabilityRevision;
  readonly offeringId: CapabilityOfferingId;
  readonly providerId: ProviderId;
  readonly providerRevision: ProviderRevision;
  readonly principal: {
    readonly userId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly taskId: string;
    readonly requestSeriesId?: string;
    readonly turnId?: string;
  };
  readonly scope: {
    readonly hostId: string | null;
    readonly workspaceId?: string;
    readonly roots?: readonly string[];
    readonly origins?: readonly string[];
    readonly accountId?: string;
  };
  readonly effects: readonly CapabilityEffect[];
  readonly budget: {
    readonly maxCalls?: number;
    readonly maxCost?: number;
    readonly deadline?: string;
  };
  readonly approval: "policy" | "user-once" | "user-session";
  readonly authorityDigest: string;
  readonly generation: number;
}
```

不变量：

- Lease 权限只能小于等于安装 grant、账号权限、Host policy 与 Workspace policy 的交集；
- Lease 默认绑定 Task/request series，不因“插件已启用”扩展成整段会话的隐式写权限；
- 用户对消息显式选择的 App/Plugin 只影响该消息启动的请求系列，除非用户明确扩大范围；
- 高风险写操作可以每次 Invocation 再审批；
- 权限、账号、Provider revision 或 Host generation 变化会 fence 旧 Lease；
- 子 Agent 只能继承父 Agent Lease 的等权或更窄 attenuated lease，不能通过 delegation 扩权；
- Capability UI 只能代 Agent 发出 Invocation intent，不能自行扩张 Lease；
- Agent 不能通过调用一个“管理插件”的能力给自己授予新能力。

Lease 本体是不可变 grant；调用计数、剩余额度、撤销时间和 fencing generation 存在独立的
`LeaseRuntimeState`。这样审计记录不会因为计数递减而失去原始授权事实。

## 9. Invocation、交互与恢复

### 9.1 状态机

```text
planned
  -> awaiting-setup | awaiting-auth | awaiting-approval
  -> queued
  -> running
  -> input-required -> running
  -> succeeded | failed | cancelled | indeterminate
```

`input-required` 保持同一个 InvocationId，并携带 opaque request state；用户回答后是同一
调用的继续，不制造一条无关的新工具调用。

调用开始前 Router 冻结 `InvocationEnvelope`：Capability/Offering/Provider exact revision、
Lease、标准化输入摘要、idempotency key、预计 effect set、Host generation 和 trace parent。
Provider 选择不能在同一个 Invocation 中途漂移；如果 Offering 失效，只能结束为 failed 或
indeterminate，再经过一次新的 Resolution 产生新 Invocation。

### 9.2 Receipt

```ts
export interface CapabilityReceipt {
  readonly invocationId: CapabilityInvocationId;
  readonly leaseId: CapabilityLeaseId;
  readonly capabilityId: CapabilityId;
  readonly capabilityRevision: CapabilityRevision;
  readonly offeringId: CapabilityOfferingId;
  readonly providerId: ProviderId;
  readonly providerRevision: ProviderRevision;
  readonly inputDigest: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "indeterminate";
  readonly outputInline?: unknown;
  readonly outputRef?: ResourceReference;
  readonly outputDigest?: string;
  readonly resources?: readonly ResourceReference[];
  readonly effects?: readonly EffectReceipt[];
  readonly approvalReceipts?: readonly ApprovalReceipt[];
  readonly startedAt: string;
  readonly settledAt: string;
}
```

- AppServer/远端 Provider 权威的执行事实进入服务端 Journal/Replica；
- 纯客户端能力进入本地 Session log，并可投影到 View Checkpoint；
- UI 卡片、Agent Activity、重放和遥测都从 Receipt/事件投影，不从活插件查询；
- 外部副作用不能假装 exactly-once：Provider 必须声明 idempotency，retry 使用稳定 key；
- 断线后无法确认外部结果时进入 `indeterminate`，不能自动宣称失败并盲目重试；
- Resource 大内容通过引用按需读取，不复制进每次 Tool result；
- Provider 返回的 result 先做 output schema、大小、敏感数据和 provenance 检查再进入模型。

Receipt 是终态摘要，不替代 append-only Invocation Event：`planned/authorized/started/progress/
input-required/effect-observed/settled` 仍按 authority 写入 Journal。大输出优先落 Resource Store，
Receipt 只保存引用和 digest。

## 10. Agent 生成能力

AI 原生生态必须允许 Agent 为当前任务补能力，但默认生命周期应比传统安装更短：

```text
intent
  -> resolve existing Spec/Offering
  -> inspect exact composition/adapter APIs
  -> choose the least-powerful Draft tier
  -> define immutable Draft revision
  -> static validation
  -> dry-run / deterministic eval
  -> policy + user approval
  -> session-scoped activation
  -> observe receipts/diagnostics
  -> append corrected revision | stop
  -> explicit promote | discard
```

### 10.1 四级生成策略

Agent 发现缺口后不能直接跳到 JavaScript。Draft Lab 按以下次序选择：

| Tier | 产物 | 是否执行新代码 | 默认选择 |
| --- | --- | --- | --- |
| A | Alias、参数 Preset、输出映射 | 否 | 首选 |
| B | 现有 Capability 组成的 Workflow/DAG | 否 | 能组合就使用 |
| C | 声明式 Adapter、Schema transform、受限表达式 | 受限 | 无现成组合时 |
| D | 隔离的 TypeScript/JavaScript Provider | 是 | 最后手段 |

多数“临时工具”其实只是已有能力的参数固化、串联和结果变换。A/B/C 更容易重放、跨平台、
审计和验证，也不会因为模型生成代码而自动获得 Cordis 服务图。只有确实存在新的计算逻辑
时才进入 D；D 必须在独立 Worker/进程/远端 Sandbox 中运行，通过按 Lease 裁剪的 RPC Port
访问外界。

### 10.2 Draft 不等于已安装插件

- Draft 默认 `(hostId, threadId)` scope，刷新/重启可清除；
- 每次修改产生不可变 revision，不原地覆盖运行代码；
- Agent 必须先 inspect 真实 API/schema，不能凭模型记忆猜内部服务；
- Host half、UI half 和 requested capabilities 分开评估；
- UI half 需要明确用户批准，并进入 sandbox；
- Draft 只能登记声明过的 Capability，不能拿 Cordis 根 Context；
- Draft 默认使用 `draft.<thread-id>.*` 命名空间，不能自称某个 canonical Capability；
- Draft Tool set 变化在下一 Step 生效，并记录新的 ModelCapabilityView；
- stop/discard 必须回收 Fiber、process、View、Lease、handler、timer 和 pending request。

### 10.3 Promotion 是独立的人类操作

Promotion 才把 Draft 变成 Workspace/Profile Bundle：

1. 冻结源码、manifest、依赖 lock、hash 和 provenance；
2. 生成行为测试、权限说明、数据流说明和 capability eval；
3. 人类审查并选择发布范围；
4. 进入 Verified Artifact 安装链路；
5. 新版本仍按普通权限与 Lease 模型运行。

Agent 可以提出 promotion intent、准备代码和证据，不能自行把临时能力提升为全局可信
插件。运行成功一次也不等于可以 promotion。

Promotion 也不是简单地把 Draft 复制进插件目录。它必须明确选择：

- 发布一个新的 namespaced Capability Spec；或
- 只发布一个 Existing Spec 的 Offering；或
- 只发布 UI/Command 等 Extension Contribution，不暴露给 Agent。

若声称兼容 canonical Spec，必须通过该 Spec issuer 指定的 compatibility suite；否则保留
独立命名空间，避免“同名能力、不同语义”。

## 11. Cordis 的 AI 原生位置

Cordis 在 AI 时代仍然有价值，但它管理的是可信运行时拓扑：

- Capability Service Definition / Provider / Consumer 的依赖关系；
- Provider Fiber 生命周期；
- 内建 policy、guard、telemetry、presenter 的 reversible effect；
- per-agent/task scoped registration；
- profile/bundle 组合和开发期 reload。

OpenCraft 应引入内部 `CapabilityScope`：

```ts
interface CapabilityScopeKey {
  readonly hostId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly taskId: string;
}
```

可信内建 Provider 可以借鉴 Harness：同一个 scoped context 同时决定 registration visibility
和 lifetime。但对隔离 Provider，外部等价物是 `CapabilityLease`，不是 Cordis Context。

Cordis 不负责：

- 语义检索与模型选择；
- 用户授权与组织策略；
- untrusted code isolation；
- durable Invocation journal；
- AppServer/MCP wire compatibility；
- 自动 promotion。

## 12. Package 边界

保留插件底座的两个拟议包，再增加两个能力包：

```text
packages/
  extension-contract/       # Artifact/manifest/Contribution/RPC
  extension-runtime/        # 安装、隔离 Host、Provider 生命周期

  capability-core/          # Spec/Offering/Lease/Invocation/Receipt/ModelView
  capability-runtime/       # Catalog/Resolver/Disclosure/Policy/Execution/Journal
```

第一阶段不拆独立 `capability-search-*`、`capability-journal-*`、`draft-lab-*`。只有出现第二个
真正独立实现或发布需求后再拆。

适配器留在拥有外部协议的包：

```text
packages/workbench-runtime/src/capabilities/appserver-adapter.ts
packages/workbench-runtime/src/capabilities/mcp-adapter.ts
apps/workbench-web/src/capabilities/sandbox-host.ts
apps/workbench-desktop/src/capabilities/utility-host.ts
apps/workbench-expo/src/capabilities/webview-host.tsx
```

`capability-runtime` 对应用只暴露一个窄 Facade；UI、Agent Loop 和 Extension 不分别拼装
Catalog/Policy/Router：

```ts
export interface CapabilityKernel {
  search(requirement: CapabilityRequirement): Promise<CapabilityResolution[]>;
  inspect(resolutionId: string): Promise<ResolvedCapabilityContract>;
  acquireLease(intent: CapabilityLeaseIntent): Promise<CapabilityLeaseDecision>;
  invoke(request: CapabilityInvocationRequest): CapabilityInvocationHandle;
  continue(invocationId: CapabilityInvocationId, input: unknown): Promise<void>;
  cancel(invocationId: CapabilityInvocationId): Promise<void>;
  reconcile(invocationId: CapabilityInvocationId): Promise<CapabilityReceipt | undefined>;
  subscribe(listener: (event: CapabilityKernelEvent) => void): () => void;
}

export interface CapabilityProviderPort {
  readonly providerId: ProviderId;
  listOfferings(signal: AbortSignal): Promise<readonly CapabilityOffering[]>;
  invoke(envelope: InvocationEnvelope, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  continue?(request: ProviderContinuation, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  cancel?(invocationId: CapabilityInvocationId): Promise<void>;
  reconcile?(invocationId: CapabilityInvocationId): Promise<ProviderReconciliation>;
}
```

Agent Tool adapter 只是把冻结的 `ModelCapabilityView` 变成当步 Tool Schema，再把 Tool Call
转发给 `CapabilityKernel.invoke`；它不是另一套执行系统。React/RN UI 同样只订阅 Kernel
projection，不直接持有 Provider。

### 12.1 多 Host 权威边界

- AppServer/SSH/Durable Offering 的 Catalog 与 Invocation Journal 由对应 Host 权威维护；
- Desktop/Web 客户端可以合并搜索视图，但不能把不同 Host 的 Offering 合并成一个运行实例；
- 本地纯 UI/剪贴板能力由 Client authority 维护，`hostId = null`；
- 一次 Invocation 只绑定一个 authority；跨 Host Workflow 是多个子 Invocation 的编排，不是
  一个 Provider 在中途换 Host；
- Replica 同步执行事实和 Receipt，不同步 Cordis Context、进程对象或 UI 组件实例。

## 13. 实施顺序

当前已实现的 Connector 纵切位于
`packages/workbench-runtime/src/connectors/{runtime,capability-runtime,dynamic-tools}.ts`：它验证了
scoped catalog、确定性搜索、cursor、按需 schema、短期 handle、调用复核与 AppServer deferred
投影，但没有宣称下列完整 Fabric 阶段已经完成。Connector 的连接、授权和物理 MCP owner 仍与
capability projection 分离；详见 [平台 Connector](platform-connectors.md)。

### Phase 0：只建索引，不改执行

1. 实现 `capability-core`；
2. 把现有内建 Tools、Skills、AppServer Plugins 与 MCP statuses 投影为 Spec + Offering；
3. 保持现有执行路径，验证 ID、Host provenance、确定排序与 catalog digest；
4. 建立 Capability Inspector 页面和录制 fixture。

### Phase 1：渐进披露

1. 内建 capability search/inspect；
2. ModelCapabilityView 与 request header 日志；
3. Skill body、Tool schema、Resource 的 L1–L4 加载；
4. Token/KV-cache 预算测试；
5. stale catalog、listChanged 与 auth-filtered catalog 测试。

### Phase 2：Lease 与统一执行

1. CapabilityPolicyBroker/LeaseRegistry；
2. Invocation 状态机、approval/input-required/cancel；
3. AppServer/MCP/local Provider 统一到 ExecutionRouter；
4. Receipt/Journal/Replica projection；
5. idempotency、断线与 indeterminate 测试。

### Phase 3：Extension substrate 纵切

1. 一个可信 Cordis Provider；
2. 一个 Web isolated Provider；
3. 一个 SSH/AppServer Provider；
4. 同一 Capability 的 Provider replacement 测试；
5. sandbox interactive-app View。

### Phase 4：可选 Agent Draft Adapter

1. 先实现 Alias/Workflow/Adapter 三个无任意代码 Tier；
2. inspect/define/run/update/stop/discard；
3. immutable revisions 与 session scope；
4. 再实现 isolated code Tier 与 deterministic eval/diagnostics；
5. UI half approval 与 explicit promotion pipeline。

第一条真正的端到端纵切不要选择“插件管理器”。选择一个同时有多个 Provider 的稳定能力，
例如 `workspace.text.search`：

```text
canonical Spec
  ├─ local browser fixture Offering
  ├─ AppServer/SSH Offering
  └─ replay Offering
       ↓
search → inspect → freeze view → lease → invoke → stream → receipt → resume
```

它能一次验证语义/实现分离、多 Host、Lease、流式、Receipt、Replay 和 Provider 选择，之后再
接 MCP 与 Draft，不会先造出一个无法证明行为的空插件框架。

## 14. 质量门

### 发现与上下文

- 10,000 个 Catalog 条目不会把全部 Schema 送入模型；
- 相同 Catalog/Policy 产生相同排序与 digest；
- revoked/unhealthy/incompatible Provider 在 hard filter 后不可被语义排名复活；
- 未获 namespace authority 的 Provider 不能注册 canonical Capability ID；
- Resolution Receipt 能解释候选淘汰、最终 Offering 和策略版本；
- 模型使用的 exact Capability View 可从 Session log 重建；
- Skill/Schema/Resource 只在披露层级需要时加载。

### 权限与执行

- 安装 grant 不自动变成 Task Lease；
- Lease 不能跨 Host、Workspace、账号、Thread 或 generation 泄漏；
- 子 Agent 获得的 lease 不得比父 Agent 或用户 grant 更宽；
- 未授权调用在 ExecutionRouter 拒绝，不能通过备用调用路径绕过；
- approval、input-required、cancel、retry 与断线都保持一个 Invocation identity；
- 每个外部副作用都有 receipt 或明确 `indeterminate`；
- Provider output 在进入模型前通过 schema、大小和敏感信息门。

### 生成式扩展

- Agent 生成 Draft 默认不持久化、不全局可见；
- 能用 Alias/Workflow/Adapter 表达的 Draft 不得升级为任意代码执行；
- 旧 revision 的迟到事件不能写入新 run；
- run 失败保留当前稳定 revision；
- stop/discard 后无 Tool、View、handler、timer、process、Lease 泄漏；
- promotion 必须包含人类动作和可审计 Artifact；
- Draft 代码即使依赖 Cordis，也只能接触公开 capability façade。

### 多平台

- Web/Electron/Expo 对同一个 Spec、Offering、Lease 和 Receipt 得到相同语义结果；
- 不支持本地代码的平台明确选择 remote/sandbox Provider 或返回 unsupported；
- UI capability 在 iframe/webview/native fallback 间不改变 Invocation identity；
- 同一 Capability 的 local/SSH/durable Provider 可替换而不改变 Agent-facing ID。

## 15. 最终判断

OpenCraft 首先应该建设一个开发体验优秀、边界稳定的商业 Extension Platform；Agent 能力运行时
是它之上的可选投影：

```text
Workbench + Extension Platform
  ├─ Commands / Views / Settings / Renderers / Workspace integration
  ├─ Extension Workshop / build / preview / install / publish
  └─ optional AgentCapabilityRuntime
       ├─ Spec/Offering Catalog
       ├─ progressive disclosure + task Lease
       └─ durable Invocation receipts
```

Firefox 与 Obsidian 仍然值得学习，但它们只解决 Artifact、权限、View 和生命周期。
Codex/MCP/Harness 给出的新问题是：能力由模型发现和组合，能力集会动态变化，上下文有成本，
调用可能跨多轮并产生真实副作用，Agent 还会在运行时创造新能力。

Extension 是公开产品和开发者生态的主角；Capability 是 Agent 调用边界内需要长期稳定的
语义。二者不能互相冒充，也不需要争夺同一个中心位置。

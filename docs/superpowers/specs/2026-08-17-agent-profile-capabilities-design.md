# Agent Profile 运行能力设计

日期：2026-08-17  
状态：产品设计已确认，待规格审查

## 目标

为每个 Agent 提供统一、可离线读取的运行能力视图，并在现有 Agent 设置页增加 macOS 风格的
模型选择器和只读 Skill 列表。能力由 Agent 当前绑定的 Computer 在该 Agent 的真实 Runtime
上下文中发现，Backend 只保存最近一次接受的版本化快照。

首版包含：

- Codex App Server、Hermes ACP、Hermes Gateway 的动态模型发现；
- 跟随 Runtime 原生默认模型或固定一个具体模型；
- 当前 Agent Profile 实际可用的已安装 Skill 目录；
- 实际 workspace 路径、能力来源、发现时间、陈旧和局部错误状态；
- Human 显式刷新及首次成功部署/启动等结构事件触发的异步刷新。

首版不包含：

- 定时刷新、页面打开自动刷新或 heartbeat 扫描；
- Skill 正文、脚本、宿主绝对 Skill 路径或凭据的云端复制；
- Skill Hub、Marketplace、安装、删除、启停或配置修改；
- 修改 Codex `config.toml` 或 Hermes Profile `config.yaml`；
- 新的 Draft、Capability 或 Snapshot 业务实体。

## 对象语义

现有 `Agent` 就是平台的 Agent Profile 权威记录，不再创建一套重复的 Profile 资源。它继续拥有
Computer 绑定、Runtime、模型策略、回复策略和 Human Revision。

运行能力不是权威配置，而是 Computer 对某个具体执行上下文的最近观察：

```text
Agent authority
├── computerId
├── runtime.kind
├── runtime.model = null | modelId
└── revision

Agent embedded observation snapshot
├── subject: Computer + Runtime + Profile + workspace
├── models
├── skills
├── observedAt
└── warnings
```

发现结果永远不能反向修改 Agent 权威配置。已固定模型从新目录消失时继续保留原值，并显示
“当前不可用”；不得静默切换到默认模型。

## 复杂度归属

Runtime-specific 复杂度归属安装在每台 Computer 上的 `vela-computer` 分发 Agent，而不是 Backend。

分发 Agent 负责：

- 选择 Codex App Server、Hermes ACP 或 Hermes Gateway 的正确原生发现 surface；
- 准备 Agent 专属 Runtime Home、workspace 和 managed Hermes Profile；
- 协调 active session、短生命周期探测进程和 Hermes Profile 运行租约；
- 解析原生模型、reasoning、service tier、Skill、scope 和 dependency 结果；
- 过滤平台不兼容或禁用的 Skill，合并该 Profile 的外部 Skill roots；
- 去重、稳定排序、条目上限、truncated/warning 生成和敏感字段清洗；
- 计算不泄露宿主路径的 Profile/workspace fingerprint；
- 维护可选的本地最近结果和 Runtime 变化 invalidation，但不运行定时刷新。

Backend 只负责：

- Human 鉴权、Agent authority、Idempotency 和 Operation；
- 把 refresh command 放入目标 Computer Assignment；
- 对 Computer 身份、refresh ID、binding、Runtime 和 generation 做 fencing；
- 校验 OpenAPI 外壳、静态 enum、数量/长度/总大小和敏感字段禁入规则；
- 通过版本化 Codec 保存已经规范化的快照，并按当前 Agent authority 计算 stale；
- 向 Human UI 返回快照，不实现 Codex/Hermes 解析、Provider 推断或 Skill 过滤。

Backend 不读取 Computer 文件系统，不运行 Codex/Hermes，不解释 Runtime 原始 payload，也不维护一套
与上游重复的模型/Skill catalog。新增 Runtime 时应主要增加分发 Agent Driver；只要输出仍符合现有
Profile capability schema，Backend 不需要增加 Runtime 分支。

## Runtime 原生语义

### Codex

Vela 当前启动的是 `codex app-server --listen stdio://`，不是 Codex ACP。

- `model/list` 提供当前 Codex 安装、账号和 Provider 的模型目录，以及 reasoning effort、
  service tier 等元数据；
- `skills/list` 按一个或多个 `cwd` 返回有效 Skill，支持 `forceReload`，并返回 enabled、interface、
  dependencies 和 errors；
- `skills/changed` 只是失效通知。本设计收到通知后标记快照可能变化，不自动启动扫描；
- 固定模型作为 `thread/start` 或 `thread/resume` 的 `model` 参数；
- `runtime.model = null` 时不传模型，由 Codex 配置及恢复 Thread 的持久模型决定。

Codex 能力上下文至少包含 Agent ID、`CODEX_HOME` 和该 Agent 的 workspace `cwd`。现有无参数
`DetectModels(context.Context)` 使用 daemon 进程上下文，不足以生成可信的 Agent Profile 快照。

### Hermes

Hermes Profile 是完整、独立的 `HERMES_HOME`，包含配置、Provider 凭据、默认模型、Skills、
Memory、Soul、Sessions 和 Gateway 状态。它不是一个轻量模型 preset。

Vela 已按 Agent ID 确定性创建一份托管 Hermes Profile。Hermes ACP 与 Hermes Gateway 可以在不同
Launch 中使用同一份 Agent Profile，但受 Profile 运行租约保护，不能同时运行。两个 Agent 即使位于
同一 Computer 且使用相同 Runtime，也必须使用各自 Profile 独立发现模型、Skill 和外部 Skill roots。

- Hermes ACP 在 session model state 中提供当前模型与已认证 Provider 的模型目录，并支持 session
  model selection；
- Hermes Gateway 使用 `model.options` 提供 Hermes-aware 模型选择目录；
- Hermes 的有效 Skill 来自当前 Profile 的 `skills/` 及该 Profile 配置的外部目录，并受平台和配置
  过滤；
- Vela 固定模型只覆盖本次托管 Session，不写回 Hermes Profile 的全局默认；
- `runtime.model = null` 时跟随该 Hermes Profile 的原生默认或 Session 恢复值。

Hermes 发现不得退回默认 `~/.hermes`。缓存和结果必须绑定具体 Agent-owned managed Profile；共享
物理外部目录也不能把快照升级成 Computer 全局事实。

## 方案选择

采用“Agent 行内版本化快照 + 异步显式刷新 Operation”。

未采用：

- Human HTTP 实时代理到 Computer：Computer 离线时 Profile 页面不可读，且请求链过长；
- heartbeat 或定时刷新：模型发现可能启动 Runtime，Skill 发现会扫描 Profile/workspace，不应成为
  高频存活协议的副作用；
- 独立 capability snapshot 表：快照与 Agent 严格 1:1，没有独立身份、查询、删除或生命周期，新增表
  会引入不必要的关联、删除一致性和扫描规则；
- 把最近 Operation result 当 read model：Operation 是审计/执行 ledger，不应承担当前 Profile 读模型；
- Web 硬编码模型或直接读取 Computer API：会把 Runtime 协议、机器权限和产品 UI 耦合。

## Human OpenAPI

现有 Agent authority API 保持不变：

```http
GET   /servers/{serverId}/agents/{agentId}
PATCH /servers/{serverId}/agents/{agentId}
```

`RuntimeConfig.model` 已存在。Web 必须在创建和编辑时显式保留该字段；`null` 表示跟随 Runtime 默认。

新增 Profile 级能力 API：

```http
GET  /servers/{serverId}/agents/{agentId}/profile-capabilities
POST /servers/{serverId}/agents/{agentId}/profile-capabilities/refresh
```

两者只允许 Server owner/admin。GET 不触发任何刷新。POST 要求 `Idempotency-Key`，返回
`202 Operation`，service 为 `platform`，kind 为
`agent.profile.capabilities.refresh`。

### AgentProfileCapabilities

```json
{
  "agentId": "...",
  "subject": {
    "computerId": "...",
    "runtimeKind": "hermes-acp",
    "profileKind": "hermes-managed",
    "profileFingerprint": "opaque-value",
    "workspacePath": "/var/lib/vela/computer/workspaces/...",
    "contextGeneration": 12
  },
  "snapshotState": "stale",
  "staleReasons": ["runtime_reported_change"],
  "models": {
    "selectionMode": "follow_runtime_default",
    "configuredModelId": null,
    "effectiveDefaultModelId": "anthropic:claude-sonnet",
    "selectedAvailability": "available",
    "items": [],
    "truncated": false,
    "warnings": []
  },
  "skills": {
    "items": [],
    "truncated": false,
    "warnings": []
  },
  "observedAt": "2026-08-17T18:42:00Z",
  "lastRefreshOperation": null
}
```

`snapshotState` 为 `absent | current | stale`。刷新中的 pending/running/failed 状态来自现有 Operation，
不是另一套快照状态机。没有快照时，subject、observedAt 和 sections 使用 OpenAPI 明确的 nullable 形状，
不能用伪造空目录表示成功发现。

Backend 根据当前 Agent authority 与快照 subject 计算 `current/stale`，不把陈旧状态写回 JSON。
稳定 `staleReasons` 至少包含：

- `computer_changed`；
- `runtime_changed`；
- `profile_changed`；
- `workspace_changed`；
- `runtime_reported_change`。

### ModelCapability

模型条目包含：

- `id`、`label`；
- optional `provider`、`description`；
- `supportedReasoningEfforts`、`defaultReasoningEffort`；
- `serviceTiers`、`defaultServiceTier`；
- optional `verified`。

目录失效时，Backend 把当前固定模型作为不可用 selection 单独呈现，不把伪条目写入原始发现 items。
跟随默认但无法确定默认模型时，`effectiveDefaultModelId = null` 且 selection 仍然合法。

### SkillCapability

Skill 条目只包含安全、紧凑元数据：

- `id`、`name`、`description`；
- `enabled`；
- `availability: available | unavailable`；
- `scope: project | user | admin | system | profile | external | unknown`；
- optional `displayName`、`shortDescription`；
- 缺失依赖的类型和数量，不包含环境变量值、token、URL header 或宿主路径。

Codex/Hermes 无法精确映射的字段留空或使用 `unknown`，不能由 Backend 猜测。

## 持久化

不新增表。在 `agents` 追加两个可空字段：

```text
profile_capability_refresh_id
profile_capabilities_json
```

`profile_capabilities_json` 使用 `internal/persistedjson` 注册的
`agent.profile-capabilities/v1` Codec。分发 Agent 已负责原生数据规范化；Backend Codec 只接收生成的
稳定 DTO，使用严格 struct、拒绝未知字段，并验证：

- `schemaVersion = 1`；
- subject 完整且标识符规范；
- model/skill ID 唯一；
- 稳定排序；
- 每 section 的条目数、字符串长度和总 payload 大小上限；
- warning/error code 只能来自静态 enum；
- observedAt 合法；
- 不允许敏感字段或原始 Runtime payload 透传。

超出 Runtime 目录上限时，Computer 在 section 设置 `truncated = true` 并加入结构化 warning；不能静默
截断。超过整个 wire/persistence 硬上限时拒绝结果，以 `result_too_large` 完成失败 Operation，并保留旧
快照。

Capability 写入不增加 Human Agent `revision`。Agent PATCH 的 Revision CAS 与 Computer observation
更新使用独立字段集。Agent 列表 repository 必须显式排除 `profile_capabilities_json`；只有单 Agent
capability 路径选择并解码该大字段。

迁移只追加 SQLite/TDSQL 列，并同步 Ent、物理规格、模型契约、durable field registry 和 migration
release lock。没有存量快照需要回填；`NULL` 表示 `absent`。

## 刷新 Operation 与 Assignment

POST refresh 在 Agent shard 的事务中：

1. 验证 Human owner/admin、Agent 存在且绑定 Computer；
2. 验证目标 Computer 声明支持 Profile capability protocol v1；
3. 通过 Idempotency-Key 创建或重放 Operation；
4. 生成唯一 refresh ID，写入 `profile_capability_refresh_id`；
5. 推进 Assignment revision，唤醒目标 Computer 长轮询。

同一个 Idempotency-Key 始终返回同一个 Operation。新的 refresh 可以 supersede 旧 pending refresh；旧
Operation 进入 `superseded`，旧 refresh ID 的结果不能覆盖快照。

`ComputerAssignment` 增加 optional `profileCapabilityRefresh`：

```json
{
  "schemaVersion": 1,
  "refreshId": "...",
  "contextGeneration": 12,
  "runtimeKind": "hermes-acp",
  "forceReload": true,
  "requestedAt": "..."
}
```

字段为 optional，以保持旧 Computer 对 Assignment v1 的向后读取能力。新版 Computer 在 heartbeat 或
注册能力中声明 `profileCapabilityVersions: [1]`；Backend 不向未声明的 Computer 创建刷新 Operation，
Human API 返回稳定 `profile_capabilities_unsupported`。

Computer 结果使用独立 Computer 身份域：

```http
PUT /computer/agents/{agentId}/profile-capability-results/{refreshId}
```

Body 回显 schema version、context generation、runtime kind、Profile fingerprint、workspace path、
models、skills、warnings 和 observedAt。PUT 幂等；相同 refresh/result digest 重放返回相同结果。

Backend 仅在以下条件全部成立时接受：

- Computer bearer 对应 Agent 当前绑定 Computer；
- refresh ID 等于 Agent 当前 `profile_capability_refresh_id`；
- context generation 与当前 Assignment 一致；
- runtime kind 与当前 Agent 一致；
- payload 通过 Codec 和大小验证。

接受后写入快照、清空 refresh ID，并把 Operation 完成为 succeeded。绑定或上下文已变化时返回
`accepted = false, reason = superseded`，清理或保留当前新 refresh 由 ID 是否匹配决定，绝不覆盖快照。

## 发现执行

分发 Agent 内的 `RuntimeDriver.DetectModels(context.Context)` 替换为显式 Profile 上下文的能力发现
接口，并扩展为统一的 Profile capability discovery。输入至少包含：

- Agent ID；
- Runtime kind；
- workspace path；
- Runtime Home/Profile 选择；
- Computer capability environment；
- forceReload。

输出为 Runtime-neutral 的 models、skills、source metadata 和 warnings。所有原生 payload 解析、
过滤、排序和敏感字段清洗在分发 Agent 完成；Runtime-specific raw payload 不跨 Computer API，Backend
也不做二次 Provider/Skill 语义推断。

执行顺序：

1. Agent 正在运行时优先复用当前 Runtime session 已持有的能力或原生查询接口；
2. Agent 停止时允许在同一 Runtime Home/Profile 下做短生命周期探测；
3. Hermes Profile 已被不兼容进程占用且不能安全读取时返回 `runtime_busy`；不得停止 Agent、绕过租约或
   退回默认 Profile；
4. Profile 尚未创建时返回 `profile_not_ready`，刷新不负责隐式 provision；
5. 模型和 Skill 分区独立采集，局部失败进入对应 warnings，能安全返回的另一分区继续返回。

Codex 使用 App Server `model/list` 与 `skills/list(cwds=[workspace], forceReload=...)`。Hermes ACP 使用
当前 session model state/available commands，停止状态的探测使用该 Agent managed Profile 的官方
Hermes surface；Hermes Gateway 使用同一 Profile 的 `model.options` 与命令/Skill目录。实现不得自行
复制一套会漂移的 Hermes Skill 过滤规则。

## 刷新触发

没有任何时间驱动触发。允许且仅允许：

- 首次成功部署或启动后创建一次能力请求；
- Computer、Runtime 或 managed Profile 结构变化后使旧快照失效，并在下一次成功启动事件创建请求；
- Human 点击“刷新能力”；
- Runtime 启动过程中自然得到的当前能力可完成已存在的请求。

Codex `skills/changed` 等原生变化通知只把当前快照呈现为 `runtime_reported_change`，不创建 Operation。
打开页面、读取 GET、heartbeat、快照年龄和后台 cron 都不得创建刷新。

Operation 本身可以使用现有 worker 的有限超时和恢复机制；这属于已发起操作的完成保障，不是定时
刷新。

## UI

Agent 详情继续使用既有 macOS `SystemPage -> SystemSection -> SystemRow` 语法和统一控件：

### 运行配置

- Runtime：既有 segmented control；
- 模型：单一 Profile model selector；首项为“跟随 Profile 默认”，已知默认时附模型名；
- Computer：既有选择器；
- 运行位置：只读 Computer 名称与实际 workspace path；
- Hermes Profile：仅表达“Agent 专属 Profile”及连接/准备状态，不暴露 Runtime Home 路径；
- 能力状态：上次发现时间、stale reason 和次要“刷新能力”按钮。

模型 selector 的选项来自 snapshot。固定模型已失配时在 selector 中保留当前值并标记不可用；保存其他
设置不能清除该模型。模型改变继续走 Agent PATCH revision CAS，不通过能力 refresh API。

### 可用 Skills

Skill 使用只读 inset group rows，显示名称、描述、scope、available/unavailable 和缺失依赖摘要。
不显示开关、安装、删除或 Hub 入口。单项异常不产生整页错误。

### 页面状态

- `absent`：显示“尚未发现运行能力”和刷新按钮；
- `current`：正常显示；
- `stale`：继续显示旧数据及低强度 warning；
- Operation pending/running：保留旧数据，按钮显示进度并禁止重复提交；
- Operation failed：保留旧数据，显示可重试的行内错误；
- Computer offline：可读旧数据，刷新按钮 disabled 并说明原因；
- unsupported Computer：显示需要升级 Computer，不创建注定无法完成的 Operation。

所有矩形文字按钮继续由 `SystemButton` 渲染，不新增蓝色 case-by-case 样式。

## 错误、安全与隐私

新增错误码进入 OpenAPI 静态 registry，至少包括：

- `profile_capabilities_unsupported`；
- `profile_not_ready`；
- `computer_offline`（若已有等价稳定码则复用）；
- `runtime_unavailable`；
- `runtime_busy`；
- `profile_capability_discovery_failed`；
- `profile_capability_result_too_large`。

Superseded 是 Operation/result 状态，不动态拼接成错误码。

Human DTO 可向 owner/admin 返回 workspace path，因为这是明确要求的管理信息；不得返回 Hermes Home、
Codex Home、Skill 文件路径、原始环境变量、dependency secret 值或 Runtime stderr。日志只记录 Agent、
Computer、Operation、Runtime kind、条目数、digest 和稳定错误码。

## 兼容与发布顺序

外部 API 只增加新路径、optional Assignment 字段和新 schema，不修改已发布 response 的 required 字段。
生成物必须由 OpenAPI 重新生成，不能手改。

发布顺序：

1. Backend 增加存储、API、Computer result 接收和对旧 Computer 的 unsupported 处理；
2. 发布声明 capability protocol v1 的新版 Computer；
3. 验证单 Profile Codex、两个独立 Hermes Profile 和 stopped/running 探测；
4. 发布 Web Profile controls；
5. 升级中的旧 Computer 只显示 unsupported，不出现悬挂刷新 Operation。

本项目无存量 capability 数据需要迁移或回填，但仍保持已发布 OpenAPI 和 migration 追加兼容。

## 测试与验收

### Contract 与持久化

- OpenAPI 新路径、身份域、幂等参数、静态错误码和 optional Assignment 字段测试；
- `agent.profile-capabilities/v1` Codec round-trip、未知字段/版本、排序、重复 ID、长度、数量和总大小测试；
- SQLite/TDSQL migration、Ent、physical schema、model contract 和 durable-field registry 一致性；
- Agent list 明确不选择 capability JSON 的 repository 测试；
- capability result 更新不推进 Human Agent revision 的并发测试。

### Backend 与 Computer

- refresh Idempotency-Key 重放；
- 新 refresh supersede 旧 refresh；
- Computer、Runtime、context generation、refresh ID 各自失配的 fencing 测试；
- 接受结果后快照、refresh ID 和 Operation 原子收敛；
- 失败保留旧快照；models/skills 局部失败；
- old Computer unsupported；offline、not-ready、busy；
- 两个 Hermes Agent 在同一 Computer 使用不同 Profile、Skill 和模型目录的隔离回归；
- Codex 不同 `CODEX_HOME`/workspace `cwd` 的隔离回归；
- source gate 证明没有 timer、cron、heartbeat 或 GET-path refresh。

### Web

- 创建/编辑 Agent 保留 `runtime.model`；
- follow-default、fixed-available、fixed-unavailable；
- absent/current/stale/pending/running/failed/unsupported/offline；
- Skill available/unavailable、局部 warning、长名称和空目录；
- owner/admin 权限、SystemButton 所有权和窄屏布局；
- Style Lab 场景与确定性截图。

### 完成门禁

按 `backend/AGENTS.md` 运行 Backend 全量测试、vet、race、生成物、migration、OpenAPI compatibility 和
secret scan；运行 Computer 全量 Go 测试；运行 client-core 生成、测试和类型检查；运行 Web 全量
Jest、TypeScript 和 Expo export，并在真实 Codex 与两个独立 Hermes Profile 上完成 Canary。

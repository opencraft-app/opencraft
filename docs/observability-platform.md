# OpenCraft 运行观测平台规格 V1

状态：实施规格，首批实现见 [可选观测部署与运行手册](../ops/observability/README.md)，运行验收仍按矩阵逐项记录。规范版本：1.1（2026-10-21：补充宿主维护入口和免二次登录，扩展 F-13/F-19、NF-06/NF-12）。最终完成以真实目标部署的验收为准，文档合入、进程启动或单元测试通过均不代表能力已落地。功能性与非功能性验收见 [验收矩阵](observability-acceptance.md)。

本文的“必须”是 V1 验收要求；预算是待实现验证的工程目标，不是当前产品的性能声明。变更规范须记录版本、理由、兼容性和受影响验收项，不得通过放宽阈值掩盖失败。

## 1. 定位、范围与完成结果

观测属于平台横切的运行诊断能力，服务部署者、开发者、运维人员和已授权维护 Agent。它回答：平台能否正常使用、等待在哪个阶段、异常影响谁和哪些操作、运行的究竟是什么版本、改动后是否改善、证据是否足够。

用户操作和领域事实由现有 owner 产生；可选观测适配器负责裁剪、汇聚与导出；外部设施存储、查询和展示。观测不拥有执行、连接恢复、会话历史、权限、重试或账单的权威状态。关闭整个观测栈不影响业务可用。

V1 包含：

- 整页进入、会话切换、列表、配置显示、发送与恢复的操作观测。
- 执行接纳、排队、有效进展、终态，以及能可靠获得的模型、工具、资源与存储信息。
- 每个组件实际运行身份、能力覆盖、数据新鲜度及采集损失。
- 观察到的活跃人/自动化来源、操作量、执行并发等负载背景。
- Grafana 视图、只读命名查询、CLI、运行时 Skill、故障证据包和优化前后比较。
- 可独立部署、升级、关闭和保留数据的配套设施。

V1 不要求增长分析、留存漏斗、多部署汇总、全量 profiler、真实手机能耗测量、自动修复调度器或完整 trace 存储。Token 真实用量、人员分摊、配额与账单复用各自的权威契约；本平台不得依据估算、观察到的请求数或展示订阅另建记账规则。

最低执行覆盖为参考部署启用的 Codex、DSH、Pi 的输入接纳、执行生命周期、最后进展和运行身份。某项引擎内部模型/工具细节不可见时必须报告 unsupported，不补造数据；这不豁免基本执行覆盖。未启用引擎显示 not_enabled。

## 2. 仓库、部署与责任边界

通用契约、适配器、查询定义、CLI、Skill、部署模板和 Grafana provisioning 与 OpenCraft 同仓维护。企业登录映射、实际域名、服务账号和安装目录由下游装配配置，不能进入公共核心或示例凭据。

建议实现位置如下；本规格不表示这些目录或命令已经存在：

| 位置 | 责任 |
| --- | --- |
| `packages/observability-contract` | 版本化事件、指标、能力与查询结果契约；平台无关 |
| `packages/observability-query` | 唯一命名查询定义、比较规则和 Grafana 查询生成输入 |
| 现有 client/runtime/Host adapter | 在事实提交处产生安全投影；保持原状态 owner |
| `apps/observability-service` | 可选 Observe 服务：有界只读查询、证据索引及观察活动汇总 |
| `apps/observability-cli` | 随维护工具包安装的短进程命令 |
| `runtime/skills/opencraft-observe` | 唯一运行时 Skill 源；经各引擎真实安装/发现端口交付 |
| `ops/observability` | 固定版本部署模板、配置 schema、provisioning、升级/关闭手册 |

完整 V1 配套栈是 **5 个常驻服务**：

| 服务 | 输入与职责 | 持久化 |
| --- | --- | --- |
| OpenTelemetry Collector | 接受裁剪后的遥测、处理与导出；不读取会话正文 | 有上限的队列；可丢失，损失可见 |
| Prometheus | 指标与资源时间序列、分布和覆盖信号 | 独立卷 |
| Loki | 结构化诊断与关联事件 | 独立卷 |
| OpenCraft Observe | 同一套命名查询供 CLI 使用；生成证据包；汇总观察到的活动 | 自有 SQLite 卷：索引、水位、去重和派生汇总；不复制权威历史 |
| Grafana | 原生 Prometheus/Loki datasource 与受管看板 | 配置/状态卷，或可重建 provisioning |

使用活动汇总是 Observe 的内部任务，不增加独立 worker 进程，也不承担 Token 分摊。CLI 与 Skill 不增加常驻服务。Tempo 为后续可选项，V1 依靠结构化事件关联完成基本诊断，不得把未部署的 trace 后端标成可用。

```mermaid
flowchart LR
  B[客户端：操作与轻量诊断] --> A[现有准入：校验、裁剪、可信作用域]
  H[Hub / Gateway / Engine owner：领域事实] --> C[Collector]
  A --> C
  C --> P[Prometheus]
  C --> L[Loki]
  P --> O[Observe：命名查询与证据]
  L --> O
  P --> G[Grafana]
  L --> G
  O --> CLI[维护 CLI]
  CLI --> S[运行时 Skill / 维护 Agent]
```

Observe 的内部活动汇总可以再暴露有限聚合指标给 Prometheus；命名查询定义生成看板表达式，禁止各维护一份不同统计。Grafana 不直接访问业务 SQLite。Observe 不直接修改业务数据库或重放业务请求。

默认业务部署不开启观测栈。显式启用时使用一个受管部署 profile；镜像须锁定完整版本及 digest，禁止 latest。参考部署不要求 Kubernetes、外部商业 SaaS、额外数据库或自定义 Grafana 插件。业务服务不以观测后端 ready 为启动条件。

### 2.1 工作台入口与免二次登录

宿主产品通过现有可信产品/扩展贡献边界提供“平台监控”维护入口，位于工作台维护导航，不放进会话加载提示。入口属于部署级能力，不随当前选中会话或 Host 改变目标。通用核心只提供必要的可复用贡献端口，产品拥有文案、显隐、部署目标和身份装配；不能假设当前公共导航 API 已支持任意外部 URL。监控入口及下述代理均为待实施能力。

参考路径是：已获观测读取权限的维护者点击入口 → 新标签页打开本部署同源 HTTPS 子路径 → 现有可信准入验证身份及监控权限 → 受信代理转交 Grafana → 显示部署总览。无需输入 Grafana 用户名、密码或复制 token。新页使用 `noopener`，原会话与草稿保持；不把 Grafana 嵌入 iframe 或加载到业务运行时。部署者须在交付配置中登记唯一 base path、默认 dashboard UID、允许的时间/筛选参数和实际入口。

免二次登录复用宿主的有效身份，不等于匿名公开。未认证的文档导航进入宿主既有登录/拒绝流程；若已有返回地址机制，只允许同源已登记的监控路径。数据 API 对未认证返回 401，对已认证无权限返回 403，不返回登录 HTML 冒充数据；无监控读取权限的主体也不能凭直达链接访问。无身份配置的本地工作台不能自动开放观测；自托管可复用随包账号认证，无企业登录依赖。

参考集成选择现有受管网关的受信代理能力和 Grafana Auth Proxy，**不另增第六个常驻认证服务**。每次文档、静态资源、数据 API 及启用的 WebSocket 握手，均先经过现有可信身份/准入和独立观测权限检查；不只保护首个 HTML。产品身份适配器验证来源，核心/部署授权策略决定 scope，代理把稳定主体标识及受限 Viewer 身份交给 Grafana。浏览器传来的代理身份/角色头必须剥除，验证后重建；不转发宿主 cookie、企业认证头或管理凭据给 Grafana。

Grafana 上游仅受信代理可达，同时限制 Auth Proxy 可信来源；关闭匿名、Basic/独立交互登录及自动管理员提升。参考配置保持 `enable_login_token=false`，不得用 Grafana 登录令牌替代每次宿主准入。隐藏登录表单仅改善呈现，不能作为安全控制。身份过期、已有退出/撤销机制生效或权限撤销后，既存 Grafana cookie 不能续权；已建立的数据推送连接也须在身份有效期结束前关闭。没有退出契约的身份提供者不因此虚构退出功能。

Grafana Viewer 可查询其有权数据源，看板变量不构成数据隔离。V1 原生 Prometheus/Loki 数据源面向具备本部署完整观测读取权限的维护者，provisioning 只装配该部署允许的数据集；仅有单项资源权限的 Actor 不进入部署总览，仍可经 Observe 查询其授权资源。需要进一步分区时，必须由数据源后端或独立租户/存储分区强制隔离，不能仅靠 URL scope、隐藏面板或组织角色。诊断明细的额外权限在提供数据的后端执行，不能把受限明细装进全体 Viewer 可读的数据源。

同源子路径要完整代理 Grafana 资源和只读查询；`root_url`、子路径重写/`serve_from_sub_path`、转发 Host/协议以及可选 Live 路由须按固定版本成套配置，不能拼接任意目标 URL。浏览器链接/历史/Referrer 不含凭据；返回地址及 dashboard/filter 参数有白名单。看板/数据源修改和管理 API 必须在服务端拒绝。服务缺失或故障时显示可重试的监控不可用状态，不影响业务页面或清除草稿；关闭 profile 后移除入口并停止转发，不落到业务 SPA 的 200 页面冒充看板。

实施须对照固定版本的官方 [Auth Proxy](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/auth-proxy/) 和 [反向代理/子路径](https://grafana.com/tutorials/run-grafana-behind-a-proxy/) 配置，并提交真实浏览器与授权负控；本规格没有声称已有可用入口。

## 3. 事实、身份与事件契约

### 3.1 唯一生产者

| 事实 | 唯一提交处 |
| --- | --- |
| 用户操作开始、展示/配置完成 | 对应客户端操作生命周期 |
| RPC 排队、开始、结算 | AppServer 请求生命周期；每个 attempt 一次 |
| 连接尝试、关闭、恢复状态 | 现有连接/恢复 owner，带有效代次 |
| 输入接纳、轮次开始和终态 | 执行 Host/引擎的已提交状态；客户端通知不重复生成执行 |
| 队列与最后进展 | 已有执行队列和引擎 adapter 的只读投影 |
| 当前源码/构建/配置代次 | 对应正在运行的组件自行报告 |
| 自然人、自动化与资源作用域 | 现有可信准入；不采信客户端自行填写的身份 |

Renderer、Host、Hub、执行轮次、RPC 和自然人是不同对象。多 tab、恢复回放、steer、订阅者增加不等于新增执行。观察值与权威业务事实必须有来源类别；浏览器上报不能作为执行计数或计费的权威输入。

### 3.2 最小安全包络

每条记录须含 `schemaVersion`、`eventId`、`kind`、`occurredAt`、`receivedAt`、`producerInstanceId`、`sequence`、可信 `deploymentId/resourceScope`、`component`、`sourceRevision/buildId`（不可得为 null）、`originClass`、采样信息和覆盖信息。事件体严格按 kind 白名单定义；没有通用 params/result/error 对象槽位。

关联字段按事实存在性选择：`incidentRef`、`clientInstanceId`、`operationId`、`recoveryEpisodeId`、`physicalAttemptId`、`rpcAttemptId`、`executionId`、`engine`、`connectionGeneration`。缺失为 null，并给出关联缺口。未证明的关联不得依据相同秒数、方法名或相似标题补造。

- `eventId` 在重传时保持不变，`producerInstanceId + sequence` 在进程代次内唯一。
- 传输去重与领域事实去重分别处理；执行事实按 deployment/Host/engine/execution/事实版本归并，历史重放和进程恢复不能重复累计终态。
- 一条执行保留一个当前权威结果，修订带版本；较旧版本不得覆盖较新事实。RPC 超时不自动成为执行失败。
- 部分事件丢失、生产者更换、重启和 schema 不支持均进入覆盖状态。未决执行保留 unknown/active，不因窗口结束自动算作失败。
- ID 只进入受控事件字段；不成为 Prometheus label 或 Loki stream label。指标维度使用有限枚举/注册集合，动态值进入 other 并计数。

`occurredAt` 与接收时间分开。持续时间在同一 owner 的单调时钟域内计算；跨进程阶段通过因果 ID 关联，不直接相减两个机器的墙钟。并行阶段不相加，分阶段 P95 不能相加成端到端 P95。客户端时间异常必须标记，不能产生负时延。

### 3.3 内容与权限

默认禁止正文、提示词、工具参数/输出、原始异常消息、完整 URL、路径、cookie、认证头、模型凭据、输入内容和截图。错误使用稳定分类码；配置身份只投影非敏感版本，不对含 secret 的整份配置做公开指纹。

自然人活动按已验证 Actor 去重，经部署内伪名化保存；同一人不同登录方式只有在已有身份绑定验证后才合并。缺身份的记录保留 unknown，不按邮箱、昵称、连接数推断自然人。伪名化密钥更换导致窗口不可比时须披露，不能把两套身份相加。

Actor 种类与流量来源是正交字段：`actorKind` 区分 human/agent/service/unknown，`originClass` 区分 interactive/operator/automation/probe/unknown。同一维护者可以同时产生 interactive 与 operator 活动，分组人数不能直接相加成总人数；全窗人类总数按 Actor 并集去重。来源由现有准入或可信调度确定，不能靠客户端自称。

查询至少区分运行摘要读取与受控诊断明细读取，均按部署/资源作用域授权；可发现 Skill 不代表拥有管理员权限。CLI 的身份配置不得分发 Prometheus/Loki 管理凭据；后端凭据由 Observe 持有。Collector、存储和管理接口默认只在私有网络监听，公网入口只能经部署现有受管认证与 TLS。

## 4. 操作与指标语义

### 网关发布与人的连接连续性

`connection.update_disconnections` 导出每次受管重启停止前仍打开的 AppHost 与原始 AppServer RPC 连接总数，绑定更新器该次 `updateId` 和目标 `buildId`。这是连接数，包含当时仍连着的只读探针，不等同受影响人数或之后的失败重试次数。更新器先写短期观测意图，旧网关核对实际发行指针，再于关闭浏览器前直接写入 Observe；此意图不授权退出或取得 writer 锁。捕获到零才表示该次实际为零；强杀或观测链路失败而没有回执时为未知，不补零。普通手动停止不混入发布统计。

`connection.person_downtime` 是经过服务端身份核验、部署内伪名化的真人每日累计断开时长。浏览器首次可用后的连接失效开始计时，直到原 Runtime 完成重连、初始化及资源恢复的 `settled`；首次冷启动不计为断开。客户端用单调时钟测量，服务器按事件时间拆成 UTC 日，同一人多个 Host/页面的重叠区间取并集，不将多个标签页时长直接相加。记录以独立 outage ID 去重并持久化，网关/Observe 重启不重置当天已捕获时长。

未观察到 `settled` 的周期单列 `connection.unfinished`，时长仅累计最新捕获的区间，不把后台、离线、丢报或关闭的页面无限外推，也不宣称零等待。指标是已观察到的时长；旧客户端、未启用观测或丢失样本的完整性边界须与采集覆盖和丢报指标一起判断。派生库追加迁移6，保留旧迁移SQL和历史；回退使用兼容该数据库版本的发行，不回灌旧快照。

### 历史首屏显示耗时（已实现）

`thread_open` 现有计时仍止于导航准备/提交。新增 `thread_history_first_paint` 从明确点开会话开始，保持跨导航准备与历史读取，直到虚拟列表已有历史行、完成滚动恢复且跨过绘制帧后结算。这是 DOM + requestAnimationFrame 的 paint proxy，不代表浏览器合成器硬件呈现时间。复用保留 View 也产生独立测量；正在展示的同一会话重复点击不产生新测量。初次页面恢复/浏览器 POP 不属于本项明确点开采样。

事件只有低基数 `cache`（保留 View 为 warm，否则 cold）、`lengthBucket`（lt50、50to199、200to499、500plus、unknown）、`engine`（Host 声明的 codex/pi/dsh/unknown）和 `outcome`。长度为完整历史中的不同轮数；分页/持久显示缓存未提供完整总轮数时使用 unknown，不额外拉取历史。会话身份仅在本地隔离迟到绘制回调，不进入事件。

历史索引分页返回可选 `totalTurnCount`，只读首屏的 Thread 元数据携带 `historyTurnCount`；Replica 投影、内存及持久展示缓存保留该总数，与裁剪后的消息窗口独立。完整历史没有索引总数时按原始 Turn 数计数，不按可见帧计数；旧展示缓存或不能提供总数的 Host 仍明确 unknown，不能把最后10轮当作短会话。Codex adapter 显式声明执行引擎，混合 Host 的 provider 声明仍由其装配 owner 持有。

直方图包含 0.05、0.1、0.15、0.25 秒等边界，并显式导出零桶。桶结构升级时服务使用新的内部累计代次，所有桶、count、sum 同时从零开始，指标名和标签不变；旧 Prometheus 历史保留，旧内部累计值不与新桶混算。跨部署窗口应剔除升级边缘，至少等两个 scrape，5分钟图等待完整5分钟。精确达标比例使用部署后窗口 `sum(increase(opencraft_thread_history_first_paint_duration_seconds_bucket{length_bucket="500plus",le="0.15"}[24h])) / sum(increase(opencraft_thread_history_first_paint_duration_seconds_count{length_bucket="500plus"}[24h]))`；首次24小时窗口须从实际部署时刻起算。500plus自然样本为空时不能评估目标；建议每个待评估cache/engine分组积累至少100条再看尾部，同时报告样本量。严格小于150ms在此累计桶上按小于等于150ms近似，原始事件可精确复核。

切走/替换/销毁为 aborted，准备或历史失败为 failed，权威空历史为 empty；只有可见交互的 ok 样本进入 `opencraft_thread_history_first_paint_duration_seconds`。终态另进入 `opencraft_thread_history_first_paint_total`，保留 cache、length_bucket、engine、outcome、origin。原交互指标保持原标签与历史。

`operations.history_paint_p50` 与 `operations.history_paint_p95` 是同一查询注册表生成的中文看板图，按冷/热、长度桶、引擎展示 5 分钟滑窗分位数。部署前没有同口径真实首屏样本，不能从原 thread_open 或新图倒推 Stage 0 的真实用户前后改善；新采样与既有受控验收分别报告。

### 历史读取分阶段诊断

只读 `thread/read` 和 `thread/turns/list` 结果附带可选 `__opencraftHistoryTiming`。
Host 每次生成随机 `pairId`，Web RPC 保存该 ID、`webSentAt`、`clientQueueMs`，
以及白名单的 `historyCoreMs`、`historyMetadataMs`、`historyQueueMs`、`historySourceMs`、
`historyReconcileMs`、`historyScanMs`、`historyPageMs`、`historyProjectionMs`、
`historyNativeRpcMs` 和 `historyNativeRpcCount`。缺失阶段保持缺失，旧 Host 兼容。
字段只进入受控明细，不成为指标标签。`operationId` 在请求发出时从本地 Host/Thread
对应首屏操作捕获；替换打开后旧请求仍关联原操作。Host/Thread 身份不进入事件。

`history-read-stages` 日志按 `pairId` 关联 Web；`history-native-rpc` 按相同 ID
列出物理 `requestId`，关联 router 的 `history-route-stages`：`routeReadyMs`
包含路由、代次就绪及接纳前等待，`nativeRpcMs` 为原生往返。metadata 为前置原生
Thread 元数据；queue 为同会话缓存串行等待；source 为来源解析和验证；reconcile
包含 rollout 扫描、原生分页和缓存写入；scan 仅计本地 rollout 增量扫描；page 包含
索引读页、正文恢复和来源复核；projection 为发送者与附件投影。core 从 Host 读入口
到返回构造，Web RPC 终态包含往返与客户端接收；序列化及返回传输留在 Web 总耗时中。
阶段可嵌套，不能相加阶段分位数或把 native RPC 再加进 reconcile。

原生 Codex 固定二进制没有导出内部文件读取、投影和分页的单独时间，原生往返仍包含
其内部排队和处理，不能直接标为纯投影耗时。必须用同请求 router 和 Host 数据判断
等待边界，必要时在原生源码 owner 增加内部探针。诊断不新增历史、模型或 Resume
请求，不改变取消、缓存新鲜度、分页或执行所有权。

### 4.1 用户等待的范围

每项操作都保存 `operationType`、触发点、完成点、`measurementScope`、`evidenceKind`、负载形状及结果。不同起点不共用同名时延。

| 操作 | 起点 | 必须分别记录的完成点 |
| --- | --- | --- |
| `navigation` | 当前文档导航开始 | Shell 可交互、历史显示、权威历史就绪、配置确认、可发送；准入重定向不可见范围另列 |
| `thread_open` | 已打开工作台中的明确切换动作 | 缓存历史显示、权威历史、配置确认、可发送 |
| `catalog_open` | 目录首次需求 | 首批可用、完整目录；临时页不能充当完整缓存 |
| `configuration_show` | 切换到目标会话 | 当前模型/推理档位/Fast 的真实配置确认；placeholder/fallback 不算完成 |
| `input_submit` | 提交意图产生 | 可信接纳/拒绝、执行开始、首次可见反馈；三者分开 |
| `recovery` | 当前恢复 episode 开始 | 传输、初始化、订阅、权威历史、执行能力分别恢复 |
| `sidebar_open` | 输入事件开始 | 开合起步与稳定可用；不与连续拖动帧成本混为一项 |

“历史显示”若使用 DOM+动画帧标记，必须写为 paint proxy，不声称是合成器实际呈现时间。缓存只授予展示资格，不能授权发送、工具或审批。配置未知不能算默认配置已确认。

负载形状包含引擎、浏览器大版本/平台、视口区间、可见性、缓存状态、目录/历史大小区间、并发与流量来源。合成 fixture 另附 workload hash、CPU/网络限制；不对用户正文生成工作负载 hash。

### 4.2 首期查询目录

| Query ID | 必须回答 | 不可见时 |
| --- | --- | --- |
| `platform.status` | 各 essential query 的状态、影响操作、版本、新鲜度与缺口 | degraded/unknown，禁止无条件全绿 |
| `operations.latency` | 各操作的成功/失败/未决、p50/样本 p95、样本数、范围与来源 | 没有样本与零耗时分开 |
| `recovery.episodes` | 整轮结果、attempt、阶段、关闭原因、最后进展和旧代隔离 | 明确缺关联或无现场 |
| `execution.progress` | 接纳量、队列、最老等待、活动轮次、有效进展、终态 | 区分未知与正常人工/容量等待 |
| `dependencies.summary` | 能可靠观测的模型、工具、存储错误与耗时 | 每项 unsupported，不反推原始模型 TTFT |
| `resources.summary` | 主机/组件 CPU、RSS、事件循环、GC、磁盘/I/O、数据库 busy/健康 | 来源与权限缺口明确 |
| `usage.activity` | 观察到的 24h/7d 活跃自然人、自动化、操作量与执行并发 | 身份/采样/丢失不完整则标下界或 unavailable |
| `components.versions` | Web、Gateway、Core、各引擎、Observe 与采集配置的实际身份 | null；网页 SHA 不代替独立组件 |
| `data.coverage` | 支持/启用、最后成功采集、through、采样、丢弃、拒绝和失联 | unknown/stale，不填零 |
| `incident.read` | 故障原窗口、关联、版本、证据及其有效期 | no_capture/partial/expired |
| `baseline.compare` | 同范围前后结果、关键回归、可比性与未决项 | inconclusive |

使用量是负载背景。`usage.activity` 表达观察到的人/操作，不能标成完整 DAU、账单或所有用户参与率。自动化/维护/探测来源由可信调度或准入提供；unknown 必须保留。有效人类 steer 可计参与活动，但不能因此新增执行轮次或改变 Token 分摊。

业务终态、错误、取消、拒绝、未知和仍运行分别展示。等待人工、容量退避、模型、工具、存储与应用计算不得折叠成一个“卡住”。观察到变化、统计相关与已复现根因是三个证据级别，不提供任意“AI 置信度”。

### 4.3 首期统计口径

以下是命名查询的必需输出，不要求把每个字段都变成独立 Prometheus 指标；具体名称、桶边界与维度投影随查询定义版本固定。

| 输出 | 单位与口径 |
| --- | --- |
| 操作量与结果分布 | 按开始落入窗口的唯一 operation 计数；成功、失败、拒绝、取消、未决分列。窗口截止仍未结算是未决，不按失败补齐 |
| 操作/阶段耗时 | 存储单位秒、展示可转 ms；只对同起止、范围、结果和来源的已结算样本求分位，同时返回总操作数、已结算数和缺失数 |
| 错误比例 | 分子为该类错误，分母为同批同口径已结算结果；拒绝/取消单列；同时披露未决与采集损失，不能冒称所有请求的故障率 |
| 执行量与结果 | 输入接纳、实际开始、终态按各自事实发生窗口计数，使用领域去重；三者不是同一 cohort，不直接相除作为完成率 |
| 队列与进展 | 当前排队/执行 gauge、最老排队秒数、距最后有效进展秒数及等待原因；当前存量与窗口新增分开 |
| 恢复 | 唯一 episode 数、按结果的结算耗时、每轮 attempt 数；单次连接失败不等于整轮恢复失败 |
| 活动 | 固定 24h/7d 观察窗口内的不同已验证伪名 Actor 数，同时给 actorKind 和 originClass 分组及人类并集总数；操作与执行量不从人数推算 |
| CPU/内存/存储 | CPU 秒增量除以观察秒数得到逻辑核数，百分比注明单核/整机分母；RSS 字节、磁盘可用/增长字节、I/O 字节每秒、数据库 busy 次数；主机与进程范围分开 |
| 新鲜度与损失 | 每个 essential producer 的最后成功采集/水位、已接收/拒绝/丢弃数及重启代次；无法观测的损失标 unknown |
| 依赖 | 可见调用数、结果与耗时；排队、重试和一次真实尝试分开；原生提供完整边界时才报告模型内部首 token 时间 |

查询返回 `measurementKind`：事件样本、精确领域归并、直方图估计或资源采样。Prometheus counter 的 `increase` 插值结果不能标成精确事件计数；直方图分位不能标成原始样本 nearest-rank。图表和 CLI 使用同一评估时刻、步长/桶和水位；偏差、近似及数据过期按定义披露。细分浏览器、视口、历史/目录大小的诊断优先查询有界事件，不把全部维度做标签笛卡尔积。

### 4.4 采样与缺失

参考部署对低成本操作记录采用 100% 采样，较重的成功诊断细节默认 10%；两者独立声明。通用部署可以下调操作采样率，必须在操作开始时固定选择，成对保留开始/结算。错误额外保留的诊断记录不直接进入均匀样本分母，避免混合采样扭曲错误率或尾延迟。

查询必须返回采样数/比例、分子/分母、丢弃、支持范围和 essential query 清单；不能把成功采样率当全平台覆盖率。能力未支持、未启用、数据过旧、权限拒绝、无样本和采集丢失是不同状态。数据完整性不足时只能给有限结论。

## 5. 客户端轻量诊断与失效隔离

优先复用现有 RPC 生命周期、recovery episode、物理 attempt 以及引擎的有界诊断，不能把原始 params/result 转接到日志。客户端只观察已有状态，不额外读原生历史或改变恢复计时器。

客户端可记录交互阶段、可见性、受支持的长任务/响应信号和有界近期事件。严重主线程饥饿时上报回调也可能无法运行；无终态或数据过旧不能单独证明 freeze。需要提供 unfinished/no_capture/telemetry_stale，并考虑后台、离线和页面关闭。

深度 profiler、调用栈与浏览器 trace 按需启用并明确资源开销；V1 不要求为每个 tab 新建 Worker 或持续高频心跳。诊断入口放维护功能，不恢复普通加载 UI 中的内部技术信息。

所有遥测均异步、有限队列、可丢弃。观测失败不影响业务事务，不重试业务命令，不阻塞启动/发送/恢复，不以观测健康改变原授权。非法或未知诊断种类要单条拒绝并继续处理其余合法记录，不能用坏记录阻塞整队。

客户端关联ID复用既有兼容生成器；缺少 `crypto.randomUUID` 或整个 Crypto 对象时，模块加载、禁用态业务操作、启用后的事件/RPC/导航记录仍可运行。ID保持生产者与操作关联，不能将所有降级客户端标为同一 `unavailable`；这些ID不承担认证或授权。

## 6. 命名查询、证据包、CLI 与 Skill

### 6.1 同一查询定义

查询定义版本化，声明语义、必要 producer、维度、单位、分母、支持版本、权限、最大窗口/行数/字节、超时与图表表达式。Grafana provisioning 由该定义生成，CLI 通过 Observe 执行同一语义。不能为让结果一致而在客户端复制统计逻辑。

只读 API 提供 capabilities、named query、incident 与 comparison，拒绝任意 SQL/PromQL/LogQL、任意文件/URL 和管理命令。此限制适用于 Observe/CLI 的维护 Agent 入口；Grafana 运维数据源权限按部署授权配置，跨资源隔离由后端保证，不能只依赖看板变量。已有授权入口可以代理传输，不能由观测层建立第二套业务身份。scope 从可信认证上下文得到，客户端填写的 scope 不能扩大权限。

### 6.2 CLI 约定

以下为待实现的接口：

```sh
opencraft-observe capabilities --target "$OBS_TARGET" --json
opencraft-observe status --target "$OBS_TARGET" --window 15m --json
opencraft-observe snapshot --target "$OBS_TARGET" --from "$OBS_FROM" --to "$OBS_TO" --out "$OBS_BEFORE" --json
opencraft-observe incident --target "$OBS_TARGET" --ref "$OBS_INCIDENT" --out "$OBS_INCIDENT_BUNDLE" --json
opencraft-observe issues --snapshot "$OBS_BEFORE" --json
opencraft-observe explain --snapshot "$OBS_BEFORE" --finding "$OBS_FINDING" --json
opencraft-observe compare --before "$OBS_BEFORE" --after "$OBS_AFTER" --json
```

capabilities 返回目标身份、版本、权限、命名查询与限制、适配器覆盖和可选 trace 能力。CLI 随维护工具包提供，无仓库 checkout 时可运行；凭据经部署现有安全配置引用，不出现在参数、输出和 Skill。

退出 0 表示取得结构化结果，业务 status 仍可 degraded/unknown。稳定非零退出类别：参数/窗口错误、未认证、无权限、目标/后端不可达、版本不兼容。错误正文也结构化。默认 summary 窗口 15m，普通查询及明细窗口最大 24h；`usage.activity` 的固定 7d 汇总是单独声明的有界能力，不允许据此读取 7d 原始明细。incident 默认有界原窗口且上限 30m，超过时提示分段，不无界扩大。

incident 只读取已经捕获的现场。查询不触发远端浏览器抓取、模型探测、轮次重试、重启或配置写入。本地证据文件只能写入调用者明确指定的位置，禁止覆盖已有 before 文件。

### 6.3 证据包

至少包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion/snapshotId/deploymentId` | 结果格式与目标身份 |
| `window.from/to/capturedAt/dataThrough` | 绝对 UTC 窗口、采集时刻和各来源水位 |
| `queryDefinitionRevision/metricSchemaVersion` | 口径版本 |
| `status/coverage/captureStatus` | ok/degraded/unknown；complete/partial/unavailable；captured/partial/no_capture/expired |
| `components` | 每个组件的 sourceRevision、buildId、observedAt、能力；未知为 null |
| `measurements` | 值、单位、样本、分子/分母、availability、operationType、measurementScope、evidenceKind、measurementKind、负载维度 |
| `findings/evidenceRefs` | 固定规则、严重度、observed/correlated/reproduced、假设和可访问证据 |
| `sampling/loss/correlationGaps` | 采样、丢失、关联范围与缺口 |
| `evidenceExpiresAt` | 可补取明细的有效期；数值快照本身自包含 |

快照冻结查询数值、窗口、定义版本及当时覆盖；explain 后补证据保留获取时刻和来源，不悄悄改写旧数值。明细过期仍保留原聚合和过期提示。数据源补入迟到事件时不得声称它属于旧快照已经捕获的现场。

比较先检查目标、时钟范围、schema、操作起止、平台/引擎、缓存、来源和负载可比性。样本不足或流量不一致返回 inconclusive，附原因；只有统计方向相同不等于已证明因果。合成对照至少 20 个配对样本，真实用户分位至少 100 个均匀操作样本才给方向性结论，仍标记 observed association，不外推为总体 P95 或因果。来源不兼容不能靠增加样本数豁免。

每次比较同时给目标收益、错误/未知、历史范围/行为回归证据、资源开销与数据完整性。测试成功、代码已合入、相关组件已更新、现网已改善四件事分别保存。

### 6.4 运行时 Skill

Skill 负责选择操作、目标与窗口，检查覆盖，保存 before，提出可证伪假设，沿现有授权工作流修复，再核对实际组件并取得 after。统计由 CLI 完成。Skill 不授予管理员、代码写入、部署或跨目标权限，不新增人工审批门槛，也不创建周期任务。

Skill 必须经当前引擎真实的目录发现机制交付，不能仅把文件放 contributor `.agents/skills` 就宣称运行时已安装。参考部署启用的 Codex/DSH/Pi 均需有“无仓库工作目录加载 Skill → 执行 capabilities/status → 取得本部署数据”的证据；既有用户 Skill 和配置不被覆盖。旧会话刷新能力不支持时如实说明并使用新维护会话验收。

## 7. 非功能约束与运维默认值

所有数值的采样场景、单位和判定在 [NF 验收](observability-acceptance.md#非功能性验收) 中定义。默认部署基线：

| 项目 | V1 约束 |
| --- | --- |
| 数据新鲜度 | 正常运行时关键指标/事件进入查询不超过 90s；超过则明确 stale/unknown |
| 客户端缓冲 | 近期诊断最多 128 条/128KiB；全部待上传数据最多 256KiB；单条最多 2KiB |
| 上传 | 单批最多 32 条/32KiB；正常最多每 10s 一批；终态异常可一次立即尝试；失败指数退避至 60s，无界重试禁止 |
| 后台/静置 | 队列清空后无专属上传 timer；隐藏页面不持续轮询；返回前台按已有生命周期刷新 |
| 服务端导出 | 每进程最多 2048 条/2MiB；满队列丢弃并计原因；业务热路径不等待远端 |
| 查询 | 默认最多 500 条明细/1MiB 结果；并发最多 5；后端不可达 5s 内给有限结果或结构化失败 |
| 指标基数 | 参考 profile 总活动 series 不超过 10000；关联/用户 ID 不能增加标签基数 |
| 保存 | 指标 30d；原始诊断与服务端证据索引 7d；本地导出由调用者保管；可缩短并显式展示能力 |
| 空间 | 参考 profile 指标卷 10GiB、诊断卷 5GiB、Observe 卷默认 1GiB 上限；部署可用有界配置提高 Observe 卷/数据库上限，具体预算由部署方决定并保留 WAL/维护余量；只清理自有过期数据 |

限流后的错误记录同样可能丢失，必须显示 dropped，不能把“100% 错误采样”表述为永不丢失。采集状态本身使用独立有界计数，禁止因记录遥测错误再次递归记录同一错误。

SQLite 使用项目既有持久化、事务、升级与备份契约。变更、关闭、回退均不清理业务账户、会话、配置、预览或执行数据。回退只回退代码，不自动恢复旧业务备份。Observe 卷损坏须降级为派生数据缺失，可重建部分明确标范围，不能宣称权威历史受损或全量恢复。

## 8. 实施顺序与最终验收

1. 契约、生产者与查询定义：统一范围、identity、去重、版本、覆盖、采样和有限队列。
2. 最小闭环：实际采集 → 5 服务受管部署 → 工作台维护入口/可信准入代理/Grafana免二次登录及CLI → 真实引擎 Skill。仅有看板链接或服务健康不能算闭环。
3. 证据与优化：incident、同口径 compare、已知退化/缺数据/隔离负控及资源开销验证。
4. 目标部署验收：功能/NF 证据、持续观察、升级关闭回退、最终运行身份与交付记录。

各批可以独立合入部署；验收状态未完成不阻塞目标部署正常持续交付。正式发布和日常环境测试继续沿已有各自流程，不新增完整性能测试的部署前置。

最终完成要求所有适用 F/NF 和下游目标部署验收通过。已知缺口标 pending/failed，不以文档、模拟、截图或安装成功替代实际行为。物理手机、真实模型内部请求或外部认证未验证时明确范围，不能用 Chromium 模拟冒称已覆盖。

## 9. 既有事实入口

- [平台架构与已有诊断](platform-architecture.md)、[执行所有权](execution-ownership.md)。
- [启动/性能基线与整页导航范围](startup-performance.md)。
- [持久化生命周期](sqlite-lifecycle.md)、[Skill 发现协议](appserver-profile-skills-protocol-v1.md)。
- [验收矩阵与证据格式](observability-acceptance.md)。

### Implementation measurement notes

The `navigation` operation ends at the existing startup-finished event and uses
the browser navigation time origin. It is distinct from `submit_ready`, whose
existing Host/history/capability or draft-configuration predicates are observed
without changing admission. Unsettled captured operation starts are reported as
`unfinished`, never as proof of a frozen client. An idle browser without new
events has no recent capture; the client does not add a heartbeat upload timer.

Independent legacy processes can be projected by Gateway health. Their versions
are null unless self-reported or bound to the actual PID/start and installed
artifact/manifest by the trusted operator profile. `observedBy`, `producerMode`
and `identitySource` disclose this provenance. Imported modules do not start
component producers: initialization belongs to the actual process owner.

A private per-deployment probe key can classify controlled browser measurements
as `probe` at the authenticated ingress. It does not grant authentication or
query access, and is never embedded in the page. Verified-human activity counts
only interactive-origin observations; probes retain their own origin and cannot
increase the real-human union. The query registry revision identifies this
semantics. Hourly actor rollups plus exact boundary-hour samples avoid full raw
retention scans without changing the selected-window union.

Comparison can select an operation/cache/engine from immutable evidence; it
rejects missing workload dimensions, overlapping sample IDs and ambiguous pairs.
Selection does not rewrite either capture. CLI results include the installed
CLI's own build/source identity separately from server components.

### Named-server deployment paths (2026-10-22)

Browser capabilities, telemetry and dashboard navigation use the selected server context. Operator-owned `grafanaBasePath` in ingress and observation-service configuration must match Grafana root_url for that named-server prefix. The relay preserves already-scoped HTML paths exactly once; ingress maps authorized Grafana requests to the configured Unix-socket path. These URL transformations never establish identity or expand target ACL. Each deployment owns independent storage and deploymentId; missing component capture stays partial.

增量历史核对从十个完整原生 Turn 开始，沿原 cursor 继续到所有脏 Turn 的最老边界；
完整重建仍读取全部历史。这样小增量不再反复投影一百轮未变的工具输出。此改动不减少
最终返回的 Item、正文或旧页，不用窗口轮数替代完整轮数；原生大小限制仍按原策略缩页。

直接转发的 metadata-only `thread/read` 和原生 cursor 页同样返回关联计时，覆盖首屏
窗口因大小限制回退的读取。它们没有缓存串行等待、来源验证或索引读页阶段，这些字段
缺失而非伪造零；`nativeRpcMs` 包含直通原生往返，`projectionMs` 包含回复处理和投影。
原生 RPC 自身仍未拆分内部排队与磁盘/投影时间。

## 业务可用性与主动告警

`platform.status`表示真实新连接探测的可用性：按site/hostId/engine分开，任一失败为degraded，
缺样本或超过90秒为unknown，不再用producer心跳代替。`collection.freshness`独立报告采集；
`availability.ratio`为5分钟内实际探测成功比例，`availability.last_success`为最近成功。
Observe `/health`中的`ready`只说明查询服务已启动；`ok/status`反映探测可用性，`collection`
保存采集覆盖和后端健康。Headless业务health还必须汇总已有Host readiness，unavailable或
connecting不能返回ok。业务进程的readiness不替代每分钟全新initialize/thread/list。

部署者拥有探针与通知调度，不把私有产品装配放进公共核心。核心接收严格字段白名单的
availability/lifecycle事件，指标不含事件ID或用户身份。故障按component/engine/errorCode归组；
仅保留稳定分类或数值RPC码，不导出原始异常。默认总览首屏显示“新连接、成功率、最近成功、
拨测、故障分类”，采集新鲜度另列。

事件数量超过500时，snapshot的events是明细样本（eventSampleTruncated=true），eventSummary
和eventCount覆盖选定窗口全部已存事件；长事故的Prometheus测量单列measurementsWindow（最长24小时），
不缩短完整事件聚合窗口；timeline保留部署、重启与显式owner_handoff。
truncated=false仅指聚合完整，不代表明细全量；baseline.compare拒绝用抽样明细作可靠比较。

拨测状态与成功率的查询只读取 `kind=availability` 的事件，使用受管 v5 部分索引。
既有观测库通过增量迁移保留事件及 v1–v4 迁移回执；健康、指标和看板刷新不得随其他类型历史事件量线性扫描。

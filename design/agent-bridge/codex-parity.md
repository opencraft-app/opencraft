# Codex bridge 能力对照清单

目标：内置 Codex 全部走 provider bridge，退休旧路径（`apps/opencraft-daemon/src/codex-engine-adapter.ts` 及其 Codex 库）。退休前，bridge 线程必须提供旧路径已有的全部用户可见能力。本清单是 [P8](README.md) 之前的能力对齐范围；每项补齐时在此更新状态与证据。

核验基线（2026-11-21，只读）：

- 旧路径：`codex-engine-adapter.ts` 处理的方法与通知。
- bridge：daemon 侧 `apps/opencraft-daemon/src/codex-provider-bridge.ts` 对 `bridge:codex:` 线程的路由；Engine Host 侧 `apps/agent-bridge-host/src/codex-runtime.ts` / `codex.ts`。
- 原生：固定 Codex 0.162.1 `codex app-server generate-json-schema` 导出的方法。
- 通用 bridge 提供者 `apps/local-agent-host/src/bridge-engine-provider.ts`（Pi、DSH）同样声明 queue/fork/rename/archive 为 false，这是 bridge 家族的共同缺口，不只是 Codex。

## 已具备

bridge 线程目前只路由以下方法；其它线程级方法一律返回 `Method unavailable for this bridge thread`。

| 能力 | bridge 路径 |
|---|---|
| 新建（显式 opt-in） | `thread/start {agentBridge}` → `session/create` |
| 发送、steer、中断 | `turn/start`、`turn/steer`（需 evidence 扩展）、`turn/interrupt` → `turn/stop` |
| 续接、读取、历史分页 | `thread/resume`、`thread/read`、`thread/turns/list`、`thread/items/list` |
| 退订、steer 状态、审批回复 | `thread/unsubscribe`、`opencraft/steer/status`、interaction resolve |
| 事件 | turn/item/消息增量/reasoning/plan/tokenUsage/审批投影 |
| 执行准入与会话 MCP | `turn/start` 携带 `opencraftExecutionAdmission`、`opencraftSessionMcp` |

与线程无关的方法（`model/list`、`opencraft/codex/accounts/*`、`opencraft/tasks/*`、`opencraft/schedules/*`、`command/exec`、`thread/list`）仍由旧 adapter 经 Core 处理，`thread/list` 已对 bridge 线程做 ID 投影。退休旧 adapter 时这些要另找 owner，见末节。

## A. Codex 原生已支持，只需接线

bridge 协议加方法与能力声明，Engine Host 转发原生请求并投影 ID，daemon 路由，客户端按声明开放入口。

| 能力 | 原生方法 | 旧路径 | 备注 |
|---|---|---|---|
| 分叉 | `thread/fork` | 有 | **已接线**：`session/fork`（`forkCheckpoint`），新线程获得新的 `bridge:codex:` 身份与 Host 路由，与创建同等的账本/租约处理 |
| 重命名 | `thread/name/set`、`thread/name/updated` | 有 | **已接线**：`session/rename`（`lifecycle`）；成功后向订阅者发 `thread/name/updated` |
| 归档 / 取消归档 | `thread/archive`、`thread/unarchive` 及通知 | 有 | **已接线**：`session/archive|unarchive`（`lifecycle`）；归档要求会话空闲、输入已结算，会话保持绑定，取消归档后可直接续用 |
| 删除 | `thread/delete`、`thread/deleted` | 有 | **已接线**：`session/delete`（`lifecycle`）；先原生删除成功再解除绑定，Host 按结束会话处理租约与审批 |
| 目标（goal） | `thread/goal/get|set|clear` 及通知 | 有 | **已接线**：`goal/get|set|clear`（`goals`）；设置/清除成功后发 `thread/goal/updated|cleared`。模型在轮次中自行更新目标产生的原生通知尚未转发，见下 |
| 图片输入 | `turn/start` 的 `localImage` / `image` | 有 | **已接线**：Codex bridge 接受并校验 text、`image`（https 或 data:image）、`localImage`、`mention`（绝对路径），64 KB 上限，start 与 steer 一致；其它类型在发送前拒绝 |
| 压缩上下文 | `thread/compact/start` | 未暴露 | 非对齐必需，按产品需要 |

## B. OpenCraft 自有能力，需要在 bridge 侧确定 owner

旧路径把这些放在 daemon 的 Codex 库或 adapter 内存里。bridge 线程的常驻 owner 是 Engine Host，daemon 可能重启；凡是必须在 daemon 不在时继续推进的，放 Engine Host。

| 能力 | 旧路径 owner | 建议 owner | 说明 |
|---|---|---|---|
| 排队 `thread/queue/add|list|update|reorder|delete|start|steer|retry` 及 `thread/queue/changed` | `OpenCraftHostQueue`（`opencraft-host-queue.ts`） | **已完成**：Engine Host（Host 库 v4） | 与旧路径共用 `@opencraft/thread-queue` 的存储、核对与派发；轮次结束由 Host 发出队首，daemon 不在也继续；协作输入与 `collaborationReceipt`、排队轮次的执行 CLI 凭据尚未支持 |
| 标题生成 | `CodexThreadTitles` | **已接线**：daemon | bridge 路由把新建与第一轮按原生身份交给本地标题生成器；生成器经同一原生 AppServer 写入名称，通知映射回公开 ID。依赖 Core Host overlays（见“桌面接线时注意”） |
| 置顶 `thread/pins/updated` | `codex-thread-pins.ts` | **已接线**：daemon | 设置时公开 ID 换成原生 ID 交给旧 Host（只改原生分组元数据，同一原生 AppServer，无第二写者）；列表与通知映射回公开 ID |
| 线程设置 `thread/settings/update` | adapter 配置刷新 | **已接线**：`session/settings`（新 `settings` 能力） | 原生 `thread/settings/updated` 经通知转发通道到客户端 |
| 附件暂存 | `LocalAttachmentStagingService` | **已完成**：daemon，与本地线程同一暂存 | 由装配注入：发送、steer、排队添加/编辑前暂存（排队在添加时暂存，因为 Host 自行发送），按公开线程与客户端消息记录，历史读取时投影附件 |
| 维护准入（`codex-admission.paused`） | adapter 检查 | **已补**：`CodexProviderBridge` | 新建与发送等准入（与旧路径同一 `isCodexAdmission` 判定）在暂停时以同一维护错误拒绝；steer、读取、审批继续；维护快照合并 bridge 在途与拒绝计数。daemon 与服务器装配均传入同一暂停开关 |
| 模型使用策略 | adapter 在 `turn/start`、goal 激活时检查 | **无需补**：服务器的 `ModelPolicyTransport` 包在 bridge 外层，经 bridge 的 `thread/read` 同样校验 bridge 线程；桌面 daemon 两条路径都未配置 Codex 模型策略 | 新接入 goal 等准入方法时须在该外层覆盖范围内 |
| 模型网关准入（花费授权） | adapter `admitModelExecution`：按人类授权者登记执行，轮次结束结算 | daemon 路由层，需观察 bridge 轮次结束 | 仅在设置 `OPENCRAFT_MODEL_GATEWAY_DATABASE` 的服务器生效；bridge 线程目前不登记，属漏洞，桌面不受影响 |
| 历史读取取消 `thread/history/cancel` | adapter | **已接线**：daemon | bridge 历史读取没有可取消的在途请求，如实返回 `cancelled: false` |
| 待建线程 | `ProvisionalThreads` | 由 bridge 的 `session/create` 幂等语义取代，需核实 UI 依赖 | |
| 编排 / 协作回执 | adapter 与 orchestration | P7a 执行 CLI 已覆盖 spawn/tell/wait；queue follow-up 待做 | 见 P7a 剩余范围 |

## C. 不需要在 bridge 内对齐

- SSH 远程 Codex（`kind: "remote"`）：bridge 只接本机 Core，远程 Host 保留现有路径，不在本清单退休范围。
- 实时语音 `thread/realtime/*`、`thread/revert`、`thread/shellCommand` 等原生能力：旧路径未暴露，不是对齐项。

## 已有会话的连续性

- 并存期：账号 Core 与 APP Server 使用桌面现有 `codexDataDirectory`（同一 `CODEX_HOME` 与账号库），已有会话不迁移数据。路由按线程 ID 前缀，非 `bridge:codex:` 的已有会话继续由旧 adapter 经 Core 读写。
- 关闭 bridge：已有会话不受影响；开启期间创建的 `bridge:codex:` 会话因“native fallback refused”暂不可用，原生数据仍在 `CODEX_HOME`，重新开启即恢复。开关说明须写明。
- **接管已有会话（已实现，默认关闭）**：`session/adopt`（`adoption` 能力）。开启 `--codex-agent-bridge-adopt-existing` 后，已有会话在下一次 `turn/start` 时迁入 bridge：旧 Host 先确认该会话空闲（无轮次、排队或未知输入、目标、重试、恢复、标题任务、活跃定时、待审批、在途准入）并取消订阅，否则保持本地；Host 要求公开 ID 等于原生 ID，Codex 层只续接空闲的原生会话并核对身份。失败或中途崩溃都退回旧路径，期间不执行任何内容。仍在旧 Host 的会话数据（附件记录、标题）按同一 ID 继续投影。

## 桌面接线时注意

daemon 经 Core 运行旧 adapter 时，只有开启 Core Host overlays 才会暂存附件、保存附件记录、生成标题，也才能可信地判断会话空闲（接管前提）。默认是直通 Core。daemon 现有显式开关 `--codex-core-host-overlays`（`codexCoreHostOverlays`，须同时给 Core 地址；桌面启动参数 `codexCoreHostOverlays`）。桌面接入 Core 时必须打开；服务器的 web-server 部署由网关在同一 Codex 数据目录上运行 overlays，daemon 必须保持关闭，否则两个 overlay owner 争用同一锁。已用真实 Codex 0.162.1 的拆分 Core 验证：该模式下本地任务、定时、附件、排队、恢复、计量等库正常打开并服务。

## 退休旧 adapter 时的其余 owner

线程无关的职责（账号、任务、定时、计量、附件暂存、置顶列表、模型与线程列表、初始化能力、维护状态等）移到 Thread 路由之前的 Host 服务前台 `CodexHostServices`（`apps/opencraft-daemon/src/codex-host-services.ts`）；只在旧 Host 本来就持有本地状态时（无 Core，或 Core + Host overlays）由前台接管，直通 Core 时不接管，避免同一数据目录出现两个写者。部署形态：桌面在 daemon 进程内；单机服务器在服务进程内；四容器在 gateway。

| 步骤 | 状态 |
|---|---|
| S0 桌面可开 Host overlays | 完成（显式开关，默认关闭） |
| S1 前台骨架 + 任务 | 完成：daemon 与服务器装配 |
| S2 账号 | 完成（Core 模式；无 Core 时账号池仍在旧 Host 内，它同时为原生进程鉴权） |
| S2′ 维护状态汇总、计量查询与配置 | 并入 S5：维护计数主要来自线程执行，计量的查询、配置与收集共用一份账本，单独搬会产生两个 owner |
| S3 原生元信息连接：模型、权限档案、线程列表、置顶、独立命令 | 待做 |
| S4 初始化能力声明集中到前台 | 待做 |
| S5 作用于线程的后台职责改走“按线程派发”：定时、恢复、重试、目标、标题、计量收集 | 待做 |
| S6 旧 adapter 只剩旧线程执行，批量接管后退休 | 待做 |

## 顺序建议

1. ~~维护准入~~（已补）；模型使用策略核实为已覆盖。另：模型网关准入（`OPENCRAFT_MODEL_GATEWAY_DATABASE`，仅服务器）对 bridge 线程尚未生效，见 B。
2. ~~A 中的分叉、重命名、归档、删除、目标~~（已接线，2026-11-21，仅替身原生验证）。原生自发的线程元信息通知（名称、目标、设置、归档）已有转发通道：provider 的 `thread/notification` 回调按白名单写入 Host 事件流。
3. 排队（Engine Host 落地）、图片输入与附件。
4. ~~标题、置顶、线程设置、历史取消~~（已接线）。
5. ~~已有会话接管~~（已实现，默认关闭）；线程无关能力的 owner 拆分，然后才能进入 P8。

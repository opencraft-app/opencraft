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

## 桌面 bridge 栈（daemon 子进程）

daemon 以 `--codex-bridge-stack <程序目录>`（`codexBridgeStack`）启动 bridge 栈：拆分 Core（账号与模型代理）、独立 APP Server、Engine Host（`host-process` 后端，pool 明示接受不强制资源与尽力隔离）。三者是 daemon 子进程，随 daemon 停止：daemon 为每个子进程持有 stdin 管道，子进程预载 `exit-with-parent.cjs`（只在主线程），管道一断（daemon 崩溃或被杀）即走自身的 SIGTERM 正常收尾；另外下次启动按记录（核对命令行，不误杀复用的 pid）停掉仍残留的子进程，且只在持有存储锁之后启动，不会停到另一个 daemon 的子进程。Codex provider 代次按内容寻址（程序摘要 + 启动参数），重启注册同一代次；产物按摘要保存在私有目录，应用更新后旧代次的线程仍有其产物。该模式下 Core 地址、Host overlays、bridge 配置由栈提供（与显式 Core 地址或 bridge 配置互斥），新线程一律经 bridge 创建（provider bridge 的 `newThreads`），已有会话在下一次 `turn/start` 时接管。程序由 daemon 构建打包到 `dist/codex-bridge/`。

演练 `scripts/smoke/execution/smoke-codex-bridge-stack.ts`（真实原生 Codex 0.162.1 + 本地假模型 + 合成账号，2026-11-22 在 Node 26 与 Electron 44 以 Node 运行（Node 24.22，与打包 daemon 相同）下均通过）：旧 Host 建的会话在栈启动后以原 ID 续聊并保留历史；新线程经 bridge 应答；daemon 关闭时三个子进程全部退出；整栈重启后同一 bridge 线程续聊；每条输入只到达模型一次。Engine Host 重启后，声明 `adoption` 的 provider 在路由下次使用时续接已记录的原生会话，Host 仍记为进行中的轮次按原生结果收口（查不到记为中断），排队输入随后继续派发。

可复用的验证环境（Linux 云端会话与 CI 共用，均为合成账号与本地假模型 `tests/fixtures/fake-responses-model.mjs`，输出在 `.local/`）：

| 目的 | 命令 |
|---|---|
| 固定版本的原生 Codex | `bash scripts/ci/setup-toolchain.sh codex`（按 `runtime/codex` 锁文件 `npm ci`，打印可执行文件路径） |
| bridge 栈演练（任意平台） | 先 `npm run build --workspace @opencraft/opencraft-daemon`，再 `node scripts/smoke/execution/run-codex-bridge-stack-drill.mjs`（Electron 自带 Node 运行） |
| 源码桌面端到端 | 先 `npm run build:electron`，再 `node --import tsx scripts/smoke/desktop/smoke-codex-bridge-desktop.ts [--step 模块]... [--keep]`：新会话经 bridge 应答，退出后 DevTools 端口释放、该 profile 进程全部结束；无显示器的 Linux 自动用 `xvfb-run` |

桌面入口（`apps/desktop/src/codex-bridge-default.ts`）：macOS 与 Linux 默认开启，`OPENCRAFT_CODEX_BRIDGE=0` 退回旧 adapter 作应急；Windows 仍需 `OPENCRAFT_CODEX_BRIDGE=1` 显式开启，待真机验证后再改默认。开启时 Main 把打包的 `runtime/codex-bridge` 传给 daemon。已在运行的 daemon 不会因开关变化而重启，需退出应用后再开。

该模式下 daemon 不再组装旧 adapter，见“退休旧 adapter 时的其余 owner”。演练另覆盖：计划任务自行在 bridge 线程上运行；daemon 在轮次进行中重启后，Host 自行续跑该轮次且只续一次。

未完成：打包产物验收（macOS 签名包内的 `runtime/codex-bridge`）；Windows（Core 目前只支持 Unix socket）；真实账号与界面需在用户机器验证；栈中子进程意外退出后的重启策略（当前 daemon 不自动重启，Codex 请求失败可见）。

## 退休旧 adapter 时的其余 owner

线程无关的职责（账号、任务、定时、计量、附件暂存、置顶列表、模型与线程列表、初始化能力、维护状态等）移到 Thread 路由之前的 Host 服务前台 `CodexHostServices`（`apps/opencraft-daemon/src/codex-host-services.ts`）；只在旧 Host 本来就持有本地状态时（无 Core，或 Core + Host overlays）由前台接管，直通 Core 时不接管，避免同一数据目录出现两个写者。部署形态：桌面在 daemon 进程内；单机服务器在服务进程内；四容器在 gateway。

| 步骤 | 状态 |
|---|---|
| S0 桌面可开 Host overlays | 完成（显式开关，默认关闭） |
| S1 前台骨架 + 任务 | 完成：daemon 与服务器装配 |
| S2 账号 | 完成（Core 模式；无 Core 时账号池仍在旧 Host 内，它同时为原生进程鉴权） |
| S2′ 维护状态汇总、计量查询与配置 | 并入 S5：维护计数主要来自线程执行，计量的查询、配置与收集共用一份账本，单独搬会产生两个 owner |
| S3 原生元信息连接：模型（含网关过滤）、权限档案、置顶 | 完成（有 Core 时；前台经 `CodexNativeReader` 自连 Core 的 AppServer，无 Core 时原生连接是旧 Host 独占的 stdio，仍由它服务） |
| S3′ 线程列表合并、独立命令 | 线程列表依赖旧 Host 的待建线程等创建状态，随旧路径退休处理；`command/exec` 属执行，归 S5 的按线程派发与准入 |
| S4 初始化能力声明按层组合 | 完成（桌面 bridge 栈）：底层 `CodexNativeFallback` 给原生 initialize（去掉本机专属扩展，加 read-history、首轮持久化、execution-engines 基础声明）；bridge 在独占模式下把线程能力（生命周期含删除、队列 v2、跟进、目标、steer 证据）声明为整个 Host 的；各前台服务声明自己的扩展（置顶、权限模式、附件、计划任务、轮次恢复与容量重试、维护） |
| S5 作用于线程的后台职责改走“按线程派发” | 桌面完成：前台服务以 Host 自己的客户端身份经 bridge 作用于线程（与客户端同一准入、队列与命令账本），并经 bridge 新增的全线程事件流看到每个线程的事件。轮次恢复、容量重试、目标续跑（`codex-continuation-service.ts`）、计划任务（`codex-schedules-service.ts`，以运行 ID 作客户端消息 ID，重复提交即账本重放）、附件（暂存、消息记录、历史投影、分叉继承、生成文件收集，`codex-attachments-service.ts`）、标题、维护快照（含 Host 新增 `/maintenance` 队列计数）。计量：桌面 daemon 从未配置计量查询，收集无人可读，未迁移；服务器的计量与模型网关计费随服务器迁移处理 |
| S6 旧 adapter 退休 | 桌面 bridge 栈模式已不组装旧 adapter（`codex-bridge-host.ts`）；旧 Host 队列中仍排队的输入一次性交给对应线程的 Host 队列（`codex-legacy-handoff.ts`，两侧按客户端消息 ID 幂等），恢复、重试、计划、附件、任务记录由新 owner 打开同一存储，无需迁移。旧 adapter 代码仍在：桌面 `OPENCRAFT_CODEX_BRIDGE=0` 应急路径与 Windows 默认走 spawn 模式，服务器走 Core + overlays，SSH 远程走 remote 模式。退休条件见下 |

### 退休旧 adapter 的剩余条件

1. **桌面默认开启 bridge 栈**：macOS 与 Linux 已默认开启（2026-11-22，此前已用真实账号与界面验证）；应急开关 `OPENCRAFT_CODEX_BRIDGE=0` 在旧 adapter 退休时一并移除。
2. **Windows**：已实现，默认仍走旧路径，`OPENCRAFT_CODEX_BRIDGE=1` 开启。控制端点与 relay 用命名管道（按栈实例命名），原生 Codex 在 `ws://127.0.0.1:随机端口` 上以 `--ws-auth capability-token` 监听，令牌文件在私有 runtime 目录；所有客户端经 `openCodexNativeSocket`（`@opencraft/account-pool-host`）连接三种端点。子进程停止改为关闭 stdin、由预载脚本触发子进程自己的 SIGTERM 处理（Windows 没有可捕获的 SIGTERM）。Windows 专属修正：开机标识在没有 PowerShell 时退回由系统运行时长推算；写锁与恢复记录不再对目录做 fsync、不再检查 POSIX 权限位；Codex provider 用平台的 `isAbsolute` 判断工作区与文件路径。验证：`.github/workflows/windows-codex-bridge.yml` 在 GitHub 的 `windows-2022` 上运行 `scripts/smoke/execution/run-codex-bridge-stack-drill.mjs`（Electron 自带 Node、`runtime/codex` 固定的 codex.exe、本地假模型；建会话、Windows 临时工作区、经 bridge 应答、关闭无残留），相关路径改动时自动触发，也可手动触发。2026-11-22 在 `windows-2022` 上通过：三个子进程经命名管道启动、初始化、建会话（Windows 临时工作区）、经 bridge 应答、关闭无残留。过程中修正：新会话首条消息落盘前读取会话被原生拒绝（Windows 上为 rollout 文件已建但为空，连会话元数据都读不出），读取现等待该窗口（最多约 2 秒）后按“暂无轮次”回答；演练在读取被拒时记录原生 Codex 的原始错误。同次运行的 SQLite 全套测试在 Windows 上有 77 项失败，已知原因：Windows 检出把迁移 SQL 与快照转成 CRLF 导致基线校验不符（已用 `.gitattributes` 统一 LF 修正，Windows 构建的安装包同样受影响）；约十处目录 fsync 在 Windows 上 EPERM（含桌面会走到的 codex-core 账号、产物目录、daemon 计量归档）；测试本身断言 POSIX 权限位与拼接路径。后两项待单独处理，在此之前 Windows 任务不跑 SQLite 全套。命令执行、终端（ConPTY）与 Electron 界面尚未在 Windows 上验证。Windows 结论只以这个任务为准；此前在 Wine 9.0 下跑通过的同一演练只算预检（Wine 的 ConPTY、命名管道与原生模块行为不代表 Windows）。
3. **服务器（单机与四容器）**：服务器组装依赖旧路径上的协作与编排（`collaboration`、编排控制、对话工具与 `nativeTool` 动态工具）、桌面附着、工作区钩子、线程元数据与发送者、会话 MCP 的环境注入、计量查询与模型网关计费。这些在 bridge 上都还没有 owner，迁移前服务器不能切到无旧路径组装。
4. **SSH 远程 Codex** 不在退休范围：它与本地模式共享客户端复用、交互、工具、附件、元数据等核心，退休时只删本地模式（spawn、Core 直通、Core + overlays），保留并抽出远程所需部分。

## 顺序建议

1. ~~维护准入~~（已补）；模型使用策略核实为已覆盖。另：模型网关准入（`OPENCRAFT_MODEL_GATEWAY_DATABASE`，仅服务器）对 bridge 线程尚未生效，见 B。
2. ~~A 中的分叉、重命名、归档、删除、目标~~（已接线，2026-11-21，仅替身原生验证）。原生自发的线程元信息通知（名称、目标、设置、归档）已有转发通道：provider 的 `thread/notification` 回调按白名单写入 Host 事件流。
3. 排队（Engine Host 落地）、图片输入与附件。
4. ~~标题、置顶、线程设置、历史取消~~（已接线）。
5. ~~已有会话接管~~（已实现，默认关闭）；线程无关能力的 owner 拆分，然后才能进入 P8。

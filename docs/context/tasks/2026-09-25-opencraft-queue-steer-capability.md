## goal
让 OpenCraft 的排队消息 Steer 与唯一队列 owner 的真实能力一致。2026-09-25 用户要求从原生 Codex 补丁改为参考 BB/Paseo 的 Host-owned queue，并替换当前本地预览服务；Codex 只消费标准 `turn/start`/`turn/steer`。

## non_goals
- 不将 `turn/steer` 加 `thread/queue/delete` 两次 RPC 伪装为原子操作。
- 不以未经持久化/崩溃交错验证的 Rust RPC 补丁宣称 Codex 队列 Steer 已实现。
- 不提交、推送或修改生产/GitOps/云服务；当前 `/opt/opencraft-server/current` 是用户明确要求替换的本机预览服务。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-25-queue-steer`: 截图显示 `thread/queue/steer` unknown variant；用户要求完整支持并询问 DSH 是否要升级，随后授权“开搞”，包括原生补丁方向。

## interface_refs / data_structure_refs
- `opencraft/thread-queue` capability V2 中 `atomicSteer` 是真实 Host 能力声明。
- Codex 0.156.1 生成协议有 `turn/steer`、`thread/queue/start`，没有 `thread/queue/steer`。
- DSH 原生 `session.updateQueue` 的 `steer` action 是单一队列操作，Host 持久化 clientUserMessageId 与原生 rpcId。

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`、`opencraft/docs/platform-architecture.md`、`opencraft/docs/execution-ownership.md`。
- `relevant_evolution`: OpenCraft 方法表人工定义了 queue steer，DSH 实现并声明能力；Workbench 目前仅使用 queue capability 的 reorder 字段，未使用 atomicSteer。
- `superseded_refs`: 无。

## acceptance
- Codex 活跃 Turn 的队列项不展示可触发的 Steer；正常 Composer `turn/steer` 与空闲队列 `thread/queue/start` 不受影响。
- 即使绕开 UI，缺少 `atomicSteer` 的 Host 也在 Client command port 失败关闭，不把不存在的方法发给 Codex。
- DSH 原生队列 Steer 的已接纳、断线与恢复对账有聚焦测试；不把测试替身冒充进程崩溃实测。
- 聚焦测试、受影响 workspace typecheck、平台边界检查通过；如构建预览，核对包内 buildId 和真实运行态。

## affected_paths
- `opencraft/packages/composer-appserver/src/command-port.ts`
- `opencraft/packages/codex-composer/src/queue-tray.tsx`
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/tests/chat-appserver-command.test.ts`
- `opencraft/tests/chat-composer-queue.test.tsx`
- `opencraft/tests/local-agent-host.test.ts`
- `opencraft/docs/chat-ui-architecture.md`

## required_context
- 根 Context Router 查询无匹配 Pack；用有界检索定位上述代码和设计文档。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 研发边界与任务记录 | 限定部署、验证与文档 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 责任分层 | Host 能力不由 UI 猜测 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 维护方法 | 先核对对象寿命与权威 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验证矩阵 | 选择 Host/会话与迟到帧测试 |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | 队列呈现契约 | 保留 queued/steering/durable 三态 |
| `opencraft/docs/platform-architecture.md@working-tree` | Codex adapter 与 Host 边界 | 区分 Codex 与 DSH 能力 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端邻接卡 | 核对页面/测试邻居 |

## evidence
- 截图中的 Codex AppServer 拒绝 `thread/queue/steer`，错误为 unknown variant。
- 固定版本 `@openai/codex@0.156.1` 上游 `thread_queue_processor.rs` 的 `start` 明确要求空闲，活跃/待启动 Turn 返回 invalid request；`QueuedItemService` 会在空闲时自动派发。单靠 Host 串联 `turn/steer` 与 `queue/delete` 无法锁住原生自动派发。
- 2026-09-25 上游 `main` 的 `thread.rs` 也没有 `ThreadQueueSteer`。`core/src/session/turn_input.rs` 文件头明确写明 Core 在决定是否 Steer 后即回复，不等待 rollout 持久化或模型处理。因此即使在 `QueuedItemService` 的派发锁下先 `steer_turn` 再删队列，崩溃后仍可能重复；先删再 Steer 会丢消息。需要持久认领、恢复对账，以及 Core 已接纳输入的持久化边界，不能只增添路由。
- DSH 当前实现使用 `session.updateQueue(action.kind="steer")`、Thread 写租约和本地持久 queueStore；不能因此无测试地宣称所有崩溃交错已覆盖。
- DSH 重启后可能仅有本地持久 queue row、尚无对应的原生队列快照。此时原实现会把本地 row ID 当原生 item ID 送去 `session.updateQueue(steer)`，或把不确定投递的消息再次 `turn/start`；现在 Host 明确拒绝该未对账项的 Start/Steer，UI 禁用其投递按钮，避免错误或重复投递。

## risks
- 关闭 Codex 队列 Steer 后，用户需等待当前 Turn 完成，或在普通 Composer 直接提交一个新的 steer；已有队列项保持不变。
- 原生 Codex 若未来新增原子 queue steer，需升级协议、Host adapter 与 capability，再打开界面入口。自维护补丁还需固定源码/工具链、可重现构建和 crash/fault-injection 测试。

## validation
- `tests/chat-appserver-command.test.ts`、`tests/chat-composer-queue.test.tsx`、`tests/dsh-execution-authority.test.ts`、`tests/local-agent-host.test.ts`：最终聚焦测试 40/40 通过。
- 受影响 workspace typecheck（含 Web、Composer 与 Local Agent Host）、`npm run check:boundaries`、`git diff --check` 均通过。
- 根文档校验通过：退出码 0、broken first-party links 0、warnings 0。
- `npm run matrix:build -- headless-linux-amd64-tar` 与 `npm run smoke:headless:linux` 通过；归档内 `web/version.json` buildId 为 `20260925014314-dfc676efa06a`。
- 用户随后明确要求替换当前预览服务；独立 systemd 部署任务校验并切换到 release `92d67f5513476f6f`，Result=success。当前服务、健康端点、首页 HTML 和 `/version.json` 均证实新 buildId；真实 DSH AppServer 与 Codex AppHost 初始化握手通过。未验证手机旧标签刷新后的 DOM，也未做真实模型推理。

## decisions
- 未证明原生原子性前 fail closed；不利用两次 RPC 进行有丢失/重复风险的投递。
- DSH 保留既有原生队列 Steer；新增未对账项的 Start/Steer 服务端守卫和 Host 集成测试，其余原生队列路径不改。
- 用户已授权继续探索 Codex 原生补丁；Rust 构建工具链当前机器不存在，且核心回复发生在持久化之前，故安全门控与原生能力分阶段验收。不能因接口草图或编译通过就开放 `atomicSteer`。

## scan_scope
- `opencraft/packages/{composer-appserver,codex-composer,workbench-runtime}`、`opencraft/apps/{workbench-web,local-agent-host}`、相邻测试。

## scan_output
- Context Router 无匹配；有界符号检索定位 UI 按钮、command port、DSH adapter 和固定 Codex 版本的原生 QueueService。

## handoff
- 安全门控、UI 接线、DSH 恢复模型测试与未对账项守卫已实现并通过聚焦验证；原生 Codex 原子 Steer 未完成，能力保持关闭。未对账 DSH 项现在需要等待原生队列/历史回显，或由用户明确删除后重新提交；不能自动重试。
- 原生实现需至少：持久 queue claim 隔离自动派发；将 Steer 接纳与 client ID 绑定到可恢复的持久记录；Host/原生进程重启时按该记录与 rollout 对账；故障注入覆盖 claim 前后、Core 接纳前后、rollout 提交前后与响应前后；再生成协议并打开 capability。

## 2026-09-25 native prototype continuation
- 用户再次要求“要支持codex 支持steer”。官方 AppServer 文档仍仅列 `turn/steer`；npm `@openai/codex` 最新 0.157.0 的生成 schema 仍无 `thread/queue/steer`。核对源码标签 `rust-v0.157.0`，对应 commit `00c972e`。
- 在隔离 checkout `/data/codex-native-review-EpSNWz/repo` 构建了第一版原生补丁，并固化为 `opencraft/runtime/codex/patches/queue-steer-rust-v0.157.0.patch`：`queued_items.steering_turn_id` 持久认领；普通队列读取/修改/自动派发排除已认领项；新 `thread/queue/steer` 先认领再交给 Core；明确拒绝释放认领，模糊错误保留；列表与 idle 依据分页/旧式持久历史的 `client_id` 结算并提供 `steering` 投影。
- 隔离 Rust 1.95.0 位于 `/data/codex-native-review-EpSNWz/{rustup,cargo}`；基线及补丁后的 `cargo check -p codex-app-server` 通过；新增 SQLite 认领/重排/重开测试通过。AppServer 队列 suite 11/11 通过；新增进程重启前 rollout 未提交的认领保留测试通过。
- OpenCraft Codex adapter 只在原生 initialize 返回 `opencraftQueueSteerVersion: 1` 时声明 `atomicSteer`；适配器测试 6/6 和受影响 TypeScript 检查通过。头less 启动器可选择经补丁哈希、源码提交号和二进制哈希校验的原生 Codex，原版保留关闭状态。原生构建脚本已写，尚未完成实际 release 二进制构建与包内 smoke。
- 尚未完成：更多崩溃故障注入、模糊投递的人为恢复交互、跨进程同一 thread 所有权核验、多平台打包、完整发行验收与发布。上述完成前不应部署当前原型；运行中的 Codex 仍无 `atomicSteer`。

## 2026-09-25 native validation continuation
- 将认领展示区分为本进程已获 Core 接纳和跨重启送达未确认：前者 `pausedReason: null`，后者 `steer-delivery-unconfirmed`；Chat runtime 将后者显示为 unknown，不自动重投。
- 固定 tag 的原生补丁重新生成且通过 `git apply --reverse --check`；`cargo check -p codex-app-server` 通过；AppServer `thread_queue` 集成测试 12/12 通过（包含重启后认领未确认），此前 SQLite 认领专项测试通过。
- OpenCraft 聚焦测试 60/60 通过；Chat runtime TypeScript 检查、补丁与工作树 diff 检查、构建脚本语法检查通过。
- 当前仍未部署。跨进程同 Thread 的独占、异常认领的人为处置流程及生产级故障注入仍为上线前风险，不能把编译和测试通过等同于生产完整性。
- 从固定 `rust-v0.157.0` / `00c972ed5d6ff6499317fd41b7f23605b8e6850d` 加补丁完成 `cargo build --locked --release -p codex-cli --bin codex`；二进制位于忽略的 `opencraft/runtime/codex/native/linux-x64/codex`，`SOURCE.json` 的二进制与补丁 SHA-256 均同独立 `sha256sum` 一致。`codex --version` 返回 `0.157.0`。
- 直接启动产出的真实 AppServer，`initialize` 返回 `opencraftQueueSteerVersion: 1`。尚未执行整个 Headless 打包与运行服务替换；系统没有可直接调用的 npm，可复用的打包链路仍需单独验收。

## 2026-09-25 headless delivery continuation
- 本轮 context 路由查询 `opencraft Codex queue steer crash recovery multi-process ownership headless package` 无匹配 Pack；按入口在 OpenCraft 有界检索 `steer-delivery-unconfirmed|claim_steer|atomicSteer`，并核对 Headless 包装、Host 单写入者和邻接验证入口。重读根与 OpenCraft Agent 入口、维护 Skill/验证清单，以及 Chat、平台、构建矩阵和执行所有权相关段落；项目邻接卡 `frontend-runtime-openspec-i18n` 无专属 Headless 路径，转而核对相邻 `headless-server.test.mjs` 与包烟测。
- Headless Server 启动先对私有数据目录的 `server` 文件取得不重试的进程锁，再创建 Local Agent Host 与 Codex AppHost；该发行形态阻止两个服务实例共用同一数据根。原生 SQLite `claim_steer` 是 compare-and-set，但普通队列 start/自动派发仍依赖单物理 AppServer 的进程内锁，因此独立 AppServer 共用 Codex 数据库明确不支持。
- 真实 Headless 源码烟测以隔离数据目录和补丁版 Codex 通过；加强了 `smokeCodexAppHost`，断言 Host 对外的 `opencraft/thread-queue` V2 `atomicSteer` 与物理 marker 一致。最初缺少 `--import tsx` 的直接 Node 启动失败，按仓库入口重跑后通过。
- 在临时目录装入 npm 12.1.0，仅作为本机构建工具；新归档写入独立临时路径，未覆盖旧归档。完整 `package-headless-linux.mjs` 构建通过，归档烟测通过（buildId `20260925061005-791070a0dfaa`），包含清单哈希、真实 WebUI、DSH、Codex AppHost 与队列 Steer capability 验证。未替换运行服务。
- 15 个 Headless 聚焦测试、受影响四个 workspace typecheck、`check:boundaries` 通过；正式设计文档同步更新，显式 change-impact 检查通过并提示 `wisp/mono2-maintainers` Owner 复核。异常认领的人工处置产品选择已向用户询问，尚未改为自动重投。

## 2026-09-25 final capability gate and archive
- 复核发现原生 `initialize` 原先无条件声明队列 Steer，即使 `experimental_thread_store=in_memory` 时 `queue_service=None`；现改为仅队列服务实际存在才返回 `opencraftQueueSteerVersion: 1`，并新增负例测试。SQLite 正例、无 SQLite 负例通过；队列集成测试再次 12/12 通过。
- 补丁重新固化，反向应用检查通过；从固定源码完成第二次 `--locked --release` 构建。最终原生二进制 SHA-256 为 `52dde9bc876e723be090c504677574e67abed6caa59990eea2f530eb8cd34afc`，补丁 SHA-256 为 `a9e61c7e326864462b03396f86838b6c57440d731830f2794244ff80d542388d`，均与 `SOURCE.json` 匹配。
- 最终独立归档 `/data/opencraft-queue-package-iVrwZh/OpenCraft-server-queue-steer-linux-amd64.tar.gz` 构建和实包烟测通过，buildId `20260925064239-1be8486caea1`，归档 SHA-256 `cf0cb1ca6fc2a350c3d72147586c9edc461feaf244c7bdff00201b988b2ccbce`。烟测验证清单、WebUI、DSH、Codex AppHost 和队列 Steer capability。旧归档和运行中的 `/opt/opencraft-server/current` 未替换。

## checkpoint
### stage
原生未确认认领的显式丢弃恢复已实现并在做最终打包；旧归档和运行服务仍保持不变。

### verified
- 原生认领先于 Core 投递，正常/重启/无 SQLite 能力门控测试通过。
- 最终归档来自新补丁与二进制，实包启动 Host 对外声明 `atomicSteer`。
- Headless 单数据目录由进程锁独占；不支持外部独立 AppServer 共用该私有数据库。

### unverified
- 真实模型运行中队列 Steer 与手机 Web UI 操作尚未在用户账户上实测；未进行生产替换。
- 显式人工丢弃已接通 native RPC、Host/Client、Runtime 和确认 UI；不自动重投。新构建的真实归档与手机操作尚未验收。
- CI 通用 Linux runner 尚未构建该可选原生二进制；无本地二进制时 Headless 包会安全退回 stock Codex，保持按钮禁用。

### discard
- 第一版 `81e3c9de…` 二进制与 buildId `20260925061005-791070a0dfaa` 归档已被第二版门控修正取代，不能交付。

### restore
- 工作树 `/data/mono2` 有用户既有大量未提交修改，勿重置；原生源码隔离在 `/data/codex-native-review-EpSNWz/repo`，最终补丁与构建脚本在 `opencraft/runtime/codex/patches/`、`opencraft/scripts/build-codex-native-queue-steer.mjs`。
- 临时 npm 位于 `/data/opencraft-npm-bsV6pe`；最终归档路径见上。已部署服务指向旧 buildId `20260925032609-63040606d22c`。

### next_action
- 完成 Rust release 构建、更新 `SOURCE.json`、独立 Headless 归档与烟测；交接前核对未替换的运行服务。若用户选择上线，先取得明确替换授权并完成 Owner/运行态核验。

## 2026-09-25 explicit unconfirmed-claim recovery continuation
- 本轮 context 路由 `OpenCraft Codex queue steer delivery-unconfirmed explicit discard recovery` 无匹配 Pack；有界检索定位原生 QueueStore/Service、AppServer delete RPC、Client command port、Chat Runtime 和 Composer tray。重读根与局部 AGENTS、OpenCraft 维护 Skill 及验证清单。
- 新原生 `thread/queue/delete` 扩展仅在 `expectedTurnId` 与 `acknowledgeUnknownDelivery:true` 同时存在时尝试丢弃 steering claim。先在同一 thread 派发锁下严格核对持久历史；历史读取/flush 失败拒绝，当前进程已接纳或 Turn 仍运行也拒绝，最后以 thread+item+targetTurn 条件删除。普通 queue delete 不碰认领，不存在自动重投或回队列路径。
- 原生物理 marker 升到 `opencraftQueueSteerVersion:2`：v1 只保留原子 Steer，v2 才声明独立 `unconfirmedSteerDiscard` 能力。DSH 的 `atomicSteer` 不继承此能力。Runtime 从 Host steering 投影保留原 item/Turn 身份；确认对话框明确提示可能已送达、只丢弃认领、不会重发；失败留在原位。
- 原生 SQLite CAS 测试通过；AppServer 重启后无确认拒绝、错误 Turn 不删除、正确确认删除的集成测试通过；活跃 Turn 认领拒绝用例已新增，待再次执行。OpenCraft 共享层 55/55 聚焦测试通过；新增版本门控测试后 Codex adapter 7/7、相关协议/Composer/命令测试通过。七个受影响 workspace typecheck、Web Vite 生产构建与 `check:boundaries` 通过。Rust 格式检查通过。release 二进制与新归档仍在构建，旧服务未替换。

## 2026-09-25 Host ownership pivot (current)
- User explicitly replaced the native-patch plan with the BB/Paseo ownership model and requested implementation plus replacement of the current local preview service. BB owns its durable queue in the server and forwards standard Codex `turn/steer`; Paseo forwards standard `turn/steer` and distinguishes definitive rejection from ambiguous delivery. References reviewed at `ref/bb` commit `62fe3bc` and `ref/paseo` pinned `3cc4ae2`.
- Context Router query `OpenCraft Host owned durable queue Codex AppServer steer DSH ownership invariants runtime replacement` had no Pack. Bounded exact search found the existing queue task, platform/chat architecture and headless packaging. Root/leaf AGENTS, OpenCraft maintenance Skill and verification list, official Codex AppServer page, task pack, adjacent source and tests were read. Official docs state `turn/steer` appends input to an in-flight turn; they do not supply a queue-to-steer RPC.
- Host owner is the Daemon `CodexEngineAdapter` plus `CodexHostQueue` SQLite store, not Renderer or Codex's native queue. The adapter intercepts `thread/queue/*`, serializes dispatch per Thread, claims before standard `turn/start`/`turn/steer`, and never auto-retries ambiguous delivery. A definite steer rejection returns the claim to queued. Paged `thread/items/list` user-message client IDs reconcile accepted/unknown claims; explicit discard requires a matching target, idle Thread and successful negative history check.
- Before physical AppServer spawn, native queued rows are copied to Host storage and deleted; repeated migration is idempotent and malformed/conflicting rows fail closed. The current preview's native `queue_1.sqlite` read-only count was 0 rows / 0 Threads, so this particular replacement needs no row migration. A detached background Host resumes unloaded Threads before draining Host-owned queued work.
- Headless packaging now always selects stock `@openai/codex`; the historical native patch and script remain in the dirty worktree as an unused prototype, not a packaged executable. The package smoke now expects the Host extension regardless of a native marker. DSH remains a separate Host queue/native steer adapter and must pass its regression suite.
- Current focused verification: `codex-engine-adapter.test.ts` + `codex-host-queue.test.ts` 15/15 passed after fake AppServer turn/history controls; Daemon typecheck passed. Remaining: broader Chat/AppServer/DSH tests, boundaries, package build/smoke, runtime replacement and health/handshake check. No replacement yet.

## 2026-09-25 Host-owned queue release checkpoint
- Host-owned queue implementation and tests are complete. Full `npm run gate` exited 0; earlier focused suites passed AppServer 222/222, Chat 426/426 and DSH bridge 242/242. Documentation validation exited 0 with no errors, warnings or broken first-party links; boundaries, typecheck and diff whitespace checks passed.
- Stock-Codex Headless archive `/data/opencraft-host-queue-release-dn61dp/OpenCraft-server-host-queue-linux-amd64.tar.gz` passed real package smoke: buildId `20260925085957-b542a257994f`, archive SHA-256 `9549cfdfe697ef29ef1f158d1feb445102cebda94a72181c4afdf7ed78cf3a50`. It exposes Host queue V2 capabilities and contains no native patched Codex executable.
- The release was copied to `/opt/opencraft-server/releases/20260925085957-b542a257994f`; its bundled server hash matches the extracted archive. The running `current` symlink still points to `/opt/opencraft-server/releases/3c7a87d365734ac4` until the deferred switch. Host root is writable; the service's private mount namespace presents `/` and `/run` read-only. A transient systemd cutover will atomically update `current`, restart the local preview service, validate health and buildId, and roll back the symlink/service if validation fails.
- Avoid restarting the current service mid-assistant-turn: it hosts this conversation and would abort the response. The deferred cutover must be scheduled only after all in-turn checks and then reported as pending until the independent health check confirms it. True model execution and mobile UI interaction remain unverified.

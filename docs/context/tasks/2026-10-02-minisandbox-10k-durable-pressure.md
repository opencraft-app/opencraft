---
id: minisandbox-10k-durable-pressure-2026-10-02
type: task
scope: 收敛万级 active Durable Object 下 Depot 后台维护放大、交互请求饥饿与取消后 UDB 水位泄漏。
triggers: ["minisandbox 10k active", "durable storage pressure", "Depot compaction admission"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-02-minisandbox-10k-durable-pressure.md
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让设计中的万级 active Durable Object 资格门禁在保持 10,000 active、零请求重试和三秒创建
SLO 的条件下通过，并确保后台 SQLite/Depot 维护不会饿死交互请求，取消的 UDB transaction 也不会
留下虚假容量水位。

## non_goals

- 不降低 active Object 数量、heartbeat 频率或 strict receipt 标准来隐藏失败。
- 不把 `indeterminate_result` 改成透明重放；请求可能进入用户代码后仍保持不可自动重试。
- 不用手工扩 Engine/FDB、直接改线上 ConfigMap 或跳过 reviewed-source/runtime release 门禁。
- 不把单 Cell 的本次校准写成整个产品的容量上限。

## requirement_ids / requirement_refs / requirement_excerpt

- `stateless-workers-do-routing/phase-5`：万级 active Object 容量测试必须通过，随后才能生成 Router
  performance receipt。
- `stateless-workers-do-routing/phase-4`：扩容期间仍必须维持请求正确性和无人值守收敛。
- `gasoline-workflow-admission/ownership`：Depot activity admission 负责约束真实昂贵工作，不能让
  后台 compaction 争用到交互路径失去响应。

## interface_refs / data_structure_refs

- `runtime.depot_manager_refresh_max_concurrency` 与
  `runtime.depot_compaction_max_concurrency` 是每个 Engine 进程的 admission 上限；生产固定六个
  Engine，因此 Cell 上限是配置值的六倍。
- `rivet_udb_transaction_pending{name}` 必须表示当前尚未结束的 transaction；future 被取消时也必须
  恢复 gauge。
- `502 indeterminate_result` 保持现有副作用边界；修复目标是消除资源饥饿，不改变错误语义。

## history_context

- `current_design_refs`：
  `minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md`、
  `minisandbox/infra/cells/deploy/tencent/fleet/runtime/gasoline-workflow-admission-2026-09-18.md`。
- `relevant_evolution`：首轮正式 10k 因 Host HPA cohort 过大失败；改成每分钟最多六 Pod 后，第二轮
  从零积压稳定推进到 8,868 Object，但 Depot maintenance 在约 8k active 后出现 Cell 级放大。
- `superseded_refs`：不得继续使用“Engine/FDB healthy 即存储数据面无压力”的旧推断。

## acceptance

- 取消一个尚未完成的 `Database::txn()` 后，其 pending gauge 精确回到调用前值。
- 六 Engine 的生产 maintenance 并发具有经 10k 证据校准的有界默认值，源码测试和运行时渲染测试
  固化该值。
- 设计与运行文档记录第二轮失败的真实首因、不可接受的规避方案和重跑条件。
- reviewed-source、runtime 配置、Rust 聚焦测试、fleet manifest 与 mono2 context/change-impact 门禁通过。
- 新 digest 经正式 release 后，真实 10k receipt 必须满足零 retry、零 active failure、10,000 active；
  通过前不得运行或宣称 Router performance qualification 完成。

## affected_paths

- `minisandbox/engine/packages/universaldb/`
- `minisandbox/engine/packages/config/`
- `minisandbox/infra/cells/deploy/tencent/fleet/runtime/`
- `minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md`

## required_context

- `upstream-subtrees`
- `release-gitops`
- `minisandbox/AGENTS.md`
- `minisandbox/engine/AGENTS.md`
- `minisandbox/infra/cells/AGENTS.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@f06c5e0a` | mono2 P0、Task Pack 与发布边界 | 使用隔离 clone；源码、镜像和线上证据分层 |
| `minisandbox/AGENTS.md@f06c5e0a` | Engine 修改和验证约束 | 使用聚焦 cargo 门禁，不运行宽泛 fixer |
| `minisandbox/engine/AGENTS.md@f06c5e0a` | Rust/Engine 不变量 | 保持 FDB/Gasoline 正确性与协议不变 |
| `minisandbox/infra/cells/AGENTS.md@f06c5e0a` | Cell release/TAT/资格门禁 | 不绕过正式 runtime release 与真实 receipt |
| `docs/context/project/upstream-subtrees.md@f06c5e0a` | minisandbox subtree 权威归属 | mono2 是唯一源码真源 |
| `minisandbox/MONO2_SUBTREE.md@f06c5e0a` | reviewed-source 身份 | 后续镜像必须由 mono2 subtree bundle 构建 |
| `docs/context/domains/release-gitops.md@f06c5e0a` | 发布状态定义 | 构建成功不冒充 rollout/qualification 完成 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@f06c5e0a` | 发布邻接检查 | 不读取或提交 Secret；检查运行时 desired state 邻居 |
| `minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@f06c5e0a` | 用户目标真源 | 保持 10k/零重试/跨 Cell 目标完整 |

## evidence

- 第二轮 run `354610a58f4a66c7e0b4ec8d7978cbda` 从 A/B 各 4 Host、0 active、0
  compaction waiter 启动；在 8,868 created 时 strict load receipt 失败。
- 最早异常是 7 个 B Cell `502 indeterminate_result`；随后 initialize 请求失败并触发停止。同一毫秒的
  127 个 `code=20` 是取消扇出，不是 127 个独立网络故障。
- 失败前 A/B active 分别约 4,503/4,331；B 的 compaction 达 48 in-flight/1,258 waiters，manager
  refresh 达 96 in-flight/151 waiters。B UDB transaction 平均约 0.6--1.6 秒，A 约 0.05--0.12 秒；
  Engine 与 FDB CPU 均未饱和。
- B Engine 日志证明 `pegboard_actor_get_for_gateway`、SQLite commit 与 Depot compaction 同时进入秒级，
  随后出现 FDB transaction timeout 和 workflow worker pull deadline。
- 清理后 active/workflow 几乎归零而 `udbPending` 仍保留约 A 2,640/B 9,513，源码检查确认
  `Database::txn()` 只在 `.await` 正常返回后 decrement，future cancellation 会泄漏 gauge。
- 线上精确配置由 TAT `inv-d9d2fmgmp3` 确认为每 Engine refresh=16、compaction=8；六副本实际
  Cell 上限分别为 96/48。

## risks

- maintenance 并发过低会使 FDB hot tail 增长：真实 10k trace 必须同时观察 hot bytes、compaction
  waiter 年龄和 cold publish 追赶速度，而不是只看 HTTP 成功。
- 只扩 FDB process 不会消除进程级 activity 放大；CPU/health 绿色也不能证明延迟安全。
- 运行时参数变更必须随新 digest 发布；直接 patch ConfigMap 会制造不可重建漂移。

## validation

- `cargo test -p universaldb --lib pending_transaction_gauge -- --nocapture`：1 passed；真实 RocksDB
  transaction 进入 closure 后 abort，等待 cancellation 完成再检查 gauge，同时检查成功和失败返回。
- `cargo test -p rivet-config --test runtime -- --nocapture`：10 passed。
- `python3 -m unittest minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_render_runtime_config.py -v`
- `bash minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file <每个变更文件>`：passed。
  jj 没有 staging；显式文件清单避免对 parent HEAD 执行空变更检查。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`
- runtime render unittest、shell syntax、fleet manifest invariants、documentation validator 均通过。
- `cargo clippy -p universaldb -p rivet-config --lib -- -W warnings`：exit 0；保留现存代码告警，未运行
  broad fixer。
- 全量 Context validator 与 context unittest 存在其他服务历史文档失败；须与 parent 基线比较，不能
  将执行检查等同于全量通过。此任务不修改其他服务的历史 Task Pack。
- 与干净 f06c5e0a worktree 比较：Context validator 的 4,798 条错误在路径归一化后完全一致；
  两边 context unittest 均为同样四个历史失败。context-audit 的 33 项测试通过；本轮未新增 Context
  失败，任务自身 schema 检查无错误。

## decisions

- 先修准确水位和每进程 maintenance 上限；不把请求超时、重试或 active 数量调松。
- 生产 Engine 保持固定六副本；若未来改变 Engine 副本数，必须重新计算并验证 Cell 级 activity budget。
- 只有新 digest 的真实 10k 通过后才生成 Router performance receipt。

## scan_scope

- UniversalDB transaction metrics、Depot admission、runtime render/release defaults、10k trace 与设计文档。

## scan_output

- 云上只读诊断通过 TAT invocation 留存；不包含 token、Secret、kubeconfig 或对象 payload。

## handoff

- 当前状态：源码取消清理、8/2 maintenance 默认值、真实取消回归和配置/manifest 检查已完成；
  新 runtime release 与 10k 重跑尚未完成。

## checkpoint

### stage

源码与文档门禁完成后推 mono2/master；线上容量资格仍未通过。

### verified

- pending gauge 在真实 transaction cancellation、success、error 三条路径恢复基线。
- Rust runtime 配置 10 项测试通过，production install/release/render 使用相同的 8/2 默认值。
- 原 f06 候选镜像已构建并推送，真实 workerd process 6 项测试通过；它尚未包含本轮修复。

### unverified

- 本轮新 digest 的正式 A/B release、ACK 故障门禁、strict 10k 和 Router performance receipt。
- 低 maintenance concurrency 能否同时保持 hot tail 有界和 cold publish 进度。

### discard

- 上轮 127 个同时间 cancellation 不能当作 127 个独立网络故障。
- 旧 pending gauge 不能用来证明清理后仍有真实交易积压。

### restore

- 当前开发在 mono2 的独立 jj revision；parent 为 f06c5e0a，原 dirty 工作区保持不动。
- 真实 10k run 354610a58f4a66c7e0b4ec8d7978cbda 的 cleanup/downscale invocation 必须先确认终态。

### next_action

- 将通过验证的源码推 master，再生成绑定 mono2 commit/minisandbox tree 的 reviewed-source bundle。

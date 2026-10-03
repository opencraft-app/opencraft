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
reviewed_at: 2026-10-03
review_due: 2026-11-02
revision: 1.8.4
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

- 用户追加要求：解释性能劣化并从建模设计解决，不能只靠调参数或增加机器。
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
- Gasoline debug history 按 signal index 分组多个 input chunk；调试读取不能把合法多块信号
  误判为历史损坏。生产 replay、持久编码与当前负载 Runtime 不变。
- Gasoline activity execution attempt 使用固定 succeeded/error/timeout 结果。新源码显式准入
  不计入 execution timeout；旧 Runtime 仍含排队。正常返回 retryable 业务结果不是有效 fold。
- Depot 的 refresh/compaction lane 仍各为每进程 8/2 执行许可，等待槽各最多 64/16。
  准入最多 30 秒，超出后通过 exact lease 延后 60--120 秒，不记录 execution failure event。
- manager 新迭代在任意 active job 期间执行有界观察，`planning_deferred=true` 不是无待办工作。
  force completion、quiescing 与派发新计划必须等待完整 refresh；生命周期停止与 fallback timer 不跳过。

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
- active job 观察的读取量与历史 tail 大小无关；不能清 dirty、完成未执行 force 请求或跳过
  生命周期停止。旧完整 activity 与新观察均可持久回放，普通规划不增加版本事务。
- 明确排队与执行预算；真实 production workflow handler 必须在延期时释放 exact lease、
  保留 input、重启恢复且不耗尽执行失败次数。实际 execution timeout 和数据 fence 不削弱。
- 新 digest 经正式 release 后，真实 10k receipt 必须满足零 retry、零 active failure、10,000 active；
  通过前不得运行或宣称 Router performance qualification 完成。

## affected_paths

- `minisandbox/engine/packages/universaldb/`
- `minisandbox/engine/packages/config/`
- `minisandbox/engine/packages/gasoline/`
- `minisandbox/engine/packages/gasoline-macros/`
- `minisandbox/engine/packages/depot/`
- `minisandbox/docs-internal/engine/sqlite/components.md`
- `minisandbox/infra/cells/deploy/tencent/fleet/runtime/`
- `minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/`
- `minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- `minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/`
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
| `minisandbox/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/runner.mjs@d7ff0a90` | 实际负载语义 | heartbeat 包含持久 state 与操作记录写入，不能等同 keepalive |
| `minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/run-on-builder.sh@d7ff0a90` | 固定到达模型 | 10k/十秒目标节拍、实际发起率与成功率分开 |
| `minisandbox/engine/packages/depot/src/workflows/db_manager.rs@d7ff0a90` | 当前等待机制 | exact 成功续批与失效后的维护周期分开 |
| `minisandbox/engine/packages/gasoline/src/db/kv/mod.rs@d7ff0a90` | 诊断存储路径 | workflow 索引还须包含 Cell namespace，旧无 namespace 查询不能证明工作流不存在 |
| `minisandbox/engine/packages/gasoline/src/db/kv/debug.rs@02f3c676` | 诊断反例 | 新 signal index 与同一输入后续 chunk 的检查分开 |
| `minisandbox/engine/AGENTS.md@02f3c676` | 本轮 Rust 验证 | 新测试放在 tests/，私有键 fixtures 使用最小 cfg(test) shim |
| `minisandbox/.claude/reference/testing.md@02f3c676` | 测试环境 | 从 minisandbox 执行 Cargo，加载 tokio_unstable；真实 RocksDB/memory PubSub |
| `minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@02f3c676` | 发布邻接真实测试 | 复核失联不能重复发作业，失败收据不得冒充资格成功 |
| `AGENTS.md@3989cb4d`、`minisandbox/AGENTS.md@3989cb4d`、`minisandbox/engine/AGENTS.md@3989cb4d` | 本轮源码与测试约束 | 不改重试或持久 schema，新 fixture 放在 tests/ |
| `docs/context/project/upstream-subtrees.md@3989cb4d`、`docs/context/project/adjacency/argocd-ci-secrets.md@3989cb4d` | 路由与邻接 | mono2 唯一真源，检查实际 monitor 测试而非只读摘要 |
| `minisandbox/docs-internal/engine/sqlite/components.md@3989cb4d`、`minisandbox/docs-internal/engine/sqlite/storage-structure.md@3989cb4d` | 后台成本与 fence | 排除全局 ledger 争用假设，不去掉 committed-prefix/PITR 校验 |
| `minisandbox/engine/packages/gasoline/src/ctx/workflow.rs@3989cb4d`、`minisandbox/engine/packages/depot/src/admission.rs@3989cb4d` | 超时所有权 | execution timeout 当前包含 admission 排队，以真实 semaphore 验证 |
| `minisandbox/engine/packages/depot/src/workflows/db_manager.rs@10b8b6d2`、`minisandbox/engine/packages/depot/src/compaction/shared.rs@10b8b6d2` | 无效规划路径 | 已有 active job 时仍完整读取 DELTA，最终无法派发 |
| `minisandbox/engine/packages/depot/src/compaction/companion.rs@10b8b6d2`、`minisandbox/engine/packages/gasoline/src/ctx/workflow.rs@10b8b6d2` | 完成与回放所有权 | 不丢 dirty、完成信号或旧 activity，显式区分观察与规划 |
| `minisandbox/docs-internal/engine/sqlite/constraints-and-design-decisions.md@10b8b6d2` | 数据 fence | 仅消除规划读取，不删除 stage/install/PITR/lifecycle 校验 |
| `AGENTS.md@4857746f`、`minisandbox/AGENTS.md@4857746f`、`minisandbox/engine/AGENTS.md@4857746f`、`minisandbox/infra/cells/AGENTS.md@4857746f` | 本轮所有权与验证 | 只改源码和本地回归，不写云上配置或发布 workerd |
| `docs/context/project/upstream-subtrees.md@4857746f`、`minisandbox/MONO2_SUBTREE.md@4857746f`、`docs/context/domains/release-gitops.md@4857746f`、`docs/context/project/adjacency/argocd-ci-secrets.md@4857746f` | 源码、发布和邻接 | mono2 唯一真源；源码通过不冒充 Runtime 发布 |
| `minisandbox/.claude/reference/testing.md@4857746f`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@4857746f` | 测试与发布邻居 | 真实 RocksDB/memory PubSub；不重启失联云作业 |
| `minisandbox/docs-internal/engine/sqlite/components.md@4857746f`、`minisandbox/docs-internal/engine/sqlite/constraints-and-design-decisions.md@4857746f`、`minisandbox/docs-internal/engine/sqlite/storage-structure.md@4857746f` | 后台工作与安全边界 | 准入不取得数据权威，保留原 publication/lifecycle/backup fence |
| `minisandbox/engine/packages/gasoline/src/ctx/workflow.rs@4857746f`、`minisandbox/engine/packages/gasoline/src/error.rs@4857746f`、`minisandbox/engine/packages/gasoline/src/worker.rs@4857746f`、`minisandbox/engine/packages/gasoline-macros/src/lib.rs@4857746f` | admission/execution/replay | 独立有界准入、可取消；由原 exact-lease handler 持久延期 |
| `minisandbox/engine/packages/depot/src/admission.rs@4857746f`、`minisandbox/engine/packages/depot/src/compaction/companion.rs@4857746f`、`minisandbox/engine/packages/depot/src/workflows/db_hot_compacter.rs@4857746f` | job 恢复和故障边界 | 不丢 signal、伪造完成或移动 StageBeforeAdmission fault 到许可之后 |
| `minisandbox/infra/cells/deploy/tencent/fleet/runtime/README.md@3d03bf6a`、`minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/build-runtime-via-tat.sh@3d03bf6a`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/reuse-stage-from-runtime.sh@3d03bf6a` | 实际发布入口与 compiled-input closure | 先证实 workerd 复用，不绕过 source、ABI、资源及凭证边界 |
| `minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/test_runtime_build_log.py@3d03bf6a`、`minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/test_build_parallelism.py@3d03bf6a` | 发布邻居真实测试 | 原 invocation 失败须保留；有界日志、退出状态、CPU/内存限制不变 |
| `AGENTS.md@1a724a3c`、`minisandbox/AGENTS.md@1a724a3c`、`minisandbox/infra/cells/AGENTS.md@1a724a3c`、`docs/context/domains/release-gitops.md@1a724a3c`、`docs/context/project/upstream-subtrees.md@1a724a3c` | 本轮发布和观察工具边界 | 单独工具身份，不修改原 build、负载参数或线上容量 |
| `minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/test_observe.py@1a724a3c`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh@1a724a3c`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@1a724a3c` | 真实诊断和发布邻居 | 单次有界查询；失败 job 不重复发起；完整持有发布锁 |
| `AGENTS.md@69098b68`、`minisandbox/AGENTS.md@69098b68`、`minisandbox/infra/cells/AGENTS.md@69098b68`、`docs/context/project/upstream-subtrees.md@69098b68`、`docs/context/domains/release-gitops.md@69098b68` | 本轮恢复工作与发布边界 | 只记录确证阶段；维持 immutable invocation、完整锁和原性能门禁 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@69098b68`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@69098b68`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/verify_bottomless_receipt.py@69098b68` | 邻接、故障与收据资格 | 原作业不重发；原字节 SHA 和正式 production-cell profile 重验 |
| `minisandbox/engine/AGENTS.md@73598bca`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/qualify-runtime.sh@73598bca`、`minisandbox/infra/cells/deploy/tencent/qualify_workerd_density.py@73598bca`、`minisandbox/engine/packages/depot/src/compaction/shared.rs@73598bca` | exact cold 等待的真实条件 | 区分 cache override、checkpoint publication、PITR/history pin 及安全回收，不由总等待推断单一瓶颈 |

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
- 以上是失败轮的历史配置，不是当前配置。新 Runtime source `072e504b` 保持六 Engine、
  每进程 8/2；名义 Cell 总上限 48/12，不等于已校准的有效吞吐。
- A 新 release、48 对象 production-cell Bottomless 和 Engine HA 已通过，冷态等待约 973 秒；
  B 原发布 invocation `inv-e9dx3fg9p5` 已 SUCCESS/0，Bottomless、Engine HA 和 activation 均通过。
  两项均不能替代 strict10k 或百万 dormant 的证据。
- 新只读观察工具 source `d7ff0a90` 已落到 builder：`inv-d9dxb0g9gs` SUCCESS/0，
  manifest 摘要前缀 `b2bfa893`（完整身份保留在 source receipt）。
  tools 与 Runtime 来源分开绑定，不因此重编 workerd。
- 当前 fixture 源码确认每个 heartbeat 写 state 和新的 operation 去重结果。十秒周期的
  10k active 目标约为 1,000 次持久交互/秒；每对象一个在途请求会在迟到时降低实际到达率。
- 原始 A/B Bottomless/HA 收据归档到 fleet `runtime/evidence/`，未重写 JSON。两 Cell 的
  exact cold 均为 48/48，等待约 973/964 秒；HA 各 1,500 公共请求、零失败。
- 首个 strict10k preflight 的 B `CapacityEvidenceMissing` 失败已保留。只读
  `inv-e9e0300ee9` 证明证据到达后 readiness 自然恢复，不 patch 状态或重复 B release。
- 新 run 首段只读 `inv-d9e08dgdx4`：约 270 秒，384 ready、5,275 active 成功、零
  terminal failure，但 warmup 容量背压重试 2,418 次，就绪最大约 78 秒。不是全程零重试
  或三秒创建证明。相邻样本 A/B 各六 Ready Host，desired 10/11，后台 admission 队列为零。
- 新只读 `inv-c9e9u20q2x` SUCCESS/0，故障前末五分钟 A/B manager read 为
  23.16/24.19 MB/s、hot stage 为 9.22/7.00 MB/s；manager attempts 平均 1.460/1.453。
  每 Pod 一分钟 CPU 峰值最高约 2.09/2.34 cores。业务输入 bytes 未齐，不能声称写放大倍数。
- 同窗 stage attempt 平均耗时 27.77/28.26 秒、install 为 26.40/26.33 秒。旧 activity
  histogram 将 timeout/error/success 合并，不能将完成率视为有效 compaction 或计算 timeout 比例。
- 原始 718,367-byte work-amplification.json 已经 COS relay 验 SHA；完整 SHA、builder 路径、
  时间窗口与证据限制记录在 strict10k evidence README，不把原始大文件加入 Git。
- 真实 RocksDB/UDB 与生产 ActivityCtx fixture 证明 admission semaphore 等待可以在数据工作
  开始前产生持久 activity timeout。新的固定 result metric 在 history write 前观察执行结果；
  成功输出 replay 不重复计数。未修改 durable event、activity timeout/retry 或发布 Runtime。
- 160 个真实 commit 的新 fixture：active observation 读取小于 4 KiB，完整规划读取超过其
  100 倍；此比值仅证明此路径的读取成本，不是生产请求速度或集群容量的倍率。
- 七项真实存储/history 回归覆盖有界观察、恢复规划、旧完整事件回放、新观察回放不重复读、
  普通规划单 activity、force/timer 不误完成、非 live/畸形 metadata 失败关闭。
- 新显式准入 fixture 已证明连续三次 deferred 仍保留同一 job/input、不写 execution error，
  production handler 每次释放 lease；等待跨越原 execution deadline 后仍能取得许可执行。
  worker stop、真实 execution timeout 和持久 output replay 分开验证，未提高执行超时或重试数。
- 有界 FIFO pool 验证 10,000 次 overflow 均立即延后、accepted waiters 顺序和取消/到期释放容量；
  这是本地算法回归，不是万级业务压测。真实 stage 前/后 head advance 三项及 branch GC 七项通过。

## risks

- maintenance 并发过低会使 FDB hot tail 增长：真实 10k trace 必须同时观察 hot bytes、compaction
  waiter 年龄和 cold publish 追赶速度，而不是只看 HTTP 成功。
- 只扩 FDB process 不会消除进程级 activity 放大；CPU/health 绿色也不能证明延迟安全。
- 运行时参数变更必须随新 digest 发布；直接 patch ConfigMap 会制造不可重建漂移。
- FIFO 只保证已接受的进程内等待者，不保证过载时所有 deferred job 全球公平或最终准入。
  延期仍有 due/replay 成本，并可能延后完成/停止信号处理；必须测 hot-debt 斜率与有效 service rate。

## validation

- 本轮 checkpoint：documentation 0 errors/0 warnings；Context 4,942 个历史错误在
  SHA 归一化、保留重复次数后与 12080 基线完全相同，当前 Task 无错误。context 26 项仍为
  原四项历史失败，audit 33 项通过。真实 monitor 五项与 operation-lock 回归通过；
  两个待执行阶段 wrapper 和 A 提交 wrapper 的 shell syntax 通过，不冒充云端阶段验收。
- 本轮 observer 21 项回归通过：同一个真实 loopback HTTP 请求保留显式准入/执行和规划
  transaction 的独立维度；缺失不当作零，未知/跨阶段维度失败关闭。新维度最坏 154 行
  fixture 保持原 1 MiB/256 行上限，既有八个容量字段不变。不是云端吞吐证明。
- 本轮观察工具不改变 source 59e86519 的原 build，也不触发 workerd 构建；新工具须在
  正式 strict10k 前通过独立 reviewed-source 身份部署，负载数、频率和重试规则不变。
- 原 strict verifier 15 项通过；full fleet manifest invariants 通过，manifest e8aa3e5b。
  documentation 0 errors/0 warnings，显式五文件 change-impact 通过（matched_rules 为空，
  不冒充语义评审）。Context 4,942 个历史错误归一化 digest 后逐项相同，当前 Task 无错误；
  26 项 context 测试仍为同样四项历史失败，audit 33 项通过。没有 Rust 改动或本地重编译。
- 本轮 builder Python 修正：3 项回归通过，真实子进程在旧 default 位于 PATH 首位时
  仍使用 Python 3.11，支持原失败的 subprocess 接口；错误 interpreter 失败关闭，主机默认不变。
  构建 parallelism 9、prepared stage 9、bounded log 1、stage closure 14 项通过，共 36 项。
  原脚本在新契约测试中三项均失败；真实 Python 3.6 故障证据来自原云 invocation，
  不把测试中缺少新 shim 的失败混称为完整旧解释器仿真。shell syntax 与 diff 检查通过。
  full fleet manifest invariants 通过，新增 Python 回归进入 permanent materialization gate；
  documentation 0 errors/0 warnings，audit 33 项通过且实际 audit exit 0。
  Context 仍为相同 4,942 个历史错误，归一化 digest 后与 3d03bf6a 基线逐项相同，
  当前 Task 无错误；26 项 context 测试仍为同样四项历史失败，不称全量通过。
- 本轮独立准入：Gasoline lib 33 passed、Depot lib 56 passed，真实存储/production handler
  覆盖延期重启、same input、新 lease、stale owner fencing、排队取消、实际执行超时、
  output replay、pre-admission output 及直接宏调用不绕过准入。
- 本轮真实 `test_driver` 3、`head_advance` 3、branch GC 7 passed；没有物理恢复或云端变更。
  Gasoline 默认路径 `activity_ctx` 两项真实 worker 集成也通过，验证 state/property 行为不变。
  `cargo check --offline --locked -p rivet-engine` exit 0，默认 clippy exit 0；Depot 保留
  48/50、Gasoline 保留 139/140 现存库/测试 warnings，新准入 fixture 无 warning。
- 本轮 documentation validator 0 errors/0 warnings；Context 4,942 个历史错误与上一基线
  在归一化 SHA 后完全相同，当前 Task 无错误。context 26 项测试仍同样四个历史失败；
  audit 33 项测试 passed，实际 audit exit 0。未将历史全量失败称为全量通过。
- 本轮 Depot lib：54 passed，包含七项 active observation 回归；真实 manager/companion
  `test_driver` 三项、`head_advance` 三项、branch GC 七项均通过。
- 本轮默认 clippy `--lib --tests -- -W warnings` exit 0，库/测试保留 48/50 warnings，
  新 fixture 无 warning。最初发现旧 GC `never_loop` 错误，等价改为 match；activity 顺序、
  requeue、lifecycle fence 与删除条件不变，七项真实 GC 回归通过。未加入 lint allow 或宽泛 fixer。
- 本轮 `cargo test --offline --locked -p gasoline --lib -- --nocapture`：25 passed，包含
  成功与生产 history replay、用户错误固定标签、admission queue timeout 三项新真实存储回归。
- 本轮 clippy exit 0，库/测试保留原 139/140 warnings，新 fixture 无 warning；documentation
  validator 0 errors/0 warnings，显式六文件 change-impact 通过，Context 仍为 4,942 个历史错误，
  当前 Task Pack 无错误。没有把空 changed-files 检查作为门禁证据。
- 本轮 `cargo test --offline --locked -p gasoline --lib`：22 passed，真实 RocksDB/memory PubSub；
  聚焦 debug history 四项均通过。旧 reader 多块失败反例已经执行，不修改生产 replay。
- 本轮 `cargo clippy --offline --locked -p gasoline --lib --tests -- -W warnings`：exit 0，保留
  现有库/依赖告警；新 debug_history fixture 无告警。不运行 broad fixer。
- 原 trace SHA 验真后在本地复算 strict verifier：预期 exit 1，四组
  verdict/checks/expected/evidence 与原云端收据逐项相同。strict verifier 15 项单测通过。
- documentation validator：0 errors/0 warnings；原字节三份终态收据 SHA 与 builder 一致。
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
- 报告目标节拍、实际 attempts/s、成功/s、有效 reclaim、计划重做与债务趋势；容量模型
  不得仅使用活跃 Object 数或平均 CPU。未来 Engine 扩容必须重新约束 Cell 总后台预算。

## scan_scope

- UniversalDB transaction metrics、Depot admission、runtime render/release defaults、10k trace 与设计文档。

## scan_output

- 云上只读诊断通过 TAT invocation 留存；不包含 token、Secret、kubeconfig 或对象 payload。

## handoff

- 当前状态：历史 Runtime 072e504b 的 A/B release/Bottomless/HA/activation 已通过，
  其 strict10k 失败后精确清理和自然缩容完成。性能修正 source 59e86519 已实际通过 stage
  reuse、Engine/Host 编译和产品 cold pull；A 的正式 rollout/Bottomless/HA/activation 已通过。
  B 的同产品 rollout/Bottomless/HA/activation 也已通过；strict10k 新 run 已实际启动。
  新诊断工具已独立交付且真实 A/B 查询通过。不能把源码、小规模资格或模型文档
  标为万级容量问题已解决。

## checkpoint

### stage

A/B 旧 Runtime 资格完成；strict10k 终态失败。新 Runtime 59e86519 的 reviewed build、
workerd reuse、产品 cold pull 和 A 正式 rollout/Bottomless/HA/activation 均已完成。
B 原 invocation 已 SUCCESS/0，完成新产品全部资格。strict10k 新 run 从 A/B 各四 Host/Node
开始实际负载，Runtime 59/tools 120/API 723 独立绑定；新诊断信号完整、无采样 warning。
小资格负载或首批 warmup 成功不证明 strict10k 通过，
原零普通重试、万活跃及三秒创建门禁不放宽。

### verified

- B 原 `inv-a9ednt0v6b` SUCCESS/0，02:58:56 UTC 进入资格、03:17:42 UTC 激活。
  只读 `inv-d9eeevgn90` 用正式 production-cell verifier 复验：48 对象、6,240 写入、
  48/48 exact cold、964,391 ms 冷态等待；cold wake p95 约 1,115 ms、max 约 4,295 ms。
  HA 1,500 请求零失败、清理 passed。Bottomless/HA/activation SHA 前缀分别为
  72b394d5/beb2c656/5cad44f8，最终 allow control SHA 前缀 1323ce56，warnings/failures 空。
- strict10k run `55b558752ba2454987491cdea655ff68` 已提交一次：`inv-c9eef1012r`
  SUCCESS/0 只证明 supervisor 提交。真实 systemd InvocationID 为
  `8ee84c21e87944c983932c62a5df5c56`，MainPID 4004295；没有重发或借用旧 run。
  `inv-e9eeg5gs9d` 只读证明 service active/running、完整 preflight 通过、initial low
  成功。实际首个 progress（约 45 秒）54 ready、44 proven、72 active success，零普通
  retry/失败/身份错配；16 Version 已发布，尚未进入 post-warmup 三秒创建样本。
  同窗 A/B observer 各 91/87 samples、新诊断无 missingSignals/warnings；容量仍各四。
  输出根为 `load-tests/ten-thousand-active-55b558752ba2454987491cdea655ff68`，无终态收据。
- B 非 Secret 三文件 archive `inv-c9eeg60ccv` SUCCESS/0，23,898 bytes、SHA 前缀
  162c2f62，原收据逐个 SHA 校验通过；官方 COS relay `inv-e9eegtgjv4` /
  `inv-e9eegugnbr` SUCCESS/0，本地 archive 和 exact 三个普通 member 原始 SHA 均一致。
  解包目录 `b01-qualified.sCoN2Z`，本地正式 production-cell verifier 再次通过。
- 本轮性能归因复查：正式 qualifier 的 cold-cache retention override 为 1 ms，
  exact cold 等待仍同时要求 checkpoint watermark、cold_ready、head 不回退及写债边界。
  因此 954 秒不是默认自然冷降耗时，也不能单独归因于缓存 TTL 或 COS 带宽；必须分阶段观察。
  B 曾在 Bottomless hold（03:14:25 UTC，`inv-d9eea8g9tf` 只读确认），之后已通过；
  没有修改 Runtime 或在资格前提交 strict10k。后续继续跟随上述唯一活跃 load run。
- 本轮有界查找中 `docs/context/catalog.json`、`deploy/tencent/qualify_runtime.py` 与
  `depot/src/branch/reclaim.rs` 不存在；已分别从 validator、正式 qualifier 和
  `depot/src/compaction/shared.rs` 定位实际路径。没有扩大到无关服务或读取凭证。
- A 原字节收据重新验证 `inv-a9edtugu8q` SUCCESS/0：production-cell profile，48 个
  Actor、6,240 次写入、48/48 exact cold，冷态等待 954,465 ms（约 15.9 分钟）；
  cold wake p95 约 942 ms、最大约 4,494 ms。HA 1,500 请求零失败，清理通过。
  claim_eligible=false 是此 48 对象 profile 的边界，不声称已通过更大 profile 或 strict10k。
- A 三份非 Secret 资格收据经 exact SHA 和 credential-shaped 字段检查后归档：
  `inv-e9ee1b0pwp` SUCCESS/0，24,007-byte archive SHA 前缀 d8cface6，完整摘要保留在
  原 invocation 及本地 archive 验真记录。
  官方 COS relay `inv-a9ee1ngcfx` / `inv-d9ee1pgrdj` SUCCESS/0，下载后 SHA 一致；
  本地为 `/data/actor-build/local-admission-59e86519-20261003/qualified-a01-evidence.tar.gz`。
  本地已检查 exact 三个普通 archive member、各原始 receipt SHA，正式 production-cell
  verifier 通过；解包目录 `a01-qualified.C8Dbwq`。不复制 kubeconfig 或 Secret。
- B 只读 `inv-d9edukgvhr` SUCCESS/0（02:59:53 UTC）：六 Engine、四 Host 均已更新至
  05840b48，Ready 数达标；02:58:56 UTC 获得 exact Host UID 的 qualification hold。
  post-control 只因新 Bottomless/HA 收据尚缺而 block，未人为解除。原 `inv-a9ednt0v6b`
  仍 RUNNING；不能把 rollout 就绪当成最终资格通过。
- strict10k run `55b558752ba2454987491cdea655ff68` 监督 launcher SHA 前缀 a2e1d18c，
  保持 Runtime 59/tools 120 和原负载参数；仅在 B qualification activation 通过后提交。
  15 项 strict、21 项 observer、五项 monitor 回归再次通过；
  此轮未修改或重新编译 Runtime。
- A 原 invocation `inv-e9ecw30f8e` 已 SUCCESS/0，输出依次证明 rollout、Bottomless、
  Engine HA、qualification activation passed。新产品 digest 05840b48、source 59e86519、
  manifest 24b265e9，未借用旧 072 资格。新 Bottomless 原字节 SHA 前缀 `83728114`，
  HA SHA 前缀 `1c5fb716`；activation 于 02:51:09 UTC 生成，SHA 前缀 `a75656d0`，
  最终 control SHA 前缀 `d6637bfc`，image inventory SHA 前缀 `814cd243`。
- B 正式 release/qualification `inv-a9ednt0v6b` 已 detached 提交。同一 d39e86f5 wrapper
  和 c8dac029 产品 receipt；本地 waiter session 22706，每五分钟恢复原 invocation，不重发。
- A 只读配置 `inv-e9ed4n0u05` SUCCESS/0：真实 refresh/compaction 8/2、workflow 上限
  4096、4 MiB 对象、write-debt target/limit 10/12 MiB；ConfigMap UID d2f333dc，
  config hash 前缀 11c5aefb。未通过手工提高 timeout、重试或容量规避本次负载。
- observer `inv-d9edjngwtw` SUCCESS/0（02:50 UTC）：A/B 各一次 query，91/60 finite
  samples、无 warning；A 新四类 admission/execution 信号完整，B 仍为预期 unknown。
- 只读成本采样 `inv-d9edmb0rgk` SUCCESS/0（02:52 UTC，五分钟 rate 窗口）：A 的
  active observation 约 1.354 完成事务/s、165 bytes/完成事务、平均 attempts 1.0；
  完整 refresh 约 0.202 完成事务/s、76,285 bytes/完成事务、平均 attempts 1.0。
  此时 active observation 平均实际执行约 8.05 ms、已完成准入约 11.6 us。
  这些是小资格流量下的完成者样本，不是 strict10k 对照；不能把旧 605 KB 与新 165 bytes
  直接当同一业务工作的收益，也不能由 null 推导零 timeout 或由 succeeded 推导有效 fold。
- source `59e865199b8d841e6c8ecb6469240c3be13d12ab` 的 full bundle 已在本地生成并验真，
  14,273 文件，manifest 前缀 `24b265e9`。新本地监督服务
  `minisandbox-admission-runtime-build-59e86519-20261003.service` 的 InvocationID 为
  `5e68a0bf8b094b3a84d9f745bae85259`；构建成功后临时 unit 已回收。materialization
  `inv-e9ebxa0pb1` 与 build preflight `inv-d9ec0qg3pu` 已 SUCCESS/0。实际 build
  `inv-c9ec0u0g61` 已 SUCCESS/0，没有重启原失败服务或旧 TAT invocation。
- 实际产品 image digest 前缀 `05840b48`，source 59e86519 / manifest 24b265e9，
  `registryPullVerified=true`。产品原字节 receipt 经 COS 下载，SHA 前缀 `c8dac029`，
  路径 `/data/actor-build/local-admission-59e86519-20261003/product-runtime.receipt.json`。
  native build log SHA 前缀 `3fb01b46`；Engine 编译 25m28s，Host 编译 2m22s，六项实际
  workerd_process 测试通过。构建成功不等于集群发布或吞吐门禁成功。
- A 正式 release/qualification 使用已验 SHA 的 d39e86f5 wrapper 与 exact c8dac029 产品，
  原 invocation 的最终成功证据见本节开头，不发重复作业。
  新资格根路径使用 `runtime-admission-59e86519...-c8dac029...`，不能借旧 072 的资格。
- 只读 `inv-e9ed000sws` SUCCESS/0（02:29 UTC）：A 的正式 pre-control 为 allow，
  failures/warnings 均空，exact Host UID 的 release hold 已获得。此时 Engine/Host
  仍是旧 image，证明流程已进入受保护发布，不表示 rollout 或 qualification 已通过。
- 实际 stage receipt `runtime-stage-reuse-59e86519...-uKwrsV.json` verdict passed，
  SHA 前缀 `e00cf451`。完整 receipt 在 builder `/data/actor-qualification/builds/`，绑定
  source 59e86519、manifest 24b265e9、stage projection a48e6285、artifact 614a6a8c，
  workerd buildJobs=0；不是仅靠旧 label 或本地回归宣称二进制可以复用。
  只读 `inv-e9ecsf0fn7` SUCCESS/0（02:23 UTC）：scope
  `actor-bj-a01-runtime-build-59e865199b8d-uKwrsV.scope` active/running，真实日志已编译至
  rivet-workerd-host；该时点尚无产品 receipt，后续原作业已成功。没有重编 V8 或新建重复构建。
- 新 tools source `12080fbe94ac5b39324a98c7a3ec60d82b87f6c1`，manifest 前缀
  `952b0513`（完整 SHA-256 保留在 immutable source receipt），14,273 文件；
  materialization `inv-a9ech8gnfh` SUCCESS/0，独立 immutable tree 完整校验通过，未改变
  promoted source link、Runtime 构建或线上容量。监督临时 unit 已回收，终态由原 invocation 证明。
- 真实 observer 查询 `inv-d9ecp2g9nr` SUCCESS/0（02:19 UTC）：A/B 各一次有界查询，
  encoded query 7,344 bytes，返回 54/60 finite rows，无 warning。四个 admission/execution
  字段缺失是旧 Runtime 的预期 unknown，不回退合并 duration，也不当作零耗时或零排队。
- release wrapper 已验 SHA 交付并提交 A；已静态核对使用正式 ops-cycle 执行 rollout，再持完整共享锁
  运行 Bottomless/HA/activation。新 release 使旧资格失效时保留 cycle 的 post-block，不伪造
  pass；只有 pre-allow 且 exact action 的字符串 exitCode="0" 才进入新 digest 的资格阶段。
  strict10k wrapper 在准备时绑定 Runtime 59/tools 120 独立身份；随后按原参数启动，见本节开头。
- 最新 release inputs `inv-d9ec2b0fcg` SUCCESS/0：A/B 仍为旧 Runtime，Cell/Host/Engine/
  MachineSet UID 未变，各六 Ready Engine、四 Ready Host，没有 release hold。C Workers API
  仍为 source 723eebaa、image d2e890c5、三 Ready；Argo Synced/Healthy，不推断未发布的 86a 工具。
- 只读 `inv-e9ec6m0ipe` SUCCESS/0：A/B 实际 `fdbbackup describe` 均 Restorable true。
  不要求物理恢复；A CR 的 restorable 字段为空不等于实际备份不可恢复。
- 本轮只读 `inv-d9ebkng529`：A/B 均 readyForPlacement，仍运行旧 6e4d982e 镜像，
  Engine 各 6 Ready、Host 各 4 Ready。未 rollout 或修改线上容量。
- source `3d03bf6a6fe9ece26e3ae2ea54a4864b66b785d3`，manifest 前缀 `c2c1614c`，
  完整 manifest/bundle 摘要保留在上述本地 immutable source receipt 与 builder metadata。
  14,272 文件的 full reviewed source 经 COS 中转；`inv-d9ebm30xwq` SUCCESS/0，
  immutable materialization 和 manifest 门禁通过，不改变 promoted source link。
- 构建原 invocation `inv-d9ebnrg4ke` FAILED/1，明确报
  `__init__() got an unexpected keyword argument 'text'`。reuse helper 的 subprocess 使用
  Python 3.7+ 接口，而 builder 默认是 3.6；仅设置 ACTOR_BUILD_PYTHON 不覆盖子 helper。
  本地监督服务 InvocationID `b9a4377a38e749bf9c066f4613ee99b2` 已 failed/1，不是仍在构建。
- 原构建没有 stage receipt、产品 receipt 或 rollout。14 项 stage reuse 本地回归通过；
  不将这组测试冒充本次真实 compiled-input projection 已通过。
- pending gauge 在真实 transaction cancellation、success、error 三条路径恢复基线。
- Rust runtime 配置 10 项测试通过，production install/release/render 使用相同的 8/2 默认值。
- Runtime `072e504b` / image `6e4d982e` 已构建，A 正式 gate/activation 已通过。
- 新 tools `d7ff0a90` 已完整验真落地，不改变上述 Runtime 镜像。
- 原始 A/B Bottomless/HA JSON 已按原字节归档并验 SHA；正式 Bottomless verifier 与 HA
  原生成器的 hash、UID、请求窗口/清理条件均通过。
- strict10k `e479f1a64f1e4d109ac8940d75c05999` 在 preflight 失败：B UID 与 observedGeneration
  正确，但 `readyForPlacement=false`。负载目录不存在，不能报告“已开始万对象负载”。
- 新 run `d3a163511fd849bf9a466553e4ab4f48` 已提交，TAT `inv-e9e03sgq36` SUCCESS/0；
  监督服务 InvocationID 前缀 `5090f1d5`。只读 `inv-e9e04dg6b4` 确认服务 running、
  A/B 完整 preflight 通过、initial low 和实际 runner 的首个统计；最终 receipt 尚未产生。
- 本轮 `inv-e9e0adgcj4` 只读确认同一监督服务 running；约 390 秒时 641 ready、10,877
  active 成功。未重发 workload 或 release。
- 最终原服务已 failed/exit 1；只读 `inv-e9e9bh00r4` 取回终态。load 到 9,194 ready、
  2,117,371 active success 后遇到一个 initialize `502 indeterminate_result`。随后 2,643
  `code=20` 为全局取消；9,226 scheduled 全部精确删除、清理零 retry，自然回到各四 Host/Node。
- 原字节 capacity/load/cleanup receipt 已归档，完整 189.7 MB trace 与 load journal 经 COS
  中转并验 SHA。复算 verifier 的 verdict/checks/expected/evidence 与原收据相同，exit 1；
  扩容、身份、trace、cleanup、safe drain、final low 通过，10k/load/active capacity 未通过。
- 故障前 B UDB pending 为 3,989、A/B compaction waiter 为 1,360/1,102。历史 range 证据
  `inv-d9e9ei01uw` 显示汇总 Engine CPU 峰值约 10.6/10.8 cores，并非上轮总 CPU 饱和。
  原始首因 transport warning 未落在 bounded current-Pod log 选择内；不以取消日志替代首因。
- debug 多块 fixture 在旧 reader 失败、生产 replay 成功；修复后四项真实存储回归和全部
  22 项 Gasoline lib 测试通过。缺失 index 与非法 chunk 仍失败关闭，不变更 Runtime 镜像。
- 进一步 25 项 Gasoline lib 测试通过；新增有界三结果指标和真实 queue timeout 回归，不将
  指标修正冒充调度/性能整改完成。线上镜像仍是 072e504b/6e4d982e。
- active-job 有界观察通过 Depot 54 项 lib 测试及真实工作流/前缀/GC 共 13 项回归。
  保留数据 fence、fallback timer 与 force 语义；普通规划活动序列未变。该本地结果本身
  不是发布或 strict10k 证据。
- 独立准入源码通过 Gasoline 33 / Depot 56、实际工作流/前缀/GC 13 项回归；Engine 类型
  检查和默认 clippy 通过。只在准入 overflow/deadline 延后原 job，失败计数、数据 fence
  与持久 event 编码不变；A 正式发布证据见本节开头，真实 strict10k 仍未通过。

### unverified

- strict 10k 通过和 Router performance receipt；历史 run 失败、新 run 尚无终态，
  A/B 小规模资格不替代容量验收。
- 供给时延与可用槽位余量是否覆盖目标创建率和同步唤醒突发；未实现预测扩容。
- 低 maintenance concurrency 能否同时保持 hot tail 有界和 cold publish 进度。
- 万级失败完整因果：补 hot fold 有效/失效工作、history replay 字节、每 Pod CPU 与 FDB 重试；
  reclaim 为零可能是 live pins/retention，不能只凭同窗相关性下结论。
- 历史窗口具体 timeout/replan 比例、admission 等待与实际执行的分布、首次 502 完整归因。
  per-Pod CPU/读字节/transaction attempts 已补，旧合并 activity 标签无法追溯分类。
- durable admission deferral 源码已实现；有界 DELTA 读批优化仍未实现。准入修正与 active-job
  观察已完成 A/B 发布与资格；其真实 strict10k 读取/延迟、有效吞吐和 hot-debt
  改进仍无证据。

### discard

- 上轮 127 个同时间 cancellation 不能当作 127 个独立网络故障。
- 旧 pending gauge 不能用来证明清理后仍有真实交易积压。

### restore

- 当前开发在 mono2 独立 jj revision，以 73598bca 为已推送基线；原 dirty 工作区保持不动。
- 本轮 build/materialization 日志在 `/data/actor-build/local-admission-3d03bf6a-20261003/`。
  原构建监督服务已经终止失败；只能在构建入口修正验收后提交一份新身份作业，不重启原作业。
- 上述 59e86519 build 已成功，不再重启其 service/InvocationID；日志和完整 source receipt 在
  `/data/actor-build/local-admission-59e86519-20261003/`，固定 wrapper 在
  `/data/tmp/minisandbox-admission-runtime-build-59e86519-20261003.sh`。
  原 terminal TAT、stage closure 和 product receipt 才是构建成功证据。
- B release/qualification `inv-a9ednt0v6b` 已 SUCCESS/0，waiter session 22706 已结束；
  本地 launcher `/data/tmp/minisandbox-admission-release-b59-20261003.sh` 不重复提交。
- 当前只观察 strict10k `55b558752ba2454987491cdea655ff68`，systemd InvocationID
  `8ee84c21e87944c983932c62a5df5c56`；launcher/只读 progress 分别为 `/data/tmp/` 下
  `minisandbox-strict10k-start-55b55875-20261003.sh` / `minisandbox-strict10k-progress-55b55875-20261003.sh`。
  TAT `inv-c9eef1012r` 只提交一次，不因本地断线重发；service 的终态、load/cleanup/capacity
  原收据和 exact 清理才决定验收结果。
- B 原 TAT invocation `inv-e9dx3fg9p5` 只能续接，不能重发发布；历史失败负载不改为 passed。
- B 发布原作业已 SUCCESS/0。strict10k 服务 InvocationID 前缀 `0836e279` 已 failed/exit 1；
  启动 TAT `inv-d9e00x0557` 的 SUCCESS 仅表示服务提交，绝非资格通过。

### next_action

- 跟随唯一已运行 strict10k，保留旧失败身份，不临时 patch 线上容量、超时或重试。
  A/B release/qualification、materialization/stage reuse 与新产品已通过，strict10k 未通过。
  不因为文档/诊断更新重编 workerd；tools 120 独立于 Runtime 59。
- 将 admission wait、execution 与 durable history/replay 分开建模；现有排队 timeout 机制
  已复现；新指标 A/B 已可用。不重写历史分类，不用小资格采样宣称
  万级对照已经成功。
- 当前相同 strict10k 观察 shared lane 总 offered demand、执行时间、有效 fold/publish/reclaim、
  deferral/replay 成本和 hot-debt 斜率。排队不再耗失败预算并不证明存储吞吐已足够。
- 不拿旧合并指标估算
  timeout 比例，不因普通 docs/诊断变更单独重建 workerd。
- 保持 Router performance 前置 10k 门禁；诊断修复不单独触发 workerd 重构建或 Runtime 发布。

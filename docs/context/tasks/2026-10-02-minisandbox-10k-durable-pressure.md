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
revision: 1.18.0
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
- FDB 相邻 Get/GetKey 有界并发而非串行等待；mutation、range、commit 和 retry/reset 均为
  FIFO barrier。真实 native FDB 验证读写顺序、64 并发值、generation 冲突和 on_error 重试。
- 新 digest 经正式 release 后，真实 10k receipt 必须满足零 retry、零 active failure、10,000 active；
  通过前不得运行或宣称 Router performance qualification 完成。
- Router 性能工具必须区分固定到达计划、实际 dispatch 和 response 时延；五分钟 Prometheus
  滚动窗口全部位于 offered-load 窗口内部。准备、尾部等待和清理不能污染 steady-load 指标。
- 本地组件 gate 对百万不同 key 实际访问生产 ObjectRouter，验证缓存/LRU/miss 表有界、
  GC 后的保留 heap 不随历史访问基数线性增长。固定小 payload 的组件证明不能替代百万
  dormant 公共路径/FDB/真实 API RSS 与云端容量证据。

## affected_paths

- `minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/`
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
- `minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/`
- `minisandbox/infra/cells/internal/workersapi/objectrouter/`
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
| `docs/context/domains/release-gitops.md`、`docs/context/project/upstream-subtrees.md`、`minisandbox/infra/cells/{AGENTS.md,deploy/tencent/fleet/README.md}`、`minisandbox/infra/cells/deploy/tencent/fleet/{runtime/qualify-engine-ha.sh,operations/{publish-qualified-release.sh,plan-qualification-activation.py},load/ten-thousand-active/README.md}@b2874c06` | A 终态验真与 B 发布前置 | 读真实 HA 内置 probe/hash/topology、activation 源 audit hash 和完整容量门禁；不将 production-cell 小规模收据冒充全产品容量 |
| `AGENTS.md`、`minisandbox/infra/cells/AGENTS.md`、`docs/context/domains/release-gitops.md`、`docs/context/project/{upstream-subtrees.md,adjacency/argocd-ci-secrets.md}@587b4fb2` | 本轮正式发布取证 | 保持完整目标、同一 invocation、mono2 唯一写源和资格锁 |
| `minisandbox/infra/cells/deploy/tencent/fleet/{load/ten-thousand-active/README.md,operations/{run-autonomy-governance.sh,static-release-plane.md,verify-release-qualification-authorization.py},qualification/actor-bj-q01/{persist-receipt-from-builder.sh,relay-upload-to-builder.sh,relay-download-from-builder.sh},runtime/{test_monitor_bottomless.py,test_build_runtime_scale_in_hold_patch.py}}@587b4fb2` | 原生 ledger、COS relay 和门禁所有权 | 不把 action exit 0 或中间旧收据缺失改写为最终资格通过，不绕过静态漂移检查 |
| `AGENTS.md`、`minisandbox/infra/cells/AGENTS.md`、`docs/context/domains/release-gitops.md`、`docs/context/project/{upstream-subtrees.md,adjacency/argocd-ci-secrets.md}@962ad5ea` | 接续用户性能建模要求 | mono2 唯一写源，不以扩大副本替代单位成本/控制面隔离 |
| `minisandbox/infra/cells/deploy/tencent/fleet/{README.md,tat/{tat-run.sh,lib-tat.sh,tat-download.sh},operations/{run-autonomy-ops-cycle.sh,with-autonomy-operation-lock.sh},runtime/{monitor-bottomless-qualification.sh,install-admission-controller.sh,install-host-autoscaling.sh,test_builder_storage.py}}@962ad5ea` | 实际锁、准入所有权与发布邻接 | MachineSet minimum 与 Host HPA floor 由不同 installer 读取，不能因都叫 MIN_REPLICAS 擅自改 qualification 条件 |
| `AGENTS.md`、`minisandbox/infra/cells/AGENTS.md`、`docs/context/domains/{agent-gateway-runtime.md,release-gitops.md}`、`docs/context/project/{upstream-subtrees.md,services/ctl.md,services/sandbox.md,adjacency/argocd-ci-secrets.md}@00708032` | 恢复后精确路由与原发布边界 | 只读 collector 和原锁复用，跨服务信息不授权修改 CTL/Sandbox |
| `docs/context/domains/release-gitops.md`、`docs/context/project/{upstream-subtrees.md,adjacency/argocd-ci-secrets.md}@00708032`、`minisandbox/infra/cells/deploy/tencent/fleet/{tat/{tat-run.sh,lib-tat.sh},operations/with-autonomy-operation-lock.sh,terraform/create-first/bootstrap/{prepare-bootstrap-host.sh,test_install_pull_credential_e2e.py},qualification/actor-bj-q01/{build-runtime-via-tat.sh,relay-upload-to-builder.sh},runtime/prepare-cargo-cache.sh,terraform/create-first/management/{main.tf,variables.tf},terraform/create-first/pre-destroy/audit.py}@00708032` | 实际存储采集、保护凭据、构建缓存与 Terraform 状态邻接 | 原 TAT/ops lock 语义不另造，guest 兼容 stock Python 3.6，仅用 metadata 读取实例 ID |
| `AGENTS.md`、`minisandbox/AGENTS.md`、`minisandbox/infra/cells/AGENTS.md`、`docs/context/domains/release-gitops.md`、`docs/context/project/{upstream-subtrees.md,adjacency/argocd-ci-secrets.md}@df32d6c0` | 本轮继续性能归因与 bootstrap 修复 | mono2 唯一写源，原独立 revision 接续，不将局部测试视为发布 |
| `minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/{management/main.tf,management/outputs.tf,test-terraform-storage-contract.py,bootstrap/validate-inputs.py,bootstrap/test_validate_inputs.py,bootstrap/README.md,rebuild/README.md,README.md}@df32d6c0` | 严格 inventory 契约和磁盘身份 | 确认新增 builder 字段会被平台拒绝，独立输出，不放松原 schema；新 planner 只读且不是格式化授权 |
| `minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/{management/main.tf,management/variables.tf,management/outputs.tf,management/versions.tf,management/terraform.tfvars.example,rebuild/fleet-intent.json,rebuild/render-inputs.py,rebuild/test_render_inputs.py,test-terraform-storage-contract.py,bootstrap/prepare-bootstrap-host.sh,bootstrap/README.md,README.md,rebuild/README.md,tools/resolve-terraform.sh,tools/install-terraform.sh}@173f293b` | 用户追加性能设计要求与资源所有权 | 在模板内增加 build-only CVM/CBS，不替换控制节点，不将 provisioning 当作已挂载或已准入 |
| `docs/context/domains/release-gitops.md@173f293b`、`docs/context/project/upstream-subtrees.md@173f293b`、`docs/context/project/adjacency/argocd-ci-secrets.md@173f293b`、`minisandbox/infra/cells/AGENTS.md@173f293b` | 正式发布与邻接 | 保持源码/镜像/实际资格分层；读取真实 Terraform storage 和 renderer tests |
| `minisandbox/infra/cells/deploy/tencent/fleet/runtime/{build-image.sh,prepare-cargo-cache.sh,README.md,test_runtime_base_contract.py}@f225363b`、`qualification/actor-bj-q01/{build-runtime-via-tat.sh,test_build_parallelism.py,test_runtime_python.py,test_runtime_build_log.py}@f225363b` | 实际构建副作用边界 | 在 push authority 和 source mount/compile 前检查实际 backing，保持 Python/ABI/source/token 与输出边界 |
| `minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/{management/main.tf,management/variables.tf,management/outputs.tf,bootstrap/README.md,rebuild/render-inputs.py,test-terraform-storage-contract.py}@f225363b` | rebuild 资源所有权 | 现有模板共享 rootfs，不因新 admission checker 通过就声称已实现独立盘；本轮不 apply 云资源 |
| `minisandbox/infra/cells/deploy/tencent/fleet/observability/{README.md,federation/README.md,federation/hub-values.yaml,federation/hub-prometheus-adapter-values.yaml}@b72df9f5`、`terraform/create-first/{bootstrap/prepare-bootstrap-host.sh,management/main.tf}@b72df9f5` | 管理面真实资源耦合 | 核实 custom metric 上游、保留盘拓扑及 builder 共根盘；不在原作业持锁时修改观测或目录 |
| `docs/context/domains/release-gitops.md@b72df9f5`、`docs/context/project/upstream-subtrees.md@b72df9f5`、`minisandbox/infra/cells/deploy/tencent/fleet/README.md@b72df9f5` | 正式 Runtime 发布前置 | 保持源码、镜像、资格与实际发布分层；不与原 strict cycle 重叠 |
| `minisandbox/infra/cells/deploy/tencent/fleet/runtime/{release-runtime.sh,test_build_runtime_scale_in_hold_patch.py}@b72df9f5`、`operations/{run-autonomy-ops-cycle.sh,with-autonomy-operation-lock.sh}@b72df9f5`、`gitops/image-seed/{bind-inventory.sh,product-lock.py}@b72df9f5` | 锁、来源与回滚门禁 | 复用正式 transaction、exact runtime digest 和资格激活，不直接 patch Cell |
| `minisandbox/infra/cells/internal/workersapi/objectrouter/{router.go,router_test.go}@40adcd4e`、`minisandbox/infra/cells/go.mod@40adcd4e` | 百万 key 后缓存驻留成本 | 生产 LRU/TTL/single-flight 与轻量确定性 resolver fixture；不模拟云端持久性、不写 Registry/FDB |
| `minisandbox/infra/cells/deploy/tencent/fleet/runtime/{prepare-cargo-cache.sh,build-image.sh,README.md}@ae339fd6` | Rust 重编工作量诊断 | 输入/toolchain closure 改变会清空整批 Cargo target；不将此次编译描述为只编几份修改源码，不改 live build |
| `minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/{README.md,run.py,capture.py,run-on-builder.sh,test_run.py,test_lifecycle.py,test_capture.py,test_sample_window.py,test_capacity_receipt.py,test_run_on_builder.py}@ae339fd6` | 后续 Router 性能门禁的实际覆盖 | 修正固定到达延迟与五分钟窗口污染；只跑本地真实 HTTP/子进程回归，不抢占云端 ops lock |
| `minisandbox/infra/cells/internal/workersapi/{object_router.go,objectrouter/router.go,metrics.go,api.go}@ae339fd6` | 缓存模型边界 | 固定轮询不能保证命中率；32,768 项/十分钟 TTL 与 Router 副本独立，意图不能代替实测 |
| `minisandbox/infra/cells/deploy/tencent/fleet/runtime/{bundle-full-reviewed-source.sh,verify-full-source-bundle.py,build-image.sh,reuse-stage-from-runtime.sh,test_full_source_bundle.py}@c631f554`、`qualification/actor-bj-q01/{materialize-full-reviewed-source-via-relay.sh,relay-upload-to-builder.sh,build-runtime-via-tat.sh}@c631f554` | 正式不可变源码、COS relay 与 stage 复用 | 构建包含 fold/point-read 修正的新 Runtime；不重编未改 V8，不绕过 compiled-input closure，不改线上 Cell |
| `minisandbox/engine/packages/universaldb/src/driver/foundationdb/{database,transaction}.rs@0700632d`、`minisandbox/engine/packages/universaldb/tests/{foundationdb,foundationdb_unavailable,foundationdb_node_loss,conflict_parity}.rs@0700632d` | adapter 真实等待与重试边界 | 修正相邻点读，并保留 FIFO state barrier 与 native conflict/maybe-committed 语义 |
| `minisandbox/infra/cells/deploy/tencent/fleet/observability/{infrastructure-metrics.yaml,values.yaml}@0700632d` | FDB 诊断来源及缺失指标 | 容量 gauge 不是延迟证明；nodeExporter 禁用时空磁盘指标保持 unknown |
| `minisandbox/.claude/reference/{testing,docs-sync}.md@0700632d`、`docs/context/project/adjacency/argocd-ci-secrets.md@0700632d`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@0700632d` | 本轮验证与发布邻接 | 私有测试 shim、正式设计同步和只读观察不重发原作业 |
| `docs/context/domains/agent-gateway-runtime.md@046f2bde`、`docs/context/project/services/ctl.md@046f2bde`、`docs/context/project/services/sandbox.md@046f2bde` | 本轮路径路由必读 | 后两者为 minisandbox 字符匹配的邻接摘要，不修改独立 CTL/Sandbox 服务 |
| `minisandbox/engine/AGENTS.md@046f2bde`、`minisandbox/.claude/reference/testing.md@046f2bde`、`minisandbox/docs-internal/engine/sqlite/components.md@046f2bde`、`minisandbox/docs-internal/engine/sqlite/storage-structure.md@046f2bde`、`minisandbox/docs-internal/engine/sqlite/constraints-and-design-decisions.md@046f2bde` | 局部 fold 改动规则与 fence | 测试单独文件、只改页折叠，不改变存储权威、事务或恢复覆盖 |
| `minisandbox/engine/packages/guard/src/routing/pegboard_gateway/mod.rs@046f2bde`、`minisandbox/engine/packages/pegboard-gateway2/src/lib.rs@046f2bde`、`minisandbox/engine/packages/namespace/src/keys/metric.rs@046f2bde`、`minisandbox/engine/packages/pegboard-envoy/src/ws_to_tunnel_task.rs@046f2bde` | 前台真实成本 | 区分就绪、gateway lookup、统计和 generation 验证，不删 fence 或丢计量 |
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
| `AGENTS.md@d10ee76a`、`minisandbox/engine/AGENTS.md@d10ee76a`、`docs/context/project/upstream-subtrees.md@d10ee76a`、`docs/context/project/adjacency/argocd-ci-secrets.md@d10ee76a`、`minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_monitor_bottomless.py@d10ee76a` | 当前归因与发布邻接 | 不变更 Runtime 或重发 load；诊断成功与资格失败分别记录 |
| `minisandbox/engine/packages/gasoline/src/ctx/workflow.rs@d10ee76a`、`minisandbox/engine/packages/gasoline-macros/src/lib.rs@d10ee76a`、`minisandbox/engine/packages/depot/src/admission.rs@d10ee76a` | timer/guard 生命周期 | completed-cohort proxy 不冒充精确利用率或 offered rho |
| `minisandbox/engine/packages/depot/src/workflows/db_hot_compacter.rs@d10ee76a`、`minisandbox/engine/packages/depot/src/compaction/shared.rs@d10ee76a`、`minisandbox/engine/packages/depot/src/workflows/db_cold_compacter.rs@d10ee76a`、`minisandbox/engine/packages/depot/src/workflows/db_reclaimer.rs@d10ee76a` | stage 成本及共享 lane | 准备、串行 materialize/publish 与 integrity/install 分开，不能去掉 PITR/lifecycle/backup fence |
| `minisandbox/infra/cells/internal/workersapi/api.go@d10ee76a`、`minisandbox/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/runner.mjs@d10ee76a` | 首错与取消边界 | 等响应头超时不透明重试；journal 首个错误与全局取消分开 |

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

- 本轮局部 fold 五项通过：真实 LTX encode/decode、旧 prefix oracle、24 种 shrink/grow
  历史、乱序/重复 coverage、future 排除、空输入零访问及原 staged-row 上限；128 coverage
  输入访问 128 次而原重复应用总数 8,256。不是端到端倍数或云上容量证明。
  全 Depot lib 61、真实 RocksDB forced driver/head advance 各三项通过。首轮 clippy
  发现新 source-owned fixture 位于 tests 顶层，被 Cargo 同时当作 integration crate；
  已移到 tests/inline 并保留私有模块 shim，随后重跑同样默认 lint，不添加 ignore/allow。
  最终路径的全部 61 项 lib 再次 passed，默认 clippy exit 0，新 fixture 无 warning；
  保留既有库/测试与依赖 warnings。改动仅 Rust 页合并与正式模型/原证据，未构建 V8。
  最终路径的真实 driver/head-advance 各三项、branch-GC 七项再验通过。Context 4,942
  历史错误经 SHA 归一化、保留重复次数的 Counter 与基线完全相同，无新增或消失，
  本 Task 无错误。最终 checkpoint/catalog 更新后再执行同一检查。
  Python analyzer 17、release monitor 5、audit 33 通过；documentation 零 errors/warnings；
  Context 26 项仍同样四个历史失败，不冒充全仓全绿。七文件 change-impact 通过但没有
  matched rule，不代替性能或语义资格。
  最初未指定已有 target cache 的本地测试被主动终止，随后指定受控四 jobs 和已配置
  cargo cache 重跑成功；不把被终止命令标为通过，未构建 workerd 或发布云 Runtime。
- 本轮只读归因/文档：analyzer 17 项真实文件/CLI 回归通过，三份新归档 JSON 与原文件
  cmp 同字节；documentation 零 errors/warnings，七文件 change-impact 通过（matched_rules
  空，不冒充语义评审）。未修改 Rust、未重编 workerd，未运行另一份业务负载。
  最终 Context 4,942 个历史错误按归一化 SHA、保留重复次数的 Counter 与原 baseline
  相同，无新增或消失；不是全仓全绿。临时完整摘要触发检查后，Task 改为摘要前缀并引用
  正式 evidence README 的完整 SHA，未削弱凭证检查器。
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

- 本轮先修可独立证明的重复成本：同一 hot job 多个历史 coverage 共享一次 DELTA 前缀
  折叠，输出仍逐 coverage 生成，顺序、重复 coverage 与逐次 EOF 语义保持。用原逐前缀
  算法作等价 oracle，并验证访问次数；不声称该 CPU/copy 优化就是 A Cell 首错根因。
  不修改 FDB transaction、fingerprint、PITR/GC/backup fence、wire schema 或在线 Runtime。
- 先修准确水位和每进程 maintenance 上限；不把请求超时、重试或 active 数量调松。
- 生产 Engine 保持固定六副本；若未来改变 Engine 副本数，必须重新计算并验证 Cell 级 activity budget。
- 只有新 digest 的真实 10k 通过后才生成 Router performance receipt。
- 报告目标节拍、实际 attempts/s、成功/s、有效 reclaim、计划重做与债务趋势；容量模型
  不得仅使用活跃 Object 数或平均 CPU。未来 Engine 扩容必须重新约束 Cell 总后台预算。

## scan_scope

- UniversalDB transaction metrics、Depot admission、runtime render/release defaults、10k trace 与设计文档。

## scan_output

- 本轮云环境 status tool 与 policy snapshot 仍不可用，不据此宣称访问/凭证 ready。
  `observability/rules/` 与 `qualification/actor-bj-q01/collect-cloud-evidence.sh` 精确路径
  不存在；实际规则为 actor-rules.yaml、FDB 低频采集脚本在 infrastructure-metrics.yaml。
  后续只在已定位 producer/observer 与实际 kubeconfig 对应 Cell 中收集有界只读证据。
- 本轮精确路径查询发现 config 的 guard/pegboard 位于 `src/config/`，不是 `src/`；
  `depot/tests/test_driver.rs` 不存在。后续使用限定目录的文件清单，不扩大仓库扫描。
- 新 request-path 原字节已官方 relay 验真。A 的前台 gateway、Depot commit 与 Gasoline
  多类 transaction 同时排队；不能把 shared contention 简化为 hot stage 的唯一故障。
  源码确认 Gateway2 ingress 统计用 join 加入响应关键路径，每 HTTP 另有 egress transaction；
  改为异步/批量之前必须明确计量准确性、有限缓冲和重启语义，不先丢弃账本。
- 云上只读诊断通过 TAT invocation 留存；不包含 token、Secret、kubeconfig 或对象 payload。
- 本轮三次有界精确路径查询失败：`depot/src/compaction.rs`、
  `depot/src/compaction_protocol*.rs`、`depot/src/compaction/planner.rs` 不存在。
  已读取 `compaction/types.rs`，下一步仅在 `depot/src/compaction/` 用文件清单定位 planner。

## handoff

- 本轮新增共享前缀 fold 仅源码落地，不能把线上 Runtime 59 标成包含该优化。已确认
  A ready-wait 和多类 FDB transaction 同窗劣化；下一项仍需核对 A/B FDB 分片/机器/
  I/O 与热点差异，及前台统计与重复 lookup 的成本。没有确定唯一根因，不直接 rollout。
  原 run 的 exact cleanup 已通过，自然缩容仍由原 unit 完成；Router performance gate
  与完整 strict10k 仍未通过。后续服务曲线必须同看交互率/尾延迟、有效维护和债务斜率。
- 当前状态：历史 Runtime 072e504b 的 A/B release/Bottomless/HA/activation 已通过，
  其 strict10k 失败后精确清理和自然缩容完成。性能修正 source 59e86519 已实际通过 stage
  reuse、Engine/Host 编译和产品 cold pull；A 的正式 rollout/Bottomless/HA/activation 已通过。
  B 的同产品 rollout/Bottomless/HA/activation 也已通过；strict10k 新 run 已实际启动。
  新诊断工具已独立交付且真实 A/B 查询通过。不能把源码、小规模资格或模型文档
  标为万级容量问题已解决。

## checkpoint

### stage

当前 checkpoint（1.18.0）：上一 turn 为 progress，strict JSON 工具与真实回归已
FF 推送 master b0e77182ab893111dab0bdd1c9aea8fe1b8a6930，remote exact SHA
核验、jj import 后 clean；空祖先 usqrqztm 保留，新 xyknulvl 独立记录资格进展。
09:03:52 只读 inv-e9eqhu0322 SUCCESS/0：B 原 qualification 精确冷态 43/48、
pending 5、hot/cold shards 482/763、elapsed 945137.137 ms，staged/read/cleanup
错误零。下次 progress 不早于 09:08:52；原 inv-d9epts0437 与 waiter 25982
09:04:42 重新确认仍 running，不能把 observer 终态当作 mutation 完成。

路由 must_read release-gitops/upstream-subtrees、argocd-ci-secrets adjacency、
monitor 测试邻居已读；cloud-environment/networking skill 已读，status tool/policy
snapshot 缺失不推定 readiness。源协议 collector/control/activation 与现有
COS relay helper 均保持不变。误在 /data/tmp 猜测带 immutable hash 的 release wrapper
路径失败；bounded filename 列出真实 draft 与正式远端路径后不使用错误副本。
猜测 test_runtime_release_hold.py 不存在，bounded filename 定位真实
test_build_runtime_scale_in_hold_patch.py。第一次组合 jq 的 cold_state_wait 字段
猜测不存在，未取得 schema；随后直接 keys/source 确认真实 bottomless.states 与
actor_records。猜测 depot/routes*/ops 也不存在，bounded package search 后定位
src/inspect.rs；不把缺失路径当作行为结论。两次包含无实际设计修改的 patch 因
context 不匹配被拒绝，核对未创建文件后按真实 context 单独重提。
最终证据通过 activation 引用追溯 exact control/audit，校验链后复制到已批准
release evidence root，再使用原 COS relay；不重写已有 native 非标准 JSON。

下一 safe action 是 B 完整资格终态、原五份收据及 live UID/Ready 校验，然后更新
runtime release-bound strict10k launcher。API 已使用 HPA 3..30，旧 wrapper 的固定
spec.replicas==3 与 dynamic ownership 不符，不能手工缩 API 以满足旧静态假设；
须观测实际 desired/ready/UID/image 并保留容量身份，不改变原 workload 参数、
三秒 post-warmup SLO、零普通重试、精确 cleanup 与自然 drain。没有运行新负载。

09:08:12 progress inv-c9eqmw0wh2 SUCCESS/0：47/48 冷态、pending 1、hot/cold
90/247、elapsed 1218142.889 ms、staged/read/cleanup 零。该提交提前五分钟
边界约 40 秒，不掩藏；后续已增加实际 clock guard。09:13:20
inv-d9eqsq0qk9 SUCCESS/0 同样 47/48、90/247、elapsed 1521571.288 ms；
下一 progress 不早于 09:18:20。原任务/handle 仍 live，不重启、不强制清页。

新 qualification wrapper 原字节 8712 bytes、SHA 前缀 653289721ab7；完整哈希由
归档 artifact 的 test_release_admission.py 固化，不在短派生入口重复长十六进制值。
已作为 exact-release evidence artifact 归档。API HPA 3..30、整数 replicas、
observed generation/Ready/updated/image/UID 都必须收敛；activation/control/audit
字节链及 source identity 先复核。实际 jq 子进程五项回归和原 strict10k verifier
十五项通过；未执行 wrapper。原 tools120 workload graph 完全保留。
COS relay upload inv-a9eqt50are SUCCESS/0、远端 length/SHA 验证，落于
/data/actor-build/release/minisandbox-strict10k-runtimec631-tools120-653289721ab7.sh。
仅传源码 artifact，不改集群容量或 runtime，不绕过 B 的 pending 资格。
完整 fleet session 22738 已 exit 0，fleet_manifest_invariants=passed；没有新增
Runtime/workerd 编译。09:17:07 只读 inv-d9eqw90iqb SUCCESS/0，复用原 qualifier
PID 1536326 的动态 loopback inspect，不另启端口转发。唯一 large database 的
head/hot/cold watermark 均 179（与 exact checkpoint 一致），manifest generation
256、hot shards 90、cold shards 122、staged 0、write debt 374,929 bytes。
该状态证明 publication 已覆盖目标，不证明 reclaim 完成或解释慢因。

09:21:08 progress inv-a9er21g4gh SUCCESS/0：仍 47/48 exact cold，hot/cold shards
降至 26/185，elapsed 2006813.24 ms，staged/read/cleanup 错误零；Engine 6/6、
Host 4/4 exact digest/revision 收敛。下一 periodic progress 不早于 09:26:08。
本轮第一次 tat-run 误传不存在的 --poll-interval，helper 在提交前拒绝，未创建
invocation；按 usage 修正后只提交一次成功 observer，不冒充 qualification 完成。

09:21:48 一数据库保留诊断 inv-a9er2n0v75 SUCCESS/0：branch Live、dirty null、
hot/cold watermark 179、manifest generation 258，history-pin rows 空且没有下一页；
唯一 PITR interval 保护 txid 179，expires_at_ms 1791622059363。GC root/refcount
是存活分支身份，不可等同 runtime/history pin。sample_limit=1 的 row family 数
存在 truncated，只作有界元数据观察，不作 exact 总数。回收已推进而非全程停滞；
不能由 PITR 存在直接断言它阻止所有 hot eviction，也不能由 dirty null 宣称无维护。
后续以 exact manager job/lease/attempt 及阶段成本区分安全保留、排队、失效重排和
实际执行；不强制清理、不延长门禁、不以增加 Engine 掩盖单位工作放大。
上述诊断成功不是 B 原 inv-d9epts0437 完成，当前仍不启动新 strict10k。
本轮组合 patch 再次因无实际修改的设计 context 不匹配被拒绝，未落盘；随后按
真实文本分别更新。源码检索误猜 depot/src/policy.rs 不存在，真实 policy binding
读取位于 compaction/shared.rs；不据缺失文件推断系统行为。
Context 首验新增一个 long hexadecimal credential finding，实际是此处 wrapper SHA；
短摘要改为 SHA 前缀，完整值留在真实 artifact checksum 测试，不放宽检测器。
本轮追加读取 api-peer 的真实 router/depot_inspect、Depot inspect 的 database/
branch/rows 与 compaction/shared、db_reclaimer、db_manager 的回收/到期路径。
一次检索误猜 depot/src/db.rs 不存在；后续只搜实际 conveyer/workflows 目录，未
取得 exact manager ID，不把源码候选当作线上已确认慢因。只读观察使用已有 TAT/
qualifier，不发布修改或强制调用 maintenance。
本地新增 jq filter 五项、strict10k verifier 十五项、monitor 五项全部通过；完整
fleet 已通过。documentation 零 error/warning，Context v3 的 4,942 个历史 error
归一化 Counter 与已存基线完全一致，Task 零 error；26 项 context tests 保留同
四项历史失败，不宣称整个 mono2 context 全绿。change-impact 对七个真实 changed
path passed；该门禁不替代设计语义审查和云上性能证据。

当前 checkpoint（1.17.0）：上一阶段 A 五份原生最终证据已进入 master
7a9e669416ebd255fb05269399b2b5b25b81767d，远端 verified、clean；新 qunpnqyq
只修改独立 audit 工具及回归，不修改正在执行的 immutable c631 B workflow。
B 原 inv-d9epts0437 保持唯一，waiter 25982 未结束。08:53:35 只读
inv-e9eq87ge4e SUCCESS/0：Engine 6/6、Host 4/4 exact d3a6e41e；精确冷态
14/48、pending 34、hot/cold shards 3341/4421、staged hot rows 0、read errors 0。
本次进度命令实际于 08:53:36 提交；未将 cycle 原 post block 当作最终 qualification。
08:58:41 只读 inv-e9eqd0gnkm SUCCESS/0：cold-ready 26/48、pending 22、
hot/cold shards 2178/2888、elapsed 641060.922 ms，staged/read/cleanup 错误均零。
下次进度采样不得早于 09:03:41 UTC；原 slow waiter 继续，不重复启动任务。

审计 writer 的确定性修正：内部分数/阈值计算保持数值，输出递归转换非有限 float
为 +Inf/-Inf/NaN 字符串并使用 allow_nan=False；有限值字节不变。Prometheus
scalar NaN 不计为有效样本，全缺失时 value=null、触发既有缺指标门禁，不能补零。
五项真实文件/HTTP/CLI 回归与既有 audit 28 项通过；原 A audit/control 原字节不变。
实际 Node JSON.parse 新编码原生 fixture 通过。新测试纳入完整 fleet verifier；
原 fleet session 42912 已 exit 0，manifest invariants passed；未执行云端物理恢复。
activation planner 3 项与 Cell-binding assert gate passed。独立 audit Context 33/33 passed，
Context unit 26 项仍为同名四项历史 failure；documentation 0 errors/0 warnings。
全仓 Context 4,942 条错误的归一化 Counter 与基线相同，added/removed 均零、
本 Task 无错误。一次 --base-ref gate 只比较已提交 HEAD，changed_files 为空，
不能作为本次 jj 工作树证据；按 jj diff 的实际七路径逐项 --changed-file 重跑，
impact passed、matched_rules 为空，仍不将结构检查包装为设计语义证明。
新工具尚未发布云端，因此不声称本轮 B 收据已经使用严格 JSON 编码。

本次完整读取根/minisandbox/infra-cells AGENTS、路由五份 must_read、
argocd-ci-secrets adjacency 和 monitor 测试邻居；operations README 全文及真实
autonomy_audit.py collector/verdict/writer、evaluate-autonomy-receipt.py consumer
均已检查。cloud-environment/networking skill 已读，status tool 与网络 policy
snapshot 不可用，不视为环境 readiness。先前猜测 autonomy_control.py 和
test_evaluate_autonomy_receipt.py 均不存在，bounded filename 搜索后定位真实 evaluator
和 test_autonomy_audit.py；不引用不存在的 gate。本次 positional tat-run 参数被本地
parser 拒绝（exit 2、未提交远端），读 usage 后改为 --file 发一次有界只读进度查询。

性能工作仍按成本向量推进：point-read overlap 减少串行关键路径，不减少 GET 数；
shared coverage fold 减少重复输入访问，不减少必需输出。每 Engine 8/2 乘六即 Cell
48/12，尚不声称全 Cell 预算自动有界。A 小 gate 不能替代 unchanged strict10k
收益对照，旧 run 55b55875 永久保留 FAILED；完整 goal active。

当前 checkpoint（1.16.0）：上一 goal turn 为 progress，A 原始 release/cycle 与
模型更新已正常 FF 推 master b2874c06，远端 exact SHA 核验且 clean。本轮新 revision
qywotuok 接续，不改旧 source 或历史。只读 inv-e9epr40mix 于 08:37:28 已观察到
Bottomless 最终 passed；inv-e9eprjgpda 在批准的 evidence root 复制精确 Bottomless/HA。
原 A inv-a9ep2a0399 已由 native RequestId 57667815 确认为 SUCCESS/0，08:13:08 开始、
08:36:16 结束，slow waiter 14735 也已 exit 0。没有重发原工作。

五份正式收据经现有 COS helper 下载，source/copy/local/仓库字节 SHA 相同：
Bottomless 263,220 bytes/922a7cba934a；HA 12,977/bcf821139d71；activation
4,190/0858168f3607；control 1,066/130f41068e98；audit 29,269/9b100d943e11。
production-cell 正式 verifier 通过：48 Actor/6,240 writes、cold wake p95
719.303432 ms、p99/max 1,998.496521 ms。claim_eligible=false 原样保留，小规模
Cell 资格不单独构成 Bottomless 全产品/万级容量声明。

HA canonical evidence hash 重算、六副本/三 hostname/三 zone 2/2/2、exact victim
UID 替换和 fault 在流量窗口内均通过；公共 /v1 十对象/十并发、1,500 请求零失败、
故障后 SQLite write count=1、cleanup passed。activation 的 control SHA 与 control
的 source audit SHA 精确串联，audit allow/passed、零 failures/warnings、static drift=0。
08:38 的只读 inv-c9epsg0h0v 确认原 Cell UID、generation/observedGeneration=4、
desired/phase Ready、readyForPlacement=true、capacityRisk Normal，不仅依靠旧收据。

A 全部前置通过后，B 仅提交一次 inv-d9epts0437，StartTime 08:40:20；native
RequestId c562ccbe 的本地 projection 于 08:42:46 完成并确认 RUNNING，不将其中
ExitCode=0 当作终态。
新 slow waiter local session 25982 五分钟轮询，原 shared operation lock 与
checksum-bound 1a44fbcfad28 wrapper/c631 product 完全复用，未重编 workerd、手动
改容量、apply TF、安装监控或启动第二负载。下一次 B 观察不早于 08:47:46 UTC。

08:48:05 只读 inv-c9eq32g9ba SUCCESS/0：B 原 Engine UID 6/6、Host UID 4/4
均为 exact d3a6e41e，新 current/update revision 6767cb4bd 收敛。原 cycle
20261003T084021Z-1512977 pre allow/0、action string 0、post block/string 1，
不合成 cycle passed。真实 .inflight waiting_for_exact_cold_state，48 Actor、48
online/final/post-sleep reclaim，cold-ready 0/48，elapsed 50.709 ms、read errors 0、
cleanup 空；三个 staged hot rows 不当成错误或卡死。还没有 B cold-wake、HA、
activation 终态，原任务不重发。下一次观察不早于 08:53:05 UTC。

本轮检索/归档异常不隐藏：猜测 operations/verify-qualified-runtime-release.py 不存在，
已 bounded exact filename/source 定位真实 publisher/planner。第一次 native TAT query
错误使用 InvocationId 参数而非官方 helper 的 Filters，未取得状态；读 lib 后单次正确
query 才确认 SUCCESS。整份归档读取被截断，JSON parse 拒绝，未提交不完整数据；
改为每 200 行有界读取。audit 的四个 ETA float Infinity 是原 Python 非标准 JSON，
只位于 memory/storage headroom 预测；原字节保留，不重写源 audit/control 身份。
其尾部原无 newline，归档仅机械恢复该格式后才通过 byte/hash 检查。strict JSON
消费者仍有确定性序列化缺口，后续单独修工具，不碰当前 immutable B workflow。

本轮局部 activation planner 3、monitor 5、release-hold 6 passed；Context unit 26 项
保留相同四个历史失败，audit unit 33/33 passed、discovery 正常结束。文档门禁零
errors/warnings，五份 artifact 的 sensitive-key/credential-literal 扫描无命中且字节
一致。没有 Rust/Go/workerd 源码改动，不重复重编。最终 catalog/source hash matched，
Context 4,942 条历史 errors 的 normalized Counter 与基线相同、added/removed 零、
本 Task 零 errors；九路径 impact passed、文档零 errors/warnings、diff --check passed。
万级 verifier 的 15 项真实 CLI/子进程回归通过。猜测该目录 test_run_on_builder.py
不存在，随后 bounded exact filename/source 搜索定位 test_verify.py；读取真实
runner/fixture 后核对原参数与 verifier，未运行负载、未改脚本或门禁。

完整目标继续 active：B 全部资格、原标准 strict10k、Router 矩阵/百万 dormant/
同步唤醒/故障和网络证据尚未齐全；不以 A 资格或中间云状态宣称完成。

当前 checkpoint（1.15.0）：上一 goal turn 是 progress，实测缓存清理/控制面恢复和
成本模型文档已正常 FF 推 master 587b4fb2，远端 exact SHA 已核验、隔离 worktree
干净。本轮接续 koumyook，原 A inv-a9ep2a0399 仍由 slow waiter 14735 观察，未重发。
08:20:40 inv-c9ep9c0npq SUCCESS/0 已证明实际 release cycle pre allow/0、action
exit string 0、post block/1；08:18:27 native ledger releaseId 62e200a732cc 已生成。
Bottomless .inflight 存在、原 shell/python 仍执行。不是停止或再次发布授权。

inv-c9epaigfn2 SUCCESS/0 将两个精确已完成原始收据复制到批准的 evidence relay
根，source/copy SHA 完全一致。原 COS helper metadata/upload/read-after-write
inv-c9epatg7pw、inv-d9epau028s、inv-a9epau0puv、inv-a9epav0q7i 均 SUCCESS/0。
5330-byte release SHA 462be8f387ce、1497-byte cycle SHA 0ae9e2586077 已保存原字节
到 runtime/evidence；仓库文件与云源 SHA 相同。真实 validate_ledger、releaseId
重算、c631 source/manifest、Engine/Host/init exact d3a6e41e digest 与 action 条件检查
通过；旧 block/1 原样保留，不合成 passed receipt。未改 workload 或容量。

08:24:27 inv-c9epcvga64 SUCCESS/0：A same Engine UID 6/6、新 Host revision 4/4
已收敛到新 digest。其第一次 inflight projection 错用了最终 receipt 字段，null/length
结果不当作零错误或进度。08:25:16 inv-c9epdmgv72 SUCCESS/0 用真实 stage/progress：
waiting_for_exact_cold_state，48 Actor、48 initial/final/post-sleep reclaim，20 cold-ready、
28 pending、275868.841 ms、read_error_count 0、cleanup_errors 空；不是终态。

08:25:59 inv-e9epebgcb5 SUCCESS/0 明确中间静态 block 的原因：post-action 沿用旧
59 release directory，external_release_receipt_missing_or_mismatched；ledger payload
hash 一直一致。后续新目录 audit ready=true、driftCount=0、externalReceiptMatches=true，
FDB Available/fully replicated、backup Restorable，失败仅缺新 Bottomless/HA receipts。
不误判成新 workload 漂移，也不放宽 qualification 或静态门禁。

08:32:17 inv-c9epk8gk9c SUCCESS/0 沿同一 root 观察到 36/48 cold-ready、12 pending，
elapsed 704189.414 ms，read_error_count 0、cleanup_errors 空；stage 仍为
waiting_for_exact_cold_state。不以中间 shard 总量变化推断精确回收字节或有效吞吐。
原 slow waiter 和原 inv-a9ep2a0399 未重发，下一次观察不早于 08:37:17 UTC。
本轮重验 monitor 5、release-hold 6 passed。第一次 ledger unittest 错用 runtime
目录，仅发现零项，不能算通过；已定位 operations/test_release_ledger.py 重验。
正确目录重新发现且通过 14 项。Context unit 26 项保留四个同名历史失败，audit
unit 33/33 passed，不把历史全库检查写成通过。HA 没有独立
`verify_engine_ha_receipt.py`，已由 bounded exact filename/source 搜索定位真实
qualify-engine-ha.sh 的内置 probe/receipt 验证；未调用不存在的 verifier。
B 的 checksum-bound launcher 仅准备并通过 bash -n，尚未提交。它复用同一云端
immutable wrapper、product receipt 和 shared lock，不重编或更改 payload。
最终 documentation 零 errors/warnings；Context 4,942 条历史 errors 的 SHA-normalized
Counter 与已存基线完全一致，added/removed 均零，本 Task 零 errors。六个 exact
路径 change-impact passed（matched_rules 空，不替代语义评审），diff --check passed。
audit discovery 已正常结束，仅待 Agent assessment，不虚构成熟度评分。

本轮局部门禁 monitor 五、release-hold 六、ledger 十四项通过，原字节/身份检查通过。
猜测 `runtime/verify_runtime_release_receipt.py` 不存在，后续仅用已定位正式 ledger
模块，不造不存在的 verifier。没有 workerd/Rust 构建、云 TF apply 或第二负载。
下一项仍是同一 A gate 的终态 → B 同产品完整资格 → 原标准 strict10k；百万 dormant、
同步唤醒、Router cache/replica/performance、故障矩阵等完整目标没有缩小或宣称完成。

当前 checkpoint（1.14.0）：新 v2 dry-run inv-e9ens0gbt4、execute inv-e9ensrg8cq
均 SUCCESS/0，后者通过收据已进入正式 evidence JSON：十五 exact deletedIds、零
implicitDeletedIds、四十保护 refs，root available 增加 4,667,826,176 bytes。
fresh TCR inventory 共 36/36；所有删除对象有 immutable registry 副本可恢复。
业务数据/PVC/源码/Cargo/TCR 未删，不放宽 kubelet 门槛，不重发 v1 partial mutation。
新 archive 的第一次 sed 截断解析失败，未生成 artifact；改为完整 jq projection 后
成功，不把截断库存当作完整证据。08:00 的 DiskPressure False 在二十秒后转 True；
故未宣称瞬间恢复。inv-c9envf0x9m FAILED/1 精确定位原 preflight line 62 为 C API
readiness predicate；不误报为产品 checksum 或源码失败。

只读 inv-e9ep100q67 SUCCESS/0 于 08:11:44 UTC：same Node UID、DP False since
08:07:59、Ready True、API 12/12 exact digest Ready，kubelet backing available
20,180,090,880 bytes。近期 DisruptionTarget 明确 ephemeral-storage 驱逐；HPA 当前
QPS/in-flight 为零、ValidMetricFound，只是 idle 链恢复证据。第一次全 Pod 明细输出
截断，未当完整 artifact；新的精简 projection 完整保留，SHA 6461c1486ce9。
TKE RequestId e2c33cbd 返回三原节点 running。完整 TF plan session 74033 exit 0、
show session 41263 exit 0：五 builder-only create，零 change/destroy/drift；已保存
plan，未 apply。cloud lock/鉴权没有绕过，没有 targeted/skip-refresh。

A/B c631 preflight inv-d9ep1i0ech SUCCESS/0，两个 Cell 都 passed。A formal release
仅提交一次 inv-a9ep2a0399 detached，slow waiter local session 14735 使用五分钟
间隔，后续必须继续同一 invocation，不重发。原 fast local waiter 已终止，仅停止
本地观察、不取消远端工作；没有第二云 mutation。发布、Bottomless、HA、activation
目前未取得终态，不宣称 passed。没有重编 workerd或新建另一负载。

局部临时 wrapper 草稿曾把 qualify 的 Node capacity minimum 改为四；阅读真实
install-admission-controller 后发现它读的是 MachineSet min（三），Host autoscaling
才读 floor 四。已撤回草稿改动，云端始终使用原 1a44fbcfad28 不可变 wrapper；没有
发布该错误推断。猜测 `.agents/context/catalog.json` 与根 `.context/catalog.jsonl`
路径不存在；读取真实 validator 后定位 `docs/context/.context/catalog.jsonl`，后续
只更新本 Task 的精确 row。一次 `/data/tmp` 递归文件名搜索匹配 Metro cache 而非
目标 operator 文件，输出未用于身份或发布决策；后续限定已知 artifact 路径。

当前本地门禁：builder storage 17 项通过，真实缓存收据字段/计数/字节增量检查通过；
documentation 零 error/warning，五 exact 路径 impact passed（matched_rules 空，
不冒充语义评审）。最终 catalog/source hash 与 Context 基线复核仍待收口。
context 26 项仍四个历史失败，audit tests 33 项通过；未修改其他服务历史文档，
不把检查执行当成全库通过，也未重新编译 V8/Rust。
原 A native TAT RequestId 258c1c7c 确认 RUNNING、StartTime 08:13:08 UTC，未重发。
08:15:40 只读 inv-c9ep4n0w4u SUCCESS/0：旧 runtime Engine 6/6、Host 4/4，
未观察到 rollout，不将 RUNNING 的 ExitCode=0 当作成功。
08:18:00 inv-a9ep6u0kiw SUCCESS/0 确认原 release shell 仍在执行，且精确 admission
receipt root 已创建；尚无 terminal cycle/qualification 收据。完整目标保持 active。
最终文档零 error/warning；Context 4,942 条历史 errors 按 SHA 归一化且保留重复次数
后与基线 Counter 完全相同，added/removed 均零、本 Task 零 errors。catalog 仅更新
本 Task row。audit discovery 实际输出 Markdown，错误按 JSON jq 解析的命令 exit 5，
不把它当作 audit 失败或新语义评分；实际 discovery 为 needs_agent_review/not_assessed。

2026-10-03 接续：上一 goal turn 是 progress，collector/回归和 kubelet 共盘/阈值证据
已正常 FF 推 master 962ad5ea 并核验 clean。当前独立 revision xkspvlyr 接续，完整目标
仍 active，不把 schema/模板当成 runtime release 或 strict10k 通过。原 partial 清理
inv-a9end9g59c 的 immutable receipt 已通过同一 waiter 重新收集，仍 FAILED/1、仅一
image deleted；不重发该 mutation。当前只读 inv-d9enk80qei / local session 77859 正在
观察 Buildah 版本、精确第二候选、四个已知目录占用及真实 C node condition；只读
timeout 不是允许重启 mutation。Cloud Skill/networking 已完整重读；status 工具与 policy
snapshot 缺失不推断 readiness。下一项在实际版本语义和新 inventory 上形成新 bounded
plan，而不是改 eviction threshold 或 force 删除。未 apply、未新编译、未启动第二负载。

当前只读 inv-d9enk80qei 已 SUCCESS/0，原 TAT payload 从 07:58:09 UTC 运行至
08:00:29 UTC 后才结束；期间 native DescribeInvocationTasks 确认 RUNNING，未重发。
Buildah 实际版本 1.33.11、无 containers、90 images、第二 exact ID 双名未变；已知
四路径 allocated bytes：containers/storage 14,513,721,344，actor-build 25,559,724,032，
/data 30,573,514,752，/var/log 841,539,584。du 非同时快照、bind/路径可能重叠，不求和
冒充 root unique bytes。最终同 UID node DiskPressure=False（transition 08:00:29），
df available 15,856,648,192 bytes，余量仍很窄。
完整 TF plan 新 session 85992 已 exit 1：仍 bootstrap attachment refresh failed，未保存
或 apply；native TKE RequestId 46a01456 仍 failed/旧 DiskPressure:True reason。其与更早
Kubernetes condition 时间不同，尚不能断言只是 cloud stale；不使用 targeted/skip-refresh。
已核对 upstream Buildah v1.33.11 与 pinned common v0.57.7：by-ID 多名拒绝，tag 可
单独 untag，剩一名再按 ID 删；默认可回收无引用父层，需记录 actual ID delta。新计划
仅原剩余十五 exact image，fresh TCR 36/36 refs RequestId b23c1cfb；临时 artifact
61458c19b820 经 inv-e9enrbgxgj COS relay SUCCESS/0。无 ops lock 的本地负门禁拒绝；
新 dry-run/execute 仍待实际收据，不能因源码可解析即当成清理通过。

本轮最新 checkpoint：bootstrap discover 92 项通过，完整 fleet runner session 15608
已 exit 0、fleet_manifest_invariants=passed。只读 collector 已接入正式 runner 并补齐 README 与
正式设计；guest/control timestamps 均要求 fresh、有序。未构建 workerd、未发布 Runtime。
当前 latest Task 1.12.0，最终源码冻结后只更新本 Task 的 catalog row，不改写全库。
context tests 26 项仍同四项历史失败；audit tests 33 项通过，discovery 仅候选发现，
没有语义评分。documentation 最终零 error/warning；11 条精确变更路径 impact passed，
没有 matched rule，不代替语义审阅。Context 4,942 历史 errors 的归一化 Counter 与基线
完全一致，added/removed 均零，本 Task 零 errors。最后 checkpoint 后再次核验并正常
FF 推 master；完整目标保持 active，不称 builder 云上隔离或 strict10k 已通过。

完整保护集合由 all-namespace C/A/B deploy/sts/pod（含 initContainers）重新观察。
第一 dry-run inv-a9en8egsq3 FAILED/1 因全对象 JSON 输出超过上限，deletedIds 空；
改为 kubectl 原生 image-only projection，不提升输出上限。新 artifact e19d048eb061
经 COS relay inv-a9enckgsn3 SUCCESS/0 核对 bytes/SHA；TCR RequestId 74cb8789
重新获得全部 36/36 refs，全部十六候选仍可恢复。
dry-run inv-a9encv0inv SUCCESS/0：保护 40 refs、空 containers、原 ops/build 锁及 exact
C node identity 通过。execute inv-a9end9g59c FAILED/1，partial，仅第一候选 image
779bdd8e7285 成功删除，第二候选命令失败即停止；没有 --force 或清业务数据。
随后 inv-d9endv081c SUCCESS/0 于 07:51:22 UTC 确认第一 ID 不在 inventory、第二
b204330e1c21 仍完整双名，镜像从 91 到 90；root available 16,882,380,800 bytes，
同 UID node DiskPressure 仍 True。不能宣称恢复健康，也不能直接重发原 partial plan。
进一步只读 inv-d9enge0843 SUCCESS/0 于 07:54:04 UTC 取得实际 kubelet summary/configz：
nodeFs 与 imageFs 同 capacity 105,620,869,120、available 15,495,536,640 bytes，约
14.67%，低于真实 imagefs.available=15% evictionHard；nodefs=10%，transition=5m。
native imageFs used 4,391,030,784、nodeFs used 85,706,403,840，不能用容器镜像自身
用量代替整个 backing 的可用量。df 与 kubelet samples 不同窗，差值不能直接归因为构建。
这确证共 backing 与当前 pressure 判据，不反向证明原业务首个 502 的唯一原因。
需重新观察剩余精确身份及失败语义，再形成新的有界计划；不强删 containers/旧 PVC。
本轮 exact runtime/relay-upload-to-builder.sh 不存在；rg --files 定位到 qualification
真实 helper 并完整阅读。外部 Buildah untag 文档路径 404，不假设该命令存在或重试变更。

当前 npnlnupk revision 接续已推 master 00708032，上一 goal turn 是 progress。新增
guest 与 control 两份只读 collector，真实 TAT shell helper + 本地协议进程六项测试通过。
guest 不接收云 credential，只读取 metadata、lsblk、精确 by-id 和 wipefs --no-act；
control 加入 exact C inventory/VPC/bootstrap membership，裁剪无关 API 字段和 tags，
保留请求 ID、原 TAT terminal invocation、source hash 与最早采样时间。未实现初始化。

实际全 management Terraform plan 原 session 61548 已 exit 1：预计五 add、零 change/
destroy，但 provider refresh 原 bootstrap attachment 时失败，未保存 plan、未 apply。
独立 TKE DescribeClusterInstances RequestId 0a177a50 于本轮返回唯一 ins-55ry1kb1 为
failed，FailedReason 明确 DiskPressure:True,Ready:True；不是 provider 误报，不能跳过。
只读 inv-d9emqtg58a SUCCESS/0 于 07:28:55 UTC 确认同 UID C node 仍 DiskPressure。
其中猜测的 actor-ten-thousand-active unit 查询没有 LoadState/InvocationID，不能作为
原作业观察证据；原 run 的终态沿用已验证原 receipt，不重新启动。

缓存诊断 inv-d9emrtgmrv FAILED/5 因无 containers 时原生 JSON 为 null；改为兼容空
array 后 inv-c9emsmgdjt SUCCESS，但 91 个 image 的 TAT aggregate 输出截断，不当完整
库存。随后 bounded inv-e9emtg01un SUCCESS/0 于 07:31:44 UTC：无 Buildah containers，
root 外层持锁/compiler 列表空；Cargo target 约 2.97 GB、整个 build-cache 约 5.10 GB。
不据一次无进程观察删除任何目录。旧镜像的十六条精确 ID inventory 完整获得，TCR
DescribeImages 共 36/36 rows 可证明全部十六 immutable registry refs 仍存在。
首次 A/B 查询只取 admission namespace，仅返回 controller，不是 Runtime 绑定证据；
正在用只读 all-namespace deploy/sts/pod image 集合补齐，未删除镜像、Cargo 或磁盘。
一次 exact runtime/manifest.yaml 查询不存在，后续不继续猜 manifest 路径。

下一安全步骤是完整保护 current/rollback image、保持原 ops/build 双锁，仅退役经过归档
验证的精确本地旧构建镜像，恢复 C 实际 disk condition 后重跑 full plan；不改 eviction
threshold、不使用 targeted apply 绕过现有 node 异常。盘初始化/持久挂载及 c631 正式 release
仍未完成，strict10k 不变，完整目标保持 active。

本轮源码最终门禁：bootstrap 86、rebuild 20、storage contract 10 项均通过；完整 fleet
runner 原 session 62533 exit 0，fleet_manifest_invariants=passed，新 planner 回归已接入
该正式 runner。真实 Terraform 1.9.8/provider 1.83.11 validate 为 valid=true、零 error/warning，
合法 .tf fmt、diff-check 通过。documentation 目前零 error/warning，context tests 仍同
四项历史失败、audit 33/33、discovery needs_agent_review；不伪造全库通过或质量评分。
documentation 最终零 error/warning；14 条 exact changed paths impact passed、无 matched
rule，不能代替语义审阅。Context 4,942 历史 errors 的归一化 Counter 无新增或消失，
本 Task 零错误。只更新本 Task 的 catalog row，不运行全库改写。
正式设计补充资源成本向量、四项结构问题与不同预期效果，区分关键路径缩短和总工作减少；
并纠正原 strict run 已 failed 终态，安全 drain 通过不覆盖 active 容量失败。
一次 patch 使用了错误换行 anchor 被整笔拒绝，随后在实际已读完整行成功修改。
一次读取尚未完成的 discovery 输出报告不存在，等待同一 session 22120 exit 0 后读取；
不重复发作业。对 attachment ID 的一级来源核验中，旧 provider 文件路径 404、搜索
无结果、Registry web 页面不可访问；正确 services/cbs 路径成功读取锁定 1.83.11 源码，
Create SetId(storageId) 与 live InstanceId 检查一致。不据访问失败放松身份门禁。
Cloud networking 已完整重读，policy snapshot 缺失不作为访问 readiness；无绕过。
最终 Task/catalog 更新后再验 docs/context/精确 impact 并核验 source push。
仍无云 apply、初始化/挂载、缓存删除、Runtime release 或新负载，本轮是源码 progress。

2026-10-03 07:19 UTC 接续 checkpoint：当前 lxknlqyx revision 修复上一模板的严格
inventory 回归。实际 production validator 拒绝 runtimeBuilder unknown field；旧 fixture
未包含新增输出，107 项通过不覆盖该组合。现将 builder 拆成独立 runtime_builder_inventory
输出，保持平台 management inventory 不变，不放松 schema，也不混入 C bootstrap receipt。
新增只读磁盘 planner 的七项测试通过，含 42 个 observation 故障子场景及真实文件/CLI：
exact cloud/CVM/CBS/TKE/guest 身份，by-id+serial+capacity，实际 root ancestry，空签名，
拒绝既有挂载/文件系统、过期证据及重复 JSON。plan 保持 storageReady=false；实际 collector、
磁盘初始化/挂载和受控交接未实现，不能把 planner 通过等同 build-ready。

只读 inv-a9em5wgcj7 SUCCESS/0 于 07:08:46 UTC 证明 C 原控制节点仍 DiskPressure True，
root、data、Buildah 仍共 /dev/vda1，available 14,845,512 KiB；API 12/12 Ready。
Hub Prometheus 当前 Ready，HPA condition 为 ValidMetricFound，但没有查询实际两项 metric
值，不声称闭环已恢复。vdb/vdc 已挂载到实际 Kubernetes PV，均不能初始化或用作构建盘。
原 strict 已 failed 终态，未重发；c631 image 未发布、未 apply/格式化/删缓存。

失败 query 已记：docs/evidence 目录、bootstrap/run-tests.sh 和 fleet/verify.sh 均不存在；
有界 rg --files 定位到真实 fleet/verify-manifests.sh 与 load/ten-thousand-active/evidence/README.md，
不继续猜文件名。Cloud skill 已完整重读；environment_status tool 缺失，不能据此宣称 ready。
下一项先完成独立 inventory 与身份门禁源码测试/文档/TF 验证并发布；随后仍需完整存储
bootstrap、隔离构建交接、观测信号验收及 c631 正式 release，再重跑同一 strict10k。

本轮最终本地 gate：standalone builder 的 78 项 bootstrap、20 项 rebuild 与九项 storage
contract 回归全部通过；完整 fleet runner session 90061 exit 0，marker 为
fleet_manifest_invariants=passed。合法 .tf fmt、真实 provider validate、diff-check 均通过。
documentation 零 error/warning；15 个 exact changed paths 的 impact passed（无匹配
rule，不代替语义审阅）。Context 4,942 个历史 errors 按 SHA 归一化并保留重复次数与
基线完全相同，本 Task 零错误；context tests 仍同四项历史失败，audit 33/33。
discovery 仅 needs_agent_review。上述都是源码/本地门禁，不是已创建新 builder 或恢复
在线 HPA；本轮不编 workerd、不启动第二负载、不 apply 云资源。更新 catalog 后再验
docs/context/impact，正常 FF source publish 与远端核验后交接；完整目标未完成。

2026-10-03 本轮接续：用户确认需要从建模设计解释性能劣化，不仅扩副本。当前 revision
qlqrltvm 在 management Terraform 中增加独立、不加入 TKE 的 build-only CVM/CBS 和
exact inventory；renderer 显式管理其容量，不改变 Cell 或原三个 C worker。
storage contract 与 renderer 各九项通过；真实 provider 1.83.11 init（backend=false、
lockfile=readonly）及 validate JSON 为 valid=true、零 error/warning。初始化只写本地
TF_DATA_DIR，没有 plan/apply 或云节点变化。首次 fmt 误传 .tfvars.example 被拒绝；
随后只对合法 .tf 文件检查，不将拒绝命令标为通过。一次 docs patch 的末段不存在，
整笔 patch 拒绝，回到已读取的实际标题修正；不扩大检索。
后续 docs patch 仍带不准确的末段 anchor，被整笔拒绝；现已拆成独立、精确上下文
patch 成功。只使用实际已读行，不把失败编辑记成完成。没有 source rollback 或云 mutation。
一次本地汇总将 impact 的 text+JSON 当成纯 JSON 导致 parser 失败；实际 impact 已 passed，
已重新直接核验其状态并单独完成 Context Counter 的 assert，不将 parser 失败标成门禁通过。

原 run 55b55875 现在已有终态：只读 `inv-e9ekt2gfn9` SUCCESS/0 于 06:57:09 UTC
确认 MainPID=0、同一 InvocationID、service failed/exit 1。原 receipt failed，但
exactObjectCleanupPassed、automaticScaleUpObserved、safeDrainObserved 和 finalLowCapacity
均 true；最终 06:53:45 UTC A/B 各四 Host/Machine Ready、active 零，694 样本。原始
receipt 路径仍在同一 load root，SHA 前缀 a49cb93099fd；本地 observation log 为
`/data/actor-build/local-admission-c631f554-20261003/progress-0659.log`。不将观察命令的
SUCCESS 当成负载通过，也不再重发原 load 或假称 supervisor live。该次观察距前一
06:53:25 UTC 不足五分钟，终态后不再轮询，后续长作业严格保持至少五分钟 cadence。
实际独立 builder 尚未 apply，guest 数据盘初始化/挂载、正式 build handoff、旧缓存安全
退役和 Prometheus/HPA 恢复仍未完成；c631 已建镜像仍未发布、完整目标 active。

06:49 UTC 交接：最终 fleet runner session 22614 已 exit 0，最后 marker 为
fleet_manifest_invariants=passed；最终行为源码没有在此轮 runner 期间变更。checker 十七项
及旧 ABI/parallelism/Python/log/stage tests 已通过，docs 零 error/warning，十条精确路径
impact passed（无 rule 命中，不是语义评审）。context tests 仍同四项历史失败，audit 33/33；
discovery 仅 needs_agent_review、不伪造评分。原 strict `inv-e9ekj3gv8m` 于 06:48:33 UTC
SUCCESS/0，同一身份 live，A Host/Machine 各四，B Host 12/Machine 15 Ready、active 零。
下一原作业进度不早于 06:53:34 UTC。source helper 防回归可发布，实际独立盘/独立 builder
仍未实施，新 Runtime c631 未发布，strict10k 仍失败，完整目标保持 active。

06:46:04 UTC 最终 checker 负门禁 `inv-a9ekgn0vip` SUCCESS/0：exact 源码 SHA 前缀
47d1aed61e11 正确 blocked/exit 1，bulk 共 root、15,225,659,392 bytes available；
inode 3,389,309 充足，不是 inode 耗尽。新 checker 追加 inode 保留与 CLI 路径数量的
前置界限，最终十七项已通过。首轮 fleet runner session 22646 已 exit 0，但其内部
builder test 早于最终修改，最终 fleet runner 唯一 session 22614 正在重验，不冒充终态。
context tests 二十六项仍同四项历史失败；audit tests 三十三项通过。没有 live mutation。

06:43:18 UTC 最新只读 `inv-a9eke8g65p` SUCCESS/0：原 supervisor identity 未变，A 已到
Host/Machine 各四 Ready，B Host 25、Machine 27 Ready；active 零、final waiting。
storage admission 最终十五项、base contract 四项、parallelism 九项、Python 三项、log 一项、
prepared stage 九项全部通过，bash/AST/diff 检查通过；完整 fleet runner 原 session 22646
仍在执行，不能据中途 OK 计作最终 gate。没有新构建或 live rollout。

2026-10-03 06:42 UTC 接续：上一 turn progress 已正常 FF 推 master f225363b，远端与
clean 核验。当前独立 xmruvmtt revision 在落地只读 builder storage admission，不缩小目标。
原 strict progress `inv-d9ek8fgvn6` 06:37:11 UTC SUCCESS/0，同一 supervisor live；
A/B Host 4/39 Ready、Machine 12/42 Ready、active 零，自然 drain 未终态。
新 checker 十五项通过；旧 parallelism/Python/log tests 9/3/1 项通过。实际云上负门禁
`inv-c9ekcp03c6` SUCCESS/0，06:41:50 UTC checker 正确 blocked/exit 1：三 bulk 路径
均在 /dev/vda1、系统 reserve 不足、build increment 空间不足；这是负案例成功，不是
builder 已资格通过。checker SHA 前缀 3c2c7a652e42，不写盘或授予 push token。
正式 build-runtime 在 token 前及 build lock 内复核，build-image 还检查实际 stage/target/TMP。
预算 floor 是保守 64 GiB increment，不是 V8 峰值或运行期 quota；同设备路径合并预算。
Terraform/bootstrap 的实际分盘或独立 builder 仍待完成，本轮没有 apply、格式化或缓存删除。
本轮 exact query 的 runtime/bootstrap-runtime-system.sh、runtime/test_product_receipt.py
不存在；已回到 qualification 的真实 system helper 和 runtime base test，不再猜路径。
Cloud Skill/networking 完整读取；status tool 不存在、policy snapshot 缺失不证明 readiness。

本轮交接：只读诊断、正式 release wrapper 与共同资源预算设计为 progress，不是修复发布。
docs 零 error/warning、四路径 impact passed，release hold 六项及 monitor 五项通过。
Context 全量仍 4,942 历史 error，归一化 Counter added/removed 零、Task 零 error；
26 context tests 仍是相同四项历史失败，audit tests 33/33。第一次 Context 验证使用
默认 Markdown 却按 JSON 解析失败，改为 --format json 后比较通过，不隐藏失败。
audit discovery 首次缺少 --output 拒绝，随后使用显式本地路径重跑；仅候选发现，非成熟度评分。
未再观察云端或修改 live workload。下一项先完成原 floor convergence，再在完整 ops lock
下修复 builder/在线资源耦合与观测调度；c631 source/image 不因本文档变更重新构建。

2026-10-03 06:32 UTC 最新验证：原 supervisor `inv-d9ek3i08h1` SUCCESS/0，仍同一身份
running；Host A/B 15/52 Ready、Machine 24/55 Ready，active 零，final waiting。
实际 custom-metrics 只读 `inv-e9ek3igvri` SUCCESS/0，两项均 InternalError；唯一
APIService 已指向两个 Ready 的 Hub Adapter，但 Prometheus Pending。调度诊断
`inv-a9ek410d4r` 首个完整 Pod condition 明确一个 disk-pressure 节点、两个 volume
affinity conflict；其整体 TAT output 截断，不能把后续 inventory 当完整原件。
正式设计与 evidence README 已同步共同资源模型；没有发布、清理缓存或改容量。
新增失败路径查询已记录：`.agents/context/scripts/invalidate_context.py`、
`observability/federation/values.yaml`、`observability/federation/test_verify_hub.py` 与旧
`.agents/context/catalog*` 均无对应文件。实际 helpers 在 validate_context.py，目录隐藏
catalog 在 docs/context/.context；Hub 配置是 hub-values.yaml，测试由 rg --files 定位。

2026-10-03 06:26 UTC 接续：c631 产品已构建，正式 release wrapper 已上传但未发布；
原 strict10k 仍在自然 drain，负载失败和 exact cleanup 成功均不改写。完整 readiness
原件经 COS 验证 84,546 bytes、SHA 前缀 `7f723c22039d`。C 的 builder 同时是控制节点
10.160.0.4；DiskPressure 正在驱逐 API，而非已证实的 API 内存泄漏。只读磁盘诊断
确认 /data 和 Buildah/containerd 均在 100 GiB 系统盘上；actor-build du 超时，大小 unknown。
两项 HPA custom metrics 未有值，CPU/memory 有值；原因尚未核实，不把它补零或改 HPA。
下一步保持只读，验证 custom-metrics 链与原 drain，并记录独立构建/在线资源预算设计。
不能由后续 eviction 反推首个 502，不能通过任意清理、扩副本或降低 eviction 门槛遮蔽问题。

2026-10-03 05:13:51 UTC：原只读 `inv-d9ehs7gxq7` SUCCESS/0，原 unit running、
Host A/B 202/202、MachineSet 212/208、active 零，final waiting。下一进度不早于
05:18:51 UTC。临时 FDB 诊断 `inv-c9ehrugfrk` FAILED/1，内嵌 Python 的 RSS query
f-string 语法错误，实际业务/云配置未改变；已修正且下一提交前额外 AST 校验，不重发
业务负载或把该工具失败当成新业务故障。

2026-10-03 05:12:29 UTC 恢复：前一 goal turn 为 progress，源码/模型已推 master
0700632d，当前 clean。新 turn 保持完整目标 active；原负载 failed、exact cleanup
passed、自然缩容未终态。下一只读不早于 05:13:36 UTC。本轮先定位 A/B FDB 拓扑与
历史 I/O 差异，不重启 workload、改线上容量或发布局部 fold；缺失历史指标不能补零。

2026-10-03 05:08:36 UTC 最终 checkpoint：原 unit 仍同 PID/InvocationID running，
Host 已自然降至 A/B 215/215、MachineSet 224/221；next observation 不早于
05:13:36 UTC，无 final receipt。源码、存储回归与 lint 已通过；最终 documentation
零 errors/warnings，Context Counter 仍相同 4,942 项，八文件 impact passed（无 rule
命中）。本轮准备正常推送 master；不发布 Runtime、不新增负载、不将容量目标标 complete。

2026-10-03 05:07:42 UTC：本轮为 progress。新源码共享 hot coverage 前缀已完成，
最终 lib 61、driver 3、head-advance 3、branch-GC 7 通过，默认 clippy exit 0，库/测试
保留 47/50 warnings，新 fixture 无 warning。Context 4,942 历史错误 Counter 不变。
本轮下一步是最后 docs/catalog/impact 验证及正常 master push；不是 Runtime 发布或
万级容量通过。仍只有原监督 unit 执行 natural drain，不重发 load；完整目标 active。

2026-10-03 05:03:11 UTC：原 supervisor 仍 running；exact cleanup passed，Host 已
自然降至 A/B 228/228、Machines 236/233，仍无 final receipt。下一只读进度不早于
05:08:11 UTC。源码共享前缀 fold 已落地、五项等价/成本回归通过，其余真实存储与 lint
门禁在本地单一 cargo cache 上运行。局部原型不是万级性能资格通过。

2026-10-03 04:59:27 UTC：固定 phase 新查询与 relay 均成功，原 combined-name 查询
错误仍保留。A ready-wait p99 末端 24.22 秒、B 2.35 秒，订阅均毫秒级；A 多类前台/
Gasoline transaction 同时变慢。下一实现仅减少源码已确认的多 coverage 重复 DELTA
遍历，以等价 oracle 和访问数保护；不是完整根因修复，不编 workerd、不发布或重跑负载。

2026-10-03 04:52:27 UTC checkpoint：原 exact cleanup 已确证 9,159/9,159 deleted、
零 DELETE retry、pending 零；自然缩容仍等待，不能把清理成功当作容量通过。
新只读 request-path invocation 已 SUCCESS/0，恢复首错 Actor ID，并采集 A/B 12 个
实际 Engine Pod 身份和历史 transaction/gateway 指标。两个 phase histogram query 返回
HTTPError，不能把该维度当成零；下一步先 relay 原 JSON 和 cleanup 原字节、核验 SHA，
再修正固定 phase 查询。当前没有 live local session，不重复原诊断或业务负载。

2026-10-03 04:48:06 UTC 恢复：上一 turn 为 progress，真实高水位/首错证据及成本模型
已推 master 046f2bde。原 supervisor fresh 同 PID/InvocationID running；load 已失败，
cleanup_exit_status=0，final capacity phase waiting，A/B sampled active 均零、Host 263/260。
当前继续确证 cleanup 原收据与定位 Cell 内响应等待，不重启负载、不跑 Router qualification。
下一只读进度不早于 04:53:06 UTC。云环境 status tool 和 policy snapshot 均不可用，不由
缺失推断网络/凭证 readiness；使用已有授权的 CLI，保持 proxy/凭证边界。

2026-10-03 04:36:37 UTC 接续：原 run 已 load_exit_status=1，stopReason 为
warmup_unexpected_error；9,127 ready、9,111 proven、2,086,955 active success。
32 objectsFailed/2,043 activeFailed 包含取消扇出，尚未提取首因，不称为独立错误数。
原监督 unit 仍 active/running、InvocationID/MainPID 未变，不能把监督清理期当作正常负载。
此前 04:29:50 高水位快照 relay 已完成、SHA 验真、离线复算成功。下一项先保存首错和
故障前 trace，让原 exact cleanup/natural drain 完成，不重发 workload，不放宽资格。

2026-10-03 04:23:54 UTC 恢复点：当前唯一 run 已 fresh 确认 running，7,613 ready、
1,443,192 active success，普通 retry/失败零。InvocationID/MainPID 不变，三秒创建正式
样本仍零；下一采样不早于 04:28:54 UTC。上一轮 v2 单位修正与固定 SHA trace 证据
已经推 master 51d79791；不同阶段的均值不能换算成受控性能收益。
本轮是 progress：真实 HTTP 重现 Router collector 对历史时间错误放行，修复窗口、
step 网格、时间顺序和末端新鲜度，42 项回归和最终 fleet 通过，discover 入口已包含全部测试。
documentation 当前零 errors/warnings；audit 33 项通过，Context unit 仍为原四项失败。
Context 4,942 个历史 errors 的归一化 Counter 无新增或消失；最新 checkpoint/catalog 后再验一次。
本轮源码待正常 push，不改在线 Runtime/tools/负载。

A/B 旧 Runtime 资格完成；strict10k 终态失败。新 Runtime 59e86519 的 reviewed build、
workerd reuse、产品 cold pull 和 A 正式 rollout/Bottomless/HA/activation 均已完成。
B 原 invocation 已 SUCCESS/0，完成新产品全部资格。strict10k 新 run 从 A/B 各四 Host/Node
开始实际负载，Runtime 59/tools 120/API 723 独立绑定；新诊断信号完整、无采样 warning。
小资格负载或首批 warmup 成功不证明 strict10k 通过，
原零普通重试、万活跃及三秒创建门禁不放宽。
本轮为 progress：固定原始失败 load 与高水位分析、确认首错传输阶段和工作成本模型；
不是 runtime 性能修复或容量通过。未启动第二负载，未编译或发布 Runtime；完整目标未完成。

### verified

- 本轮 standalone builder 模板：实际 Terraform 1.9.8/provider 1.83.11 validate valid、
  零 error/warning；storage/renderer 各九项通过，合法三个 .tf fmt-check passed。
  原 strict10k `inv-e9ekt2gfn9` 确认 terminal failed，但自然缩容和 exact cleanup passed。
- `inv-e9ehma0rme` SUCCESS/0，05:08:36 UTC：exact cleanup 已通过、final capacity
  waiting；A/B active 零、Host 215/215，原监督身份不变，sample missing/warning/error 零。
- 固定 phase follow-up `inv-e9ehaqg4md` SUCCESS/0，无 query errors；官方 relay
  `inv-d9ehbf0rqc` / `inv-a9ehbfgu7m` SUCCESS/0，411,749 原字节 SHA 前缀 8a65d1812adf。
  两个原 combined-name HTTPError 仍保留，没有改写原诊断成成功。
- `inv-a9ehg7g2i6` SUCCESS/0，05:03:11 UTC：原 unit 身份不变，Host 已降至
  A/B 228/228、MachineSet 236/233、active 零，仍 final waiting。
- `inv-a9eh970n7b` SUCCESS/0，04:55:42 UTC：原 supervisor 身份未变；A/B Host 已
  自然降至 246/246，MachineSet 253/251；仍 final waiting，无容量终态收据。
- request-path relay `inv-d9eh96geat` / `inv-c9eh970f0f` SUCCESS/0、SHA 验真；
  cleanup relay `inv-d9eh98gjkc` / `inv-a9eh99056w` SUCCESS/0、原字节验真。
  同窗 A/B gateway success rolling mean 末端 2.166/0.179 秒、in-flight 1,144/101；
  Depot commit histogram p99 2.274/0.308 秒。A 的 pending 含 gateway metrics 637、
  gateway lookup 457、commit 184 及多类 Gasoline transaction。不是单请求因果追踪。
- `inv-e9eh5ugs4b` SUCCESS/0：首错 Actor ID 为 5jtio0wprc5klcki8595arbwolal00；
  A/B 各六 Engine UID 未替换、零 restart。有限时间/日志字节内未匹配该 Actor，不能证明
  请求未执行。14 个 range query 中两个 routePhaseP99 返回 HTTPError，其余成功；
  request-path.json 161,966 bytes，SHA 前缀 8681733c4e39，尚未 relay 本地。
- 同一目录 cleanup-receipt.json 原字节 1,160 bytes，SHA 前缀 5331e9b3506c；
  04:43:02 UTC passed：本 run exact-owned 9,159 deleted、alreadyAbsent/pending/retries
  均零。未删除测试 cohort 以外资源，不声称业务失败得到修复或 final floor 收敛完成。
- `inv-e9eh230s0h` SUCCESS/0，04:48:06 UTC：原 supervisor 仍同 PID/InvocationID
  running，cleanup_exit_status=0；final waiting，A/B active 零、Host Ready 263/260。
- `inv-a9egtq0md4` SUCCESS/0；12 个 bounded range query 无错误，缺失 throttle series
  仍 unknown。首个安全 API transport record 为 req_1ae818ff4410d89378c8dc7915bd8603，
  04:36:35.186453032 UTC：连接/write 各 2 ms，等待 response headers 25,002 ms 超时，
  peer 10.161.0.7:6420。1935 其余匹配 warning 是 context canceled；一个 Evicted API Pod
  的日志不可读，其发生时间与资源原因不确定，不据此归因。
  195,048-byte 原 JSON SHA 前缀 `a831e7c8439a`，完整摘要见 evidence README，
  官方 relay `inv-d9egu8g0xp` / `inv-d9egu9g22k` SUCCESS/0、本地原字节已验。
- `inv-d9egtxgbjh` SUCCESS/0，04:41:35 UTC：原 supervisor 仍 running，load 已 failed；
  A/B sampled active 均零，Host desired 263/260。没有 cleanup terminal receipt，
  不能把 active 零当作全部 DELETE 完成或 floor/natural drain 通过。
- 首错归档 `inv-c9egqm0ktj` SUCCESS/0：04:36:35.187 UTC、index 9086 的 initialize
  返回一次 502 indeterminate_result；04:36:35.546 UTC 起 2,043 个 active code=20 是
  全局取消。Load receipt 原字节 SHA 前缀 `91e10cdd037e`，完整摘要见 evidence README。
  官方 relay `inv-a9egr30m47` / `inv-e9egr3g42x` SUCCESS/0，8,099,833-byte archive
  SHA 前缀 `cfd762515131`，完整摘要见 evidence README。
  本地 `/data/tmp/minisandbox-strict10k-55b55875-failure.V19y9o/` 的 trace 为
  72,264,143 bytes，SHA 前缀 `c8f32a8b2688`，完整摘要见 evidence README。
  04:25--04:36:35.187 离线 v2 32 样本/Cell：A/B UDB pending 峰值 4,373/717，
  compaction waiter 峰值 94/87。此阶段比 04:29 更劣化，尚不是 502 单一根因证明。
- C 只读 `inv-d9egs90inr` SUCCESS/0：相同 Workers API UID/image，HPA 已自动扩大到
  13 desired/13 Ready，并非始终三副本。一个 Failed Pod 原因为 Evicted，其具体资源
  原因与发生时间尚不确定，不能据此解释首错。
  临时诊断 `inv-c9egrr0p2h` / `inv-d9egsw03at` 均 FAILED/1，分别是诊断自身把 Pod
  数误限为 12、把取消后的匹配日志数量误限为 128；不代表新业务故障。
  新诊断改为按实际有界 HPA envelope 检查、保留最早 128 条及总数，不改运行时/资格门禁。
- `inv-d9egpaghg6` SUCCESS/0，04:36:37 UTC：原 supervisor 身份不变，load 已 exit 1，
  9,159 scheduled、9,127 ready、9,111 proven、2,086,955 active success，普通 retry 零、
  warmup 背压 7,631，post-warmup 样本零；停止原因为 warmup_unexpected_error。
  32 object failures 和 2,043 active failures 的首因/取消分组待查；前台 active p99 累计
  上界约 2.9 秒、max 17.2 秒。A/B Host desired 263/260、Ready 244/246。
- `inv-c9eggx0d8c` SUCCESS/0，04:29:50 UTC：8,333 ready、8,312 proven、1,730,459
  active success、37 in-flight，普通 retry/失败/身份漂移零；warmup 背压仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 233/242、Ready 222/222，原 service 身份不变。
- `inv-d9egbd0hva` SUCCESS/0，04:23:54 UTC：7,613 ready、7,610 proven、1,443,192
  active success、零 in-flight，普通 retry/失败/身份漂移零；warmup 背压仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 215/218、Ready 206/202；MachineSet
  desired/current/Ready 为 215/215/215 与 218/218/212。诊断无 missing/warning/errors。
- `inv-c9eg5vgkxa` SUCCESS/0，04:18:04 UTC：6,923 ready、6,907 proven、1,193,475
  active success、119 in-flight，普通 retry/失败/身份漂移零；warmup 背压仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 197/200、Ready 183/181；MachineSet
  desired/current/Ready 为 197/197/191 与 200/200/194。诊断无 missing/warning/errors。
- `inv-a9eg0qgash` SUCCESS/0，04:12:33 UTC：6,262 ready、6,245 proven、976,752
  active success、109 in-flight，普通 retry/失败/身份漂移零；warmup 背压仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 173/182、Ready 165/163；MachineSet
  desired/current/Ready 为 173/173/173 与 182/182/176。诊断无 missing/warning/errors。
- `inv-d9efts05nb` SUCCESS/0，04:07:16 UTC：5,632 ready、5,622 proven、787,957
  active success、150 in-flight，普通 retry/失败/身份漂移零；warmup 背压仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 161/164、Ready 147/150，原 service 身份不变。
- `inv-c9efp70fti` SUCCESS/0，04:02:22 UTC：5,033 ready、5,021 proven、628,461
  active success、103 in-flight，普通 retry/失败/身份漂移零；warmup 背压仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 143/146、Ready 129/132；Machines
  desired/current/Ready 为 143/143/137 与 146/146/146。仍是原 run，不是万级终态。
- `inv-a9efg70hhp` SUCCESS/0，03:54:54 UTC：4,134 ready、4,117 proven、423,205
  active success、116 in-flight；普通失败/retry/身份漂移零。warmup 背压累计仍 7,166，
  三秒 post-warmup 样本零。A/B Host desired 119/122、Ready 108/111，原 service 身份不变。
- fixed-prefix snapshot `inv-e9efa7gbxk` 与官方 relay 两 invocation 均 SUCCESS/0，
  13,472,442 原字节与 SHA 前缀 a11bd34a 校验通过。复算同窗 authority 约各增长
  0.20--0.22 MB/s，末端 reclaim 零、manager waiter 峰值零、compaction waiter 峰值 0/1。
  阶段约 1.6k active/Cell，与旧 9k 场景不同，不推断受控收益或高水位根因。
- v2 非资格分析和 metric 单位修正见 pressure-analysis Task；cold publication rate
  不是实际唯一 PUT 或对象填充率，不能与 reclaimed FDB value bytes 直接相减。
- `inv-d9ef6dga7b` SUCCESS/0，03:44:27 UTC 原 run 55b55875：2,873 ready/proven、
  203,912 active success，普通请求 retry/失败/身份漂移零；warmup 背压仍 7,166 次、
  576 对象、零 timeout，三秒 post-warmup 样本零。A/B Host desired 83/80、Ready 75/72，
  Machines desired/current/Ready 为 83/83/83 与 80/80/80。诊断 91/87 samples，无缺项/warning。
  active p99 上界约 304 ms；这只是当前累计样本，不是万级终态性能。
- 03:39:01 UTC `inv-d9ef1agh1t` SUCCESS/0，只读确认原 service / InvocationID 未变：
  2,244 ready、2,231 proven、121,935 active success，普通 retry/失败/身份漂移零；
  warmup 背压累计 7,166 次、576 对象、零 timeout、最长 227 秒。A/B desired Host
  65/62、Ready 各 57；三秒 post-warmup 样本尚未开始。下一观察不早于 03:44:01 UTC。
- 独立 pressure analyzer 与 16 项真实文件/CLI 回归、完整 fleet 通过；旧失败 trace
  窗口复算和设计约束见 `2026-10-03-minisandbox-pressure-analysis.md`。诊断不重建 Runtime，
  不触碰运行中 tools 120，不签发容量资格。规划/准入/执行/有效回收分别报告，缺项 unknown。
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

- Router 当前 `run.py` 只支持一次共享 Worker、固定 Object 集的持续绑定负载；
  `capture.py` 可采实际 cache hit ratio，但尚无 1%/50%/99% mix 与 1/4/8/16+ replica
  的完整矩阵收据。新增 Object 请求不是纯 cache miss，创建/唤醒成本不得混为缓存成本；
  单副本曲线不得通过直接降低生产三副本 HA 下限实现。
- 完整目标还包括百万 dormant 公共路径、1k/10k 同步 wake storm、热点/多 key、流式取消/
  背压及剩余网络故障矩阵；不把已有小资格、局部算法测试或 3→4→3 HPA 证据代替这些要求。
- strict 10k 通过和 Router performance receipt；历史 run 与 55b55875 均终态失败，
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

- 本轮开发 revision qlqrltvm，parent c2e2d4ae（空 revision），master 为 173f293b。
  真实 TF 本地 validation data `/data/tmp/minisandbox-runtime-builder-tf.b2T4Na`，
  init/validate 输出为 `/data/tmp/minisandbox-runtime-builder-tf-{init,validate}-20261003.*`。
  原 strict supervisor 已 terminal，不再续接或重发。c631 image 不因本轮 Terraform/docs
  变更重编，实际 source、build、release 身份仍按其原 immutable receipts。
- 当前开发在 `/data/tmp/mono2-minisandbox-storage-pressure-local.kPqDAf/repo` 的独立 jj
  revision lxlmltuv，parent master d10ee76a；原 dirty 工作区保持不动。
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

- 先完成新 builder 的 exact cloud/guest CBS 身份 join、拒绝使用已有数据盘的初始化、
  幂等持久挂载和真实 bulk-path admission，再在 reviewed plan 下创建/交接。原 C 的 rootfs
  恢复只允许 exact 验证后可恢复的旧构建缓存处理，不碰在线 containerd/日志/PVC 或旧证据。
  恢复真实 HPA 监控信号后使用已建 c631 正式 release/资格，随后重跑原严格负载。
- 当前源码防回归是 progress，云上真实 builder 负门禁已证明 fail closed，不是性能修复完成。
  剩余明确：在原自然 drain/ops lock 完成后，通过 Terraform/bootstrap 实现独立 bulk backing
  或独立 builder，不手工搬目录；恢复实际 Prometheus/HPA 值后，发布已建 c631 并重跑固定
  strict10k。已有 c631 产品不因 tools/文档变更重编 workerd。
- 上一 goal turn 为 progress：百万 key 组件实测/模型与原收据记录正常 FF 推 master
  `b72df9f5`，远端身份与 clean worktree 已核验。当前独立 `lnrotoor` revision parent
  `b72df9f5`，准备 c631 的正式 A/B release，不缩小完整目标。
- 只读 preflight `inv-d9ejqjg5u6` 于 06:20:23 UTC SUCCESS/0，但 A/B preflight 都 exit 1，
  绝不是发布成功。原 strict supervisor 同一 MainPID/InvocationID live；A/B Host 42/80
  全 Ready，Machine 52/81 Ready，仍未到原低容量门禁。C API desired 12/Ready 11，HPA
  min/max 3/30，UID/image 未变；readiness v1 已完成但 TAT 输出截断，不作为完整原件。
- 完整 readiness v2 `inv-e9ejtk0j3t` SUCCESS/0，06:23:37 UTC；COS relay
  `inv-c9ejv0gw05` / `inv-e9ejv10m41` 已 SUCCESS/0，原件 84,546 bytes、SHA 前缀
  `7f723c22039d`。C Node UID 前缀 `cdea12a3` 对应原 builder，DiskPressure True；
  18 条 DisruptionTarget 记录及 06:23:19 eviction 均在该节点。memory pressure False。
- 磁盘只读 `inv-d9ejv00vae` SUCCESS/0，06:25:04 UTC：/data 不是独立数据盘，和
  /var/lib/{actor-build,containerd,containers} 共用 /dev/vda1。available 15,240,155,136
  bytes，inode 未耗尽；Buildah 14,825,512,960 bytes、containerd 4,703,731,712 bytes、
  logs 827,445,248 bytes。actor-build du timeout/124，不推断它的总大小。未清理或改盘。
- 用户再次要求从成本/排队/协调/维护模型解决性能劣化。HPA snapshot 的两项 custom
  metrics 未有值，不能仅由低 CPU 推断可缩容；生产源码已经初始化零值 metric，排除
  “缺少启动时零序列”这一简单解释。继续核实唯一 APIService/Adapter/Prometheus 路径。
- c631 release wrapper 已复用正式 release/ops/qualification/activation 路径；旧期望 Runtime
  改为 59、旧资格目录改为 runtime-admission。公共 API 只校验同 UID/digest、HPA 3--30
  内实际 desired 全 Ready，不强制三副本；仍保留四 Host/Machine、六 Engine 与全部资格门禁。
  preflight 只可生成本地 image inventory，不调用 workload mutation。bash -n exit 0，
  六项 exact release-hold 回归通过。wrapper SHA 前缀 `1a44fbcfad28`；正式 COS relay
  `inv-a9ejph06wf` 验真 12,103 bytes，未启动 release、未创建第二份负载。
- 已记录三条失败的 exact query：`qualification/actor-bj-q01/release-runtime-via-tat.sh`、
  `runtime/test-runtime-admission-render.sh`、`workers-api/production.yaml`。都不存在，已按
  有界文件搜索回到正式 release-runtime.sh、真实 release-hold test 和 workers-api/api.yaml，
  不再猜测上述路径。等待前一原作业，不将 API 短暂未 Ready 直接判成完整根因。
- 本轮 million churn 组件变更的文档 gate 零 error/warning；Context 26 tests 的四项失败名称
  与既有 FDB-read-flights 基线完全一致，audit tests 33/33。discovery 执行 exit 0 只是候选
  发现，不是成熟度评审通过。最终 Context normalized error Counter 与基线完全相同：
  4,942 项、added/removed 均零、当前 Task 零 error；六条精确变更路径的 impact gate 通过，
  matched_rules 为空，只是变更集映射检查，不代表完整性能目标通过。
- million churn 实测已经执行且没有 skip：独立模块用 GOWORK=off、已安装 Go 1.25.4，
  native 三项测试 exit 0；100 万不同 SHA key、32,768 retained entries，GC heap 在
  131,072/1,000,000 访问为 10,773,840/10,774,144 bytes，exact Worker delete 后
  1,862,168 bytes（baseline 1,861,320）。race 三项也 exit 0、无 data race，百万 fixture
  9.85 秒；Go vet exit 0，gofmt/diff-check 通过。两个日志 SHA 前缀为 `3b99e3d70f51`/
  `dc250f40f727`，完整摘要在正式 evidence。固定 64-byte ID payload 的保留 heap 门禁
  不代表整套 API RSS；README/design 已明确边界。
- 原生首跑被根 go.work 的 Go 1.26 要求和系统 GOTOOLCHAIN=local/Go 1.24.4 拦住，
  未执行任何测试。随后 bounded find 定位真实 binary
  `/data/build-cache/toolchains/go1.25.4/bin/go`；在 module/GOWORK=off 下实际 GOVERSION
  已核验为 go1.25.4。未改根 workspace、工程 toolchain/version 或下载未知编译器。
  未加 GOWORK=off 的 version 观察曾选择 Go 1.26，这不是最终 gate 的 toolchain 身份。
- 原服务 06:14:44 UTC `inv-e9ejja0pwn` SUCCESS/0，同一 MainPID/InvocationID running，
  load failed/cleanup passed/final waiting；A/B Host desired/Ready 56/87，Machine
  66/87 Ready，active 零、无观察错误。只观察原 supervisor，不提交第二份负载。
- 原 runtime build session 67448 / `inv-a9eij1gqpt` 已 SUCCESS/0，临时 build auth 清理
  `inv-a9ejfgge4q` SUCCESS/0。只读 06:10:41 UTC `inv-a9ejfgge4n` 确认产品收据 passed、
  source `c631f554` / manifest `a54e7daa59d1` / registry image `d3a6e41e3d1c`，
  registryPullVerified 真。Rust Host 六项测试通过；未重编 V8、未上线 A/B。
  正式 COS relay `inv-d9ejgg0jmg` / `inv-d9ejgh03tg` 下载产品原收据 673 bytes，
  SHA 前缀 `d49da48b0ec0`，源身份及 exact ref 本地 jq 已核验。原 runtime build log
  SHA 前缀 `06ec7b3b4e48`。完整 identity/hash 在正式 evidence。
- 上一 goal turn 为 progress：Router offered-window 修正正常 FF 推 master `40adcd4e`，
  远端 SHA 已核验、worktree clean。当前独立 revision `ytlzyvvs` parent `40adcd4e`，
  只补 million-key cache churn 组件验证；不降低完整 million-dormant/10k/cache-mix 门禁。
  原 build session 67448 本轮续接已完成；不重新提交 runtime build/rollout 或负载。
  cloud runtime Skill/networking 本轮已完整读取，status tool 不存在、policy snapshot 缺失，
  实际现有授权 TAT 为准。Go 系统 binary 为 1.24.4，工程 pin 1.25.4，使用正常 toolchain
  选择且将 cache/tmp 放 /data，不降工程 version 规避要求。
- 只读临时路径检索曾误扫 /data/tmp 树，已核验并终止唯一自建 rg 进程，改为 maxdepth=1
  的确切文件查找。产品 helper `runtime/build-product-receipt.py` 是不存在的错误路径，
  已回到实际 build-image/build-runtime 入口和 product 原收据；未运行猜测的 verifier。
- 当前 Router 工具的最终 source 门禁：49/49、changed Python AST 六文件通过、diff-check
  无错误，documentation 零 error/warning；Context 4,942 历史 error 的 normalized Counter
  与基线完全相同、Task 零 error。26 项 context tests 与旧 FDB-read-flights 日志的四个失败
  名称完全相同，audit tests 33/33；audit discovery 是 needs_agent_review/not_assessed，
  不冒充成熟度通过。十个 changed paths 的 impact gate passed、matched_rules 为空。
  错误猜测 `/data/tmp/minisandbox-context-tests-20261003.log` 已纠正为 bounded 目录定位的
  `/data/tmp/minisandbox-fdb-read-flights-context-tests-20261003.log`；不重复猜测。
- 原监督服务 05:50:59 UTC `inv-e9eiv1g7t1` SUCCESS/0、同一 MainPID/InvocationID
  running，load failed/cleanup passed/final waiting。A/B Host 114/113 Ready，Machine
  123/120 Ready，active 零、观察 errors/warnings/missing 空。下次 load 只读观察不早于
  05:56:05 UTC；既有失败首错与收据不改写。
  build 05:52:25 UTC `inv-d9eiwcg9af` SUCCESS/0，正式日志继续编译 rivet-telemetry 等
  Rust dependencies；cargo 真进程仍在。原 build session 67448/`inv-a9eij1gqpt` 只续接。
  下次 builder tail 不早于 05:57:30 UTC；没有重提、发布、第二负载或手工扩缩容。
- Router v4 本地完整 suite session 4607 已 exit 0，49/49（含真实 HTTP/CLI、单完整五分钟
  样本、late dispatch 拒绝、arrival/dispatch 时间分解与原容量 fail-closed 门禁）。最终日志
  `/data/tmp/minisandbox-router-arrival-window-gate-v4-20261003.log`；v3 原 46/46，v2 失败
  保留。v2 schema 不接纳旧的缺少 offered/timing 证据 receipt，不改生产协议或 compiled Rust。
  当前准备最终 docs/context/impact 门禁和推 master；云端仍不能运行 Router performance。
- build 只读 v2 `inv-e9eirag1gs` 在 05:47:01 UTC SUCCESS/0，cargo/rustc 真进程存在，
  唯一正式日志 `/data/actor-qualification/builds/runtime-c631f5542f45b974455543d5bb458e0b3b3cf395.OJTtUP.log`
  显示 Rust dependencies 正常编译。原 session 67448/build `inv-a9eij1gqpt` 继续，未重发。
  `prepare-cargo-cache.py` 是错误路径，正确 helper 经 rg --files 为 `.sh`，现已完整读取。
  helper 在 transitive local input/toolchain digest 改变时清空整个有界 target，这是 Rust
  依赖重编的确定原因；并非 V8 重编或构建已失败。mtime/immutable-source 与 Cargo fingerprint
  正确性需独立设计，不能直接删除 cache guard 或中途干预该 build。
  下次 builder build tail 不早于 05:52:05 UTC，原 load 进度不早于 05:50:05 UTC。
- 当前 Router 工具修正已实现 v2 offered window、三种 client timing histogram 和完整
  scheduled/succeeded/cleanup/count 门禁；Prometheus 评估只覆盖五分钟内完整 offered load。
  第一轮本地真实 HTTP/CLI suite 45/45。新增单点五分钟 fixture 后第二轮 45 passed/1 failed，
  原因是 fixture 错写 2025 epoch 而声明 2026；collector 实际返回正确 2026 epoch。
  已仅修 expected 常量，第三轮 session 32418 正在运行；失败日志原样留在
  `/data/tmp/minisandbox-router-arrival-window-gate-v2-20261003.log`。不隐藏失败或改实现放行。
  README/formal design 同步，仍未完成受控 cache/replica 矩阵或云端 Router 资格。
- 05:45:00 UTC `inv-d9eipe0wsw` SUCCESS/0，唯一 supervisor 原身份 running，
  load failed/cleanup passed/final waiting；A/B Host 各 127 Ready、Machine 137/134 Ready、
  active 零、观察无 error/warning/missing。下一只读观察不早于 05:50:05 UTC。
  build `inv-a9eij1gqpt` 原 session 67448 仍运行，不重发。
  builder 只读 `inv-c9eiqp0450` 在 05:46:22 UTC 已确认 cargo/rustc 进程，随后因远端
  不安装 rg 而 FAILED/127，未更改文件或构建。下一观察改用单目录 exact revision 的
  bounded find，不安装工具、不 restart build；此错误不是 build 已失败。
- 上一 goal turn 为 progress：full bundle 验证、两套 helper 各五项通过，唯一 build 已启动，
  Task/catalog 正常 FF 推 `ae339fd6` 并核验远端与 clean worktree。当前 `vkvvnqzq`
  parent `ae339fd6` 是独立 Router 验收工具修正，不改正在构建的 c631 immutable source。
  本轮 cloud Skill/networking/docker references 已完整读取；环境 status tool 仍不存在、
  network-policy snapshot 缺失，不推断权限；原 session 67448 已续接仍 live。
  source atomic materialize `inv-e9eih40404`、build preflight `inv-e9eiiw0vmi` 和 push-auth
  helper 已 SUCCESS/0；原 build `inv-a9eij1gqpt` 正在继续，不重复提交。
- 新检索失败：`workersapi/actor_cache.go` 与 `router-performance/test_capture_transport.py`
  不存在。随后分别以 rg --files 定位 `objectrouter/router.go` 与 `test_sample_window.py`；
  不继续猜路径。当前固定轮询工具不能完成 1/50/99 cache mix 矩阵。
  下一项先修确定性证据问题：计划到 dispatch 的排队遗漏、[5m] 查询混入 preparation。
  保留真实 Worker binding、每次持久 increment、零 retry、精确清理和 strict10k 前置门禁。
- 用户重申从模型/设计解决劣化。沿用正式设计的前台成本向量、有效 maintenance 与
  rework/replay 分解；不把机器 CPU 均值、有界 permit、排队延期或源码测试当作容量收益。
  两项确定性修正已在 master `c631f554`，仍须同负载实际尾延迟/有效吞吐证明。
- 本轮完整 source bundle session 79514 已 exit 0；14,287 files，project tree
  `7abf2ab8`、manifest 前缀 `a54e7daa59d1`、bundle SHA 前缀 `810754b20d39`。
  `verify-full-source-bundle.py` 对 exact revision 验证 exit 0。session 93526 的
  full-source 五项和 bottomless monitor 五项测试均通过；不冒充 Engine/容量测试。
  本地证据 `/data/actor-build/local-admission-c631f554-20261003/`。
  唯一 formal build wrapper 为 `/data/tmp/minisandbox-point-read-runtime-build-c631f554-20261003.sh`，
  local session 67448 正在继续；首个 relay TAT `inv-a9eigvgdpt` 已提交，不重复启动。
  exact Runtime 59 digest 用作 unchanged workerd stage 基准；immutable tag 为
  `bounded-point-reads-c631f5542f45`。此处只准备/构建产品，不发布或启动新负载。
  relay 的四个 download invocation `inv-a9eigvgdpt`、`inv-e9eih1gdmf`、
  `inv-d9eih2gr5d`、`inv-e9eih3gjxu` 均 SUCCESS/0；原 atomic materialize
  `inv-e9eih40404` 正在运行，继续唯一 session 67448，不因等待重提。
- 05:38:34 UTC 原 run 只读 `inv-d9eihd0d57` SUCCESS/0；MainPID/InvocationID
  未变，load failed/cleanup passed/final waiting。最新 trace 05:38:16 A/B Host
  各 143 Ready，Machine 153/150 Ready，active 均零、观察 errors/warnings/missing 均空。
  此次仍早于建议边界十四秒；下次硬按至少五分钟，不能用 trace 采样时间替代完成时间。
  后续只读观察不早于 05:43:40 UTC；不抢占原 ops lock，不启动第二负载或线上 rollout。
- 上一 goal turn 为 progress：源码修正已正常 FF 推 master `c631f554`，远端 SHA 与
  本地相同、工作区 clean。当前新 jj revision `zknkrxvw` parent `c631f554`，不沿用旧
  source identity。本轮按正式 full reviewed-source/COS relay/build-runtime 入口准备新产品，
  复用 Runtime 59 的 exact workerd stage，不降低 compiled-input closure/self-check 门禁。
  build 与 runtime rollout 分离：原 strict10k ops lock 未释放前不改 A/B 镜像、配置或负载。
  cloud runtime Skill 与 networking/docker references 本轮已完整读取；环境状态 tool 不存在、
  network policy 文件缺失，不能因此声称网络/auth readiness，实际现有授权 CLI/TAT 为准。
- 05:33:48 UTC `inv-d9eicw0wna` SUCCESS/0，再确认唯一 supervisor 原 MainPID/InvocationID
  running；load failed、exact cleanup passed、final waiting。A/B Host desired/Ready 各
  154/154，Machine desired/current/Ready 为 164/164/164 与 161/161/161，active 均零。
  该观察比建议边界提前九秒，后续用真实完成时间至少五分钟，下一次不早于 05:38:48 UTC。
- ReadFlights 源码本轮验收：universaldb + foundationdb check exit 0、lib 19/19、
  clippy v4 --lib --tests exit 0；新增文件没有 warning，现有 UDB lib 20/libtest 22
  warning 不做无关 fixer。真实 FDB 7.3.79 opt-in gate 四项全部通过，原日志为
  `/data/tmp/minisandbox-fdb-point-read-test.556dPz/attempt.NuDO1u/test.log`，没有 skip。
  launcher trap 已停止唯一测试 server，localhost:45679 无 listener；data/log 留作证据。
  不连旧本地/云上数据库，不改线上镜像、admission、范围读或存储格式。
  正式设计、FDB 诊断 evidence README 已同步。下一步完成 source/context 门禁并推 master；
  等原自然 drain 收敛/ops lock 释放后，才走正式 runtime release 和固定 strict10k。
  四项 native fixture 清理改用 exact owned prefix successor，重跑验证清理后范围/键为空；
  单 key 的 `end_of_key_range` 不用于 prefix cleanup。最终 gate 仍 4/4，Clippy gate exit 0。
  文档门禁零 errors/warnings；Context 当前 4,942 个全量历史 error 与已存基线的 normalized
  Counter 完全相同、Task 零 error；26 项 context 测试保留同四项历史失败、audit tests 33/33。
  原监督服务 05:28:57 UTC `inv-d9ei8cgw2j` 同一身份 running；A/B Host 166 Ready、
  Machine 176/173 Ready、active 均零，load failed/cleanup passed/final receipt 尚未产生。
  下一次只读进度不早于 05:33:57 UTC，不抢占原 ops lock。
- 当前 revision `uplnqwyp` parent `0700632d` 正在修正 FDB point-read 串行化，尚未提交或
  发布。`cargo check -p universaldb --features foundationdb` exit 0；lib 19 tests（含
  四个 ReadFlights 状态机）已通过。第一轮 lib fixture 的 pinned future 生命周期编译失败，
  缩小借用 scope 后复跑通过，不隐藏原失败日志。真实本地 FDB gate 仅绑定
  `/data/tmp/minisandbox-fdb-point-read-test.556dPz/fdb.cluster` 的 localhost:45679，
  使用现有 7.3.79 binary，不连接旧本地/云上 FDB。初始连接名非法和 server memory 小于
  默认 cache 导致 fixture 启动失败，已修正名称和显式 memory/cache 后复跑；真实结果未出。
  FIFO barrier 覆盖除 Get/GetKey 之外所有 command；范围读没有并行化，generation fence、
  native on_error、reset 与 maybe-committed 分类不变。不把本地 gate 当作 strict10k 改善。
  新 native fixture 又暴露 Slice 的 Deref target 是 Vec、Fn async 必须显式 clone/move 的
  编译错误，已修 fixture 并重跑。重复启动沿用已初始化目录会使 `configure new` 拒绝，
  launcher 改为每次独立 mktemp data/log 目录；不将 fixture 失败冒充 native gate 通过。
  首个真正执行的 native gate 为 2 passed/1 failed：range 的默认 Iterator 首页只返回一行，
  fixture 错把首页当作全部 64 行。改为原生分页 stream 的 try_collect，不改 driver 的范围
  语义；追加真实 conflict/on_error/reset 回归后重新跑四项。clippy v3 已 exit 0，尚待
  最终 fixture 对应门禁。原失败日志保留在 `attempt.Gt1nOE/test.log`。
- 当前只读 FDB 诊断 v2 `inv-a9eht400a3` 已 SUCCESS/0；远端原文件为
  `/data/actor-build/release/strict10k-fdb-55b55875-20261003.1qNi9u/fdb-diagnostic.json`，
  307,079 bytes、SHA 前缀 `b9476d6015d5`。官方 COS relay 正在原 session 64924
  继续，metadata invocation 为 `inv-c9ehvtgg4b`，不得因断线重发诊断。
  A/B 当前各九 FDB storage Pod/Node/PVC，CR UID 与负载身份相同；CPU、RSS、历史 Pod
  UID 和前台 attempts 有结果，node/disk 与 throttling 查询空集是 unknown，不是零。
  初版 `inv-c9ehrugfrk` 在远端 Python 解析失败，未采业务数据；v2 AST/bash 检查后重提。
  relay 已 SUCCESS/0：metadata `inv-c9ehvtgg4b`、upload `inv-e9ehvug1ju`；本地原文件
  `/data/tmp/minisandbox-strict10k-55b55875-fdb-diagnostic-20261003.json` 已验长度和 SHA。
  同窗十八 Pod UID 全匹配，A/B 总 CPU 采样峰值 6.756/6.585 cores、单 Pod 小于
  0.89 core；前台 attempts 接近一，refresh 峰值 1.95/1.523。CPU 均值和 ratekeeper
  ratio 不能排除单线程/局部热范围/网络或磁盘尾延迟。
- 源码确认 FDB `TransactionTask::run` 对每个 Get/GetKey/GetRange 都 await 后才取下一
  command；`get_for_gateway` 的十个 try_join 点读因此被 adapter 串行化。下一项是有界
  read-flight 修正，mutation/commit/reset/on_error 保留 FIFO barrier；它是确定性缺陷，
  不是尚未完成的首错因果证明。`nodeExporter.enabled=false` 解释本轮 node/disk 空指标，
  不以盲目改 selector 或空集推断磁盘空闲。
- 原监督服务 `inv-d9ehs7gxq7` 在 05:13:51 UTC 仍为同一 MainPID/InvocationID；
  load failed、exact cleanup passed、final capacity waiting。A/B Host desired/Ready 各
  202/202，Machine desired/current/Ready 为 212/212/212 与 208/208/208，active 均零。
  下一次原服务只读观察不早于 05:18:51 UTC；不发第二负载、不改容量或发布新 Runtime。
- 最新 progress `inv-d9ehwgg5ve` 已 SUCCESS/0，同一监督服务 05:18:25 UTC running；
  最新 trace A/B Host 192/192、Machine 201/201/201 与 197/197/197、active 零。
  本次提交早于建议五分钟边界约 26 秒，后续恢复至少五分钟间隔，下一次不早于
  05:23:25 UTC。无第二负载、故障或 rollout。
- 04:29:50 UTC 高水位快照的官方 relay 已完成：metadata `inv-a9eghu0595` 与 upload
  `inv-c9eghv03s2` 均 SUCCESS/0，原本地 session 91503 已 exit 0，不重发快照或 relay。
  本地 trace `/data/tmp/minisandbox-strict10k-55b55875-pressure-capacity-042950-20261003.ndjson`
  为 59,971,839 bytes，SHA 前缀 `b080ebd57a0b`，完整摘要见 evidence README。
  离线 v2 分析 04:15--04:29 UTC 已 exit 0，各 Cell 41 样本、无观察 warning/error；
  输出 `/data/tmp/minisandbox-strict10k-55b55875-pressure-late-v2-042950-20261003.json`，
  SHA 前缀 `2628460d5fbd`，完整摘要见 evidence README。
  A/B compaction 峰值均 12 in-flight、waiter 89/88；stage 成功执行均值 236/282 ms、
  完成率 37.86/34.76 per second。前台仍零 ordinary retry 不代表后台容量已通过；
  下一步核对 guard/timer 生命周期及 stage 分片事务成本，不能直接由完成者估计 offered load。
- 下一次只读进度不早于 04:53:06 UTC；首错与故障前 trace 已保存，不把 supervisor
  running 误报为负载正常。等待原 exact cleanup/natural drain 与最终失败 receipt，
  不并发第二负载或 Router performance，不重启原 service。
- 跟随唯一已运行 strict10k，保留旧失败身份，不临时 patch 线上容量、超时或重试。
  A/B release/qualification、materialization/stage reuse 与新产品已通过，strict10k 未通过。
  不因为文档/诊断更新重编 workerd；tools 120 独立于 Runtime 59。
- 复用已完成的离线 `analyze_pressure.py` 选择不可变 trace 的负载窗口，不混入 cleanup，
  不将重叠五分钟 rate 积分为精确事件总数。供给 lead time 与后台债务分开判断。
- 将 admission wait、execution 与 durable history/replay 分开建模；现有排队 timeout 机制
  已复现；新指标 A/B 已可用。不重写历史分类，不用小资格采样宣称
  万级对照已经成功。
- 当前相同 strict10k 观察 shared lane 总 offered demand、执行时间、有效 fold/publish/reclaim、
  deferral/replay 成本和 hot-debt 斜率。排队不再耗失败预算并不证明存储吞吐已足够。
- Formal design 已记录新的高水位失败和 stage 工作成本拆分；下一轮须补有效状态/coverage/shard
  成本归因，先减少每份有效工作成本，再评估资源预算。不把有界队列、13 API Ready 或 CPU
  空闲当作容量结论；当前 first 502 已定位到发送后响应等待，Cell 内具体阻塞点仍未确定。
- 不拿旧合并指标估算
  timeout 比例，不因普通 docs/诊断变更单独重建 workerd。
- 保持 Router performance 前置 10k 门禁；诊断修复不单独触发 workerd 重构建或 Runtime 发布。

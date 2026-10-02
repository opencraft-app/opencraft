---
id: minisandbox-hot-plan-head-advance-2026-10-02
type: task
scope: 用真实存储与事件有序暂停复现持续写入使热压缩计划过期。
triggers: ["minisandbox hot plan head advance", "queued hot compaction", "hot plan rejections"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/engine/packages/depot/tests/cold_workflow_publish.rs
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

确定复现 head 在热计划执行前或安装前推进时的失效重排，验证最新持久写入不丢失。

## non_goals

- 不据此认定云上积压根因，不修改正在运行的严格一万活跃负载。
- 不弱化 fingerprint、生命周期、history/PITR 校验，不改变生产配置，不重新编译 workerd。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计 Phase 5 要求万级活跃容量与持久化正确性证据。
- 用户要求持续推进完整 Stateless Workers / DO 目标，修复必须有确定证据。

## interface_refs / data_structure_refs

- StageHotJob、InstallHotJob、CompactionJobStatus::Retryable、ForceCompactionResult。
- test-faults 新增准入前暂停点，不在 FDB 事务内等待并发写入。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：mastera7872881，云 run94270692 正在原参数运行。
- superseded_refs：不能根据 completed COS duration 排除未完成请求，也不能根据队列判定数据丢失。

## acceptance

- 三个真实 filesystem UniversalDB / Gasoline 测试由 pause/release 明确排序，无定时 sleep 制造竞态。
- 旧计划一次拒绝、新计划成功、watermark 推进到2、读取结果仍是最新写入。
- 连续九个计划各被实际 commit 使其失效，force 明确耗尽八次重试预算，root 不假推进，最新页不丢。
- 无生产语义变化，聚焦测试与文档、Context 门禁完成后正常 push。

## affected_paths

- Depot 热压缩测试故障点、feature-gated 准入前暂停、cold_workflow_publish 回归。
- 正式设计、本 Task 与 catalog。

## required_context

- upstream-subtrees、minisandbox CLAUDE、cells AGENTS、fleet README、argocd-ci-secrets 邻接。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@a7872881 | 根约束 | 独立 revision 与证据 |
| docs/context/project/upstream-subtrees.md@a7872881 | 路由结果 | 仅 mono2 写入 |
| docs/context/project/adjacency/argocd-ci-secrets.md@a7872881 | 邻接 | 检查真实容量资格入口 |
| minisandbox/CLAUDE.md@a7872881 | Rust 约束 | 实际数据库与有序事件测试 |
| minisandbox/infra/cells/AGENTS.md@a7872881 | 云约束 | 不并发资格或部署 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@a7872881 | 门禁边界 | 不将局部复现当云根因 |
| minisandbox/engine/packages/depot/src/compaction/shared.rs@a7872881 | 指纹与规划 | 保留现有安全校验 |
| minisandbox/engine/packages/depot/src/workflows/db_hot_compacter.rs@a7872881 | 两处校验 | 分别覆盖执行与安装前 |
| minisandbox/engine/packages/depot/tests/cold_workflow_publish.rs@a7872881 | 测试邻居 | 复用真实 storage helper |
| minisandbox/engine/packages/test-deps/src/datacenter.rs@a7872881 | 测试依赖 | 隔离 filesystem 默认，非云 FDB |
| docs/context/tasks/TASK-TEMPLATE.md@a7872881 | Task 契约 | 有界状态 |

## evidence

- 10:53 UTC 严格暖机6290对象、984788成功交互、交互/身份/重试错误为0。
- A/B compaction waiters1374/1780，FDB9/9健康；没有证明积压已经导致前台错误。
- 源码 Stage 与 Install 都重读当前 head、selected max、coverage、fingerprint，不可只修其中一处。
- 三条真实存储回归已确定复现两处失效和持续写入饥饿；没有定位云中每一次拒绝的 reason。

## risks

- completed histogram 不能解释当前 pending；复现只建立可能机制，不建立云上根因。
- 事务内暂停会让串行 filesystem backend 无法并发 commit，因此暂停放在 admission 前。

## validation

- 最终三个聚焦真实存储测试通过，2.93秒。修改断言文案并添加第三条之后重新编译测试确认。
- 添加第三条之前，完整 cold_workflow_publish45项与 fault_controller7项通过；不是46项完整重跑。
- 日志在 /data/tmp/minisandbox-hot-head-advance-final-tests-20261002.log 与
  /data/tmp/minisandbox-hot-head-workflow-regressions-20261002.log。
- 文档 errors/warnings 为空，六文件变更影响门禁通过但没有匹配的责任规则。
- Context 4855项，与先前基线新增/移除均为空；audit33项通过，根26项仍原4项失败。
- canonical 非 test-faults `cargo check -p depot`、Rust 格式和 diff 检查通过。
- 首次从 mono2 根使用 manifest-path，未加载 minisandbox/.cargo 的 tokio_unstable，编译失败。
  改从 minisandbox 工作目录运行 canonical 配置后通过；这不是产品修复或降低测试门槛。

## decisions

- 先固化可重复故障路径，保留所有生产校验，之后依据证据选择安全修复。

## scan_scope

- Depot compaction、HotJob stage/install、fault controller、真实测试依赖与资格 observer。

## scan_output

- 两处 head 推进使计划过期；新 fault point 只由 test-faults 调用。

## handoff

- 已确定复现旧计划失效、持续写入下无进展与最新状态正确恢复，生产优化尚未实施。
- 非 test-faults 构建门禁已通过，正常 push 此独立复现任务；不发布 Runtime。
- 原云21551仍唯一高风险 live。未宣布目标完成。

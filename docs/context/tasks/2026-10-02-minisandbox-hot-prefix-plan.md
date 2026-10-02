---
id: minisandbox-hot-prefix-plan-2026-10-02
type: task
scope: 热压缩绑定不可变已提交前缀，避免后续写入作废无关计划。
triggers: ["minisandbox hot prefix plan", "immutable hot compaction prefix", "continuous head advance"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/engine/packages/depot/src/compaction/shared.rs
  - minisandbox/engine/packages/depot/src/workflows/db_hot_compacter.rs
  - minisandbox/engine/packages/depot/src/conveyer/commit/apply.rs
  - minisandbox/engine/packages/depot/src/conveyer/keys.rs
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让已提交前缀的热计划在 head 后续推进时仍能安全 Stage/Install，并保留最新 PIDX 与历史读取。

## non_goals

- 不改变正在运行的 strict10k run94270692，不并发发布或提交另一云资格。
- 不增加 compaction 并发，不放宽3秒/零稳态重试，不删生命周期、manifest 或历史保护。
- 不声明一万活跃、Router 性能或百万 dormant 已通过。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式 Stateless Workers / DO 设计 Phase5 的持续活跃容量与持久化安全要求。
- af1d9daf 的三个真实回归已证明当前 head 校验可能使持续写入下九个计划全部过期。

## interface_refs / data_structure_refs

- HotJobInputRange.txids、CompactionInputFingerprint、HotInputSnapshot、StageHotJob/InstallHotJob。
- PIDX 是当前页 owner；不可变 COMMIT/DELTA 才是前缀物化输入。Serializably 读取最新 PIDX 后仅清理前缀内 owner。
- prefix fingerprint 要绑定 branch、root generation/watermark、前缀 txid、COMMIT/DELTA、history/PITR coverage。
- commit-owned `META/truncate_txid` 是固定宽度 u64 BE 索引。零证明无本地 truncate，正数或缺失保留 head fence。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：af1d9daf 已有准入前、stage 后与连续九次写入的有序复现。
- superseded_refs：不能只从 fingerprint 删除 head，Stage/Install 还会选择新 commits；也不能绑定会变化的最新 PIDX。

## acceptance

- 后续写入不再产生无关 stale-plan rejection，旧前缀能推进，新页 owner 和最新读保持正确。
- Stage/Install 都严格限定计划上界，不读入未来提交，不改变已有 FDB key/byte 预算。
- 新 history pin、PITR policy 或所选 COMMIT/DELTA 改变仍拒绝旧 proof，生命周期和根 generation fence 仍有效。
- truncate-grow 不复活旧页，历史 coverage 使用自身 EOF；未知历史不允许 ordinary commit 认证为 prefix-safe。
- 原有完整 cold workflow、force driver、fork/history/PITR、quota 与故障回归通过，生产非 fault 构建通过。

## affected_paths

- Depot compaction snapshot、fingerprint、hot Stage/Install、真实数据库测试。
- 正式设计、本 Task 和 catalog。

## required_context

- upstream-subtrees、minisandbox CLAUDE、cells AGENTS、fleet README、argocd-ci-secrets 邻接。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@af1d9daf | 根入口 | 独立任务与有界门禁 |
| docs/context/project/upstream-subtrees.md@af1d9daf | 路由 | mono2 唯一写源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@af1d9daf | 邻接 | 资格与发布串行 |
| minisandbox/CLAUDE.md@af1d9daf | 实现约束 | 实际数据库测试，不 mock 模块 |
| minisandbox/engine/AGENTS.md@af1d9daf | Engine 边界 | UniversalDB、PIDX 和事务 |
| minisandbox/engine/packages/depot/AGENTS.md@af1d9daf | 包责任 | 仅 workflow publish、同步三个存储设计 |
| minisandbox/infra/cells/AGENTS.md@af1d9daf | 云约束 | live qualification 期间不发布 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@af1d9daf | 资格边界 | 不用局部测试替代生产证据 |
| minisandbox/engine/packages/depot/src/compaction/shared.rs@af1d9daf | 输入与预算 | 前缀选择和 proof |
| minisandbox/engine/packages/depot/src/workflows/db_hot_compacter.rs@af1d9daf | 事务与配额 | Stage/Install 同一边界 |
| minisandbox/engine/packages/depot/src/conveyer/history_pin.rs@af1d9daf | 历史保护 | 保留串行 pin 检查 |
| minisandbox/engine/packages/depot/src/conveyer/pitr_interval.rs@af1d9daf | PITR 索引 | 原子 coverage 更新 |
| minisandbox/engine/packages/depot/tests/cold_workflow_publish.rs@af1d9daf | 实际复现 | 改为期待安全进展 |
| minisandbox/docs-internal/engine/sqlite/storage-structure.md@af1d9daf | 键与 proof | 前缀身份不改变持久 schema |
| minisandbox/docs-internal/engine/sqlite/components.md@af1d9daf | 责任 | planner、Stage、Install 的边界 |
| minisandbox/docs-internal/engine/sqlite/constraints-and-design-decisions.md@af1d9daf | 不变量 | 前缀安全与历史保留 |
| docs/context/tasks/TASK-TEMPLATE.md@af1d9daf | Task 契约 | 记录有界判断 |

## evidence

- 已重新确认 masteraf1d9daf、clean worktree、原21551仍live，任务前 jj new。
- Stage 与 Install 都会读取当前 head；PIDX 单独用于 serializable compare-and-clear 与 quota。
- 新期望在旧产品代码下真实失败三次：两个边界无水位推进，连续写入同样失败；不是只改断言后自证。
- 修复后七条有序场景通过：旧前缀进展三条，新 fork pin/PITR 保护四条。真实 fork 还验证旧页可读。
- 最终 source 的十一个 test target 共180项通过；cold workflow57项104.78秒，commit36项和key26项也通过。
- 新 pin 夹具先前失败有明确原因：AtTimestamp 依赖已发布 PITR，而新 fork 会使 bucket proof 未完成。
  最终夹具通过真实 fork API，并分页推进真实 catalog proof，不伪造 Ready 状态或添加重试掩盖竞态。
- 当前云 run94270692 在8193 ready/8181 proven处因11次 active transport retry失败，约167万次
  交互成功；8193/8193精确删除完成，最终安全缩容仍在原操作内。未进入 post-warmup3秒样本。
  API HPA 在11:09:05删除一个Pod，30秒preStop之后与retry时间吻合；另有退出顺序漏洞待独立任务复现。

## risks

- head 推进不是不可变 COMMIT/DELTA 改变；可变 PIDX 必须脱离物化 fingerprint，但其清理不能脱离最新 serializable snapshot。
- 当前 history/PITR proof 必须重验；不得靠固定旧计划时间绕过新 pin 或 policy。
- 不改变 wire/versioned record schema；新增 commit-owned exact index，新 fingerprint domain 使旧未完成计划安全重排。
- 截断过或未知历史仍保留 head fence，持续写入进展优化只覆盖已认证从未截断的分支。

## validation

- BEFORE 三条失败，AFTER 三条通过3.06秒；history/fork/PITR五条（含continuous）通过4.54秒。
- 最终完整180项通过，生产非fault cargo check通过5.53秒，Rust格式与diff check通过。
- 文档 validator errors/warnings为空，audit33通过；根context26仍为原四项失败，没有冒称全绿。
- Clippy 因未改动 db_branch_gc.rs 原有 never_loop 错误未通过；不借本任务改其生命周期语义。
- Context4855项与原基线完全相同，新增与移除均为空。十五个变更路径的文档impact门禁通过。

## decisions

- 对 planner 保留现有预算选择；Stage/Install 用计划上界读前缀，用独立当前 PIDX 做条件清理。
- 新索引与 shrink 同事务提交，growth 永不清零；preflight 前先查 input identity，完整 body 校验和发布事务内复验保留。

## scan_scope

- Depot hot compaction、history/PITR、quota 和既有真实故障测试。

## scan_output

- HotJobInputRange 已含不可变 txid 上界，不需要新增 versioned schema。固定宽度 truncate 索引区分普通写与修改 SHARD 的 shrink。
- 首轮 truncate before/after-stage 两反例失败；索引/逐commit EOF 后 before-stage通过，after-stage仍因preflight先判missing失败。
- 调整先查input的顺序后两条通过；十条前缀/历史场景通过8.22秒，包括未知索引与真实fork旧EOF。
- 新增 staged batch 与 input-check之后的 truncate：五条truncate场景通过4.36秒，完整矩阵也覆盖这两个边界。

## handoff

- 本地修复已实施并通过最终180项矩阵，尚未发布；原云运行在 load失败后仍负责清理和安全缩容。
- 下一独立确定修复是 Workers API 必须等待 HTTP Shutdown，而不是监听器一关闭就退出main。

---
id: minisandbox-regional-seed-revalidation-2026-10-02
type: task
scope: 为依赖闭合 Runtime 发布建立严格区域镜像 cold-pull 复验入口。
triggers: ["minisandbox regional seed revalidation", "regional mirror cold proof", "regional seed exact inventory"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/gitops/image-seed/README.md
  - docs/context/tasks/2026-10-02-minisandbox-regional-seed-revalidation.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

关闭 foundation 更新之后的完整 image inventory 证据缺口，复验现有区域 TCR 的 17 个 immutable mirror，
以正式 11-product/28-image dependency closure 进入 Runtime 发布，不重编无关 workerd。

## non_goals

- 不伪造或恢复缺失的旧 seed preimage，不重新访问公共上游。
- 不手工修改 live workload、MachineSet intent 或 admission，不降低 strict 10k 资格要求。
- 不以镜像工厂、静态测试或 source push 代替完整 Stateless Workers/DO 目标完成。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless-workers-do-routing/phase-4、phase-5：安全缩回低容量、严格 10k、Router 性能证据。
- image-seed/README：11 个产品、28 个 repository 及 exact dependency closure。
- 原 inventory 不能还原 seedReceiptDigest 的 preimage，区域复验必须显式继承审阅 provenance。

## interface_refs / data_structure_refs

- image_contract.validate_inventory、validate_upstream、validate_seed、assemble。
- actor-regional-image-seed-revalidation/v1：旧 inventory、新 seed、source lock 与 17 次独立 cold pull。
- product-lock.write_new：不可覆盖的原子单文件发布；proof 与 seed 不是原子文件对。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md、image-seed/README.md。
- relevant_evolution：2c4ced82 的正确 Go foundation 已构建并 cold verified；四个 Go reverse
  dependencies 的 inv-a9d6h6033i 已由 TaskStatus=SUCCESS/ExitCode=0 验真。
- superseded_refs：旧完整 inventory 可作被审阅的 handoff authority，但不是新 regional seed preimage。

## acceptance

- input digest、regional host、upstream lock/provenance、auth 和全量 inventory 在任何 pull 前验证。
- 17 个精确 refs 各使用独立空 VFS graph，并验证实际 Linux/amd64。
- 失败或缺失平台无 seed/proof；不输出原始 registry 错误；旧文件不可覆盖。
- 新 seed 仍走原有完整产品/镜像 assembler，不降低 closure。
- 进程级回归、image-seed、fleet 静态门禁以及文档/change-impact；Context 无新增错误。

## affected_paths

- minisandbox/infra/cells/deploy/tencent/fleet/gitops/image-seed/。
- minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md。

## required_context

- release-gitops、upstream-subtrees、argocd-ci-secrets adjacency、root/minisandbox/infra-cells AGENTS。

## context_receipt

- root AGENTS、minisandbox/CLAUDE.md、infra/cells/AGENTS.md：jj/task 边界和正式发布唯一入口。
- release-gitops、upstream-subtrees、MONO2_SUBTREE：master 是源码，不等于线上 release。
- argocd/README、.ci/AGENTS、argocd-ci-secrets adjacency：未授权触碰其他产品 leaf。
- image-seed README、image_contract、product-lock、seed-tcr、record-product-image 及其测试邻居。
- cloud-environment-runtime/networking：复用配置的 TAT/COS，不输出密钥、不改变安全机制。

## evidence

- 2026-10-02 的 TAT 回查：四产品 build SUCCESS；旧 10k cleanup inv-a9cwx404ak 仍 RUNNING。
- readonly progress inv-a9d713gma9 SUCCESS：11 产品均 registryPullVerified，Go 四叶和 base 为 2c4ced82，
  Runtime 保留 a2f68ea8 原始 source identity；无 buildah/go 进程。
- baseline Context 为 4,812 errors；不得称全库绿。

## risks

- input inventory 的审阅与真实性是信任前置，self digest 不提供签名或 origin authenticity。
- 每项 graph 清理使用 TemporaryDirectory；只检查新的隔离缓存，不触碰 builder 默认 storage。
- 进程硬中断后可能只有 proof；保持 immutable，不做自动覆盖或盲重发。

## validation

- 9 条独立进程/文件系统回归与完整 image-seed gate 已通过；documentation errors/warnings=[]。
- 显式 7 文件 change-impact passed；Context 26 tests 仍有 4 项 baseline failures，不称全绿。
- 完整 fleet verify-manifests passed；Context 4,812 errors 与最新 baseline 精确一致，无新增。
- Context-audit 33 tests passed；discovery/assessment 不作为生产资格证明。

## decisions

- 复用 inventory 的已审阅 mirror provenance，新增 regional availability proof，不改原 seed schema。
- 等完整 28-image assembler 通过，才允许正式 controller-first recovery/release。

## scan_scope

- image-seed/；Context catalog 只更新本 Task 记录，不全量改写其他人的 stale records。

## scan_output

- baseline 位于 /data/tmp/minisandbox-regional-seed-context-baseline.json，未写入源码。

## handoff

- 当前阶段：regional revalidation CLI、进程回归与完整静态门禁完成；仍需推送与真实 cloud pull。
- next_action：reviewed-source relay 到 builder，复验 17 mirrors、assemble 全 28 项，再正式 release。
- remaining_goal：strict 10k、ACK/commit disconnect、告警投递、Router 性能、百万 dormant 与完整矩阵。

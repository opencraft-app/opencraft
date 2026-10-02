---
id: minisandbox-capacity-release-recovery-2026-10-02
type: task
scope: 在正式 Runtime 发布事务内恢复卡住的零 provider attempt 缩容控制器，避免 settle-before-fix 死锁。
triggers: ["minisandbox capacity release recovery", "controller-first release", "pending downscale release deadlock"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/README.md
  - docs/context/tasks/2026-10-02-minisandbox-capacity-release-recovery.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让修复后的单副本 capacity controller 能通过正式 Runtime 事务先恢复未发出请求的卡住意图，
然后继续 settle、Runtime rollout 和 ledger 提交；不能靠手工清意图或直接改 image 绕过发布所有权。

## non_goals

- 不重发 ambiguous/accepted provider 删除，不修改 Node/Machine/replica 状态。
- 不扩大 singleton writer 为 HA，不改变资格标准或恢复/备份门禁。
- 不在未完成 journal/UID/rollback 验证前部署控制器。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless-workers-do-routing/phase-4、phase-5：真实扩容后无人值守安全缩回，并证明 strict 10k。
- runtime/release：候选镜像 preflight、静态 release ledger、精确原快照回滚及 operation lock。
- runtime/exact-downscale：attempt 持久化先于 provider，未知副作用不能取消重试。

## interface_refs / data_structure_refs

- `release-runtime.sh` 的 hold、capacity settle、preflight、rollback、ledger 提交。
- MachineSet v2 downscale intent、Machine/Node UID 与 Node drain annotation/taint。
- 不可变 recovery ConfigMap 保存 pre-mutation 原模板及候选 image/source identity。
- Deployment UID/resourceVersion/template 的 JSON Patch CAS。

## history_context

- current_design_refs：runtime/README.md、2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：7073e01b 修复了旧快照误清 fence 和零 attempt 意图取消；普通 release 仍在
  更新 controller 之前等待这个旧 controller 无法自行收敛的 intent，形成部署恢复死锁。
- superseded_refs：不能以“先等 settle”作为修复卡住控制器的唯一发布顺序。

## context_receipt

- 已读 root 与 minisandbox/infra/cells AGENTS；路由必须读 release-gitops、upstream-subtrees。
- 已读 minisandbox/MONO2_SUBTREE、argocd-ci-secrets 邻接卡。
- 有界检查 release-runtime.sh、admission-controller.yaml、verify-manifests.sh、hold builder 与 tests。
- cloud-environment-runtime 规范已读，沿用已配置 TAT/COS 访问，不打印 credential/Secret。

## acceptance

- 恢复只在显式开启且 exact Machine/Node UID 未变、零 attempt、零 RequestID、无 Node fence 时允许。
- 不改变普通发布的安全 settle；恢复在候选 image/config preflight 后、settle 前执行。
- 原模板 journal 必须先在 Kubernetes 持久化；controller 必须 replicas=1、Recreate。
- Patch 和前置恢复回滚都测试 UID/RV/完整模板；迟到更新与替换 UID fail closed。
- 前置阶段失败时只恢复其控制器模板；恢复失败则保留 hold+journal，不释放 placement fence。
- CLI tests、故障场景、发布顺序测试、完整 fleet static gates 通过；云上证据另行归档。

## affected_paths

- minisandbox/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/capacity-controller-recovery.py
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_capacity_controller_recovery.py
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/README.md
- minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh
- minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md

## evidence

- 7073 controller build inv-c9d3s3gp22 已 SUCCESS；product receipt 在 builder `/data/actor-build/product-receipts`。
- registry 精确 image digest 记录于上述 product receipt，不从日志中的 receipt digest 推导镜像身份。
- 10k run 354610a58f4a66c7e0b4ec8d7978cbda cleanup passed；负载失败，不可视为资格成功。
- 02:59Z A 的 old intent 为 prepared/zero-attempt/unfenced，A/B 主 FDB 均 healthy/fullReplication。
- 03:27Z 只读回查：A runtime hosts 已自动降至 30、MachineSet 仍为 201 且原 intent 卡住；
  B hosts 已降至 22、MachineSet 36 且无 intent。不能把 Pod 缩容误报为 Node 缩容完成。
- a2 Runtime build inv-e9d34904h6 已 SUCCESS，复用未变化的 workerd/V8 stage；
  exact image digest 记录于 builder `/data/actor-qualification/builds/product-rivet-runtime-a2f68ea8*.json`。

## validation

- 新 helper 的 11 个测试方法全部通过，包括真实 CLI、生产 Shell 函数与 kubectl process double。
  验证 journal 持久化失败不修改 Deployment、Patch 已提交但 ACK 丢失后精确恢复，以及发布顺序。
- bash syntax、Python compileall、git diff --check、完整 fleet manifest gates 全部通过。
- documentation errors=[]；显式 8 个变更文件的 change-impact passed。
- Context 全量 4,798 个既有错误与 f06 baseline 精确一致，无新增错误；26 个 Context tests
  的 4 项失败与 baseline 相同，不能宣称该 suite 全绿。Context-audit 33 tests passed；
  audit 的 discovery 输出为 needs_agent_review/not_assessed，不据此声明成熟度已评测。
- 云上 release 必须绑定 source bundle、exact product digest、operation lock、收据及 ledger。

## decisions

- 恢复仍归 release-runtime.sh 所有；不是第二个 runtime template writer。
- 用现有 ConfigMap 持久化不可变 journal，不新增高权限服务或 CRD。
- 硬中断留下 hold+journal，不能无证据重新抢占；自动恢复能力不在仅持久快照的证据内。

## risks

- 候选控制器正常取消原意图属于动态容量状态，不由静态模板回滚重建原意图。
- journal/hold 是 crash evidence，不伪称完整 release resume 已实现。

## handoff

- stage：实现和完整 fleet static gates 已通过，正在完成审计与 mono2/master 推送。
- verified：7073 controller 与 a2 Runtime image 构建成功；恢复 helper、事务前置阶段、
  保留 hold 的回滚及 11 个回归测试 passed。
- unverified：正式恢复 release 与 A 自动缩容，以及 a2 Runtime 的 strict 10k 门禁。
- next_action：推送经过验证的独立 revision，归档 reviewed-source；随后通过正式事务发布并重跑云上门禁。

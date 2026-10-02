---
id: minisandbox-exact-downscale-recovery-2026-10-02
type: task
scope: 修复真实 10k 验收清理时旧 MachineSet 快照误清活动 drain fence 后的安全缩容收敛。
triggers: ["minisandbox exact downscale recovery", "runtimecapacity orphan fence", "TKE pre-provider fence recovery"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-02-minisandbox-exact-downscale-recovery.md
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/README.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让 10k qualification 从高容量无人值守缩回低容量；恢复旧快照导致的 pre-provider fence 丢失，保持
每次最多删除一台、精确 UID 删除、增长优先及 provider ambiguous result 不重试的不变量。

## non_goals

- 不手工清除线上意图或修改 replicas 来冒充自动缩容。
- 不为已经尝试的 provider 操作重新选择、补发或重试删除。
- 不将 Node/Machine UID 替换或其他控制器的 drain 标记当作可恢复状态。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless-workers-do-routing/phase-4：负载驱动扩容后安全缩容。
- stateless-workers-do-routing/phase-5：10k 真实门禁必须从低容量启动并自动回落。
- runtime/exact-downscale：MachineSet 持久意图先于 provider 调用；provider ACK 丢失保持 fail closed。

## interface_refs / data_structure_refs

- `DownscaleIntentAnnotation` 中的 MachineSet/Machine/Node UID、phase、Attempts、RequestID。
- Node `DrainAnnotation` 与 exact owner `NoSchedule` taint。
- MachineSet UID/resourceVersion 的服务端 JSON Patch CAS；Node drain 恢复已有自己的 UID/RV CAS。

## history_context

- current_design_refs：runtime/README.md、2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：原 orphan 恢复把一次 GET 的“无意图”直接当作清除 Node fence 的权限。
- superseded_refs：旧快照中无 annotation 不能证明此刻没有已经持久化的删除意图。

## context_receipt

- 已读 root/minisandbox/infra/cells AGENTS、upstream-subtrees、MONO2_SUBTREE、release-gitops。
- 已读 argocd-ci-secrets 邻接卡，并检查 runtime admission-controller.yaml 与 Go controller tests。
- 当前云上事实通过 TAT 获取，未读取 Secret、token 或 kubeconfig 内容。

## acceptance

- orphan 恢复前必须以服务端 CAS 证明相同 MachineSet 快照仍有效；CAS 失败时不能改变 Node fence。
- exact Machine/Node UID 相同、零 provider attempt、零 RequestID、完全缺失本控制器 drain 标记时，
  原意图安全取消并重启正常评估；已尝试、UID 替换或不同 owner 标记仍 fail closed。
- 永久测试覆盖迟到旧快照、缺失 pre-provider fence、已尝试 provider 请求、UID/owner 替换。
- 聚焦 Go tests/race/vet 与部署静态门禁通过后，发布 controller digest；真实 A 清理必须恢复推进。

## evidence

- run 354610a58f4a66c7e0b4ec8d7978cbda 的 Object cleanup receipt 已 passed，A/B active=0。
- TAT inv-a9d3590e8k 的日志显示 A 在 02:19:23Z prepare np-runtime0-vnq99 后，02:19:25Z
  自己执行 restore-orphaned-scale-down-fence，随后每五秒报 Node ownership fence changed。
- MachineSet intent 保持 prepared、Attempts=0、RequestID 为空；Machine UID 与 Node UID 未替换，
  Node 上 annotation 与 taint 均为空，A MachineSet 因而停在 201，而 Host 继续安全降容。

## affected_paths

- minisandbox/infra/cells/internal/runtimecapacity/controller.go
- minisandbox/infra/cells/internal/runtimecapacity/controller_test.go
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/README.md
- minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md

## validation

- `GOWORK=off`、本地缓存 Go 1.25.4 下 `go test ./internal/runtimecapacity/...` passed。
- 同一包的 `go test -race` 与 `go vet` passed；禁止套用 mono2 根 go.work 的 Go 1.26 要求。
- 显式五个 changed-file 的 change-impact passed（imported subtree 未匹配规则，不是空变更检查）。
- documentation errors=[]；diff check passed；完整 fleet manifest invariants passed。
- 真实 controller rollout 后观察 exact intent/Node/机器数量及主 FDB 健康。

## decisions

- 保留一个 Recreate controller 作为 MachineSet 的单一缩容写入者；服务端 CAS 防止过期 GET 授权恢复。
- 丢失 fence 的未发出操作只取消，不直接恢复并继续删除；重新执行完整容量/拓扑/empty-node 检查。
- 当前 a2f68ea8 Runtime 构建独立继续；本修复仅需 Go controller 镜像。

## risks

- 服务端 CAS 冲突只延迟恢复，不允许使用客户端的“无意图”猜测绕过校验。
- provider 已尝试的意图仍可能需要外部事件才能收敛，不能靠取消重试解决其不确定副作用。

## handoff

- stage：确定性源码修复与 Go tests/race/vet 已通过，正在运行部署静态门禁和准备 reviewed bundle。
- verified：旧 snapshot/server RV 不符时保持 Node fence；API proof failure 保持 fence；prepared 与
  armed/zero-attempt 缺失 fence 安全取消后走完整单台删除；attempted、accepted、替换 Node 与
  不同 owner 保留原意图且不触达 provider。a2 Runtime build invocation inv-e9d34904h6 仍在进行。
- unverified：修复后的 A 缩容与新 Runtime release/10k receipt。
- next_action：推送 master 并构建 controller digest；审查 release 先等 pending intent 收敛的恢复
  死锁，不得绕过 release ledger 或手工清除线上意图来发布。随后恢复云上缩容并执行 Runtime 门禁。

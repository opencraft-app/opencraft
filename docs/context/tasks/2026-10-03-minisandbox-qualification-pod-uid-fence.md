---
id: minisandbox-qualification-pod-uid-fence-2026-10-03
type: task
scope: 跨 Cell qualification 的精确 Pod 删除与替换归因。
triggers: ["minisandbox qualification Pod UID", "stateless termination qualification", "exact replacement snapshot"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/stateless-durable-routing/pod_lifecycle.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: retired
reviewed_at: 2026-10-03
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

# Qualification 精确 Pod UID 门禁

## goal

使跨 Cell fault/termination 门禁只删除实际选中的 Pod UID，并且不能把无关 Pod 的替换
误报为目标故障的成功恢复。此小任务不替代 Stateless Workers 整体实现目标。

## non_goals

- 不改变 Runtime 镜像、正在运行的 A 资格任务、业务调度或故障测试流量。
- 不创建新云资源、不追加物理恢复或 soak，不为 harness 改动重新编译 workerd。

## requirement_ids / requirement_refs / requirement_excerpt

- `qualification/exact-victim`：整体方案的网络与故障矩阵，以及
  `minisandbox/infra/cells/AGENTS.md` 的精确 Pod 身份和正常 termination 约束。
- 用户要求继续原方案，并从建模上解释性能劣化。可信的故障和替换证据是验收前提，
  此修复本身不是性能改善证据。

## interface_refs / data_structure_refs

- Kubernetes `DeleteOptions.preconditions.uid`：原子验证目标 UID；不设置
  `gracePeriodSeconds`，保留 workload 的 preStop 和默认 grace period。
- `fault_matrix.replace_one_pod`、`termination_matrix.wait_replacement`：恢复证明必须
  包括目标 UID 消失、其他旧 UID 保留、恰好一个新 Ready UID及原 Ready floor。

## history_context

- `current_design_refs`：Stateless Workers、Durable Objects 与跨 Cell 内网寻址设计。
- `relevant_evolution`：master `dded7bf3` 后的两个 harness 记录目标 UID，却仍按名称
  删除；替换判定也可能接受无关 peer 的替换。
- `superseded_refs`：不将旧 Runtime 072 的资格借给 Runtime 59。

## acceptance

- 使用真实 kubectl 和本地 HTTP API double 证明精确 DELETE，ABA 返回 409，不删除新 UID。
- 畸形身份和错误 ACK fail closed；正常 grace 未被覆盖。
- 替换恢复使用同一个 API snapshot，并拒绝未选中 peer 的替换。
- 聚焦测试、fleet manifest 门禁、documentation 和变更 impact 检查通过。

## affected_paths

- `minisandbox/infra/cells/deploy/tencent/fleet/load/stateless-durable-routing/`
- `minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- `minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md`
- 本 Task 与 context catalog。

## required_context

- 根 AGENTS、minisandbox AGENTS、infra/cells AGENTS。
- upstream-subtrees、agent-gateway-runtime、ctl-service-detail、sandbox-service-context、release-gitops。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Task 和门禁边界 | 创建独立 Pack，保持源代码和发布证据分离 |
| `minisandbox/AGENTS.md` | jj 与 Runtime 约束 | 继续已创建的自身 revision，不重编 workerd |
| `minisandbox/infra/cells/AGENTS.md` | 云端操作所有权 | 保留原 invocation，正常 Pod termination |
| `docs/context/project/upstream-subtrees.md` | mono2 唯一写源 | 在隔离 mono2 worktree 提交 |
| `docs/context/domains/agent-gateway-runtime.md` | 公共调用边界 | harness 不能代替真实公共路径资格 |
| `docs/context/project/services/ctl.md` | 身份不可从名称推断 | 精确 UID 是故障目标 |
| `docs/context/project/services/sandbox.md` | 状态机约束 | 不直接更改业务状态 |
| `docs/context/domains/release-gitops.md` | 发布边界 | 本地修复不是上线证明 |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | 测试与发布邻居 | 对照已有 Bottomless monitor 测试 |

## evidence

- 2026-10-03 聚焦门禁：18 tests passed，零 skip，包括 4 个实际 kubectl/HTTP double
  测试以及目标/peer 替换归因回归。完整 fleet 门禁接入这些测试并要求实际 kubectl。
- 完整 fleet `verify-manifests.sh` exit 0；日志
  `/data/tmp/minisandbox-pod-uid-fleet-20261003.log`。documentation 0 errors/0 warnings。
- context-audit 33 tests passed，实际 audit exit 0。根 Context 的 4,942 个存量错误与
  前一 checkpoint 逐项 multiset 相同，新增错误为零；26 个 Context tests 仍为相同的
  4 个存量失败，不将它们写成全通过。
- A 只读进度 `inv-e9edg007ht` SUCCESS/0：02:46:24 UTC 新 Runtime 05840 已完成
  6 Engine/4 Host rollout；Bottomless 正在原 `inv-e9ecw30f8e` 下运行。
  当前 qualification hold 与 missing-new-receipt block 保留；B 未发布。

## risks

- 删除 ACK 格式未知时拒绝继续，不降级成按名称删除。
- Pod 无关漂移使资格失败，而不是重新选另一台删除。
- 本地 HTTP double 不证明真实 TKE drain、网络和产品性能。

## validation

- `python3 -m unittest discover -s minisandbox/infra/cells/deploy/tencent/fleet/load/stateless-durable-routing -p 'test_*.py' -v`
- `bash minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- 根 documentation、context、context-audit 及 changed-path impact 门禁。

## decisions

- 使用原有 kubectl 客户端的 raw DELETE，不新增特权服务。
- 条件 UID 在 Kubernetes API 原子校验；第二次 GET 不能消除 ABA。

## scan_scope

- fault/termination harness、相邻测试和 fleet 门禁；不读取 Secrets、kubeconfig 内容或私有日志。

## scan_output

- 有界搜索定位到按名称删除和恢复条件未绑定目标 UID。敏感 payload 无输出。

## handoff

- 本地实现和门禁已完成，长期约束回写正式设计。A 原 invocation 继续等待，不重复发布。
- A 新资格和 activation 完成后再发布 B；两 Cell 通过后才能执行不放宽条件的 strict 10k。

## checkpoint

- stage：implemented。
- verified：精确 UID 删除、实际 CLI/HTTP、目标/peer 替换、单 snapshot 及完整 fleet 回归已通过；A rollout 完成。
- unverified：新版 harness 的真实云故障运行；新 Runtime A/B 完整资格和性能验收。
- discard：按名称删 Pod、替换失败后重新选目标、把 Ready 当资格、为 harness 重编 Runtime。
- restore：继续自身 revision `pmxzzrsw`，基线 master `dded7bf3`。
- next_action：提交本地门禁；继续收集原 A invocation 终态，不缩小整体实现目标。

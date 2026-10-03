---
id: minisandbox-capacity-proof-identity-2026-10-02
type: task
scope: 为万级 active 资格收据固定容量身份、节点准入和采样时序。
triggers: ["minisandbox capacity proof identity", "ten thousand active Node admission", "capacity trace replay"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/verify.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

容量收据不得把同名重建、未准入节点或重复观察误认成一次合格扩缩容。

## non_goals

- 不修改 live run、生产控制器、HPA、请求重试、SLO 或运行时镜像。
- 不将离线校验通过宣称为万级云端资格或四次旧超时的根因修复。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计 Phase 4、Phase 5：真实低容量扩缩容和未准入节点不得进入容量真值。
- cells AGENTS 的 UID-bound 资格与不可变 runtime 约束。

## interface_refs / data_structure_refs

- ten-thousand-active verify.py 读取 observer 的 capacity.ndjson、load 和 cleanup 收据。
- 基线 FDB/Host/MachineSet UID、runtime revision 固定；Node UID 可以按正常扩缩容变化。
- 新 checks 为 capacityTraceValid、capacityIdentityStable；容量分别按 Cell 校验。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：master9e754555 保留失败 strict10k 与 Go-only 诊断发布；新 run94270692 正在运行。
- superseded_refs：只累加 Ready Machine/Host 数无法证明节点准入或同一次资格的身份连续性。

## acceptance

- 真实 verifier 子进程拒绝同名 UID 替换、缺失 UID、runtime revision 改变、重复 Cell/时间、倒序时间。
- 未准入、pending-tainted、重复 UID 的节点不计入峰值或最终 floor；不可借用另一 Cell 的容量。
- 合格低到高到低样本、额外 pending 节点和正常 Node UID 更换仍通过。
- 有限/非负 active 值、原 cleanup/FDB/零 retry 门禁保持。

## affected_paths

- minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/{verify.py,test_verify.py,README.md}。
- 正式设计、本 Task 与 catalog。

## required_context

- upstream-subtrees、cells AGENTS、fleet README、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@9e754555 | 仓库入口 | 保持唯一写入源与授权边界 |
| docs/context/project/upstream-subtrees.md@9e754555 | 路由结果 | 仅修改 mono2 |
| docs/context/project/adjacency/argocd-ci-secrets.md@9e754555 | 验证邻接 | 核对实际 observer/test 邻居 |
| minisandbox/CLAUDE.md@9e754555 | 实现约束 | 真子进程测试、非 mock 验证 |
| minisandbox/infra/cells/AGENTS.md@9e754555 | 资格不变量 | UID-bound 与节点准入 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@9e754555 | 资格边界 | 不以静态校验代替云端门禁 |
| docs/context/tasks/TASK-TEMPLATE.md@9e754555 | Task 格式 | 明确目标与非目标 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/observe.py@9e754555 | 采样邻居 | 原始 trace 已有 UID/Node taint，不需要云端变更 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@9e754555 | 正式目标 | Phase 4/5 不降低标准 |

## evidence

- 新真实子进程测试在修复前复现11个错误放行的 subcase；原7项测试均通过。
- 旧方法未检查 UID 变更、Node admission、重复时序和 Infinity；这些不是已发生的云端故障结论。
- 同一新云端 run94270692、TAT inv-a9dg11gvph 保持运行，不重提或修改其 immutable source。

## risks

- observer 异步观察只能证明该次采样，不证明每个请求实际执行在哪个节点。
- 不能固定每个 Node UID，否则合法扩缩容会被拒绝；固定的是容量容器身份与 runtime revision。

## validation

- 修复前后 verifier 真实子进程测试分别留存在 /data/tmp/minisandbox-capacity-proof-regressions-{before,after}-20261002.log。
- 最终15项真实子进程测试通过，文档 errors/warnings 均为空，git diff --check 通过。
- Context errors4855，与已有 baseline 完全一致，新增/移除均为零；六个显式 changed-file impact 通过。
- Context audit33项通过；根 Context26项仍有既有4项失败，不宣称整个仓库门禁全绿。

## decisions

- 只加强离线 verifier，不修改 observer 采样、不触发构建或发布。
- 原云端 run 使用原始 verifier；终态后可独立用新 verifier 再验原始 trace，不覆写原收据。

## scan_scope

- ten-thousand-active verifier/测试和 agent-upload-soak observer 的有界精确搜索。

## scan_output

- uid 已采集但未消费；峰值只检查聚合 Ready 数。未发现需要增加外部权限的操作。

## handoff

- 云端任务仍唯一 live；完成本地门禁与提交后继续同一等待句柄，并保留全部原失败证据。

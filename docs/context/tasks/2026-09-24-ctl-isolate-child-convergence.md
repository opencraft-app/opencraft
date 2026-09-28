---
id: task-ctl-isolate-child-convergence-20260924
type: task
scope: Fix CTL IsolatePass convergence when retries leave historical failed child tasks.
triggers: ["IsolatePass historical failure", "Pass stuck isolating", "isolate child convergence"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - ctl/pkg/pass/worker/isolate_task.go
  - docs/engineering/domains/agent-gateway-runtime.md
status: active
reviewed_at: 2026-09-24
review_due: 2026-12-24
revision: 1.0.0
precedence: task
derived: false
---

## goal
修复 CTL `IsolatePass` 父任务在同一实例经历失败重派后已成功，仍被历史失败子任务永久阻塞的问题。

## non_goals
- 不在源码变更中直接批量修改上海现网 `pass` 或 `tasks` 数据。
- 不处理实例长期停在 `Deleting` 的独立删除链路问题。
- 不改变 Pass 隔离入口、计费回调协议或最终隔离步骤。

## requirement_ids / requirement_refs / requirement_excerpt
- 线上排障 2026-09-24：上海 158 个 Pass 停在 `isolating`；其中 157 个实例已有成功隔离子任务，但父任务仍统计历史失败任务。
- 用户要求：修复该问题。

## interface_refs / data_structure_refs
- `ctl/pkg/pass/worker/isolate_task.go`：`IsolatePass` 父任务派发和完成判断。
- `ctl/pkg/model/task.Entity`：子任务状态及 `task_params.instance_id`。
- `ctl/pkg/model/instance.Entity`：实例终态和隔离资格。
- 不变量：父任务按当前实例收敛；同一实例任一隔离子任务成功后，旧失败任务不得继续阻塞。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：`97dea6ccce5f3c1fa02e1acbc1841a2eab223387` 引入失败子任务重派，但完成判断仍按历史任务行计数。
- `superseded_refs`：无。

## acceptance
- 同一实例存在 `FAILED` 和后续 `SUCCESS` 子任务时，父任务可继续完成。
- 同一实例仅有失败任务时，父任务继续触发重派。
- 同一实例存在执行中任务时不重复派发，父任务继续等待。
- Paused/Deleted/Failed 实例不被历史失败任务阻塞。
- CTL 定向测试、全量测试和 context/change-impact 门禁通过。

## affected_paths
- `ctl/pkg/pass/worker/isolate_task.go`
- `ctl/pkg/pass/worker/isolate_task_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `docs/context/tasks/2026-09-24-ctl-isolate-child-convergence.md`

## required_context
- Pack：`control-plane-ops`
- 权威文件：`ctl/AGENTS.md`、`docs/context/project/services/ctl.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@21f831c58` | 仓库级边界与验证要求 | 约束生产操作、Task Pack 和门禁 |
| `ctl/AGENTS.md@21f831c58` | CTL 服务边界与测试命令 | 确定服务级验证范围 |
| `docs/context/project/services/ctl.md@21f831c58` | control-plane-ops 路由必读 | 确认 CTL 编排所有权 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@21f831c58` | 检查发布邻接 | 本次不改部署配置，发布真实性仍需后续 CI/GitOps 验证 |
| `docs/engineering/domains/agent-gateway-runtime.md@21f831c58` | change-impact 映射设计文档 | 补充隔离子任务收敛不变量 |

## evidence
- 上海现网只读扫描：158 个 `isolating` Pass；157 个满足 `child_success > 0 AND child_failed > 0 AND child_pending = 0`。
- 唯一非同类记录为 `pass-d9oo8lbq`，实例长期处于 `Deleting`，排除在本修复外。
- 定向测试：`GOCACHE=/tmp/mono-fix-isolate-gocache go test ./pkg/pass/worker -run 'Test.*Isolate' -count=1` 通过。
- worker 包测试：`GOCACHE=/tmp/mono-fix-isolate-gocache go test ./pkg/pass/worker -count=1` 通过。
- CTL 全量测试：`GOCACHE=/tmp/mono-fix-isolate-gocache go test ./...` 通过；测试依赖本地 `httptest/miniredis` 端口，因此在允许本地监听的执行环境中完成。
- change-impact 门禁：`python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 通过；命中 `agent-gateway-runtime`，需要 `wisp/mono2-maintainers` owner review。
- 文档门禁：`python3 .agents/context/scripts/validate_documentation.py --repo . --format json` 通过，无错误、警告或 first-party 断链。
- 全仓 context catalog 校验：本 Task Pack 元数据通过且无本任务相关 finding；命令仍因仓库存量旧 Task Pack schema、instruction chain 大小及历史 secret-scan findings 返回失败，本次未扩大范围修复。

## risks
- 错误忽略真正未隔离实例会提前把 Pass 标成 `isolated`；通过按当前实例逐一判断并仅让同实例成功覆盖历史失败来规避。
- 重派竞争可能产生多个子任务；执行中状态优先于失败，避免重复派发。
- 发布后大量存量父任务可能同时恢复；保持原任务调度节奏，不新增批量数据库修复。

## validation
- `cd ctl && go test ./pkg/pass/worker -run 'Test.*Isolate' -count=1`
- `cd ctl && go test ./...`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`

## decisions
- 子任务状态按 `instance_id` 聚合，优先级为 `SUCCESS > CREATED/RUNNING > FAILED`。
- 完成判断遍历当前实例集合，不再遍历历史子任务行数。
- 终态实例沿用既有语义，不要求存在成功子任务。

## scan_scope
- `ctl/pkg/pass/worker/isolate_task.go`
- `ctl/pkg/pass/worker/*_test.go`
- 上海现网 `pass.status=isolating` 与关联 `tasks`（只读聚合）。

## scan_output
- 上海聚合结果：158 个卡住 Pass；157 个属于本缺陷，1 个属于实例删除未收敛。

## handoff
- 状态：实现、测试、change-impact 和文档门禁完成；全仓 context catalog 仅剩与本次无关的存量失败，等待 owner review、提交和发布。
- 下一步：经用户确认后 commit、push 并提 MR；发布后观察存量父任务恢复收敛。
- 阻塞项：无。

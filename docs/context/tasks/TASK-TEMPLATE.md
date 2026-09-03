---
id: task-pack-template
type: task
scope: Required state contract for a non-trivial development task.
triggers: ["task context", "handoff", "checkpoint"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - docs/context/tasks/TASK-TEMPLATE.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: task
derived: false
---

# Task Pack 模板

```markdown
## goal
一个主目标。

## non_goals
- 明确排除的工作。

## requirement_ids / requirement_refs / requirement_excerpt
- 需求标识与可定位的 PRD、TAPD、Issue 或 MR 引用。
- 只摘录本次范围、非目标和验收所需的最短片段；来源不可访问时明确写 `unknown`，不得编造。

## interface_refs / data_structure_refs
- 相关 API、事件、配置、Proto、OpenAPI、Schema、类型、表结构、状态机或 migration 的精确入口。
- 记录本次必须保持的不变量，不复制完整定义。

## history_context
- `current_design_refs`：本次需求当前有效的 ADR、设计或 Domain/Journey 真源。
- `relevant_evolution`：只保留解释约束的关键演进；以 Git、MR、TAPD、Issue 事实为准。
- `superseded_refs`：仅供有界回退，绝不作为默认设计依据。

## acceptance
- 可观察的完成标准与必需命令。

## affected_paths
- 仓库路径。

## required_context
- Pack ID 与预期权威文件。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `path@revision-or-hash` | 为什么与本任务有关 | 如何影响本轮决定 |

## evidence
- 命令、输出摘要以及 commit 或 live-state 证据。

## risks
- 风险、触发条件、缓解措施与回滚方式。

## validation
- 必需的 lint、测试、类型检查与发布检查。

## decisions
- 决策、备选方案、原因与 owner。

## scan_scope
- 有界扫描路径；无需扫描时留空。

## scan_output
- 隔离扫描产物的路径或摘要；不得内联完整扫描。

## handoff
- 当前状态、下一步、阻塞项与所需权限。

任务完成后，把长期有效结论回写正式设计或 Candidate；本 Task Pack 退出默认路由，保持为有界历史记录。
```

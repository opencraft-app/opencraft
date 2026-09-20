---
id: service-owners-2026-09-18
type: task
scope: 更新 Gateway Dashboard 与 Shadow 服务 Owner，并消除这两个 OWNERS 文件的 docs-impact 假阳性。
triggers: ["服务 Owner", "OWNERS", "docs-impact"]
owner: xinqishang
authority: primary
source_of_truth:
  - gateway-dashboard/OWNERS
  - shadow/OWNERS
  - .agents/context/change-impact.json
status: active
reviewed_at: 2026-09-18
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

## goal
将 `xinqishang` 加入 Gateway Dashboard 与 Shadow 的服务 Owner，并确保这两个纯 Owner 变更不会触发业务架构文档更新门禁。

## non_goals
- 不移除或调整现有 Owner。
- 不改变其他服务的 docs-impact 范围。
- 不改变服务接口、运行时、部署或平台审批策略。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation-2026-09-18-service-owners`
- 需求摘录：将当前用户加入 `gateway-dashboard` 和 `shadow` 服务 Owner。

## interface_refs / data_structure_refs
- `gateway-dashboard/OWNERS`
- `shadow/OWNERS`
- `.agents/context/change-impact.json` 的精确 `exclude_paths`

## history_context
- 首次提交尝试被 `identity-access` docs-impact 拦截；`shadow/OWNERS` 位于责任根目录，但不承载架构语义。

## acceptance
- 两个服务的 `OWNERS` 均包含 `xinqishang`，现有 Owner 保持不变。
- 这两个 `OWNERS` 单独变更时，业务责任面的 docs-impact 不命中。
- 其他服务的变更影响范围不变。
- Context 校验测试与 staged docs-impact 通过。

## affected_paths
- `gateway-dashboard/OWNERS`
- `shadow/OWNERS`
- `.agents/context/change-impact.json`
- `.agents/context/tests/test_validate_context.py`
- `docs/engineering/decisions/ADR-0002-design-history-and-docs-impact.md`

## required_context
- `context-governance`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/23-rules-matrix.md` | Context 治理契约 | 保持规则门禁可验证 |
| `docs/context/decisions/ADR-0001-context-engineering-v2.md` | Task Pack 与路由边界 | 记录本次变更状态 |
| `docs/engineering/decisions/ADR-0002-design-history-and-docs-impact.md` | docs-impact 权威设计 | 明确精确排除语义 |

## evidence
- 两个服务 `OWNERS` 均保留原 Owner 并新增 `xinqishang`。
- 精确排除回归测试通过，两个 Owner 文件不再命中业务责任面，其他路径不受影响。
- 显式变更集 docs-impact 通过，仅命中已同步 ADR 的 `context-engineering` 规则。

## risks
- 排除范围使用两个精确路径，不影响其他服务或非 Owner 文件。

## validation
- `python3 -m unittest .agents.context.tests.test_validate_context -v`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions
- 仅对本次明确的两个 `OWNERS` 文件做精确排除，不增加通配符豁免。

## scan_scope
- 两个服务 `OWNERS`、change-impact 规则与现有排除测试。

## scan_output
- 两个 `OWNERS` 当前未在对应业务责任面的 `exclude_paths` 中。

## handoff
- 当前状态：实现与定向验证完成，等待提交钩子复验。

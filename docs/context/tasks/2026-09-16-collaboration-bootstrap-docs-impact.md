---
id: collaboration-bootstrap-docs-impact-20260916
type: task
scope: 为 Collaboration 首次 bootstrap 的密码恢复修复补齐正式设计证据。
triggers: ["collaboration bootstrap docs-impact", "CynosDB password recovery", "Collaboration release design"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - infra_pulumi/pkg/collaborationbootstrap/bootstrap.go
  - docs/engineering/domains/release-gitops.md
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
让数据库密码修复 MR 的正式发布设计与代码一致，并通过 docs-impact 门禁。

## non_goals
- 不修改密码生成、云资源、CI guard 注册表或 GitOps 发布行为。
- 不自动提交、推送、合并 MR 或重跑 bootstrap。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户提供的 MR 占位检查日志：`infra_pulumi/pkg/collaborationbootstrap/bootstrap.go` 命中 `release-gitops`，缺少映射的正式设计文档更新。MR 标识未在本次日志中确认。

## interface_refs / data_structure_refs
- `Run` 先写 SSM、后建 CynosDB 账号；账号不存在且 SSM 中受管 DSN 密码不合规时允许受控修复。
- 账号已存在时不得隐式轮换密码；GitOps 仍须独立 MR 审核。

## history_context
- `current_design_refs`：`docs/engineering/domains/release-gitops.md` 的 Collaboration 北京两阶段 bootstrap。
- `relevant_evolution`：`7fb868b84` 修复密码复杂度并处理 SSM 已存在、账号未创建的中间态；#5 apply 在写 SSM 后因 CynosDB 密码参数失败。
- `superseded_refs`：无。

## acceptance
- 该 MR 的完整变更清单通过 `validate_change_impact.py`；无关 `infra_pulumi` 发布控制面改动仍受高风险规则约束。
- 文档明确首次账号密码约束、中断恢复与不隐式轮换的不变量。

## affected_paths
- `docs/engineering/domains/release-gitops.md`
- `infra_pulumi/README.md`
- 本 Task Pack

## required_context
- `release-gitops`、`service-infra-pulumi`、`tapd-gongfeng-delivery`、`context-governance` 与最近的 `infra_pulumi/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/release-gitops.md@2.0.0` | 路由必读 | 区分源码、GitOps 与运行态 |
| `docs/context/project/services/infra-pulumi.md@1.0.0` | 路由必读 | 明确 infra 控制面 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | 路由必读 | MR 写入授权边界 |
| `docs/context/23-rules-matrix.md@2.1.0` | 路由必读 | Context 与正式文档责任分离 |
| `docs/context/decisions/ADR-0001-context-engineering-v2.md@2.1.0` | 路由必读 | Task Pack 约束 |
| `docs/engineering/decisions/ADR-0002-design-history-and-docs-impact.md@2026-09-01` | 路由必读 | 假阳性与文档真源判断 |
| `infra_pulumi/AGENTS.md`、`infra_pulumi/README.md` | 服务入口 | Secret 与故障恢复规则 |
| `.ci/AGENTS.md`、`docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | CI 邻接 | Guard 与 Secret 边界 |

## evidence
- `origin/master...HEAD` 原变更仅有 bootstrap Go 代码与测试，`release-gitops` 高风险规则命中。
- 原因不是规则误报：正式设计已经明确该 bootstrap 的 SSM → 账号顺序，缺少密码恢复不变量。
- 原 MR 文件与本轮正式设计、服务 README、Task Pack 的完整清单通过 docs-impact，`matched_rules=["release-gitops"]`。

## risks
- 禁止输出或读取 SSM 的 DSN 密码；文档只描述状态与恢复条件。
- 不改广域 `infra_pulumi/**` 门禁，避免未来真正的架构变更漏检。

## validation
- docs-impact 对完整变更清单通过；文档校验 `errors=[]`、无断链和未分类文档；聚焦 docs-impact unittest 1/1 通过；`git diff --check` 通过。
- `validate_context.py --build-catalog` 仍因仓库既有 Task Pack 缺字段、`credit/AGENTS.md` 指令链超限和既有疑似 credential 扫描结果失败；本任务文件首次触发的 triggers 数不足已修复，不扩散修改旧文件。

## decisions
- 更新已映射的正式设计而不是排除 `collaborationbootstrap`：这里的中断恢复确实属于发布 bootstrap 正确性。

## scan_scope
- `.agents/context/change-impact.json`、校验器及测试、Collaboration bootstrap、正式设计与服务 README。

## scan_output
- 有界精确搜索，无持久扫描产物。

## handoff
- 文档已在本地通过 docs-impact；提交、推送和 MR 更新仍需用户明确确认。

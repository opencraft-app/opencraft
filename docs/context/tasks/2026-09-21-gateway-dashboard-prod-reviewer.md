---
id: gateway-dashboard-prod-reviewer-2026-09-21
type: task
scope: 为 Gateway Dashboard 生产发布审核增加 xinqishang。
triggers: ["gateway-dashboard reviewer", "PROD_REVIEWERS", "生产审核人"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .ci/gateway-dashboard.yml
  - .ci/templates/service-release.yml
status: active
reviewed_at: 2026-09-21
review_due: 2026-12-20
revision: 1.0.0
precedence: task
derived: false
---

## goal
在不影响其他服务审核名单的前提下，把 `xinqishang` 加入 Gateway Dashboard 生产发布审核人。

## non_goals
- 不修改共享 `service-release.yml` 的默认审核人。
- 不追溯修改已启动的 build `b-14493ba708984103abf1ee64eb97fec5`。
- 不审核、放行或触发生产发布。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation-2026-09-21-gateway-dashboard-reviewer`
- 需求摘录：为指定 Gateway Dashboard CI 的人工审核增加 `xinqishang`。

## interface_refs / data_structure_refs
- `.ci/gateway-dashboard.yml` 的 `extends.parameters.PROD_REVIEWERS`。
- `.ci/templates/service-release.yml` 中 stage-3 与 stage-6 的 `reviewers` 均消费该参数。
- Stream build 使用启动时的 pipeline version 快照。

## history_context
- `current_design_refs`：`docs/engineering/domains/release-gitops.md`。
- `relevant_evolution`：当前 Gateway Dashboard 覆盖共享模板默认名单，导致默认名单中的 `xinqishang` 未生效。
- `superseded_refs`：无。

## acceptance
- Gateway Dashboard 的 `PROD_REVIEWERS` 包含 `xinqishang`。
- 其他前端服务的审核名单不变。
- CI runtime 契约测试与影响门禁通过。

## affected_paths
- `.ci/gateway-dashboard.yml`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- `docs/engineering/domains/release-gitops.md`

## required_context
- `service-ci`
- `release-gitops`
- `service-gateway-dashboard`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/ci.md@88edf076b` | CI 服务边界 | 确认流水线定义真源 |
| `docs/context/domains/release-gitops.md@88edf076b` | 发布授权边界 | 不触发或放行生产 |
| `docs/context/project/services/gateway-dashboard.md@88edf076b` | 服务发布边界 | 将改动限定到 Gateway Dashboard |
| `docs/context/domains/agent-gateway-runtime.md@88edf076b` | 路由器要求 | 确认本次不涉及运行时网关行为 |
| `.ci/AGENTS.md@88edf076b` | CI 局部规则 | 执行 CI runtime 门禁 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@88edf076b` | CI 邻接检查 | 核对契约测试邻居，不触碰 Secret |

## evidence
- 构建状态只读查询确认目标流水线为 `构建 gateway-dashboard`、pipeline version 180，stage-3 处于暂停审核。
- Gateway Dashboard 专属审核人契约与其他前端服务名单不变契约均通过。
- `bash .ci/runtime/check_ci_runtime.sh` 通过，共 572 条测试，跳过 3 条。
- `validate_documentation.py`、`validate_change_impact.py --staged` 与 `git diff --check` 通过。

## risks
- 当前暂停构建仍使用旧名单；需由旧审核人处理，或在新配置合入后重新触发新构建。
- 误改共享模板会扩大其他服务权限；通过服务专属配置与契约测试避免。

## validation
- `python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py ReleaseBundleContractTests.test_frontend_template_consumers_keep_frontend_prod_reviewers ReleaseBundleContractTests.test_gateway_dashboard_adds_service_prod_reviewer`
- `bash .ci/runtime/check_ci_runtime.sh`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 只修改 `.ci/gateway-dashboard.yml` 的显式 override，不改模板默认值。
- `xinqishang` 追加在现有审核名单末尾。

## scan_scope
- `.ci/gateway-dashboard.yml`
- `.ci/templates/service-release.yml`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`

## scan_output
- 精确搜索确认 stage-3 和 stage-6 均引用 `PROD_REVIEWERS`，无第三处生产审核节点。

## handoff
- 当前状态：实现与 CI runtime 验证完成，等待 staged 门禁、commit、push 和 master MR。
- 当前 build 仍需旧名单中的审核人处理；新名单仅对新 pipeline version 的构建生效。

---
id: collaboration-kubeconfig-credential-20260916
type: task
scope: 修复 Collaboration Runtime 对 Stream PASSWORD kubeconfig credential 的字段引用。
triggers: ["DB_JOB_KUBECONFIG_B64", "Collaboration Runtime"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .ci/collaboration-bootstrap.yml
  - .ci/runtime/tests/contract_tests/test_collaboration_delivery.py
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 Collaboration Runtime 流水线读取 `PASSWORD` credential 的实际 kubeconfig Base64 值。

## non_goals
- 不把 kubeconfig 写入 Git、日志或普通变量。
- 不改变 migration、verify、GitOps 或 Argo 的执行边界。

## requirement_ids / requirement_refs / requirement_excerpt
- Runtime #10/#11 在 migration 前均因 `DB_JOB_KUBECONFIG_B64` 解码 `Incorrect padding` 失败。
- Stream credential 已由受控 DevCloud kubeconfig 创建为 `PASSWORD` 类型，Key 为 `DB_JOB_KUBECONFIG_B64`。

## interface_refs / data_structure_refs
- Stream `PASSWORD` credential 通过 `settings.<key>.password` 读取。
- `.ci/runtime/harness_ci/db_job.py` 接收的是纯 Base64 字符串，不接收 credential 对象。

## history_context
- `current_design_refs`: `docs/engineering/domains/release-gitops.md`、`docs/runbooks/collaboration-beijing-bootstrap.md`。
- `relevant_evolution`: Foundation 已 `Synced/Healthy`；Runtime 两次均在 DB Job 创建前失败，没有 schema 或 GitOps 写入。
- `superseded_refs`: `${{ settings.DB_JOB_KUBECONFIG_B64 }}` 直接引用不适用于 `PASSWORD` credential。

## acceptance
- 契约测试先因缺少 `.password` 失败，修复后通过。
- 完整 CI runtime、文档、docs-impact、diff 和密钥扫描通过。
- 合入后重跑 Runtime，migration/status/verify 成功后才生成 Runtime GitOps MR。

## affected_paths
- `.ci/collaboration-bootstrap.yml`
- `.ci/runtime/tests/contract_tests/test_collaboration_delivery.py`
- `docs/engineering/domains/release-gitops.md`
- 本 Task Pack。

## required_context
- `release-gitops`、`service-collaboration`、`.ci/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `.ci/collaboration-bootstrap.yml@origin/master` | 失败入口 | 修正 credential 字段 |
| `.ci/runtime/harness_ci/db_job.py@origin/master` | 解码边界 | 确认需要纯 Base64 |
| `.ci/README.md@origin/master` | kubeconfig 顺序 | 保持现有配置契约 |
| `docs/runbooks/collaboration-beijing-bootstrap.md@origin/master` | 首发流程 | 保持人工审核与两阶段发布 |

## evidence
- DevCloud 受控 kubeconfig 已只读验证目标 context、Namespace 和 Job 权限；内容未输出。
- Runtime #11 使用已创建 credential 后仍报 `Incorrect padding`，证明对象引用没有解析到 `.password`。
- 仓库现有 `TCR_JP1_REGISTRY_CREDENTIAL.password` 提供同类型引用先例。

## risks
- 字段名错误会在 migration 前 fail closed；回归测试锁定精确表达式。
- 重跑仍须重新经过 dry-run 和人工审核，不因本修复绕过发布门禁。

## validation
- 聚焦 Collaboration delivery 测试和完整 CI runtime。
- docs-impact、文档、密钥与 diff 检查。

## decisions
- 修正 Stream 字段引用，不降低 Base64 校验，不把 kubeconfig复制到 runner 文件系统。

## scan_scope
- `.ci/collaboration-bootstrap.yml`、相邻测试、发布文档。

## scan_output
- 仅记录非敏感错误类型和文件路径。

## handoff
- 本地修复已验证；用户已授权直接更新并重跑，待提交、MR 合入后再次执行 Runtime。#11 未执行 migration/status/verify。

---
id: collaboration-release-consolidation-2026-09-24
type: task
scope: 收敛北京 Collaboration 日常发布，避免普通镜像晋级重复 bootstrap 与重写 SOPS。
triggers: ["collaboration release consolidation", "collaboration normal promotion"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-09-24
review_due: 2026-10-24
revision: 1.0.0
precedence: task
---

## goal

让 Collaboration 日常源码发布复用标准 service-release 流程：构建候选镜像、执行数据库
migration/verify、生成一个只更新镜像 pin 的北京 GitOps MR；不得重新执行 foundation bootstrap、
SSM 写入或 SOPS 导出。

## non_goals

- 不修改 Collaboration 数据库模型、Migration、OpenAPI 或业务行为。
- 不轮换 IM、数据库、JWT、Gateway 等任何凭据。
- 不自动合并 GitOps MR，不直接同步 Argo 或修改 live workload。
- 不删除首次 foundation/显式 IM Secret rotation 所需的 bootstrap 流水线。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求：普通发布应是简单流程，不应持续产生 bootstrap/密钥噪音 MR。
- 当前事实：GitOps-only `collaboration-runtime-secrets.sops.yaml` 不存在于 `master`，标准投影会将其
  视为 stale；`collaboration-platform.env` 在 `master` 中是占位模板，不能覆盖 GitOps 当前值。
- 当前事实：`.ci/collaboration.yml` 的 `MASTER_AUTO_PIN_ENVS=none`，源码合入只构建、不晋级。

## interface_refs / data_structure_refs

- `.ci/templates/service-release.yml`：标准 build/auto-pin 入口。
- `.ci/runtime/contracts/bundles.py`：ReleaseBundle 投影契约。
- `.ci/runtime/gitops/projection.py`：source ref 到 GitOps worktree 的文件投影。
- `.ci/runtime/bundles/collaboration.bundle`：北京发布文件闭包、配置与 DB gate。
- 不变量：GitOps-only Secret 和环境已激活的公共平台值由 `gitops` 保留；镜像 pin 仍由
  `update_image_pin.py` 更新；配置 gate 必须在创建 MR 前通过。

## history_context

- `current_design_refs`：`docs/engineering/domains/release-gitops.md`、
  `argocd/services/collaboration/README.md`。
- `relevant_evolution`：北京 foundation/runtime bootstrap 已完成；普通发布不再承担建库、建账号、
  SSM→SOPS 激活职责。
- `superseded_refs`：把每次 runtime 镜像晋级都描述为重跑 bootstrap 的旧说明，仅供历史追溯。

## acceptance

- Collaboration master build 自动选择 `beijing-sandbox` 作为 auto-pin 环境。
- 标准投影保留声明的 GitOps target 文件，即使 source 不存在或包含占位模板。
- Collaboration 声明保留 runtime SOPS Secret 与现有 `collaboration-platform.env`。
- 其他 overlay/base 文件仍按 source ref 更新，stale 文件仍按既有语义删除。
- 聚焦测试、CI runtime 测试、文档/变更影响门禁通过。

## affected_paths

- `.ci/collaboration.yml`
- `.ci/runtime/bundles/collaboration.bundle`
- `.ci/runtime/contracts/bundles.py`
- `.ci/runtime/gitops/projection.py`
- `.ci/runtime/tests/**`
- `argocd/services/collaboration/README.md`
- `docs/engineering/domains/release-gitops.md`

## required_context

- `release-gitops`
- `service-collaboration`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@origin/master` | 仓库发布、Task Pack 与验证约束 | 确定授权和交付边界 |
| `.ci/AGENTS.md@origin/master` | CI/GitOps 约束 | 保留标准发布与 Argo 事实链 |
| `collaboration/AGENTS.md@origin/master` | Collaboration 工程约束 | 确认不触碰数据库/OpenAPI |
| `docs/context/domains/release-gitops.md@origin/master` | 路由必读 | 区分源码、GitOps 与 live 状态 |
| `docs/context/project/services/collaboration.md@origin/master` | 服务路由必读 | 保持身份、IM、Computer 边界 |
| `argocd/services/collaboration/README.md@origin/master` | 当前北京交付设计 | 区分首次 bootstrap 与日常发布 |
| `collaboration/docs/README.md@origin/master` | 服务权威索引 | 确认数据库交付约束 |

## evidence

- RED：`python3 .ci/runtime/tests/gitops_tests/test_gitops_publish_projection.py -v` 失败，真实
  `platform.env` 被 source 的 `REPLACE_*` 覆盖。
- RED：Collaboration contract test 失败，实际 `MASTER_AUTO_PIN_ENVS=none`。
- GREEN：上述 GitOps projection 20 项与 Collaboration delivery 16 项全部通过；额外覆盖通配符、
  越界路径和 publish closure 外保留路径均 fail closed。
- 完整 `.ci/runtime/check_ci_runtime.sh` 通过 594 项 runtime 测试、materialized smoke、Stream YAML
  解析和 diff 检查。
- 以当前 staged source commit object 对最新 `origin/gitops` 离线执行标准投影与 image pin：投影
  18 个文件、删除 0 个；runtime SOPS blob hash 和除 image/deployed-at 外的平台值保持不变。

## risks

- 错误保留过宽路径可能掩盖 source 删除；缓解：只允许显式逐环境路径，并测试其他 stale 文件仍删除。
- 自动 pin 可能绕过 DB gate；缓解：保留 bundle 的 `always_run_migration` 与 verifier，不允许自动合并。
- 平台占位值覆盖 live 配置；缓解：显式保留 GitOps `collaboration-platform.env`，再仅更新 image/deployed-at。

## validation

- `python3 .ci/runtime/tests/gitops_tests/test_gitops_publish_projection.py -v`
- `python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p 'test_collaboration_delivery.py' -v`
- `bash .ci/runtime/check_ci_runtime.sh`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions

- 采用通用、显式的 `preserve_target_paths_by_env` bundle 契约，而不是给 Collaboration 写特殊分支。
- 保留路径仍必须位于 bundle publish closure 内；普通文件继续执行 source-authoritative 投影。
- 北京日常发布生成 GitOps MR但不自动合并；foundation/凭据轮换仍走独立 bootstrap。

## scan_scope

- `.ci/runtime/{bundles,contracts,gitops,tests}`
- `.ci/collaboration*.yml`
- `argocd/services/collaboration`

## scan_output

- 有界源码与历史检索；未生成独立扫描文件。

## handoff

- 当前状态：设计与验收边界已确认，进入 TDD RED。
- 下一步：新增投影保留行为和 Collaboration auto-pin 契约测试。
- 阻塞项：无。

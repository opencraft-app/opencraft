---
id: shadow-submodule-checkout-20260916
type: task
scope: 修复 mono2 根仓库 gitlink 与 .gitmodules 不一致导致 Stream checkout 中断。
triggers: ["submodule mapping", "Stream checkout", "Shadow Tencent SDK"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .gitmodules
  - deploy/localstack/localstack.sh
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
让每个跟踪中的 gitlink 在 `.gitmodules` 有路径及仓库地址映射，恢复 Stream checkout。

## non_goals
- 不改变任何 gitlink commit、子模块内容或私有仓库权限。
- 不启动、审批或重跑 Collaboration bootstrap，不改 DB/SSM/GitOps。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户确认修复、验证、提交并创建 MR。Stream foundation #8 在 checkout 报 `No submodule mapping found in .gitmodules`。

## interface_refs / data_structure_refs
- 根 `.gitmodules` 的 `submodule.*.path/url` 与 `git ls-files --stage` 的 `160000` 路径一一对应。
- `deploy/localstack/localstack.sh` 的 `SHADOW_TENCENT_SDK_REPO` 默认值是 Shadow SDK 的现有仓库来源。

## history_context
- `current_design_refs`：`docs/context/domains/release-gitops.md`、`.ci/AGENTS.md`。
- `relevant_evolution`：此前 master 无 `.gitmodules` 时 Collaboration #7 能 checkout；后续 OpenCraft 变更新增 `ref/*` 子模块映射，却没有补原有 `shadow/tencentcloud-sdk-go` gitlink。
- `superseded_refs`：不能通过删除 Shadow gitlink 或跳过可信 checkout 门禁处理。

## acceptance
- 回归测试先因缺失映射失败，补映射后通过；所有 gitlink 均有且只有一个配置，Shadow URL 与既有脚本一致。
- 本地 `git submodule status`、CI runtime 测试与 diff 检查通过；不把本地远端访问等同于 CI runner 的认证证明。

## affected_paths
- `.gitmodules`
- `.ci/runtime/tests/guard_tests/test_submodule_mapping.py`
- 本 Task Pack

## required_context
- `identity-access`、`service-shadow`、`agent-gateway-runtime`、`release-gitops`、`service-ci`、`tapd-gongfeng-delivery` 和 `.ci/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md@2.0.0` | 路由必读 | Shadow 身份边界 |
| `docs/context/project/services/shadow.md@1.0.0`、`shadow/AGENTS.md` | 路由必读 | Shadow SDK 归属 |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | 路由必读 | 排除运行时业务改动 |
| `docs/context/domains/release-gitops.md@2.0.0`、`docs/context/project/services/ci.md@2.1.0`、`.ci/AGENTS.md` | 交付边界 | checkout、源码与部署分离 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | 邻接卡 | CI 测试与 GitOps 非目标 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0`、`.agents/skills/gongfeng/SKILL.md` | MR 交付 | 工蜂鉴权、授权与失败边界 |

## evidence
- #8 checkout 在脚本运行前失败；无本次云或 GitOps 写入。
- 当前 master 跟踪 5 个 gitlink，`.gitmodules` 只映射 4 个 `ref/*`；缺的是 Shadow SDK。
- 本机只读 `ls-remote` 可访问 `deploy/localstack/localstack.sh` 所指向的内部 SDK 仓库；CI runner 访问仍未验证。
- 映射测试先 RED（缺 `shadow/tencentcloud-sdk-go`），补唯一映射后 GREEN；`git submodule status` 可解析 5 个 gitlink，实际内容仍未检出。
- 完整 CI runtime 553 项测试、物化运行时 smoke、YAML 解析通过；docs-impact、文档、改动文件密钥与 diff 检查通过。

## risks
- 根映射影响所有执行子模块 checkout 的流水线；新增私有仓库映射可能暴露独立的 CI 凭据缺口。
- 只补已有仓库的缺失映射，不更换 URL、不更新 gitlink commit。

## validation
- 聚焦映射测试、`bash .ci/runtime/check_ci_runtime.sh`、`git submodule status`、文档和 diff 检查。

## decisions
- 先恢复 Git 的路径配置完整性，不凭未经验证的 YAML 参数猜测 Stream 的子模块禁用开关。

## scan_scope
- 根 `.gitmodules`、gitlink 索引、`deploy/localstack/localstack.sh`、CI checkout 相邻测试。

## scan_output
- 精确路径与模式扫描，无持久化敏感输出。

## handoff
- 本地验证通过，待提交、推送并创建 MR；不合并或触发流水线。CI runner 对私有 SDK 的读取权限仍待合入后的 checkout 实证。

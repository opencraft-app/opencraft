---
id: minisandbox-reviewed-source-boundary-2026-10-02
type: task
scope: 让 minisandbox 的 reviewed-source、恢复与运行时构建链从 mono2 commit 精确提取 minisandbox subtree。
triggers: ["minisandbox reviewed source", "minisandbox source bundle", "minisandbox release source"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-02-minisandbox-reviewed-source-boundary.md
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/bundle-full-reviewed-source.sh
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让 mono2 中的 minisandbox 能从一个明确的 mono2 commit 生成只含 `minisandbox/` 内容、解包后仍以
minisandbox 为根的完整 reviewed-source bundle，并让恢复和运行时构建继续消费同一不可变身份。

## non_goals

- 不构建或发布新运行时镜像。
- 不修改 GitOps desired state、Argo 或云上 Cell。
- 不把 mono2 其他服务作为 minisandbox 构建上下文。

## requirement_ids / requirement_refs / requirement_excerpt

- 主目标：按 stateless Workers / Durable Objects 设计完成实现和生产资格链。
- 迁仓约束：minisandbox 已成为 mono2 的一次性 subtree，mono2 是唯一源码真源。
- 恢复不变量：运行时构建必须绑定完整 reviewed source，而不是工作站文件或未归档构建输出。

## interface_refs / data_structure_refs

- `actor-reviewed-source-bundle/v2`
- `source.revision`：mono2 commit。
- `source.repositoryTree`：该 commit 的根 tree。
- `source.projectPath`：`minisandbox`；独立根仓库为 `.`。
- `source.projectTree`：精确项目 tree。
- bundle 解包布局继续以 minisandbox 项目根为根。

## history_context

- `current_design_refs`：`minisandbox/MONO2_SUBTREE.md`、
  `minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md`。
- `relevant_evolution`：旧脚本假设 Git 顶层就是 minisandbox；迁入 mono2 后该假设会把整个 monorepo
  打入 bundle，并使恢复后的构建入口位于错误层级。
- `superseded_refs`：独立 `/data/minisandbox` Git 根只作为历史，不再是发布真源。

## acceptance

- 从 mono2 的 `minisandbox/` 生成 bundle 时，bundle 根包含 minisandbox 文件但不包含 mono2 sibling。
- receipt 同时绑定 mono2 commit、repository tree、project path 和 project tree。
- 根项目仍能以 `projectPath=.` 生成相同布局。
- pre-destroy recovery seed 从脚本所在 minisandbox 根取源，但使用 mono2 commit 作为 revision。
- 旧 builder 可通过内容寻址 COS relay 引导 v2 verifier/materializer，且 materialize 不隐式 promote。
- bundler、verifier、materializer 和 fleet manifest 门禁通过。

## affected_paths

- `minisandbox/infra/cells/deploy/tencent/fleet/runtime/`
- `minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/pre-destroy/run.sh`
- `minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/`
- `minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- `minisandbox/infra/cells/deploy/tencent/fleet/runtime/README.md`

## required_context

- `upstream-subtrees`
- `release-gitops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@8ff0c7e693` | mono2 安全、Context 与发布边界 | 使用 Task Pack；源码变更不冒充发布 |
| `minisandbox/AGENTS.md@8ff0c7e693` | minisandbox 构建与版本控制约束 | 保持运行时门禁与源码身份 |
| `minisandbox/infra/cells/AGENTS.md@8ff0c7e693` | Cell/TAT/reviewed-source 不变量 | 不绕过 builder、manifest 或资格链 |
| `docs/context/project/upstream-subtrees.md@8ff0c7e693` | subtree 权威归属 | mono2 是唯一源码真源 |
| `docs/context/domains/release-gitops.md@8ff0c7e693` | 发布与运行态证据边界 | 本任务只修源制品，不宣称发布完成 |
| `docs/engineering/domains/release-gitops.md@8ff0c7e693` | 正式发布真源 | 保持源码、制品、GitOps、运行态分层 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@8ff0c7e693` | 发布邻接检查 | 验证本次不触及 Secret/Argo |
| `minisandbox/MONO2_SUBTREE.md@8ff0c7e693` | minisandbox 迁仓边界 | 从 commit 的 subtree 提取项目源码 |

## evidence

- `test_full_source_bundle.py`、`test_audit.py`、`test_validate_destroy_plan.py`：16/16 通过；夹具使用
  nested `minisandbox/` 和仓库 sibling，覆盖项目归档根、sibling 排除、v2 identity、dirty tree 与
  destroy authority fail-closed。
- 真实 mono2 `HEAD:minisandbox` bundle：receipt 为 `actor-reviewed-source-bundle/v2`，归档中的
  14,243 个 Git 文件/符号链接与 `git ls-tree -r HEAD:minisandbox` 精确一致。
- `infra/cells/deploy/tencent/fleet/verify-manifests.sh`：通过，终态
  `fleet_manifest_invariants=passed`。
- `test-materialize-full-reviewed-source-via-relay.sh`：通过；验证四个 artifact 的远端路径/模式/哈希
  约束、v2 verifier 注入、目标 source identity，并拒绝 symlink verifier。
- mono2 documentation validator：0 error、0 broken first-party link、0 unclassified document。
- `git diff --check`：通过。

## risks

- 用 monorepo 根 tree 冒充项目 tree会引入无关源码：receipt 分别绑定两层 tree。
- archive 路径错误会多一层 `minisandbox/`：测试检查解包后的项目根布局。
- 旧恢复入口依赖 Git 顶层：pre-destroy 显式区分 project root 与 repository root。

## validation

- `python3 -m unittest minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_full_source_bundle.py -v`
- `bash minisandbox/infra/cells/deploy/tencent/fleet/verify-manifests.sh`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions

- bundle 外部布局保持项目根，避免修改 builder 消费者。
- revision 使用 mono2 commit；project tree 作为第二层不可变身份，不能只记录路径字符串。
- receipt 升级为 v2；verifier继续只接受严格字段集合。

## scan_scope

- reviewed-source bundler、verifier、materializer及其调用点。

## scan_output

- 不涉及 Secret 内容；有界源码检索结果保留在任务证据中。

## handoff

- 当前状态：v2 project-bound bundle、恢复审计和 destroy authority 已实现并通过源码门禁；不包含
  镜像发布或云上 rollout。

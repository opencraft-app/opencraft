---
id: collaboration-export-pyyaml-20260916
type: task
scope: 修复 Collaboration 北京 foundation bootstrap 在 SSM→SOPS 导出前缺少 PyYAML 的 CI 环境。
triggers: ["Collaboration foundation export", "PyYAML CI runtime", "SSM SOPS projection"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .ci/collaboration-bootstrap.yml
  - .ci/init.sh
  - scripts/export_ssm_to_sops.py
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 bootstrap apply 在执行 SSM→SOPS 导出及后续 Python 投影前，使用可重复准备的 PyYAML 环境。

## non_goals
- 不手工导出或读取 SSM 明文，不直接修改 GitOps，不重跑或审批流水线。
- 不改变 DB 权限、Secret 内容、镜像 digest 或运行时发布顺序。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户提供的 #7 apply 日志：`privileges=updated` 后，`scripts/export_ssm_to_sops.py` 因 `ModuleNotFoundError: No module named 'yaml'` 失败。

## interface_refs / data_structure_refs
- `.ci/collaboration-bootstrap.yml` apply 的 `ci_ensure_tccli`、SSM→SOPS 导出、GitOps 投影顺序。
- `.ci/init.sh` 中已有带锁的工具缓存与虚拟环境安装模式；脚本仍调用 `python3`。

## history_context
- `current_design_refs`：`docs/engineering/domains/release-gitops.md` 的 Collaboration 两阶段 bootstrap。
- `relevant_evolution`：#7 已在现有 CynosDB 账号和逻辑库上写入目标库权限；后续 Python 依赖缺失阻断 GitOps MR。
- `superseded_refs`：不能把 `tccli` 可用误认为其外部 `python3` 必含 PyYAML。

## acceptance
- 先有回归测试证明当前流水线缺少依赖准备，再实现只在 apply 阶段准备并验证 PyYAML。
- 依赖版本固定、缓存隔离、失败即阻断；不修改系统 Python 或泄露 Secret。
- CI runtime 聚焦/完整测试、文档门禁与 diff 检查通过。

## affected_paths
- `.ci/collaboration-bootstrap.yml`、`.ci/init.sh`、`.ci/runtime/tests/contract_tests/test_collaboration_delivery.py`。
- `docs/engineering/domains/release-gitops.md`、本 Task Pack。

## required_context
- `service-ci`、`release-gitops`、`service-collaboration` 与 `.ci/AGENTS.md`。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| `docs/context/project/services/ci.md@2.1.0` | 路由必读 | CI 运行时与发布权限 |
| `docs/context/domains/release-gitops.md@2.0.0` | 路由必读 | GitOps 与真实运行态边界 |
| `docs/context/project/services/collaboration.md@1.0.0`、`collaboration/AGENTS.md` | 路由必读 | 服务 Secret 和平台边界 |
| `.ci/AGENTS.md`、`docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | CI 邻接 | 安全约束与测试入口 |

## evidence
- Stream #7 apply 在 DB 权限写入成功后报 `ModuleNotFoundError: yaml`；只读云 API 回读 12 项目标库权限，无全局/表级额外授权。
- CI 源码的导出脚本静态 `import yaml`，apply 未在调用前准备该依赖。
- 契约测试先 RED（apply 缺少 `ci_ensure_pyyaml`），实现后 GREEN；隔离缓存的首次 PyYAML 6.0.2 安装、导出/投影脚本导入与重复调用均通过。
- 完整 CI runtime 门禁 552 项测试、物化 runtime smoke、YAML 解析通过；导出脚本 11 项测试、docs-impact、文档和改动文件密钥扫描通过。

## risks
- SSM 已更新且权限已落地，修复前不得重复直接写入；重新执行须独立审批与只读计划。
- 不在日志、源码或测试中输出凭据和解密 payload。

## validation
- 聚焦回归先 RED 后 GREEN，运行 `bash .ci/runtime/check_ci_runtime.sh`、docs-impact 与文档校验。
- 以上命令已通过；没有在 CI runner 上重新执行 apply，不能把本地安装烟测当作云端交付完成。

## decisions
- 在现有 CI 工具 bootstrap 中使用独立、固定版本的 PyYAML 环境，确保导出和后续 Python 投影共用同一解释器。

## scan_scope
- `.ci/init.sh`、`.ci/collaboration-bootstrap.yml`、相关契约测试与 `scripts/export_ssm_to_sops.py`。

## scan_output
- 有界精确搜索，无持久化明文。

## handoff
- 本地验证完成，待用户授权提交/推送；#7 已失败但 DB 权限落地，SSM→SOPS 和 GitOps MR 尚未完成。

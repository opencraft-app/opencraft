## goal

修复 release plan 对 master merge commit 的 source diff 漏检，确保 migration 与依赖门禁能看到本次合并相对第一父提交的真实变化。

## non_goals

- 不修改 Trade、CTL、Sandbox 升配业务逻辑。
- 不修改数据库 migration 内容、生产门禁或 Argo 策略。
- 本代码变更本身不触发流水线、不执行 DB job、不发布任何环境。

## requirement_ids / requirement_refs / requirement_excerpt

- MR `!3676` merge commit：`630f41ee2984f0902cb557ff8e143575310aa2ed`。
- 验收：该 merge commit 必须识别出 CTL 000029、Trade 000009、Sandbox 000009/000010；普通提交和 root commit 行为保持不变。

## interface_refs / data_structure_refs

- `.ci/runtime/contracts/release_plan.py::changed_files_for_revision`
- `GatePlan.changed_files`、`migration_changed`、`requires_db_job`
- 不变量：merge commit 只计算相对第一父提交的净变化，不能混入第二父或第一父已存在的文件。

## history_context

- `current_design_refs`：`docs/engineering/domains/release-gitops.md`、`.ci/README.md`。
- `relevant_evolution`：旧实现直接运行 `git diff-tree` 检查单个 revision；Git 对 merge commit 默认不输出文件 diff，导致静默空列表。
- `superseded_refs`：无。

## acceptance

- 真实临时 Git merge DAG 中新增 migration 时，release plan 要求北京 DB job/readiness。
- 第一父提交已存在、但本次 merge 未引入的 migration 不得误报。
- MR `!3676` 的真实 merge commit 能检出四个目标 migration。
- `.ci/runtime/check_ci_runtime.sh` 与 docs-impact 门禁通过。

## affected_paths

- `.ci/runtime/contracts/release_plan.py`
- `.ci/runtime/tests/contract_tests/test_release_gates.py`
- `docs/engineering/domains/release-gitops.md`
- `docs/context/tasks/2026-09-08-merge-migration-detection.md`

## required_context

- `release-gitops`
- `service-ci`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@3326f752f` | 仓库发布与验证边界 | 限制变更、发布和验证范围 |
| `.ci/AGENTS.md@3326f752f` | CI 目录局部约束 | 确定正式检查入口 |
| `docs/context/domains/release-gitops.md@3326f752f` | router 必读发布摘要 | 区分源码、GitOps 与运行态验收 |
| `docs/context/project/services/ci.md@3326f752f` | router 必读 CI 摘要 | 确定 runtime 验证要求 |
| `docs/engineering/domains/release-gitops.md@3326f752f` | change-impact 映射的正式设计 | 记录 merge diff 不变量 |
| `.ci/runtime/gitops/gitops_release_verifier.py@3326f752f` | 相邻 first-parent 实现 | 复用显式第一父两点 diff 语义 |

## evidence

- 修复前，新增的真实 merge migration 用例失败：`plan.changed_files == []`。
- 修复后，merge migration、第一父防误报、浅克隆 fail-closed、普通 migration 四项定向测试通过。
- `630f41ee2984f0902cb557ff8e143575310aa2ed` 实测得到 127 个 first-parent changed files，四个目标 migration 均为 PRESENT。
- Python 3.12.12 运行 `.ci/runtime/check_ci_runtime.sh`：488 项 runtime 测试、materialized runtime smoke、Stream YAML/guards 解析与 diff 检查全部通过。
- `validate_change_impact.py --repo . --staged` 与文档完整性检查通过。

## risks

- 风险：错误使用 merge 的所有父节点会把旧 migration 混入本次发布。缓解：只与第一父提交比较，并保留防误报测试。
- 风险：浅克隆缺第一父对象。缓解：从原始 commit 对象读取 parent header；父对象缺失时 Git diff 非零并 fail closed，不把提交误判为 root 或空变更。
- 回滚：回退本次 release plan 与测试提交；回滚不会修改 DB 或环境状态。

## validation

- 定向 release gate 单测。
- 完整 `.ci/runtime/check_ci_runtime.sh`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。
- `git diff --check`。

## decisions

- 使用 `git cat-file -p <revision>^{commit}` 从原始 commit 对象解析父提交；有父提交时显式执行第一父到 source revision 的两点 diff，root commit 保留原 `diff-tree --root`。
- 不使用 `git diff-tree -m`，避免合并多个父节点的差异导致误报。

## scan_scope

- `.ci/runtime/contracts/`
- `.ci/runtime/tests/contract_tests/`
- `.ci/runtime/gitops/gitops_release_verifier.py`

## scan_output

- 无独立扫描产物；证据记录在本 Task Pack。

## handoff

- 代码通过后仍需单独授权 commit、push、MR 以及北京 promote。
- 北京补跑必须使用已包含本修复的 runtime，并将 source revision 固定为 `630f41ee2984f0902cb557ff8e143575310aa2ed`。

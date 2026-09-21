## goal

修复国际 EdgeOne 正式发布在 OpenAPI 手动启动时把 `${{ ci.branch }}` 字面量传给 shell 的问题，并保持生产发布只允许 `master`。

## non_goals

- 不放宽生产分支保护。
- 不重建或修改已验证的 frontend artifact。
- 不改国内/国际站业务交互、支付或后端逻辑。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求发布国际站，并明确要求继续只允许从 `master` 发布。
- 失败构建：国际 EdgeOne 发布候选 `#233`，任务报错 `EdgeOne production release only allows master branch; got ${{ ci.branch }}`。

## interface_refs / data_structure_refs

- `.ci/templates/frontend-edgeone-release.yml`
- `.ci/runtime/commands/release_frontend_edgeone_artifact.sh`
- 不变量：运行时脚本最终接收的 `FRONTEND_EDGEONE_CI_BRANCH` 必须精确为 `master`，否则失败关闭。

## history_context

- `current_design_refs`：`.ci/README.md`、`docs/engineering/domains/release-gitops.md`。
- `relevant_evolution`：`0e4eee277` 已为标准服务发布处理同一种 OpenAPI 未展开 `ci.branch` 的平台行为。
- `superseded_refs`：无。

## acceptance

- OpenAPI 手动启动中 `${{ ci.branch }}` 未展开时，从 `BK_CI_GIT_REPO_BRANCH` / `DEVOPS_GIT_REPO_BRANCH` 解析真实分支。
- 同一启动方式下 `${{ ci.sha }}` 未展开时，从 `BK_CI_GIT_HEAD_COMMITS` 解析真实提交，保持默认 artifact 选择可用。
- 非 `master` 或无法解析时仍由现有运行时保护拒绝发布。
- `.ci` 契约测试与 runtime guard 通过。
- 新国际发布候选使用已验证 artifact source SHA `48d12bcab87ddd93a58e8fc5050f9f0c4bbd01dd` 并成功发布。
- 线上 `lightvela.ai` 默认隐藏升配入口，显式 `show()` 后仅登录且可升配用户可见。

## affected_paths

- `.ci/templates/frontend-edgeone-release.yml`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- `.ci/README.md`

## required_context

- `release-gitops`
- `service-ci`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@ccef1a5ed` | 仓库生产发布与验证硬边界 | 保留授权、测试和真实发布证据要求 |
| `.ci/AGENTS.md@ccef1a5ed` | CI 修改边界 | 不输出凭据且不把构建等同发布 |
| `docs/context/domains/release-gitops.md@ccef1a5ed` | 发布验收范围 | 要求线上静态资源验证 |
| `docs/context/project/services/ci.md@ccef1a5ed` | CI 模板与 runtime 权威 | 采用模板内最小修复和相称 guard |

## evidence

- `origin/master=ccef1a5ed`（2026-09-10 本轮开始时）。
- 失败候选 `#233` 报告的分支值为未展开字面量 `${{ ci.branch }}`。
- `0e4eee277` 的标准服务发布修复已验证同一平台行为及回退环境变量。

## risks

- 风险：错误回退把非 master 当成 master。
- 缓解：只在值为空或包含未展开 `${{` 时回退；回退仍由现有严格 `master` 比较校验，无法解析则失败关闭。
- 回滚：回退该 CI 模板提交；不涉及站点业务数据或数据库。

## validation

- `python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p test_release_bundle_contracts.py`
- `bash .ci/runtime/check_ci_runtime.sh`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`
- CI runtime MR 检查与国际 EdgeOne 实际发布。

## decisions

- 对齐 `0e4eee277` 的已验证解析方式，不修改运行时 `master` 安全校验。
- 国内和国际共用模板，因此只修一次共享变量解析；站点 combo 和 token 选择保持各自配置不变。

## scan_scope

- `.ci/frontend-edgeone-lightvela*.yml`
- `.ci/templates/frontend-edgeone-release.yml`
- `.ci/runtime/commands/release_frontend_edgeone_artifact.sh`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`

## scan_output

- 有界源码、Git history 与失败日志摘要记录在本 Task Pack。

## handoff

- 当前状态：契约测试先行，待实现变量解析、跑门禁、合并并重新发起国际候选。
- 阻塞项：无。

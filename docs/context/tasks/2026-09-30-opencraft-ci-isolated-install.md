---
id: task-opencraft-ci-isolated-install
type: task
scope: Repair the OpenCraft MR guard dependency installation and current generated manifest.
triggers: ["opencraft CI isolated install", "opencraft guard", "embedded test dependencies"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .ci/checks/opencraft_guard.sh
  - opencraft/scripts/sync-mono2-agent-console.mjs
status: active
reviewed_at: 2026-09-30
review_due: 2026-10-30
revision: 1.0.0
precedence: task
derived: false
---

## goal
使 OpenCraft MR guard 在独立目录安装依赖并运行嵌入式测试，修复当前 master 的 mono2 生成清单漂移。

## non_goals
- 不修改 Agent/Bot 产品行为、发布配置或生产环境。
- 不改变 MR guard 从目标分支加载可信脚本的规则。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !4872 的 2026-09-30 CI 附件日志：`npm ci` 成功后，嵌入式测试缺少多个锁定依赖；用户要求修复后提交 MR。

## interface_refs / data_structure_refs
- `.ci/checks/opencraft_guard.sh`：先检查 mono2 生成文件，再运行 `test:embedded-ci`。
- `.ci/mr-placeholder.yml`：业务 MR 使用目标分支的可信 guard；新 guard 需先独立合入 master。
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`：只由官方同步脚本生成。

## history_context
- current_design_refs: `.ci/README.md` 的 trusted guard 规则、`opencraft/AGENTS.md` 的生成文件规则。
- relevant_evolution: 当前 master 合入 MR !4868 后，`UPSTREAM.json` 的 `sourceRevision` 与同步脚本计算值不同。
- superseded_refs: 无。

## acceptance
- guard 的 npm 安装和嵌入式测试在独立临时目录执行，读取本次 checkout 的已跟踪源码和测试需要的 locale 清单。
- `check:mono2-agent-console`、完整 OpenCraft guard、本次 CI runtime 相关测试及 `git diff --check` 给出结果。
- 创建 MR 并核对远端 source SHA；不把本地验证当作远端 CI 成功。

## affected_paths
- `.ci/checks/opencraft_guard.sh`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- 本 Task Pack 与 checkpoint。

## required_context
- `tapd-gongfeng-delivery`、`service-ci`、`release-gitops`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md@efe04e16e` | MR 交付门禁 | 区分 MR 与合并发布 |
| `docs/context/project/services/ci.md@efe04e16e` | CI 服务入口 | 选择 runtime 验证 |
| `docs/context/domains/release-gitops.md@efe04e16e` | 路由 must_read | 保持发布边界 |
| `.ci/AGENTS.md@efe04e16e` | 最近服务规则 | 验证和凭据边界 |
| `opencraft/AGENTS.md@efe04e16e` | OpenCraft 服务规则 | 官方生成物同步 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@efe04e16e` | 邻接卡 | 检查 CI 测试邻居，不触及密钥 |
| `.ci/runtime/tests/guard_tests/test_mr_placeholder_workflow.py@efe04e16e` | 测试邻居 | 核对可信 guard 合同 |

## evidence
- 附件日志：生成文件校验通过；`npm ci` 后五个测试文件因多个依赖缺失而失败。
- 当前 master 上官方同步只修改 `UPSTREAM.json` 的 `sourceRevision`。

## risks
- 缺包的具体并发原因尚未由 CI 进程证据确认；隔离目录消除对共享 `opencraft/node_modules` 的依赖，最终仍需远端 CI 验证。
- 本 MR 合入前，MR !4872 仍使用 master 中的旧 guard。

## validation
- OpenCraft guard 的隔离安装与 `test:embedded-ci`：145/145 通过。
- `check:mono2-agent-console`：130 个文件通过；`bash -n` 与 `git diff --check` 通过。
- MR 占位 guard 合同测试：7/7 通过；`validate_documentation.py`：通过、无断链。
- CI runtime 全量本地检查：Apple Git 2.24 不支持测试所需的 `git init -b`，610 项中 19 项因此报错；CI Linux 环境待验证。
- Context catalog / 单测：仓库既有大量 Task Pack schema 错误，26 项中 4 项失败；新增 Task Pack 未出现在错误清单。

## decisions
- 使用 `git ls-files` 复制本次 checkout 中 OpenCraft 已跟踪文件及测试直接读取的 `frontend/src/i18n/locales.json`，避免复制已有 `node_modules`。
- 将修复独立于 MR !4872，合入后由可信 guard 生效。

## scan_scope
- `.ci/checks/`、`.ci/runtime/tests/guard_tests/`、`opencraft/tests/`。

## scan_output
- 精确搜索确定 locale 测试跨目录读取 `frontend/src/i18n/locales.json`；本地验证日志位于临时目录，不进入 Git。

## handoff
- 等待远端 MR CI 验证；修复 MR 合入 master 后再重跑功能 MR !4872。

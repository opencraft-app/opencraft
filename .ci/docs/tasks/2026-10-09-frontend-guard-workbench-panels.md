## goal
让 frontend MR Guard 的隔离安装包含全部本地 `file:` 依赖，修复缺少 `@opencraft/workbench-panels` 的 CI 失败。

## non_goals
- 不更改前端产品代码、锁文件或生产发布流程。
- 不在此 MR 合并云存储功能分支。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !5104 的 2026-10-09 16:09 CI 日志：`pnpm install --frozen-lockfile` 无法读取隔离目录中的 `opencraft/packages/workbench-panels`。

## interface_refs / data_structure_refs
- `frontend/pnpm-lock.yaml` 的本地 `file:` 依赖闭包。
- `opencraft/packages/mobile-bot-bridge/package.json` 依赖 `file:../workbench-panels`。
- `.ci/checks/frontend_guard.sh` 的 tar 隔离目录清单。

## history_context
- current_design_refs: `.ci/docs/README.md`、`.ci/AGENTS.md`。
- relevant_evolution: `225267ffa` 新增共享 Workbench 面板依赖，现有 Guard 仍只复制前端的直接本地依赖。
- superseded_refs: 无。

## acceptance
- 隔离目录包含 `workbench-panels` 源码，且排除其 `node_modules` 与 `dist`。
- Guard 测试覆盖直接及传递的本地 `file:` 依赖。
- MR 只包含 `.ci/**` 文件，可进入 CI 自修复检查；`bash -n` 和聚焦测试通过。

## affected_paths
- `.ci/checks/frontend_guard.sh`
- `.ci/runtime/tests/guard_tests/test_frontend_guard_workspace.py`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`

## required_context
- `tapd-gongfeng-delivery`、`service-ci`、`service-opencraft`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md@50aadd48b` | 独立 MR 交付边界 | 核对授权和远端状态 |
| `docs/context/project/services/ci.md@50aadd48b` | CI 服务门禁 | 选择检查范围 |
| `docs/context/project/services/opencraft.md@50aadd48b` | OpenCraft 包边界 | 确认本地依赖来源 |
| `.ci/AGENTS.md@50aadd48b` | 最近服务规则 | 保持仅修 Guard |
| `.ci/docs/README.md@50aadd48b` | CI 正式说明 | 排除发布范围 |
| `.agents/skills/gongfeng/SKILL.md@50aadd48b` | 工蜂工具路径 | 使用既有认证提交 MR |

## evidence
- CI 日志在安装阶段报 `scandir .../opencraft/packages/workbench-panels: ENOENT`。
- 修复前聚焦测试仅在传递依赖 `workbench-panels` 上失败；修复后 3/3 通过。
- 前端 Guard 契约测试同步更新了拷贝清单断言，聚焦运行 1/1 通过。

## risks
- 受信任 Guard 从 `master` 读取，修复须先作为独立 `.ci` MR 合入 `master`；!5104 本身不能覆盖该脚本。
- 磁盘空间不足，验证工作树采用稀疏检出；完整 CI 仍需远端运行。

## validation
- `bash -n .ci/checks/frontend_guard.sh`、Guard 聚焦单测 3/3、前端契约聚焦测试 1/1 通过。
- 完整 `.ci/runtime/check_ci_runtime.sh` 执行 653 个测试，因本机缺少 `kustomize`/`kubectl`、Apple Git 2.24.3 不支持 `git init -b`，以及更新前旧契约断言失败；契约断言已修复并单独复测通过。远端 MR 检查待验证。

## decisions
- 直接补齐缺失的包，并让现有工作区测试遍历本地依赖闭包，防止同类漏项。

## scan_scope
- `.ci/checks/frontend_guard.sh`、`.ci/runtime/tests/guard_tests/`、相关 `package.json` 和锁文件。

## scan_output
- 有界搜索确认唯一缺失的传递本地依赖是 `workbench-panels`。

## handoff
- 提交独立 `.ci` MR；待其合入 `master` 后重新运行 !5104 的 CI。

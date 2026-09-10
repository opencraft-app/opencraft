## goal

修复 OpenCraft Guard 在 CI 隔离目录中校验 mono2 Agent Console vendored 快照时错误依赖 `.git` 的问题，并让当前 MR 能基于最新 `master` 执行该 Guard。

## non_goals

- 不改变 Agent Console 同步文件集合或适配逻辑。
- 不放宽逐文件内容、SHA 或额外文件检查。
- 不修改部署、GitOps 或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- MR `wisp/mono2!3890` 的 CI 日志：OpenCraft Guard 先因旧分支缺少 `opencraft/` 失败；同步 `master` 后，隔离目录因不含 `.git` 在 `git log` 处失败。

## interface_refs / data_structure_refs

- `opencraft/scripts/sync-mono2-agent-console.mjs`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- 不变量：生成模式必须从 Git 解析真实 `sourceRevision`；无 Git 的只读检查只能复用已提交 revision，文件内容与 manifest 仍需完整比对。

## history_context

- `current_design_refs`：`opencraft/MONO2_MIGRATION.md`、`docs/context/project/upstream-subtrees.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：`origin/master` 引入 OpenCraft Guard 后，当前分支落后 67 个提交且没有 `opencraft/`；Guard 通过 tar 创建的隔离目录只包含 `opencraft`、`frontend/src` 和 `frontend/public`，不包含 `.git`。
- `superseded_refs`：无。

## acceptance

- 基于最新 `origin/master` 后，`opencraft/` 在当前分支存在。
- `npm run check:mono2-agent-console` 在 Git 工作树通过。
- `opencraft/checks/guard.sh` 的隔离目录 vendored 校验通过，不再出现 `fatal: not a git repository`。

## affected_paths

- `opencraft/scripts/sync-mono2-agent-console.mjs`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/i18n/generated/en-US.json`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- `tapd-gongfeng-delivery`
- OpenCraft mono2 单一写入真源与机械生成边界。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | MR CI 修复交付边界 | 保持 commit、push、MR 和 CI 状态分离 |
| `frontend/AGENTS.md` | frontend 服务门禁 | 选择聚焦测试和构建验证 |
| `opencraft/AGENTS.md` | OpenCraft 生成与校验边界 | 禁止手改 vendored 文件，要求运行同步命令与 gate |
| `opencraft/MONO2_MIGRATION.md` | mono2 与 OpenCraft 所有权 | 确认 mono2 是唯一写入真源 |
| `docs/context/project/upstream-subtrees.md@2.1.0` | subtree 与 vendored 边界 | 保留生成清单和本地差异证据 |

## evidence

- 附件 CI 日志：`tar: opencraft: Cannot stat`，Guard exit code 2。
- `git rev-list --left-right --count HEAD...origin/master`：修复前为 `1 67`。
- 同步 `origin/master` 后仅自动合并，无冲突；`AgentCommonSettingsPanel` 的 `profileId` 透传保留。
- `npm run sync:mono2-agent-console`：同步 125 个文件。
- `npm run check:mono2-agent-console`：验证 125 个文件通过。
- 修复后 OpenCraft Guard 的隔离目录完成 vendored 校验、platform boundaries 和全 workspace typecheck；本机 macOS 后续 119 个 Host 测试中 118 个通过，1 个 Linux 进程用例因 `posix_spawnp failed` 未通过，交由 Linux CI 复验。

## risks

- 无 Git 时无法独立重算 revision；缓解方式是仅在 `--check` 且已有 manifest 时回退，并继续逐文件内容、SHA 与文件集合校验。
- 回滚方式：撤销兼容分支，恢复无 Git 时 fail-closed。

## validation

- `node --check opencraft/scripts/sync-mono2-agent-console.mjs`
- `npm --prefix opencraft run check:mono2-agent-console`
- `opencraft/checks/guard.sh`
- frontend 聚焦 Vitest、typecheck、check、build。
- documentation 与 staged change-impact 门禁。

## decisions

- 不在 Guard 中复制 `.git`，避免把仓库元数据带入隔离工作区。
- 不在生成模式回退 manifest revision，确保生成产物始终记录真实 Git 来源。

## scan_scope

- `opencraft/checks/guard.sh`
- `opencraft/scripts/sync-mono2-agent-console.mjs`
- `.ci/guards.manifest`

## scan_output

- 有界源码与 CI 日志检查；未生成额外扫描文件。

## handoff

- 兼容修复已在隔离 Guard 中通过原始阻断点；提交推送后由 Linux CI 验证剩余 gate。

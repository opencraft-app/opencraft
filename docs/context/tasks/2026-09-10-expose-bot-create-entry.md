## goal
恢复国内站 `/agents` 已有实例侧边栏的“新建 Bot”入口，修复复制当前 Bot 时因幂等 Channel 配置清理被误判失败的问题，并将 Profile 创建失败转换为用户可理解的前端提示。

## non_goals
- 不修改 Bot/Profile 数量限制、API、Channel 隔离范围或 AgentChat。
- 不放开国际站多 Bot，不自动合并 MR、不发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-10：MR !3801 已合并；从新分支继续，将 `https://lightvela.com/agents` 的创建 Bot 按钮入口恢复出来。
- 用户 2026-09-10 预览反馈：复制当前主 Bot 返回 `INSTANCE_BOT_PROFILE_FAILED`，request ID `f489b1da-e4b5-439e-8813-79b10a8dcc94`。
- 用户 2026-09-10：前端不再直接展示 Hermes Profile 底层错误，改为友好提示。
- 用户 2026-09-10：提交当前实现的 MR；该授权不包含合并或发布。
- 历史实现：MR !3801 曾为首发隐藏已有实例侧边栏入口，保留底层创建能力。

## interface_refs / data_structure_refs
- `AgentSettingsPage.handleCreateNew`：现有创建入口与订阅分流。
- `canCreateBot`：继续保持多 Bot capability 与套餐数量限制。
- `ctl/pkg/instance.buildHermesProfileCreateCommand`：Hermes Profile 克隆及 Channel 配置清理命令。

## history_context
- `current_design_refs`：`frontend/openspec/specs/bot.md`、`docs/context/tasks/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`：MR !3801 合并多 Bot 能力并暂时隐藏入口；本任务仅恢复入口。
- `superseded_refs`：无。

## acceptance
- 国内站有当前 Bot 且 `canCreateBot=true` 时显示“新建 Bot”。
- 点击入口打开现有“创建 Bot”弹窗。
- capability 或套餐限制不满足时不显示入口。
- 复制 Bot 时，Hermes 明确报告 Channel 配置键不存在应继续创建；配置解析或其他清理错误仍须失败并回滚。
- `INSTANCE_BOT_PROFILE_FAILED` 显示可重试的中文提示；存在 request ID 时保留为问题编号，不展示 Hermes 或内部错误码。
- 聚焦测试、`pnpm check` 与 5174 浏览器回归通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/agent-create-error.ts`
- `frontend/src/pages/marketing/__tests__/agent-create-error.test.ts`
- `ctl/pkg/instance/bots.go`
- `ctl/pkg/instance/bots_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `tapd-gongfeng-delivery-flow`
- `adjacency-frontend-runtime-openspec-i18n`
- `control-plane-ops`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 使用独立 worktree 与验证门禁 |
| `frontend/AGENTS.md` | 前端局部规则 | 保持类型、测试和视觉验证要求 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | 分支与交付边界 | 区分本地实现、MR 与发布 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接 | 检查 OpenSpec、实现与相邻测试 |
| `frontend/openspec/specs/bot.md` | Bot 工作台现有规格 | 复用既有创建能力 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 实例编排边界 | 创建修复需覆盖 CTL 聚焦测试与公共路径边界 |
| `ctl/AGENTS.md` | CTL 局部规则 | 保持运行时归属与服务测试要求 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | 运行态邻接检查 | 区分源码修复与 CTL/Hermes 发布状态 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 多 Bot/Profile 正式设计 | 保持 Channel 清理失败不得放行的不变量 |

## evidence
- MR !3801 当前为 `merged`、CI `success`，合并提交 `70a98b29d7471b7f7c9128f125f742f459743e8a`。
- 新分支 `codex/expose-bot-create-entry-0910` 基于最新 `origin/master` 提交 `1b002838f`。
- 历史提交显示入口原位于 Bot profile 下方并调用 `handleCreateNew`，相关 CSS 仍保留。
- 聚焦侧栏测试 25 个通过；`pnpm check` 通过，TypeScript diagnostics 为 `0 new`，i18n 为 0 error / 51 个既有 warning。
- 5174 国内站本地预览验证：`bot_local_preview` 侧栏显示“新建 Bot”，点击后打开现有“创建 Bot”弹窗，关闭后页面状态正常。
- 显式 change-impact 与文档校验通过，无断链；CTL 命中高风险 `agent-gateway-runtime` 责任面，MR 需要 `wisp/mono2-maintainers` owner review。
- Hermes `0.21.0 / v2026.8.31` 的 `config unset` 在键不存在时打印 `Config key not set: <key>` 并退出 1；原 CTL 克隆脚本在 `set -e` 下连续清理两种配置结构，因此将已清理状态误判为创建失败并执行回滚。
- CTL Bot/Profile 与 Channel Binding 聚焦测试通过；配置 unset 可执行回归覆盖成功、键不存在和真实失败三种结果；CTL 公共 Bot API 路由测试通过。
- 前端侧栏聚焦测试 25/25 通过，`pnpm check` 通过且 TypeScript 为 0 new diagnostics，i18n 为 0 error / 51 个既有 warning；`git diff --check` 通过。
- 创建错误映射聚焦测试覆盖 `INSTANCE_BOT_PROFILE_FAILED` 有、无 request ID 两种返回；Profile 底层错误改为“暂时无法创建 Bot，请稍后重试”，request ID 仅作为问题编号展示。
- 创建错误与侧栏聚焦测试合计 35/35 通过；新增两条提示已进入全部语言包，`pnpm i18n:check`、`pnpm i18n:zh-hant:check` 和完整 `pnpm check` 通过，TypeScript 仍为 0 个新增诊断。
- `CGO_ENABLED=0 go test ./pkg/instance -count=1` 在既有 MySQL testcontainer 用例因本机没有 rootless Docker 中断；本次相关测试已单独通过。

## risks
- 入口恢复可能绕过能力或套餐限制；继续使用 `canCreateBot` 条件渲染。
- 侧栏新增一行可能影响紧凑布局；以桌面和移动视口浏览器回归检查。
- 不得用无条件 `|| true` 吞掉清理错误；只兼容 Hermes 的明确“键不存在”结果，其他失败继续向上返回。

## validation
- `cd frontend && pnpm exec vitest run --config vitest.config.ts --maxWorkers=1 src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `cd frontend && pnpm check`
- `cd ctl && CGO_ENABLED=0 go test ./pkg/instance -run 'Test(BuildHermesProfileCreateCommand|HermesProfileConfigUnset)' -count=1`
- 5174 国内站 `/agents` 点击与弹窗回归。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file <本次各变更文件>`
- `git diff --check`

## decisions
- 恢复原有侧栏位置和现有样式类，按钮文案使用已确认的“新建 Bot”。
- 不新增 capability、配置项或创建流程分支。
- Channel 配置 unset 保持 fail-closed，仅将目标键不存在视为幂等成功。
- Profile 操作失败由创建流程专属错误映射处理，不修改全局 RepositoryError；保留 request ID 供排障，不向用户展示 Hermes 文案或内部错误码。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/agent-create-error.ts`
- `frontend/src/pages/marketing/__tests__/agent-create-error.test.ts`
- `frontend/src/styles.css`
- `frontend/openspec/specs/bot.md`
- `ctl/pkg/instance/bots.go`
- Hermes Agent `0.21.0` 打包源码中的 `hermes_cli/config.py`

## scan_output
- 精确搜索确认创建弹窗、`handleCreateNew`、`canCreateBot` 和 `.lv-agent-create-button` 均仍存在，仅 JSX 入口被移除。
- 运行时源码检查确认 `unset_config_value` 对不存在键执行 `sys.exit(1)`，而 CTL 使用 `set -e` 将该幂等状态升级为 `INSTANCE_BOT_PROFILE_FAILED`。

## handoff
- 入口恢复、CTL 克隆修复和前端友好错误提示均已完成本地验证；5174 国内站由独立 worktree 提供并保留给用户继续试用。CTL 修复尚未构建或发布，因此现有预览环境重试仍会命中旧后端；用户已授权提交、推送和创建 MR，未授权合并或发布。

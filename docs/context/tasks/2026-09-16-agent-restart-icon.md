## goal

让 Agent 侧栏顶部操作的图标易辨识，且 hover 提示完整可见。

## non_goals

- 不修改重启、修复的命令、禁用条件或确认流程。
- 不改动其他页面的刷新图标。
- 不重构侧栏其他提示框。

## requirement_ids / requirement_refs / requirement_excerpt

- 本轮用户请求（2026-09-16，附图）：左上角重启 icon 与刷新相同，需要更换。
- 后续用户请求（2026-09-16，附图）：保留单箭头重启图标，并修复左上角按钮 hover 提示被遮盖的问题。
- 预览反馈（2026-09-16，附图）：重启图标太小，圆弧中有明显断口；调整为视觉完整的圆环并放大。
- 预览确认（2026-09-16）：图标最终调至 16px，用户确认效果并要求创建新的 MR。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx` 中 `activeBot.status`、`isActiveBotRestarting`、`isRepairingBot` 决定侧栏操作状态。
- `frontend/src/styles.css` 的 `.lv-agents-sidebar-scroll-isolated` 使用 `overflow-x: hidden; overflow-y: auto`；侧栏操作提示必须脱离这个裁剪容器。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md` 的 Agent 多 Bot 区域边界。
- `relevant_evolution`：`origin/master@f61d26595` 已有侧栏重启/修复共用入口，静止态均使用 `RefreshCw`。
- `superseded_refs`：无。

## acceptance

- 运行中 Bot 的静止态重启按钮显示箭头与圆弧相连的单箭头图标，尺寸为 16px；失败 Bot 的修复按钮仍显示双箭头循环图标；执行中显示加载图标。
- 按钮尺寸、无障碍名称、点击逻辑和确认流程不变。
- 重启和删除提示渲染到 `document.body`，使用固定定位，靠近侧栏边缘时仍完整处于视口内；hover、键盘焦点与禁用状态保持可用。
- 完成前端 lint、类型检查、相关测试、构建及 context 检查。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tooltip.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/2026-09-16-agent-restart-icon.md`
- `docs/context/tasks/2026-09-16-agent-restart-icon.checkpoint.md`

## required_context

- 路由器未匹配 Pack，`must_read` 为空；按仓库规则执行了有界精确搜索。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@f61d26595` | 仓库边界 | 确定隔离修改和验证门禁 |
| `frontend/AGENTS.md@f61d26595` | 前端服务规则 | 确定前端验证门禁 |
| `frontend/AGENTS.md@c15e96326` | 最新前端服务规则 | 复核 Next.js 及 UI 组件约定 |
| `frontend/DESIGN.md@f61d26595` | Tooltip 裁剪规则 | 使用 Portal 和 fixed 定位，保持 hover/focus 行为 |
| `frontend/src/styles.css@f61d26595` | 侧栏滚动容器样式 | 确认 `overflow` 裁剪链 |
| `docs/context/tasks/TASK-TEMPLATE.md@f61d26595` | Task Pack 格式 | 记录任务状态 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@f61d26595` | 交接检查点格式 | 记录可恢复状态 |
| `docs/engineering/domains/site-environment-routing.md@f61d26595` | change-impact 映射的正式设计 | 同步 Agent 侧栏操作图标规则 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@f61d26595` | 当前实现 | 确定重启与修复共用入口的状态分支 |

## evidence

- `python3 .agents/context/scripts/validate_context.py --route 'frontend Agent 左上角重启 icon 与刷新区分'`：未匹配 Pack。
- `rg -n '重启|Restart|restart' frontend/src/pages/marketing/agent-settings-page.tsx frontend/src/pages/marketing/agent-config frontend/src/components`：定位侧栏 `RefreshCw`。
- 从最新 `origin/master@f61d26595` 建立独立 worktree；主检出已有未提交修改，未触碰。
- 用户指出电源图标容易理解为关机；对比 `mdi:restart`、Material、Solar 等候选后，选用单箭头回环的 `mdi:restart` SVG，与双箭头刷新图标区分。
- 用户实际预览后指出 `mdi:restart` 在 14px 下偏小，圆弧断口明显；对比 Remix、Solar、Iconamoon 和 Carbon 候选后，换为箭头与圆弧相连的 `solar:restart-bold`。随后按用户反馈从 20px 逐步调到 16px，并得到视觉确认。
- `validate_context.py --route 'frontend Agent 侧栏左上角重启删除按钮 hover tooltip 被裁切显示不全'` 未匹配 Pack；有界搜索定位到侧栏内联绝对定位 Tooltip 与滚动容器裁剪关系。
- 用户确认 16px 预览并授权创建新 MR；分支 rebase 到 `origin/master@c15e96326`，没有触及同一页面和测试的上游改动。

## risks

- 重启图标需在 24px 按钮内保持可辨；使用 16px 图标，并保留“重启” tooltip 和 `aria-label`。
- Portal 提示离开触发器 DOM，需要短暂 hover 缓冲保留气泡可交互；复用现有 Tooltip 的计时、resize、scroll 和 Escape 行为。
- 最新前端约定优先使用 `lucide-react` 图标；本次运行中重启图标保留用户预览确认的单箭头 Solar 轮廓，以满足与现有 `RefreshCw` 区分和避免圆弧中途断口的明确要求。
- 回滚方式：恢复此任务的图标分支，保留原按钮逻辑。

## validation

- 在最新 `origin/master@c15e96326` 上，`pnpm check` 通过，TypeScript baseline 检查 0 个新增诊断；仓库无单独的 `lint` 脚本。
- 在最新 master 上，相关 Vitest 3 个文件、62 项通过；新测试在 320px 视口模拟右侧触发器与裁剪容器，验证提示挂载到 `document.body`、固定定位、视口约束、按钮点击、键盘焦点和 Escape。
- 在最新 master 上，最终 16px 源码的 `pnpm build` 通过，生成 103 个静态页面。
- `validate_documentation.py --repo . --format json`：通过，断链 0、警告 0。
- `validate_change_impact.py --repo . --staged`：通过。
- 全量 `pnpm test`：在未修改的其他模块报告 15 个失败，停在 `scripts/next-config.test.mjs (0 test)` 后无进展，120 秒超时中止；不能据此声明全量测试通过。

## decisions

- 运行中静止态使用箭头与圆弧相连的 `RestartIcon`，执行中使用现有 `Loader2`，失败 Bot 的修复静止态保留 `RefreshCw`；只调整视觉状态，不改变操作路径。
- 顶部两个操作复用页面已有的 `WorkspaceActionTooltip` Portal 实现，使用紧凑样式和按钮自身焦点，避免额外 Tab 停靠点。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx` 及相关前端测试。

## scan_output

- 有界 `rg` 输出记录在本轮命令证据中。

## handoff

- 图标、顶部操作提示、设计文档与侧栏测试已更新；用户确认 16px 效果并授权新的 MR。局部门禁通过，全量测试无通过证据；待推送和创建 MR。

## goal
将国内站 Agent 侧栏已有 Bot 的“新建 Bot”入口调整为重启图标左侧默认可见的“+”按钮，并在多 Bot 时于删除图标之后展示切换下拉箭头；避免到期提示遮挡“+”。

## non_goals
- 不改变 Bot 创建流程、套餐额度、功能开关或其他隐藏工具的 `show()` 揭示行为。
- 不合并 MR、不发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户先要求删除图标后的 `…` 悬停菜单并授权提交 MR !4222；本轮复审改为“+的icon按钮，放在重启按钮的左边了。如果有多bot，那就在删除按钮后面多个下拉箭头的icon”。无外部需求单。
- 用户确认本地预览与遮挡修复后再次要求“提交mr吧”，授权更新既有 MR，不含合并或发布。
- 本轮用户要求“show()隐藏入口的逻辑，去掉吧”；按上下文仅解除新建 Bot 入口的 `show()` 隐藏，不影响其他隐藏工具。
- 用户随后要求“提交mr吧”，授权将本轮改动更新至既有 MR !4222；不含合并或发布。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `multiBotEnabled`、`canCreateAdditionalBot`、`handleCreateNew` 保持原功能和额度语义；新建入口不再受 `showHiddenAgentTools` 控制。
- Bot 切换继续使用现有 `Popover`；创建按钮的额度说明复用 `WorkspaceActionTooltip` Portal。

## history_context
- `current_design_refs`: `docs/engineering/domains/site-environment-routing.md` 的 Agent 多 Bot 区域边界。
- `relevant_evolution`: 当前 Bot 操作行含重启、删除图标；原创建入口为侧栏整行按钮。旧预览工作树落后主线，本 MR 重新实现并在提交前 rebase 到 `1f21531a2`。
- `superseded_refs`: 无。

## acceptance
- 重启图标左侧展示“+”按钮；多 Bot 时删除图标之后展示下拉箭头；旧 `…` 菜单和整行创建按钮移除。
- “+”按钮可通过鼠标与键盘触发原创建流程；额度不足时禁用并保留可聚焦的原因提示。
- 鼠标移到“+”时显示“新建 Bot”提示，不被到期徽标的续费提示遮挡；到期提示内的“立即续费”仍可操作。
- 符合多 Bot 开关条件时“+”默认可见，无需调用 `show()`；额度不足时可见但禁用，其他隐藏工具仍按原方式揭示。
- 前端针对性测试、`pnpm check`、`pnpm build` 通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- 路由：frontend-product-surface、service-frontend、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@1da70f2a6` | 仓库边界与门禁 | 限定交付与验证 |
| `frontend/AGENTS.md@1da70f2a6` | 前端门禁 | 选择测试、check、build |
| `frontend/DESIGN.md@1da70f2a6` | 前端设计约束 | 维持现有样式体系 |
| `docs/context/project/services/frontend.md@1da70f2a6` | 服务范围 | 限定前端改动 |
| `docs/context/domains/site-environment-routing.md@1da70f2a6` | 区域边界 | 保留国内站开关 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1da70f2a6` | 前端邻接 | 检查测试与 `frontend/openspec`，后者无多 Bot 入口约束命中 |
| `docs/engineering/domains/site-environment-routing.md@1da70f2a6` | 正式设计 | 同步入口约束 |
| `docs/context/domains/subscription-entitlements.md` | 本轮 MR 交付路由 | 续费与额度边界 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | 本轮 MR 交付路由 | 确认提交、推送、MR 状态门禁 |

## evidence
- 初始 `git fetch origin master` 基线为 `1da70f2a6`，提交前 rebase 到 `1f21531a2`；工蜂只读鉴权成功。
- MR !4222 初版的相邻 4 个测试文件：58/58 通过；`pnpm check`、`pnpm build` 通过；`git diff --check` 通过。
- 本轮复审的相邻 4 个测试文件再次 58/58 通过；`pnpm check`、`pnpm build`、`git diff --check`、文档校验和按精确变更文件运行的 change-impact 校验均通过。
- 国内站本地预览 `127.0.0.1:5174/agents/models/`（本工作树、已登录浏览器、`show()` 灰度入口）确认“+ → 重启 → 删除 → 下拉箭头”顺序；展开下拉显示两个 Bot。旧 `…` 菜单已移除。未点击创建或更改真实 Bot。
- 续费气泡修正：到期徽标提示改为下方展开。相邻 3 个测试文件 21/21 通过；Chrome 已登录预览分别悬停到期徽标与“+”，确认前者在下方、后者显示“新建 Bot”且到期气泡消失。`pnpm check`、`pnpm build` 通过，未点击续费或创建。
- 本轮移除新建入口 `show()` 隐藏条件后，代码仅保留 `multiBotEnabled` 与额度禁用；相邻 5 个测试文件 61/61、`pnpm check`、`pnpm build`、文档及影响检查通过。5174 预览服务仍返回 200；独立浏览器自动化命令当前不可用，未做本轮登录态截图。
- 完整 `pnpm test --api.host 127.0.0.1`：3313 通过、133 失败、14 跳过，另有 worker OOM；失败分布在未改动的模型配置、支付、文档等文件。未在独立基线重跑，不能认定均为既有失败。

## risks
- 图标行更密集；已在浏览器确认短 Bot 名和多 Bot 下拉箭头的排布，用户随后要求提交 MR；正式 CR 仍由 Owner 完成。
- 额度不足仍需说明原因；使用可聚焦的 Portal 提示展示原额度文案。
- 回滚方式：回退本 MR 的前端与设计文档变更。

## validation
- `pnpm exec vitest run` 针对相关测试。
- `pnpm check`、`pnpm build`。
- 本地未暂存阶段使用 `--changed-file` 明确列举变更文件；交付前按暂存内容再运行 `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 复用现有 Lucide `Plus` 与 `ChevronDown` 和顶部图标按钮样式；Bot 切换仍由现有 Radix Popover 控制。
- 仅移除新建 Bot 入口的 `show()` 隐藏条件，保留国内区域/运行时功能开关和套餐禁用条件；其他隐藏工具不变。

## scan_scope
- `frontend/src/pages/marketing/`、`frontend/src/styles.css`、相关测试和 Agent 多 Bot 设计段落。

## scan_output
- 有界 `rg` 命中旧创建按钮、顶部操作行和相关测试；无额外扫描产物。

## handoff
- 本轮按用户再次授权更新既有 MR !4222 的分支与描述；不合并或发布。远端 SHA、CI 与合并状态以实时工蜂查询为准。

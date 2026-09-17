## goal
将国内站 Agent 侧栏已有 Bot 的“新建 Bot”入口移到删除图标之后的更多菜单，并提交 MR。

## non_goals
- 不改变 Bot 创建流程、套餐额度、功能开关或 `show()` 灰度门禁。
- 不合并 MR、不发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户在本任务中要求：“放在上面删除bot的icon的后面吧，放个...，然后hover到上面的时候，展开有个新建Bot的按钮，老版本的新建bot的按钮就可以去掉了”；随后要求“提交mr吧”。无外部需求单。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `showCreateBotEntry`、`multiBotEnabled`、`canCreateAdditionalBot`、`handleCreateNew` 保持原语义。
- `frontend/src/components/ui/popover.tsx` 提供 Portal 菜单，避免被侧栏滚动容器裁切。

## history_context
- `current_design_refs`: `docs/engineering/domains/site-environment-routing.md` 的 Agent 多 Bot 区域边界。
- `relevant_evolution`: 当前 Bot 操作行含重启、删除图标；原创建入口为侧栏整行按钮。旧预览工作树落后主线，本 MR 重新实现并在提交前 rebase 到 `1f21531a2`。
- `superseded_refs`: 无。

## acceptance
- 删除图标后展示更多图标；鼠标悬停展开含“新建 Bot”的菜单；旧整行按钮移除。
- 菜单保留点击、键盘与 Escape 操作；额度不足时显示禁用原因。
- 前端针对性测试、`pnpm check`、`pnpm build` 通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/styles.css`
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

## evidence
- 初始 `git fetch origin master` 基线为 `1da70f2a6`，提交前 rebase 到 `1f21531a2`；工蜂只读鉴权成功。
- 相邻的 4 个测试文件：58/58 通过；`pnpm check`、`pnpm build` 通过；`git diff --check` 通过。
- 完整 `pnpm test --api.host 127.0.0.1`：3313 通过、133 失败、14 跳过，另有 worker OOM；失败分布在未改动的模型配置、支付、文档等文件。未在独立基线重跑，不能认定均为既有失败。

## risks
- 菜单 Portaled 后鼠标从图标移入菜单可能短暂离开触发器；短延时关闭并在菜单区域取消计时。
- 额度不足仍需说明原因；在菜单内显示原额度文案。
- 回滚方式：回退本 MR 的前端与设计文档变更。

## validation
- `pnpm exec vitest run` 针对相关测试。
- `pnpm check`、`pnpm build`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 使用现有 Radix Popover 和 Lucide 更多图标，沿用顶部 icon 按钮样式。
- 维持原 `show()` 灰度门禁和套餐禁用条件，不扩大入口可见范围。

## scan_scope
- `frontend/src/pages/marketing/`、`frontend/src/styles.css`、相关测试和 Agent 多 Bot 设计段落。

## scan_output
- 有界 `rg` 命中旧创建按钮、顶部操作行和相关测试；无额外扫描产物。

## handoff
- 待完成暂存检查、提交、推送和 MR 创建；不合并或发布。MR 须披露完整测试集未通过。

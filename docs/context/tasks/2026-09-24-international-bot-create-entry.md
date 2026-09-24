## goal
国际站已有 Bot 时，侧栏“新建 Bot”入口默认可见，无需在控制台执行 `show()`。

## non_goals
- 不开放终端、浏览器等其他隐藏工具。
- 不改变运行时多 Bot 开关、套餐额度、创建流程或服务端校验。
- 不合并、发布或变更生产配置。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-24）：国际站创建多 Bot 的入口取消 `show()` 隐藏。

## interface_refs / data_structure_refs
- `AgentSettingsPage` 的侧栏创建按钮受 `multiBotEnabled` 控制，额度禁用态由 `canCreateAdditionalBot` 控制。
- `showHiddenAgentTools` 仍控制其他隐藏入口。

## history_context
- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md` 的 Agent 多 Bot 区域边界。
- `relevant_evolution`：旧设计要求国际站创建入口经 `show()` 揭示；当前用户要求取消此门禁。
- `superseded_refs`：旧设计中“国际站默认隐藏”的规则。

## acceptance
- 国际站多 Bot 开关开启且额度可用时，创建按钮默认可见并可点击。
- 额度满时按钮仍可见但禁用；多 Bot 开关关闭时不展示。
- 国际站终端等其他隐藏工具仍需 `show()`。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/2026-09-24-international-bot-create-entry.md`

## required_context
- `site-environment-routing` Domain Pack；前端服务说明和页面测试邻居。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@1bbb1a12` | 仓库边界 | 隔离 worktree 与交接门禁 |
| `frontend/AGENTS.md@1bbb1a12` | 前端规范 | 类型、测试、构建要求 |
| `docs/context/domains/site-environment-routing.md@1bbb1a12` | 区域 Pack | 区分前端入口与服务端能力 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1bbb1a12` | 前端邻接 | 检查配置与测试邻居 |
| `frontend/src/contexts/runtime-config-context.tsx@1bbb1a12` | 配置邻居 | 保留运行时多 Bot 开关 |
| `frontend/openspec/specs/marketing.md@1bbb1a12` | 当前前端规格 | 诊断隐藏工具规则不受本次影响 |
| `docs/engineering/domains/site-environment-routing.md@1bbb1a12` | 正式设计 | 更新创建入口显隐规则 |
| `docs/context/tasks/TASK-TEMPLATE.md@1bbb1a12` | Task Pack 模板 | 记录范围与证据 |

## evidence
- 当前 `origin/master` 的创建按钮条件为 `multiBotEnabled && (!isGlobal || showHiddenAgentTools)`。
- `runtime-config-context.tsx` 的多 Bot 默认值为 `true`，运行时仍可显式关闭。
- 聚焦组件和源码守卫测试：2 文件、49 条通过；覆盖国际站默认显示、其他工具仍隐藏、额度禁用和多 Bot 开关关闭。
- `pnpm check` 通过：i18n、文档同步及类型检查，171 条已有诊断，0 条新增。
- `pnpm build:global` 通过：国际站静态页面生成和 SEO/静态资源检查完成。
- `validate_documentation.py --repo . --format json`：错误和告警均为 0；`validate_change_impact.py --repo . --staged` 通过，未命中额外设计映射规则。
- `git diff --check` 通过；构建生成的字体文件已恢复。

## risks
- 风险：误开放其他隐藏工具或绕过额度。
- 缓解：只改创建按钮的显示条件，组件测试分别核验其他隐藏工具和额度禁用态。
- 回滚：恢复原创建按钮条件及设计描述。

## validation
- 聚焦 Vitest：多 Bot 组件和侧栏守卫。
- `pnpm check`、前端 lint、国际站构建。
- context 文档和变更影响检查、`git diff --check`。

## decisions
- 创建入口只受 `multiBotEnabled` 控制；保留既有额度禁用态和 `showHiddenAgentTools` 对其他工具的门禁。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、相邻测试、`runtime-config-context.tsx`、`frontend/openspec/` 相关条目。

## scan_output
- 有界搜索命中上述路径；无需独立扫描产物。

## handoff
- 实现和本地门禁已完成；通过 `codex/show-global-bot-create` 分支提交 MR，待审核与合并。

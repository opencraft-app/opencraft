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
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/2026-09-24-international-bot-create-entry.md`
- `docs/context/tasks/2026-09-24-international-bot-create-entry.checkpoint.md`

## required_context
- `site-environment-routing` Domain Pack；前端服务说明、页面测试邻居及 OpenCraft 生成层约束。

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
| `opencraft/AGENTS.md@a836219d` | OpenCraft 服务约束 | 同步机械生成层并运行只读漂移检查 |
| `opencraft/MONO2_MIGRATION.md@a836219d` | 生成层权威 | 确认 frontend 为唯一写入真源 |
| `docs/context/project/upstream-subtrees.md@a836219d` | 共置边界 | 不从旧 OpenCraft 仓库双向同步 |

## evidence
- 当前 `origin/master` 的创建按钮条件为 `multiBotEnabled && (!isGlobal || showHiddenAgentTools)`。
- `runtime-config-context.tsx` 的多 Bot 默认值为 `true`，运行时仍可显式关闭。
- 聚焦组件和源码守卫测试：2 文件、49 条通过；覆盖国际站默认显示、其他工具仍隐藏、额度禁用和多 Bot 开关关闭。
- `pnpm check` 通过：i18n、文档同步及类型检查，171 条已有诊断，0 条新增。
- `pnpm build:global` 通过：国际站静态页面生成和 SEO/静态资源检查完成。
- `validate_documentation.py --repo . --format json`：错误和告警均为 0；`validate_change_impact.py --repo . --staged` 通过，未命中额外设计映射规则。
- `git diff --check` 通过；构建生成的字体文件已恢复。
- MR !4621 的 CI 日志显示 frontend 检查通过，OpenCraft guard 因 `UPSTREAM.json` 清单漂移失败；本地复现同一错误。
- 在前端源码提交 `a836219d9d481adf7236d486054c2c48a2a4235d` 后运行官方同步脚本，仅更新清单的 `sourceRevision`；`check:mono2-agent-console` 验证 130 个文件通过。
- 为解决 MR 与最新 `master` 的 `UPSTREAM.json` 冲突，合入 `origin/master@dac769cce` 后重新同步清单；`sourceRevision` 指向合并提交 `e1254d3c9`，生成层仍仅该字段变化。
- 合并后聚焦 Vitest 54/54 通过、`pnpm check` 无新增类型诊断、`pnpm build:global` 通过，OpenCraft 130 文件一致性检查通过。

## risks
- 风险：误开放其他隐藏工具或绕过额度。
- 缓解：只改创建按钮的显示条件，组件测试分别核验其他隐藏工具和额度禁用态。
- 回滚：恢复原创建按钮条件及设计描述。

## validation
- 聚焦 Vitest：多 Bot 组件和侧栏守卫。
- `pnpm check`、国际站构建。
- OpenCraft `sync:mono2-agent-console` 与 `check:mono2-agent-console`。
- context 文档和变更影响检查、`git diff --check`。

## decisions
- 创建入口只受 `multiBotEnabled` 控制；保留既有额度禁用态和 `showHiddenAgentTools` 对其他工具的门禁。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、相邻测试、`runtime-config-context.tsx`、`frontend/openspec/` 相关条目。

## scan_output
- 有界搜索命中上述路径；无需独立扫描产物。

## handoff
- 实现与 OpenCraft 清单同步已本地验证；继续更新同源 MR !4621，待远端 CI 复核。

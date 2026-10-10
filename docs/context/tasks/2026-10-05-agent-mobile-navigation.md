---
id: agent-mobile-navigation-task
type: task
scope: Agent 控制台在移动浏览器窄屏下的导航与内容呈现。
triggers: ["Agent 移动导航", "Agent 窄屏布局"]
owner: LightVela 产品团队
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-05-agent-mobile-navigation.md
status: in-review
reviewed_at: 2026-10-05
review_due: 2026-10-19
revision: 1.0.0
precedence: task
derived: false
---

## goal

让 Agent 控制台在窄屏上先展示当前页面内容，同时保留随时可达的 Bot、功能和会话导航。

## non_goals

- 不改变桌面侧栏收起状态、Bot/会话数据和后端行为。
- 不提交、推送、创建 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- 2026-10-05 用户提供两张截图：桌面侧栏收起后内容可见；移动浏览器中完整导航占据首屏。用户要求重新设计移动窄屏显示。外部标识 `unknown`。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `mobileChatNavOpen`、`useMobileChatLayout`、当前 Bot 和侧栏分组状态。
- `frontend/src/components/site/agent-sidebar.tsx` 的侧栏容器和桌面滚动管理。
- 不变量：切换页面、Bot 或会话后不保留遮挡内容的抽屉；聊天视口高度与键盘逻辑不受侧栏滚动影响。

## history_context

- `current_design_refs`：`frontend/DESIGN.md`、现行 `agent-settings-page.tsx` 和 `styles.css`；桌面收起侧栏已在 `origin/master`。
- `relevant_evolution`：现行嵌入聊天在窄屏已有独立抽屉；其他 Agent 页面仍把侧栏整段排到内容前。
- `superseded_refs`：2026-10-02 Chat First 导航隔离工作树早于当前“日常／探索”和桌面收起侧栏，不能作为本次实现基线。

## acceptance

- 320–1023px 初始显示当前内容与一行页面上下文；点击导航按钮打开单列抽屉，Bot、分组、最近会话可触达且不横向溢出。
- 抽屉可通过关闭键、遮罩、Esc、选择链接或路由变化关闭，焦点可恢复；桌面布局不变化。
- 前端 `check`、聚焦测试与双站构建通过；截图或浏览器验证保留证据。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/components/site/agent-sidebar.tsx`
- `frontend/src/styles.css`
- 本 Task Pack 与相邻测试。

## required_context

- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `AGENTS.md@working-tree` | 仓库硬边界 | 实现与验证范围 |
| `docs/context/project/services/frontend.md@working-tree` | 路由 must-read | 前端验证边界 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 路由 must-read | 双站共享样式验收 |
| `frontend/AGENTS.md@working-tree` | 最近服务说明 | UI 组件、构建门禁 |
| `frontend/DESIGN.md@working-tree` | 当前设计规范 | 控件尺寸与浮层交互 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 邻接卡 | 核对测试与翻译 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@working-tree` | 侧栏历史 | 避免覆盖现行状态 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@working-tree` | 当前实现 | 复用现有导航状态 |
| `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts@working-tree` | 相邻测试 | 核对桌面布局约束 |

## evidence

- 路由器输出 `frontend-product-surface`；按路径再次路由还包含 `service-frontend` 和 `site-environment-routing`。
- 精确搜索定位 `mobileChatNavOpen` 和 `useMobileChatLayout`：旧移动抽屉仅作用于嵌入聊天页。
- 2026-10-05 再次同步时，`origin/master` 从 `7cc2f2477` 前进 25 个提交到 `ebba1eacf`；侧栏组件、页面和样式均有上游改动。本次补丁经三方应用后没有冲突标记，并保留最新的 Bot 状态与会话列表逻辑。

## risks

- 抽屉与聊天视口同用 fixed 布局；以 320px、390px 和桌面宽度核验。
- 本地账号或鉴权不可用时仅能验证静态布局与组件行为，不能声称已完成真实多 Bot 联调。

## validation

- `pnpm check`、聚焦 Vitest、`pnpm build:cn`、`pnpm build:global`、`git diff --check`。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。
- 移动宽度浏览器截图与抽屉开合检查。

## decisions

- 手机端默认收起导航，通过页面上下文条打开侧边抽屉；保留现行桌面展开／收起选择。
- 基于 `origin/master` 实现，保留现行“日常／探索”与嵌入聊天抽屉状态。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、侧栏组件和相邻测试。

## scan_output

- 有界查询 `mobileChatNavOpen|useMobileChatLayout|lv-agent-chat-mobile-nav|lv-agents-sidebar` 命中上述路径。

## handoff

- 本次交付来自隔离工作树；源码尚未合并或发布。
- `pnpm check` 通过，TypeScript 166 条现有诊断、0 条新增；`pnpm build:cn` 与 `pnpm build:global` 通过。
- 同步最新 `master` 后重新运行 `pnpm check`、58 项聚焦测试、`pnpm build:cn` 与 OpenCraft 同步检查，全部通过。
- 相关导航／嵌入聊天的 3 个测试文件通过（58/58）；加入续费提醒旧测试后 67/70 通过。失败的 3 条仍断言已被现行“日常／探索”导航替换的“实例配置导航／高级设置”结构，源自基线测试未同步。
- 完整 `pnpm test` 已尝试，但出现大量已有失败并最终 Node OOM，不能声明全套通过。
- 登录态本地预览已检查 320px、390px 与 1280px：窄屏首屏显示内容，抽屉可通过按钮、遮罩、Esc、导航链接关闭，320px 无水平溢出，桌面侧栏保持原样。真实手机软键盘未验证。
- 最新 `master` 国内站预览运行于 `http://localhost:5174/agents/overview/`；390px 浏览器复查确认默认收起、抽屉为 dialog、打开时锁定页面滚动、Esc 恢复焦点，页面 `scrollWidth` 等于 390px。
- 文档校验、change impact 校验、OpenCraft mono2 同步检查和 `git diff --check` 通过。

## checkpoint

### stage

实现与本地验证完成，准备提交 MR；不合并或发布。

### verified

- 已同步到 `origin/master@ebba1eacf`，移动导航入口覆盖所有有侧栏的 Agent 页面；三方移植没有 Git 冲突。
- 双站构建、类型检查、聚焦测试、文档检查与真实浏览器宽度检查结果见 handoff。

### unverified

- 真实手机与软键盘交互；完整测试套件因既有失败和 OOM 未通过。

### discard

- 早期 Chat First 工作树上的试验性移动补丁；其基线缺少当前导航合并。

### restore

- 本工作树：`/Users/pablozhong/.codex/worktrees/mobile-agent-navigation-master/lightvela`。

### next_action

- 提交 MR 后核对远端提交、可合并状态和 CI 即时状态；不执行合并或发布。

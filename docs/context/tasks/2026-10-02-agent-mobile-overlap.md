## goal
修复移动端 Agent 导航中 DeepSeek Harness 的 Beta 徽标，以及人设卡片标题与 SkillHub 来源链接的重叠。

## non_goals
- 不改变导航、SkillHub 链接或人设卡片的行为与文案。
- 不涉及合并、发布或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-02 提供的两张移动端截图：两个位置的文字和徽标不能重叠。

## interface_refs / data_structure_refs
- `AgentSettingsPage` 的 `SettingsSectionLink.badge` 与 `BuddyPanel` 顶部工具栏；保留现有链接目标和可访问名称。

## history_context
- current_design_refs: `frontend/openspec/specs/buddy.md` 推荐人设规则；`frontend/openspec/plan.md` DeepSeek Harness 实验室入口约束。
- relevant_evolution: 人设来源入口在桌面与卡片网格右边缘对齐，窄屏已有容器查询布局。
- superseded_refs: 无。

## acceptance
- 约 390px CSS 视口下两个位置没有重叠，标题、链接和 Beta 均可完整阅读；桌面布局保持对齐。
- 前端定向测试、类型与 i18n 检查、差异检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/styles.css`

## required_context
- `frontend-product-surface`；前端服务 context 与最近的 `frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 路由 must_read | 双站与验证边界 |
| `frontend/AGENTS.md` | 最近服务规则 | 前端检查与视觉证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 检查 OpenSpec 与相邻测试 |
| `frontend/openspec/specs/buddy.md` | 当前人设设计 | 保留桌面右边缘对齐与来源入口 |

## evidence
- 用户截图显示导航徽标与英文名、人设标题与 SkillHub 链接重叠；源代码分别使用 `whitespace-nowrap` 与绝对定位。
- Chrome 本地国内站 `/agents/persona/` 在 320px、390px、1280px 宽度检查：DeepSeek 文字与 Beta、标题与 SkillHub 来源链接的边界均无相交；320px 实验室入口单列；390px 来源链接在标题下方；1280px 来源链接仍位于右侧。

## risks
- 窄屏换行使导航行增高；使用现有自适应高度，检查 390px 与桌面排布。

## validation
- `agent-buddy-panel.test.tsx`：38/38 通过。
- `agent-settings-labs-nav.test.tsx`：运行前 Vitest worker 达到 6 GiB 堆上限，未得到该文件测试结果；已用实际本地页面验证改动的导航布局。
- `pnpm check`、`pnpm build:cn`、`pnpm build:global`、`git diff --check` 通过。仓库没有独立 `pnpm lint` 脚本。

## decisions
- 只调整携带徽标的导航文字换行与来源链接定位样式，不改产品逻辑。

## scan_scope
- `frontend/src/pages/marketing`、`frontend/src/styles.css`、相邻 OpenSpec 与测试。

## scan_output
- 精确搜索命中 `AgentSettingsPage`、`BuddyPanel` 和对应测试。

## handoff
- 独立工作树 `/Users/pablozhong/.codex/worktrees/mobile-overlap-fixes/lightvela` 内修复完成；用户随后授权提交 MR，合并与发布另行处理。

## goal
小幅收紧 `/agents/` 左侧导航红框内桌面端项目的纵向间距。

## non_goals
- 不改导航文案、顺序、字体大小或移动端布局。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图和本轮请求：“左边侧栏，如截图，红色框里面这些，间距再稍微小一点”。

## interface_refs / data_structure_refs
- `frontend/src/styles.css` 的 `--lv-agents-nav-item-height` 与 `--lv-agents-nav-group-gap`。
- 移动端 `36px` 条目高度保持不变。

## history_context
- `current_design_refs`: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md`。
- `relevant_evolution`: `a235443ec feat(agents): compact sidebar navigation` 已收紧桌面导航密度。
- `superseded_refs`: 无。

## acceptance
- 桌面端导航条目和分组间隔比当前值略小；移动端尺寸不变。
- 导航间距聚焦测试、`pnpm check` 和差异检查通过。

## affected_paths
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`

## required_context
- `frontend-product-surface`：`docs/context/project/services/frontend.md`；`frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@HEAD` | 仓库边界 | 验证和交接约束 |
| `frontend/AGENTS.md@HEAD` | 前端边界 | 前端验证要求 |
| `docs/context/project/services/frontend.md@HEAD` | 路由必读 | 确认 UI 范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查相邻测试与 OpenSpec |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@HEAD` | 现有导航设计 | 保留 tab 和导航结构 |

## evidence
- `pnpm install --frozen-lockfile` 完成；lockfile 未改变。
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts --api.host 127.0.0.1`：7/7 通过。
- `pnpm check`：通过，TypeScript diagnostics 为 166 current / 171 baseline / 0 new。
- `git diff --check`：通过。
- `validate_documentation.py --repo . --format json`：通过，失效链接 0、warnings 0。
- 本地 CN `/agents/` 在 5186 端口返回 HTTP 200；未登录浏览器只呈现登录页，侧栏视觉效果未实测。

## risks
- 桌面侧栏点击区域稍小；保持 30px 高，与现有矮屏规则相同。回滚 CSS 两个变量即可。

## validation
- 导航间距聚焦测试、`pnpm check`、`git diff --check`。

## decisions
- 只调整桌面端 CSS 变量；不改 JSX。Owner：本轮执行者。

## scan_scope
- `frontend/src/styles.css`、相邻导航测试、导航 OpenSpec。

## scan_output
- 无独立扫描产物。

## handoff
- 本地 CSS 和聚焦测试已验证；登录态侧栏视觉核对待有认证环境时完成。提交与 MR 状态以工蜂为准；未发布。

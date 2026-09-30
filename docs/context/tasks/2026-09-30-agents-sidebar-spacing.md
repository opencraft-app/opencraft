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
- `opencraft/tests/lightvela-hermes-plugin.test.ts`

## required_context
- `frontend-product-surface`：`docs/context/project/services/frontend.md`；`frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@HEAD` | 仓库边界 | 验证和交接约束 |
| `frontend/AGENTS.md@HEAD` | 前端边界 | 前端验证要求 |
| `opencraft/AGENTS.md@HEAD` | OpenCraft 边界 | 嵌入式测试验证要求 |
| `docs/context/project/services/frontend.md@HEAD` | 路由必读 | 确认 UI 范围 |
| `docs/context/flows/tapd-gongfeng-delivery.md@HEAD` | MR 交付路由必读 | 确认远端状态门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查相邻测试与 OpenSpec |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@HEAD` | 现有导航设计 | 保留 tab 和导航结构 |

## evidence
- `pnpm install --frozen-lockfile` 完成；lockfile 未改变。
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts --api.host 127.0.0.1`：7/7 通过。
- `pnpm check`：通过，TypeScript diagnostics 为 166 current / 171 baseline / 0 new。
- `git diff --check`：通过。
- `validate_documentation.py --repo . --format json`：通过，失效链接 0、warnings 0。
- 本地 CN `/agents/` 在 5186 端口返回 HTTP 200；未登录浏览器只呈现登录页，侧栏视觉效果未实测。
- MR !4875 的 CI 日志显示 frontend guard 与 OpenCraft 生成物检查通过；OpenCraft 嵌入式测试 142 个中有 1 个心跳时序断言失败。
- 心跳测试改为有界等待两次实际心跳、总是清理 transport，并使用 Node 支持的测试关闭事件；`npm --prefix opencraft run test:embedded-ci` 142/142 通过。
- `npm --prefix opencraft run typecheck`、`check:mono2-agent-console`（130 个文件）及文档检查通过。
- 合入 `master` 后运行官方 `sync:mono2-agent-console`，只重生成 `UPSTREAM.json` 的 `sourceRevision`；`check:mono2-agent-console` 验证 130 个文件通过。
- 合并后复验：导航间距测试 7/7、`pnpm check` 无新增 TypeScript 诊断、OpenCraft 嵌入式测试 145/145 通过。

## risks
- 桌面侧栏点击区域稍小；保持 30px 高，与现有矮屏规则相同。回滚 CSS 两个变量即可。
- OpenCraft 测试原先固定等待 18ms，CI 负载下可能不足以产生两次 5ms 心跳；测试失败时残留定时器会触发 Node 中不存在的 `CloseEvent`。修复只触及测试代码。

## validation
- 导航间距聚焦测试、`pnpm check`、`git diff --check`。

## decisions
- 只调整桌面端 CSS 变量；不改 JSX。Owner：本轮执行者。

## scan_scope
- `frontend/src/styles.css`、相邻导航测试、导航 OpenSpec。

## scan_output
- 无独立扫描产物。

## handoff
- 本地 CSS、聚焦测试及 CI 心跳测试修复已验证；已合入最新 `master` 并通过官方脚本重生成清单。登录态侧栏视觉核对待有认证环境时完成。未发布。

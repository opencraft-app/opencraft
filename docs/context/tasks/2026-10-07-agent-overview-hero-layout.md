## goal
修复 Agent 总览欢迎横幅布局，并将“我的 Bots”卡片改为 8px 圆角。

## non_goals
- 不改变统计数据、跳转、文案或卡片操作。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图（2026-10-07）：总览欢迎横幅文案窄列换行，统计卡片与文案重叠。
- 用户后续要求（2026-10-07）：“我的 Bots”中的 Bot 卡片使用 8px 圆角。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-overview-panel.tsx` 的 `HeroBanner` 与 `HeroStats`；保留三个统计入口的行为。

## history_context
- `current_design_refs`: `frontend/src/pages/marketing/agent-overview-panel.tsx`。
- `relevant_evolution`: 当前 `origin/master` 的欢迎横幅在 `lg` 横排时统计区同时使用整行宽度和不可收缩布局。
- `superseded_refs`: 无。

## acceptance
- 宽屏下欢迎文案保持可读，统计卡片与文案不重叠；窄屏上下排列。
- “我的 Bots”卡片外框、整卡点击层和左上角当前 Bot 标记采用一致的 8px 外角。
- 前端 lint、typecheck、聚焦测试和 build 通过，并提供布局截图或组件验证。

## affected_paths
- `frontend/src/pages/marketing/agent-overview-panel.tsx`
- `frontend/src/pages/marketing/agent-fleet-overview.tsx`

## required_context
- `frontend-product-surface`；前端服务规则。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 路由必读 | 确认前端验证边界 |
| `frontend/AGENTS.md@4620dff30` | 最近服务规则 | 确认 lint/type/test/build 与视觉验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 页面邻接 | 核对 OpenSpec 与相邻测试 |
| `docs/context/tasks/TASK-TEMPLATE.md@2.1.0` | Task Pack 模板 | 记录任务状态 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@2.0.0` | 检查点模板 | 交接状态 |

## evidence
- `pnpm exec vitest run --config vitest.config.ts --pool=threads --no-file-parallelism ...`：2 个测试文件、57 项通过；运行时仅为测试进程把不可解析的 `localhost` 映射到 `127.0.0.1`。
- `pnpm typecheck`：166 个当前基线诊断、0 个新增诊断。
- `pnpm build`：国内站 Next.js 静态构建成功，生成 106 个静态页面。
- 本地隔离组件预览：390px 与 1440px 视口均未出现文案/卡片重叠和横向溢出；预览路由已删除。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：退出码 0，无错误或警告。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过，未命中强制设计同步规则。

## risks
- 较窄窗口内统计卡片需要转成两列；保留原有响应式列数。

## validation
- 已通过 `pnpm typecheck`、聚焦 Vitest、`pnpm build`、布局截图检查与 `git diff --check`。
- 当前 `frontend/package.json` 没有 `lint` 脚本，无法运行 `pnpm lint`。

## decisions
- 使用明确的两列 Grid 限制统计区域宽度；小于 `xl` 时上下排列。

## scan_scope
- `frontend/src/pages/marketing/agent-overview-panel.tsx` 及相邻测试。

## scan_output
- 未产生隔离扫描产物。

## handoff
- 本地修复已移植到 `codex/chat-file-download`，准备追加到 MR !5041；生产真实账户页面仍待部署后确认。

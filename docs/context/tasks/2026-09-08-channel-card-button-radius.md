## goal
优化通道配置页卡片内操作按钮的圆角，使连接、重新连接、断开和配置教程按钮更柔和，并保持同组按钮一致。

## non_goals
- 不调整按钮尺寸、颜色、文案、交互或卡片布局。
- 不改全局按钮圆角，不影响其他页面。
- 不提交、推送、合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-08）：通道配置页面卡片内按钮的圆角调大一点。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-config/standard-panel.css`：通道卡片与操作按钮样式。
- `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`：通道卡片操作区样式回归。

## history_context
- 无匹配 Context Pack；已记录路由查询 `frontend 通道配置页面 卡片按钮 圆角样式`，并通过有界精确搜索定位组件和样式。
- 沿用现有 `--lh-std-radius-lg` 设计令牌，不新增单用途数值。

## acceptance
- 通道卡片内所有操作按钮使用更大的统一圆角。
- 变更只作用于通道卡片操作区。
- 国内站页面在本地预览中无布局变化或文字溢出。
- 聚焦测试与前端门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-config/standard-panel.css`
- `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`
- `docs/context/tasks/2026-09-08-channel-card-button-radius.md`

## required_context
- `frontend/AGENTS.md`
- `baseline-ui`
- `karpathy-guidelines`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@working-tree` | 前端视觉变更验证要求 | 增加聚焦测试与浏览器截图核验 |
| `.agents/skills/baseline-ui/SKILL.md` | UI 组件与设计令牌约束 | 复用现有圆角令牌并保持组件范围 |

## evidence
- 有界精确搜索定位通道卡片按钮均使用 `--lh-std-radius`（6px），同文件已有 `--lh-std-radius-lg`（10px）。
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`：1 个测试文件、3 个测试全部通过。
- `pnpm check`：i18n、繁中生成检查、文档时间检查通过；TypeScript 相对基线 0 个新增问题。
- 已登录线上通道页核对了连接、重新连接和断开按钮的真实卡片布局；本地 5174 新标签页因没有登录态停在登录门禁，未将其计作新样式截图证据。

## risks
- 只修改连接按钮会造成已连接状态下三类操作按钮不一致；统一覆盖配置教程、断开和连接按钮。
- 修改全局圆角变量会扩大影响；本次仅修改通道卡片按钮选择器。

## validation
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- 国内站 `/agents/channels/` 本地浏览器核验。

## decisions
- 从 6px 的 `--lh-std-radius` 调整为现有 10px 的 `--lh-std-radius-lg`，变化清晰但不过度圆润。
- 不引入动画、阴影或颜色变化。

## scan_scope
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-config/standard-panel.css`
- `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`

## scan_output
- 无独立扫描产物；查询和定位结果记录于任务执行日志。

## handoff
- 实现与代码验证完成；待用户在已有登录态的本地页面确认视觉效果后提交。

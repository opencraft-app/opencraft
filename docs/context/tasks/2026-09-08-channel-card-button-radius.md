## goal
优化模型配置、通道配置、定时任务与设置页的局部样式与文案：主模型操作按钮仅保留文案；模型页顶部说明移除末尾句号；通道卡片和卡片内操作按钮加大圆角；操作区固定靠近卡片底部，并将配置教程、连接、重新连接和断开按钮统一收拢到右下角；定时任务空状态提示使用一致文字颜色；通道卡片说明统一使用“连接”；设置页加载提示简化为“正在加载...”。

## non_goals
- 不调整按钮尺寸、颜色或交互。
- 不改全局按钮圆角，不影响其他页面。
- 不提交、推送、合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-08）：模型配置页“设为主模型”按钮去掉对勾，仅保留文案，顶部说明移除末尾句号；通道卡片圆角调大，卡片内按钮圆角再调大；按钮固定靠近卡片底部，Guide 与 Connect 集中在右下角；定时任务空状态的两段提示颜色保持一致；通道卡片说明中的“绑定”统一改为“连接”；“正在加载配置面板...”改为“正在加载...”。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-config/standard-panel.css`：通道卡片与操作按钮样式。
- `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`：通道卡片操作区样式回归。
- `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`：已配置模型的操作按钮。
- `frontend/src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`：模型操作按钮回归。
- `frontend/src/pages/marketing/agent-automations-panel.tsx`：定时任务空状态提示。
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`：定时任务空状态文案样式回归。
- `frontend/src/i18n/generated/*.json`：通道卡片说明的多语言译文。
- `frontend/src/pages/marketing/agent-settings-page.tsx`：设置页加载提示。

## history_context
- 无匹配 Context Pack；已记录路由查询 `frontend 通道配置页面 卡片按钮 圆角样式`，并通过有界精确搜索定位组件和样式。
- 卡片局部采用 16px、卡片内操作按钮采用 14px，不影响全局圆角令牌。

## acceptance
- 通道卡片内所有操作按钮使用更大的统一圆角。
- 通道卡片使用更大的圆角。
- 模型配置页“设为主模型”操作按钮不显示对勾图标。
- 操作区固定在卡片底部，不受上方描述一行或多行影响。
- 配置教程、断开、重新连接和连接按钮统一在右下角分组。
- “暂无定时任务”空状态提示的前后两段使用相同文字颜色和字重。
- 通道卡片说明中的接入动作统一使用“连接”，与卡片操作按钮一致。
- 已支持语言中，通道卡片说明均使用对应的“连接”译文。
- 设置页加载态显示简短的“正在加载...”。
- 变更仅作用于通道卡片操作区、主模型操作按钮与定时任务空状态提示。
- 国内站页面在本地预览中无布局变化或文字溢出。
- 聚焦测试与前端门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-config/standard-panel.css`
- `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`
- `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- `frontend/src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts`
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/i18n/generated/es.json`
- `frontend/src/i18n/generated/id-ID.json`
- `frontend/src/i18n/generated/ja-JP.json`
- `frontend/src/i18n/generated/ko-KR.json`
- `frontend/src/i18n/generated/zh-CN.json`
- `frontend/src/i18n/generated/zh-Hant.json`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `docs/context/tasks/2026-09-08-channel-card-button-radius.md`

## required_context
- `frontend/AGENTS.md`
- `baseline-ui`
- `karpathy-guidelines`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@working-tree` | 前端视觉变更验证要求 | 增加聚焦测试与浏览器截图核验 |
| `.agents/skills/baseline-ui/SKILL.md` | UI 组件与设计令牌约束 | 保持局部作用域、复用面板既有 12px 圆角尺度 |

## evidence
- 有界精确搜索定位通道卡片按钮原使用 `--lh-std-radius`（6px），卡片原使用 `--lh-std-radius-lg`（10px），同面板图标容器已有 12px 圆角。
- 卡片已使用纵向 flex 布局；为操作区增加 `margin-top: auto` 即可吸收不同文案高度造成的剩余空间。
- 配置教程按钮原本位于右侧操作组之外，是其单独停留在左下角的直接原因。
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`：1 个测试文件、4 个测试全部通过。
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`：1 个测试文件、56 个测试全部通过；覆盖主模型操作按钮的纯文案断言。
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-automations-panel.test.ts`：1 个测试文件、162 个测试全部通过；覆盖空状态后半句不再覆盖容器文字颜色与字重。
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts`：1 个测试文件、4 个测试全部通过；覆盖通道卡片描述的“连接”用语。
- `pnpm i18n:check && pnpm i18n:validate && pnpm i18n:zh-hant:check`：新文案的英语、西班牙语、印尼语、日语、韩语与繁体中文译文完整；既有 51 条告警无新增错误。
- 设置页加载态文案已从“正在加载配置面板…”缩短为“正在加载...”，并补齐各语言对应的简短加载提示。
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx src/pages/marketing/agent-model-config/__tests__/agent-model-config.id-ID.test.ts`：2 个测试文件、95 个测试全部通过；覆盖模型页顶部说明无末尾句号。
- `pnpm check`：i18n、繁中生成检查、文档时间检查通过；TypeScript 相对基线 0 个新增问题。
- 已登录线上通道页核对了连接、重新连接和断开按钮的真实卡片布局；本地 5174 新标签页因没有登录态停在登录门禁，未将其计作新样式截图证据。

## risks
- 只修改连接按钮会造成已连接状态下三类操作按钮不一致；统一覆盖配置教程、断开和连接按钮。
- 修改全局圆角变量会扩大影响；本次仅修改通道卡片、卡片按钮和主模型操作按钮。

## validation
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `pnpm vitest run --api.host=127.0.0.1 src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts`
- `pnpm i18n:check && pnpm i18n:validate && pnpm i18n:zh-hant:check`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- 国内站 `/agents/channels/` 本地浏览器核验。

## decisions
- 卡片使用 16px、卡片内操作按钮使用 14px：较原 10px/6px 更柔和，且不超过产品卡片的常用圆角范围。
- 主模型操作按钮仅移除 `<Check>` 图标，保留原有语义、禁用逻辑和文案。
- 定时任务空状态提示移除后半句额外的颜色与字重类，继承容器的 `text-black/50`，使整行视觉一致。
- 仅更改通道卡片说明的“绑定”为“连接”；表单、成功提示与底层凭据关联语义仍保留“绑定”。
- 将配置教程按钮移入同一操作组，并用右对齐、可换行布局兼容国际站长文案。
- 不引入动画、阴影或颜色变化。

## scan_scope
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-config/standard-panel.css`
- `frontend/src/pages/marketing/__tests__/agent-channel-action-layout.test.ts`
- `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- `frontend/src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`

## scan_output
- 无独立扫描产物；查询和定位结果记录于任务执行日志。

## handoff
- 圆角、按钮位置和主模型按钮图标移除均已实现并通过代码验证；本地新标签页因无登录态无法作为截图证据，待用户在已有登录态页面确认视觉效果后提交。

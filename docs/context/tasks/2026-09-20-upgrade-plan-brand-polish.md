## goal
让套餐升级中页面与其他无侧栏 Agent 状态保持一致：移除左上角 LightVela 品牌区域边框，并将升级标题调整为 LightVela 品牌文案和克制的动态省略号。

## non_goals
- 不改变套餐升级、订单轮询、Pass 权益或交付逻辑。
- 不改变正常 Agent 设置页的侧栏分隔线。
- 不合并 MR、不发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-20 截图：套餐升级中页面左上角 LightVela 周围仍有边框；标题需从 Hermes Agent 改为 LightVela，并建议增加动态省略号。

## interface_refs / data_structure_refs
- `AgentSettingsPage` 的 `isModifying` 仅控制升级流程 UI；本次只复用该状态添加页面样式标记。
- `AgentUpgradingView` 继续使用既有 `useInView` / `useReducedMotion` 控制循环动效。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`；`docs/context/tasks/2026-09-18-empty-agent-section-brand-frame.md`。
- `relevant_evolution`：MR !4304 已为无 Bot、无侧栏的 Agent 页面移除品牌区域边框；升级中同样没有侧栏，但尚未命中该样式。
- `superseded_refs`：无。

## acceptance
- 套餐升级中页面的 LightVela 品牌区域不显示右、下边框；正常 Agent 页面保持原样。
- 英文标题为 `Upgrading your LightVela plan`，其他已支持语种同步更新。
- 升级标题后的三个点按顺序循环淡入；离屏、失败、暂停或 reduced motion 状态不运行循环动画。
- 动态点号不进入可访问名称，不触发读屏重复播报。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-upgrading-view.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-empty-persona.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-upgrading-view.test.tsx`
- `frontend/src/i18n/generated/*.json`

## required_context
- 路由器未匹配 Domain Pack；已执行有界精确搜索并检查前端/i18n 邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@origin/master` | 前端验证门禁 | 约束测试、检查和视觉证据 |
| `frontend/DESIGN.md@origin/master` | UI 与动效规范 | 保持克制的产品态视觉与 reduced motion |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | i18n 与测试邻接 | 检查生成字典及相邻测试 |
| `docs/context/tasks/2026-09-18-empty-agent-section-brand-frame.md@origin/master` | 相同品牌边框历史 | 复用无侧栏状态选择器策略 |

## evidence
- 最新 `origin/master` 中，`.lv-agent-empty-page` 已移除品牌区域边框；`isModifying` 页面没有侧栏但未添加等价页面 class。
- `AgentUpgradingView` 已具备可复用的 `useInView` 和 `useReducedMotion` 状态。
- 聚焦 Vitest 2 个文件、10 项测试通过；覆盖升级页品牌 class、英文标题和动态点号可访问性。
- `pnpm check` 通过：i18n 六个目标语种均 2940/2940、结构错误 0，TypeScript 新增诊断 0。
- `pnpm build:global` 通过并生成 650 个静态页面；构建生成的 `next-env.d.ts` 和字体二进制噪声已恢复。
- 本地国际站开发预览运行于 `127.0.0.1:5174`，`/agents/` 返回 HTTP 200 且使用 `/_next/static/` 开发资源；监听进程 cwd 为本 worktree 的 `frontend/`。
- 基于当前组件代码导出了升级中视觉夹具截图，确认左上角仅保留 LightVela Logo、标题为 LightVela 品牌文案；该截图不包含真实登录态或后端升级数据。

## risks
- `:has()` 选择器作用范围错误可能影响正常设置页；使用独立升级页 class 并添加源码回归测试限制范围。
- 循环省略号可能造成视觉或读屏干扰；仅动画 opacity，离屏暂停，并使用 `aria-hidden`。

## validation
- 聚焦 Vitest：升级页与品牌边框测试。
- `pnpm i18n:extract`、`pnpm check`、相关构建、`git diff --check`。
- 本地预览截图检查升级态；若缺少可复现账号状态，明确记录视觉验证边界。

## decisions
- 标题使用产品品牌 `LightVela`，不再把底层 Agent 实现名 `Hermes Agent` 放在套餐升级主标题中。
- 使用轻量三点透明度循环，不增加位移、弹跳或额外加载组件。

## scan_scope
- Agent 升级页面、品牌 Header 样式、i18n 生成物和相邻测试。

## scan_output
- 精确命中 `AgentUpgradingView`、`isModifying`、`.lv-agent-empty-page` 与 `agent-settings-empty-persona.test.ts`。

## handoff
- 用户已于 2026-09-20 明确授权提交、推送并创建 MR；不包含合并或发布授权。
- 本地浏览器只能到登录门槛；localhost 访问国际认证 API 返回网络不可用，因此没有取得真实升级中状态的视觉截图。用户截图与组件测试覆盖了修复前问题和预期结构，但不等同于登录态浏览器实测。

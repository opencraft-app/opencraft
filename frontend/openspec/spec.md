# Agent 控制台左侧导航视觉升级规格

> 当前需求：参考 `lightvela-next-figma.zip` 与截图，仅升级 `/agents/*` 控制台左侧导航样式。

## 实现策略

- 入口仍复用 `frontend/src/pages/marketing/agent-settings-page.tsx`，只调整左侧 `<aside>`、Agent profile 和 `<nav>` 的 class 与局部交互结构。
- 左侧导航以 `origin/master` 的 `settingsSections` 为能力基线：通道、模型、技能、人设、自动任务、记忆、成就、云存储、对话（条件）、诊断中心，以及隐藏工具开关下的终端/浏览器都必须保留。
- 原 profile 中的重启 / 删除快捷按钮改为更多菜单，菜单项仍调用 `setShowRestartConfirm` / `setShowDeleteConfirm`，禁用条件沿用 master。
- 样式只新增 `/agents` 左侧导航相关 scoped class：`lv-agents-sidebar`、`lv-agent-*`、`lv-agents-nav*`；不覆盖 SDK 面板、记忆页或公开站点 header。
- 响应式仅保证左侧导航在窄屏下回到无右边框、网格导航的可读布局。
- 最新 master 的公测公告文档、docs route manifest、首页公告条和 sitemap 逻辑保持不动。

## 验证

- `pnpm i18n:extract` / `pnpm i18n:check`：新增“更多操作”文案后字典完整。
- `pnpm check`：类型检查通过。
- 本地 Next 预览 `/agents/channels/` 和 `/agents/memory/` 返回 200，确认非左栏区域没有因撤销而破坏渲染。

## 已合入 master 的相关基线

- 诊断中心 Agent 备份与恢复交互优化已在 `origin/master` 中实现；本分支只在其基础上保留左侧导航视觉升级，不修改备份/恢复业务逻辑。

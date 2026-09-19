## stage
用户反馈国际站 `/agents` 根路由仍有品牌边框；原 MR !4268 已合并，正在从最新 `origin/master` 准备独立补丁 MR。

## verified
- 具名 Agent 页面在无 Bot 状态移除品牌区域右、下边框；`/agents` 和已有 Bot 状态沿用默认样式。
- 聚焦测试 9/9、`pnpm check` 和 `pnpm build:cn` 通过。
- 5174 由此 worktree 的 `next-server` 提供，国内站 `/agents/channels/` 返回 HTTP 200；Codex 内置浏览器本地页面加载 `/_next/static/` 开发资源，已有 Bot 页面保留边框。
- 定时任务弹窗高度修复亦已合入此 worktree；Chrome 本地预览在 1728×936 视口实测为 800px，「高级设置」完整可见且可展开；两处改动的聚焦测试 199/199、`pnpm check` 和 `pnpm build:cn` 通过。
- 文档校验和 `git diff --check` 通过。
- 基于最新 `origin/master` 后，两组聚焦测试 199/199、`pnpm check`、`pnpm build:cn`、文档校验和 `git diff --check` 通过。
- 工蜂 MR !4268 源分支 `codex/empty-agent-brand-frame` 指向 `master`；创建后回查 `merge_status=can_be_merged`，提交检查为 `pending` 且阻塞合并。
- 2026-09-19 根因确认：无边框 class 额外依赖 `Boolean(initialSectionSlug)`，因此排除了国际站截图中的 `/agents` 根路由；已改为由同一无 Bot 守卫直接控制，并保留加载、创建和已有 Bot 状态。
- 更新后的聚焦测试 2/2 通过；首次 Vitest 启动被本机 `localhost` DNS 失败挡住，临时使用 `--api.host 127.0.0.1` 后通过，未修改仓库配置。
- 远端回查确认 MR !4268 已合并，merge commit 为 `58596b81d`，提交检查成功；新补丁分支 `codex/empty-agent-root-brand-frame` 基于 `origin/master` 的 `3bc843130`。
- 根路径补丁与原弹窗回归测试合计 199/199 通过，`pnpm check` 通过且新增 TypeScript 诊断为 0，`pnpm build:global` 通过并生成 649 个静态页面。

## unverified
- 本地国际站 `127.0.0.1:5174` 未携带 `lightvela.ai` 登录态，只能看到登录页；未取得无 Bot 状态的本地视觉截图。用户提供的国际站 `/agents` 截图确认了修复前问题。
- 全套测试有多模块失败并在 worker 停滞后中止。

## discard
- 构建产生的 `frontend/next-env.d.ts` 和字体生成物已恢复。

## restore
- 工作目录 `/Users/pablozhong/codex/lightvela-empty-agent-brand-frame`，分支 `codex/empty-agent-brand-frame`。
- 原始工作区和上一个定时任务弹窗 worktree 保持原状。

## next_action
- 完成提交前检查后创建独立补丁 MR，再回查远端提交与 CI；尚未发布。

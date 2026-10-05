## stage
国际站 Bot 头像状态与两站卡片高度改动已完成，待本轮验证、MR 交付和已登录浏览器视觉验收。

## verified
- 国际站与国内站共用的侧栏 JSX 已改为统一显示头像角标；运行中不渲染第二行状态。
- 本轮轻量侧栏测试 45/45、`pnpm check`、国内与国际站构建、OpenCraft 同步检查通过；文档验证退出码 0。
- 本地国际站 5174 预览返回 HTTP 200；Chrome 仅见登录门禁，预览服务已停止。
- 工作树在 `/Users/pablozhong/.codex/worktrees/global-bot-status-avatar/lightvela`，不含主检出的未提交工作。

## unverified
- 页面挂载测试因测试进程内存持续增长未执行断言，新增用例未纳入提交。
- 未在已登录国际站浏览器中看到改动后的真实侧栏。

## discard
- 构建生成的 `frontend/next-env.d.ts` 改动已恢复。

## restore
- 关键文件：`frontend/src/pages/marketing/agent-settings-page.tsx`、相邻测试与本 Task Pack。
- 用户已授权本任务在独立工作树 commit、push 和提 MR；主检出原有大量无关改动。

## next_action
运行聚焦测试与前端门禁，复核 diff 后创建分支、提交、推送、提 MR 并核验远端。

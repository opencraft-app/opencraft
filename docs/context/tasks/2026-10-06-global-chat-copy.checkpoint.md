## stage
- 已将英文 Chat 导航分组标题调整为 `Chats`；前端复查及国际站构建复跑通过。用户已授权将工作区改动提交 MR。

## verified
- 国际站 Chat 导航、Bot 卡片、删除弹窗及设置通过 `frontend/src/i18n/generated/en-US.json` 翻译。
- `frontend/scripts/i18n-apply.mjs` 已写入 20 条英文译文；OpenCraft 上游副本已同步。
- 后续按用户决定将 `对话` 英文译文从 `Chat` 改为 `Chats`；OpenCraft 上游副本再次同步且只读检查通过。
- `opencraft/apps/workbench-web/src/app.tsx` 的 `/new` 说明已为 `New chat`，嵌入式根组件复用该 App。
- 前端 `pnpm check`、4 个聚焦测试文件、`pnpm build:global` 通过；OpenCraft 的同步/i18n/typecheck/聚焦测试和嵌入式构建通过。
- 暂存变更的 change-impact 检查和全仓文档校验通过；验证后已取消暂存。
- `Chats` 调整后的 `pnpm check`、`pnpm build:global` 及 OpenCraft 同步/i18n 检查通过；构建自动修改的 `next-env.d.ts` 已还原。

## unverified
- 登录态浏览器实页显示。
- 前端全量测试通过：本轮出现多个其他模块失败和 Node heap OOM，已中断。
- 后续增测 Labs 导航文件时 Vitest worker 再次 OOM；其他 4 个聚焦文件的 123 个测试通过。

## discard
- 旧主检出中的前端文件；它比当前 `origin/master` 旧且已有大量其他未提交修改。

## restore
- 工作区：`/Users/pablozhong/.codex/worktrees/global-chat-copy/lightvela`，基于 `origin/master` 的 `717a4d315`。
- Task Pack：`docs/context/tasks/2026-10-06-global-chat-copy.md`。

## next_action
- 在 `codex/global-chat-copy` 提交、推送并创建 MR；合并与发布仍需单独授权。

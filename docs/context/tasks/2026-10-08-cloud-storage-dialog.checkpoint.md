## stage
按用户最新反馈，云存储外层弹窗恢复默认蒙层，待提交并更新现有 MR !5104。

## verified
- 冲突涉及 `sidebar-user-menu-controller.tsx`、`sidebar-user-menu.tsx`、`user-avatar-menu.tsx` 和 `agent-settings-page.tsx`；合并后同时保留云存储弹窗和 `master` 的续费提醒。
- `pnpm check`、`pnpm build:cn`、OpenCraft 同步只读检查和 `git diff --cached --check` 通过。
- 6 个相关测试文件共 124 项，122 项通过；`user-avatar-menu.test.tsx` 中 2 项旧“模型入口”断言失败，`origin/master` 的菜单源码与测试也存在相同不一致。
- 完整 Vitest 已启动，但运行至后段时 worker 内存耗尽，未获得全量通过结果。
- 本轮浏览器预览确认：云存储外层恢复 `rgba(13, 21, 48, 0.38)` 和 `blur(12px)` 默认蒙层，文件列表正常显示。前一轮打开删除确认后已取消，未删除文件。
- 本轮 `pnpm check`、`pnpm build:cn`、2 个相关测试文件共 38 项、OpenCraft 同步检查与 `git diff --check` 通过；本地 5174 返回 HTTP 200。

## unverified
- 远端 MR source commit、冲突状态与 CI 待推送后核验。

## discard
- 测试使用的临时 Vitest 配置已删除；构建生成的 `next-env.d.ts` 和字体变化已恢复。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/cloud-storage-dialog/lightvela`，分支 `codex/cloud-storage-dialog`，MR !5104。
- 合并目标为 `origin/master` 的 `ce4e9dafa`；四处冲突采用保留双方功能的最小合并。

## next_action
- 核对恢复后的浏览器预览，提交并推送本轮变更，核对 MR !5104 的远端状态。

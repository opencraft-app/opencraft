## stage
云存储弹窗的桌面高度已缩至视口的 85%，待更新现有 MR !5104。

## verified
- 国内站本地预览在 932px 高视口下，弹窗高度约 792px；内容区可滚动到底部，无横向溢出。
- `pnpm check`、`pnpm build:cn`、OpenCraft 同步只读检查和 `git diff --check` 通过。
- 5174 国内站开发服务已在构建后恢复。

## unverified
- 远端 MR source commit 与 CI 状态待推送后核验。

## discard
- 构建生成的 `next-env.d.ts` 和字体变化已恢复。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/cloud-storage-dialog/lightvela`，分支 `codex/cloud-storage-dialog`，MR !5104。
- 调整仅位于 `frontend/src/components/site/sidebar-user-menu-controller.tsx` 的云存储 Dialog 最大高度。

## next_action
- 提交并推送高度调整，核对 MR source commit，重新打开本地预览弹窗。

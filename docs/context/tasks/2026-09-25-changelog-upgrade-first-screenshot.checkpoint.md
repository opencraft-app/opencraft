## stage
- MR !4666 首次 CI 的 OpenCraft 生成物检查失败；已同步 manifest 并通过本地只读检查，准备更新 MR。

## verified
- 前序 MR !4664 已合并；本轮基于 `origin/master@f3d40ccf3` 的新分支开发。
- 国内与国际站升配页截图各一张，未截入用户标识或 URL 查询参数。
- 55 项聚焦测试、`pnpm check`、国内站与国际站构建、OpenCraft closure 检查通过。
- 附件 CI 日志中 frontend 阶段通过，OpenCraft 报 `vendored mono2 manifest drifted`。本地复现后官方同步仅刷新 `UPSTREAM.json.sourceRevision`，130 个文件内容无变化，复验通过。

## unverified
- 修复提交推送后的远端 MR 与 CI 状态待核对。

## discard
- 前序 Task Pack 中「升配第三条且无图」的旧验收目标。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/overview-news-month-year/lightvela`；分支：`codex/changelog-upgrade-first-screenshot`。
- 图片：`frontend/public/assets/changelog/lightvela-plan-upgrade-cn.png`、`lightvela-plan-upgrade-global-en.png`。

## next_action
- 完成 staged 检查、提交并推送生成物修复，核对 MR 和新 CI 快照。

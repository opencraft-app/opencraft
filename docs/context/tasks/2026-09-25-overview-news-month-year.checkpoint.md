## stage
- 用户要求把概览第 3 条改为订阅升配；正在更新现有 MR !4664。

## verified
- 来源为截图红框的「最新动态」卡片日期，非顶部权益到期日。
- `LatestNewsSection` 依 locale 格式化年月；Changelog 分组仅提供年月，未编造具体日。
- 原 MR 展示多个 Bot、通知/脚本任务、实例存储空间；现在按用户要求以订阅升配替换第 3 条。
- 升配文案从 Changelog 页抽出共用，概览无配图；概览与 Changelog 聚焦测试 54 项通过。
- `pnpm check` 通过（171 条既有、0 新增 TypeScript 诊断），`pnpm build`、`git diff --cached --check` 和 staged change-impact 检查通过。
- 原 MR 提交的 CI 为 failure/blocking，新提交推送后需重新核对。

## unverified
- 未在登录后的真实站点验证；本次使用组件测试核对年月、标题、说明和图片。

## discard
- 主检出旧分支和用户已有未提交改动均未作为修改目标；构建生成的字体文件差异已还原。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/overview-news-month-year/lightvela`，基于 `origin/master` 的 `791224baf`。
- 改动文件：`frontend/src/pages/marketing/agent-overview-panel.tsx`、`changelog-page.tsx`、共用升配文案、相邻测试及本 Task Pack。

## next_action
- commit、push 至现有 MR，确认远端 SHA 与新 CI 快照；不合并或发布。

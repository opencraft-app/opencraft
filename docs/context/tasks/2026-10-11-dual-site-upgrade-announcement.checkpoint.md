---
id: task-dual-site-upgrade-announcement-checkpoint-20261011
type: task
scope: 双站系统升级公告发布检查点。
triggers: ["10 月 11 日系统升级公告检查点"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-11-dual-site-upgrade-announcement.md
status: active
reviewed_at: 2026-10-11
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---

## stage

本地实现与验证完成；下一道门禁是提交、工蜂 MR 和双站正式发布。

## verified

- 新公告 ID、10 月 12 日 06:00（UTC+8）到期时间及双站文案已写入组件。
- 8 个语种翻译均已补齐，i18n 检查通过。
- 相关 48 项测试、`pnpm check` 和国内/国际构建通过。

## unverified

- 远端分支、MR、CI、生产构建与两站线上显示。

## discard

- 主仓有大量其他未提交改动，不能在其中提交本次工作。
- 单独 `pnpm typecheck` 在文档生成前缺少 `collections/server`；完整 `pnpm check` 生成后通过。

## restore

- 工作树：`/Users/pablozhong/.codex/worktrees/oct-upgrade-announcement/lightvela`。
- 分支：`codex/oct-upgrade-announcement`，基于 `980056ee5`。
- frontend 没有 `lint` 脚本；已执行并确认命令不存在。

## next_action

检查并暂存本次 diff，运行 change-impact 门禁，然后提交并创建 MR。

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

本地实现与验证完成，工蜂 MR !5191 已创建；下一道门禁是 CI、合并和双站正式发布。

## verified

- 新公告 ID、10 月 12 日 06:00（UTC+8）到期时间及双站文案已写入组件。
- 8 个语种翻译均已补齐，i18n 检查通过。
- 相关 48 项测试、`pnpm check` 和国内/国际构建通过。
- 提交 `e88462a26` 已推送到远端，MR !5191 初次查询为 opened / can_be_merged。

## unverified

- MR CI、生产构建与两站线上显示。

## discard

- 主仓有大量其他未提交改动，不能在其中提交本次工作。
- 单独 `pnpm typecheck` 在文档生成前缺少 `collections/server`；完整 `pnpm check` 生成后通过。

## restore

- 工作树：`/Users/pablozhong/.codex/worktrees/oct-upgrade-announcement/lightvela`。
- 分支：`codex/oct-upgrade-announcement`，基于 `980056ee5`。
- frontend 没有 `lint` 脚本；已执行并确认命令不存在。

## next_action

确认 MR CI 状态并准备双站正式发布。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本轮双站 10 月 11 日 22:00 至次日 06:00 升级公告请求；详见同名 Task Pack。

## interface_refs / data_structure_refs

- `frontend/src/components/site/maintenance-announcement-banner.tsx` 的公告 ID、文案和过期时间。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：本次复用 9 月 23 日系统升级公告机制。
- `superseded_refs`：无。

## context_receipt

- 已读取的 Context 清单见同名 Task Pack。

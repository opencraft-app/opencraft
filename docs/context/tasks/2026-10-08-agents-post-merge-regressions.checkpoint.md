---
id: agents-post-merge-regressions-checkpoint
type: task
scope: Recovery state for the MR !5097 follow-up.
triggers: ["agents post merge checkpoint", "agents renewal checkpoint", "agents redirect checkpoint"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-08-agents-post-merge-regressions.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## stage
!5099 已创建；首开无痕 Bot 头像切换修复已实现并通过聚焦测试、类型检查与双站构建，待追加提交和远端核验。

## verified
- !5097 已合入 `master`，merge commit `3fa43b017`；独立干净 worktree 已基于当前 `origin/master` 建分支。
- 无 Bot 的过期用户在 `/agents` 与 `/agents/chat` 之间的页面和权益门禁条件相互冲突。
- 桌面多 Bot 隐藏旧 Bot 卡片时，卡片内的临期续费提示与重启错误一并消失。
- 初跑 5 个测试文件，85 条中 16 条失败；国际站续费测试含缺失 `useCurrentLocale` mock。
- 无 Bot 跳转新增双站用例先红后绿；恢复临期续费到桌面账户入口，并在竖栏管理菜单恢复重启错误提示。
- 旧导航测试已迁移到 Bot 管理菜单；删除中不可重复提交、失败可重试断言仍在。最终聚焦合集 6 个文件 96 条通过。
- `pnpm check` 通过（0 新增 TypeScript 诊断）；文档校验、staged change-impact 和 OpenCraft 同步检查通过；国内和国际站最终构建均通过。
- 用户报告 Chrome 无痕首次打开无法切换 Bot，刷新后正常；正常 Chrome 可切换。未选中头像现为原生链接，避免依赖首屏客户端路由；有效 `?bot=` 驱动选中态，修复旧 URL 回写竞态。最终聚焦 5 文件 101 条通过，双站构建和 `pnpm check` 通过。
- Context catalog 全量检查被历史 Task Pack 元信息缺项阻塞；本次新文件被提示的字段已补齐，需复核新文件不再产生缺项。

## unverified
- 本次追加提交后的远端 MR 与 CI 快照；修复尚未做生产站验收。

## discard
- 不把用户提供的复审结论当作无需验证的源码事实。

## restore
- Task Pack：`docs/context/tasks/2026-10-08-agents-post-merge-regressions.md`；失败日志：`/tmp/agents-post-merge-red-tests.log`；最新门禁日志：`/tmp/agents-post-merge-*`。

## next_action
- 核对 staged diff 与 change-impact，追加提交并推送现有 !5099；核验远端 SHA 和即时 MR 状态。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids: !5097 post-merge follow-up；requirement_refs: `wiki/prd-docs/2026-10-08-agents-bot-rail.md`；requirement_excerpt: 无 Bot 停留入口、临期续费保留账户入口。

## interface_refs / data_structure_refs
- interface_refs: `AgentSettingsPage`、`NextAgentEntitlementGate`；data_structure_refs: `PassExpiryReminder`。

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution: !5097 merge commit `3fa43b017`。
- superseded_refs: none。

## context_receipt
- 实际阅读的上下文清单见同名 Task Pack 的 `context_receipt`。

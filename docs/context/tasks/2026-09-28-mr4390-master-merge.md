## goal

在 MR !4390 的源提交 `eb60cdefa73f2e70b776bc467f49a570029220a0` 上合并最新 `origin/master`，保留 MR 的侧栏与账号菜单范围，并完成提交前检查。

## non_goals

- 不处理原始脏 worktree 中其他任务的改动。
- 不创建 commit、push 或创建/更新 MR。
- 不改变生产、GitOps 或外部服务。

## requirement_refs

- MR !4390: `https://git.woa.com/wisp/mono2/-/merge_requests/4390`
- MR 当前源提交：`eb60cdefa73f2e70b776bc467f49a570029220a0`

## history_context

- MR 描述要求保留 Agents 左侧导航与账号菜单，正文业务逻辑跟随 master。
- MR 文件范围由 Gongfeng API 确认共 39 个文件。

## acceptance

- `origin/master` 已刷新到当前远端提交。
- 合并结果无未解决冲突。
- 运行受影响前端与 OpenCraft 生成物的必要检查。
- 不生成 commit、push 或 MR 写操作。

## affected_paths

- `frontend/src/components/site/`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/i18n/generated/`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`
- `docs/context/.context/catalog.jsonl`

## required_context

- `tapd-gongfeng-delivery`
- `docs/context/flows/tapd-gongfeng-delivery.md`
- `.agents/skills/gongfeng/SKILL.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付与写操作门禁 | 约束提交、push、MR 授权 |
| `.agents/skills/gongfeng/SKILL.md` | Gongfeng MR 查询 | 查询 MR 当前源提交和文件范围 |

## evidence

- `git fetch origin master`：`origin/master=2abb7cdae899073537aee39f6507fe17dc89c0ee`
- `get_merge_request_changes`：MR !4390 共 39 个文件。

## risks

- `agent-settings-page.tsx` 与账号菜单存在 master/MR 交叉修改，需要保留 MR 布局并纳入 master 业务逻辑。
- OpenCraft 生成副本需与最终 frontend 源保持一致。

## validation

- `git diff --check`
- `frontend/pnpm check`：通过，TypeScript `171 current, 171 baseline, 0 new, 0 resolved`
- 受影响 frontend 测试：5 个文件、98 个用例通过
- `opencraft/npm run check:mono2-agent-console`：通过，130 个文件一致
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，无错误或断链
- `agent-settings-renewal-reminder.test.tsx`：7 个用例因 Vitest 不能加载依赖包 `.css` 扩展失败，错误来自 `@tencent/agentchat-claw-panel` 导入

## decisions

- 采用干净 worktree，避免覆盖原 worktree 的 1906 个其他任务改动和 12 个遗留冲突。
- 使用 `git merge --no-commit --no-ff origin/master`，把提交动作留给用户确认。

## handoff

- 当前阶段：合并结果已暂存，冲突已全部解决，未创建 commit。
- 下一步：用户确认后完成 merge commit、push 和 MR 更新；当前不执行这些写操作。

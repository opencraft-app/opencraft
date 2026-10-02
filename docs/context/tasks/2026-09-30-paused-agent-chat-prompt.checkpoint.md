## stage
MR !4872 已在隔离工作树本地合入 `origin/master@b42d361c7` 并解决冲突；待用户明确授权提交和推送。

## verified
- Agent 实例暂停时聊天区显示现有暂停文案且隐藏重新连接按钮；Bot 自身暂停不会误触发该提示。
- 两个聚焦测试文件 90/90、`pnpm check` 与收紧状态判定后的 `pnpm build` 均通过。
- 改动路径未命中 change-impact 规则。
- 附件日志与本地 `check:mono2-agent-console` 同报 `sourceRevision` 从 `2a65b0388` 漂移到 `c4a076faa`；这是本次 CI 的退出码 1 原因。
- 已先后合并 `origin/master@3e8d3f690` 与 `da1f500cb`。新版同步脚本只追踪 vendored 源文件，当前 manifest 修订号为 `2a65b0388`；`check:mono2-agent-console` 与 `test:embedded-ci`（142/142）通过。
- 合并后前端 `pnpm check`、聚焦 90/90、guard 测试 130/130、CN/global build 通过。
- 二次合并后前端 `pnpm check`、合计 221/221 测试、CN/global build 再次通过。
- 2026-10-02 当前合并结果保留主线 `submitPrompt` 模板投递和草稿生命周期；暂停提示覆盖连接提示、隐藏重连，恢复后仍使用同一嵌入元素和草稿。
- 本轮前端聚焦测试 145/145、`pnpm check`、`pnpm build`；OpenCraft embedded CI 155/155、Web typecheck、Web build、130 文件生成检查；diff check 和文档检查均通过。

## unverified
- 全量测试未通过：`localhost` 解析错误后以 `127.0.0.1` 重试，多个无关测试失败，随后停止。
- 未在真实暂停 Agent 账号上做线上验证。
- OpenCraft 完整 `npm run gate` 在 `test:extensions` 测试输出后长时间未退出，已停止；最终 MR CI 尚未重新运行。
- 本轮前端全量 `pnpm test` 有多个未触及模块失败，并有 worker 达到约 4 GB 内存上限；已停止，不记为通过。
- 当前未提交的 merge 状态下，生成脚本沿旧 HEAD 计算 `sourceRevision`；提交合并后需要再次同步并校验生成清单。

## discard
- 构建生成的 `frontend/next-env.d.ts` 改动已还原。
- 旧版 `opencraft-embedded-workbench.test.tsx` 的用例已经随主线迁移到 `.cn.test.tsx`，不保留旧文件。

## restore
- 独立工作树：`/Users/pablozhong/.codex/worktrees/paused-agent-chat-mr4872/lightvela`，分支 `codex/paused-agent-chat-prompt`，本地 merge 未提交。
- 相对主线的变更仅为聊天承载组件、父页面状态传递、聚焦测试、生成清单及本 Task Pack。

## next_action
取得提交/推送授权后完成 merge commit，重新同步生成清单并验证，然后推送并核对 MR source SHA、冲突状态与 CI。

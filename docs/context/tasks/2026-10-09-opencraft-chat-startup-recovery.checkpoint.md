## stage
修复已提交至 MR !5132；合入最新 master 后补齐马来语译文，远端分支与 MR 源提交一致。

## verified
- Firefox 现场模块加载超时后，强制刷新恢复；原“重新连接”未恢复该现场。
- 当前 OpenCraft 宿主代码将启动失败和连接失败共用一个按钮；模块加载器自身有 30 秒超时。
- 聚焦恢复测试 4/4 通过；`pnpm check` 和 `pnpm build` 通过，类型检查新增诊断 0 项。
- 文档校验和 `git diff --check` 通过。
- 合入 master 后聚焦恢复测试 4/4、`pnpm check`、`pnpm build`、OpenCraft 同步检查通过；MR 返回 `can_be_merged`。

## unverified
- 完整 `pnpm test` 中途出现多个失败后，Vitest worker 持续高 CPU 且无新输出，已中断；不能认定全量通过。
- MR 提交检查仍为 pending，当前仅见占位检查；尚未通过远端 CI。
- 真实生产发布后的跨浏览器回归。

## discard
- 旧工作区 `AgentChatPanel` 的连接实现，与当前 OpenCraft 生产入口无关。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/chat-module-recovery/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-09-opencraft-chat-startup-recovery.md`。

## next_action
- 等待 MR !5132 的远端 CI 与评审；合并、发布和生产回归尚未执行。

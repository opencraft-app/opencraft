## stage
已完成本地实现和可完成的验证门禁；用户已授权提交 MR，正在提交前端真源、同步 OpenCraft 生成副本并核验远端状态。

## verified
- Firefox 现场模块加载超时后，强制刷新恢复；原“重新连接”未恢复该现场。
- 当前 OpenCraft 宿主代码将启动失败和连接失败共用一个按钮；模块加载器自身有 30 秒超时。
- 聚焦恢复测试 4/4 通过；`pnpm check` 和 `pnpm build` 通过，类型检查新增诊断 0 项。
- 文档校验和 `git diff --check` 通过。

## unverified
- 完整 `pnpm test` 中途出现多个失败后，Vitest worker 持续高 CPU 且无新输出，已中断；不能认定全量通过。
- OpenCraft 同步检查检测到生成 locale 副本漂移；按仓库要求先提交前端真源，再同步副本并复验。
- 真实生产发布后的跨浏览器回归。

## discard
- 旧工作区 `AgentChatPanel` 的连接实现，与当前 OpenCraft 生产入口无关。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/chat-module-recovery/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-09-opencraft-chat-startup-recovery.md`。

## next_action
- 提交前端真源，运行 OpenCraft 同步和检查，提交生成副本，推送并创建 MR；核验远端分支、MR 和 CI。

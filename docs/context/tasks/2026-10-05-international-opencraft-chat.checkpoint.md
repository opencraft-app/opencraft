## stage
已同步远端 master 并解决一处文本冲突，准备提交 MR 供 Owner 审查。

## verified
- 隔离工作树已从初始 `origin/master@996b23c13` 同步到 `origin/master@ebba1eacf`；原检出分支未触碰。合并保留新版双站会话分页和国内站侧栏状态改动。
- 国际站与国内站共用 OpenCraft Chat，旧 AgentChat 面板和启动 token 从对话页移除；国际站仅在控制台执行 `show()` 后显示 Chat 入口和工作台，再次执行可隐藏，国内站继续默认展示。
- 宿主当前语言传给内嵌工作台，语言切换调用 `setLocalization()`，不重建会话元素。
- 同步后 Chat 与会话分页聚焦测试 76/76、`pnpm check`、双站构建、OpenCraft 生成副本检查、文档链接检查通过。

## unverified
- 真实国际站账号下的发送、历史会话、文件预览、手机软键盘交互。
- 全量测试未通过：其他套件失败并触发 Node 堆 OOM；续费提醒等旧断言单独运行仍失败。

## discard
- 原工作区未提交改动与旧国际 AgentChat 分流假设。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/international-opencraft-chat/lightvela`，任务记录 `docs/context/tasks/2026-10-05-international-opencraft-chat.md`。

## next_action
- 提交 MR 后核对远端分支、MR 和 CI 状态；真实会话与移动端交互仍需有权限的国际站测试账号验证。

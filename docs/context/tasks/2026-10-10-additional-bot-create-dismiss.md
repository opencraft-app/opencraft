# 再次创建 Bot 可退出

## goal
首次创建无高级和关闭；已有 Bot 的再次创建可在提交前关闭。

## non_goals
不取消已开始的后端创建，不改变鉴权、订阅和 Bot 配置流程，不发布。

## requirement_refs
用户 2026-10-10 截图与本轮请求。

## context_receipt
frontend 服务 pack、site-environment-routing、frontend/AGENTS.md、frontend/DESIGN.md、frontend-runtime-openspec-i18n 邻接及 agent-create-bot-paths / agent-settings-create-intent 测试。

## history_context
当前源码 cloneOptions 仅已有来源时显示高级；AgentOnboardingPanel 无退出 prop。截图的 3D 头像与当前 worktree 的 GeometricAvatar 不同，本次仅修改共用创建行为。初始路由查询无匹配，第一次 agent-create-bot 文件搜索失败后按文件清单定位。

## acceptance
首次没有关闭/高级；再次关闭不调用 addBot，保留 bot 查询参数并删除 newBot；创建阶段不可误取消。

## affected_paths
frontend/src/pages/marketing/agent-onboarding-panel.tsx、agent-settings-page.tsx 及相邻测试。

## validation
聚焦创建流程回归、pnpm check、构建。

## checkpoint
verify：补表单关闭 prop 与有来源时的清除 URL 回调；尚未提交发布。

## evidence
- 聚焦创建流程 18 项通过：/tmp/lightvela-create-dismiss-tests.log。首次无高级/关闭，再次关闭不调用 addBot 且保留当前 bot 参数。
- i18n/文档门禁通过；新增测试的 exact 参数类型问题已修复，最新类型门禁单独复核。
- 国内构建通过：/tmp/lightvela-create-dismiss-build.log；git diff --check 通过。
- 未提交、推送或发布；截图的 3D 视觉未在当前几何头像实现中改动。

## checkpoint
交接：可关闭入口仅传给有可复制已有 Bot 的创建表单；进入创建流程后仍保留原来的恢复保护。

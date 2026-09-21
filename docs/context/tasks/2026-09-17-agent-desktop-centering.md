# 双站 Agent 桌面内容居中

## goal
国内、国际站固定侧栏右侧的公共配置内容，在剩余可用宽度内居中。

## non_goals
- 不改首页、字号、业务逻辑、移动端布局或生产环境。

## requirement_refs
用户本任务确认：国内国际双站都需要；参考固定左侧栏、右侧响应式居中。

## history_context
当前样式限制外层最大 1760px 且左对齐，内层已有 1280px 居中。大屏外层封顶导致右侧空白。

## acceptance
- 外层占满可用宽度；侧栏保持 264px；右侧两端 gutter 均为 24px。
- 内层保持 1280px 上限，随可用宽度收缩；共享 loading 布局同步。
- 双站共用 CSS，不引入地域分支。

## affected_paths
- frontend/src/styles.css
- frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts

## context_receipt
- docs/context/domains/site-environment-routing.md：双站独立交付边界。
- docs/context/project/services/frontend.md、frontend/AGENTS.md：服务验证规则。
- docs/context/project/adjacency/frontend-runtime-openspec-i18n.md：相邻测试。
- frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts：共享 shell/loading 回归。

## decisions
只移除外层上限；保留既有内容宽度，避免放大表单。使用父容器百分比而非 vw 避免滚动条宽度影响。

## validation / checkpoint
实现完成。国内与国际环境各运行 agent-settings-nav-spacing.test.ts，均 7/7 通过；git diff --check 通过。pnpm lint 不存在（无该 script），类型检查进程仍运行中，尚无结果。未完成登录态浏览器视觉验收或完整 build，不宣称全量门禁通过。change-impact --staged 通过但暂无 staged 文件。无发布授权，不提交、不发布。

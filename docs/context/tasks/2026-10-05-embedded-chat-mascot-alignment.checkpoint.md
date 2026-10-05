## stage
嵌入 Chat 空状态插画对齐修复完成，等待交接。

## verified
- 实际标题由 `NewThreadDraftPage` 渲染，紫线与插画分别是同一 h1 的 `::before`/`::after`。
- 原插画固定 `top:-16px`，标题字号从 32px 缩到约 25px 时，插画不会随标题底边上移。
- 插画改为 `top:calc(100% - 54px)`；在隔离 Chromium 中用本次构建 CSS 验证窄/宽视口，宽屏位置几乎不变。
- OpenCraft 聚焦测试、Workbench Web 类型检查和构建通过；文档与 diff 检查通过。

## unverified
- 未在用户登录的实际国际站 Agent Chat 中验证；本地构建不等于生产部署。

## discard
- 未采用以某一截图像素为准的窗口宽度特例；改用与标题底边一致的几何来源。

## restore
- worktree：`/Users/pablozhong/.codex/worktrees/homepage-heading-typography/lightvela`，与之前首页/侧栏任务的未提交改动共存。
- 本轮源码：`opencraft/apps/workbench-web/src/styles/app.scss`；正式设计：`docs/engineering/domains/agent-gateway-runtime.md`。

## next_action
- 交接本地修改；提交、推送或发布需用户明确指令。

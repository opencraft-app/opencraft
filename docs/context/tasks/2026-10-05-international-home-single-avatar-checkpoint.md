## stage
登录态头像去重已实现并完成聚焦验证；待用户决定是否提交后续交付。

## verified
- 国际首页只挂载一个 `PublicHeaderAuthIsland`。
- 头像组件原来在登录态桌面与移动分支各创建一次。
- 首页相关 Vitest 3 文件 101/101 通过，新增断言要求登录态头像节点只有一个、产品入口仍区分移动端埋点。
- `pnpm check`、国际站与国内站构建、文档校验、`git diff --check` 均通过。

## unverified
- `pnpm test` 全量运行出现多个其他文件失败与 worker OOM，中止后仍需在独立环境调查。
- 实际生产站导航截图需发布后验证，本轮未获发布授权。

## discard
- 首页静态片段重复挂载 auth island 的猜测；源码只有一个挂载点。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/homepage-heading-typography/lightvela` 含此前任务未提交改动，不要覆盖。
- 本任务改动 `frontend/next-site/public-header-auth-island.tsx` 与对应测试。

## next_action
- 保持本地工作树，等待后续明确的提交或发布指令。

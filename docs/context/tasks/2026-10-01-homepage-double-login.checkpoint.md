## stage
本地修复与验证已完成，用户已授权提交 MR，待远端核验。

## verified
- `loginOnly` 匿名入口在 DOM 中保留一个响应式登录按钮。
- 组件和首页渲染测试 56/56 通过；`pnpm check` 无新增 TypeScript 诊断。
- 国内站本地桌面和手机预览各只见一个登录按钮，手机点击可打开登录弹窗。
- 文档完整性与 `git diff --check` 通过。

## unverified
- 未用真实账号重走生产退出登录链路，未合并或发布。

## discard
- 线上匿名直达首页的单按钮结果不能替代退出后回跳验证。

## restore
- 隔离工作区：`/Users/pablozhong/.codex/worktrees/homepage-double-login/lightvela`，基线为 `origin/master` 的 `48905e3f83137bd19a451a5c05b03b22cd34d7b8`。
- 主工作区有大量用户既有改动，勿在其中覆盖或整理文件。

## next_action
- 核对隔离工作区差异，提交并核验工蜂 MR。

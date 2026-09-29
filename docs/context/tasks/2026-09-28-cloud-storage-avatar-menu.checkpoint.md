## stage
完成；已通过交接前验证。

## verified
- `/agents` 的 `manage` 组已移除 `files` 导航项，路由与页面分支未修改。
- 左下角 `UserAvatarMenu variant="sidebar"` 仅在点击时展开，并将云存储置于套餐与费用之前。
- AI 套餐和标准套餐的菜单顺序、`bot` 查询参数传递均由 51 项定向测试覆盖。

## unverified
- 未运行真实登录态浏览器预览；组件测试已覆盖菜单 DOM、可访问状态与路由。

## discard
- 主工作区的既有未提交变更不属于本任务；未改动。

## restore
- 隔离工作区：`/Users/pablozhong/.codex/worktrees/cloud-storage-avatar-menu/lightvela`。
- 变更文件见同名 Task Pack 的 `affected_paths`。

## next_action
等待用户决定是否提交或创建 MR。

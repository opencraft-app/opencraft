## stage
已完成代码、聚焦测试、双站构建及文档门禁；准备交接。

## verified
- 顶部与头像菜单共用资格判断；已确认有有效或历史套餐时不等待 Bot 列表。
- 仅 Bot 可证明资格时继续等待列表完成且成功。
- MR !5052 CR 后的正式设计文档明确：套餐资格已确认但 Bot 列表失败时入口仍显示，由 `/agents` 提供错误重试。
- 新增行为聚焦用例 6/6 通过；三文件聚焦测试 73/75 通过，两条失败在主线基线复现。
- `pnpm check`、双站构建、OpenCraft 同步检查、文档检查、change-impact 检查通过。

## unverified
- 全量 Vitest 未完成；单个高内存 worker 持续运行后中止。
- 本地没有用户登录态，未做真实首页加载时序的浏览器复测。
- 首页资源预算检查未通过，原因是生成首页脚本数量与体积超过既有预算。

## discard
- 最初工作区是 2026-09-11 的旧分支；本改动以 2026-10-07 的 `origin/master` 创建独立工作区。

## restore
- 工作区：`/Users/pablozhong/.codex/worktrees/homepage-agent-entry-loading/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-07-homepage-agent-entry-loading.md`。
- 不修改主工作区的既有未提交改动。

## next_action
- 复核最终 diff，提交 MR，并说明两项未通过的门禁。

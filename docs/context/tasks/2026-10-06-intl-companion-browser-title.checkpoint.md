---
id: task-2026-10-06-intl-companion-browser-title-checkpoint
type: task
scope: 国际站浏览器标题与 OpenCraft 内嵌标题所有权修复的交接检查点。
triggers: ["browser title checkpoint", "OpenCraft embed checkpoint", "international homepage checkpoint"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-06-intl-companion-browser-title.md
status: candidate
reviewed_at: 2026-10-06
review_due: 2026-11-06
revision: 1.0.0
precedence: task
derived: false
---

## stage
国际站标题统一与 OpenCraft 嵌入标题所有权修复已完成本地实现、测试和双站构建；准备提交 MR。

## verified
- 根因：OpenCraft `App` 卸载时曾无条件写入 `document.title = "OpenCraft"`。
- 国际站 `/`、`/agents/`、`/agents/chat/` 构建产物与本地 Chrome 均显示 `My AI Companion | LightVela`（Chrome 只核对 `/` 和 `/agents/`）。
- 国内站首页与 `/agents/` 构建产物保持中文标题；`/zh-sg/` 保持中文标题。
- 前端聚焦测试 49/49、OpenCraft 聚焦测试 4/4、前端 check、双站 build、OpenCraft Web typecheck 与 embed build 均通过。

## unverified
- 完整 `pnpm test` 已出现多处本次未改模块失败，并有 worker Node heap OOM；中止于 exit 130，不能视为通过。
- 本地认证服务不可用，未在真实登录后的 OpenCraft 嵌入聊天复现离开聊天的完整路径。
- 生产尚未更新，线上标题仍取决于后续发布。

## discard
- 最初关于缓存或浏览器扩展造成标题残留的推测；当前源码已定位 OpenCraft 卸载写入。

## restore
- 隔离工作树：`/Users/pablozhong/.codex/worktrees/intl-companion-page-titles/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-06-intl-companion-browser-title.md`。
- 主检出原有大量未提交改动未触碰。

## next_action
- 构建生成的 `frontend/next-env.d.ts` 已还原；提交并推送已验证改动，创建工蜂 MR，核对远端分支与 MR 状态。

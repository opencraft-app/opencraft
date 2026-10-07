## stage
国内站首页标题已修改，聚焦测试、双站构建及变更检查通过，等待交接。

## verified
- 首页 Next metadata 和国内站客户端 SEO 标题原先不同于 `/agents` 浏览器标题。
- `/agents` 中文标题来源为 `getAgentDocumentMetadata()`。
- 国内站构建产物：首页及 `/agents` 标题一致；首页 OG/Twitter 标题一致。
- 国际站构建产物：首页及 `/agents` 均保持英文原标题。
- SEO/页面标题测试 62/62 通过，`pnpm check` 与双站构建通过。
- OpenCraft 同步、文档和 change-impact 检查通过。

## unverified
- 真实站点需要发布后才能验证；本轮没有发布授权。

## discard
- 原首页标题“LightVela｜长期在线的云端 AI 伙伴”。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/homepage-agent-entry-loading/lightvela`，与首页入口加载修复一并提交 MR。
- 本任务文件：`docs/context/tasks/2026-10-07-cn-homepage-tab-title.md`。

## next_action
- 向用户交接本地改动与验证结果。

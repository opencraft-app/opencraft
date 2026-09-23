## stage
MR !4573 的 CI 修复中；撤回触发 opencraft guard 的额外共享文案调整，待复验并推送。

## verified
- 双站移动菜单显示语言切换；国际站繁体切西语时路由和演示语言同步。
- 四个聊天平台的多语言演示片段及繁体文本已更新，导入脚本同步维护译文。
- 定向测试、`pnpm check`、国内和国际构建通过。
- 全量测试中多处仓库现有失败；已确认韩语玩法卡失败源于 HEAD 原有文案。
- 首次 CI 的 frontend guard 全部通过；opencraft guard 在 CI 环境中因 `node: command not found` 失败。
- CI 触发范围修复后，CN / global 移动菜单聚焦测试通过，`pnpm check` 通过且新增 TypeScript 诊断为 0。

## unverified
- 未在生产环境验证，未触发发布；全量测试未形成完整通过结果；本次修复后的 CI 尚未运行。

## discard
- 早期未安装隔离工作树依赖导致的模块解析失败；依赖已在该工作树安装。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/homepage-mobile-locale-demo/lightvela`，分支 `codex/homepage-mobile-language-demo`；MR !4573 当前源 SHA `b4570dc36`。
- 主 checkout 保持原有状态。

## next_action
- 运行聚焦测试和 frontend check，确认差异不再包含 `frontend/src/**`，然后推送同一个 MR 并核验远端状态。

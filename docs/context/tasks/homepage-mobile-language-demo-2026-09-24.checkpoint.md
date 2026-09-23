## stage
两项首页 P1 修复已在隔离工作树完成；交接前复核完毕。

## verified
- 双站移动菜单显示语言切换；国际站繁体切西语时路由和演示语言同步。
- 四个聊天平台的多语言演示片段及繁体文本已更新，导入脚本同步维护译文。
- 定向测试、`pnpm check`、国内和国际构建通过。
- 全量测试中多处仓库现有失败；已确认韩语玩法卡失败源于 HEAD 原有文案。

## unverified
- 未在生产环境验证，未触发发布；全量测试未形成完整通过结果。

## discard
- 早期未安装隔离工作树依赖导致的模块解析失败；依赖已在该工作树安装。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/homepage-mobile-locale-demo/lightvela`，基于 `b2573c45a`。
- 主 checkout 保持原有状态；未提交、未推送。

## next_action
- 用户检查工作树改动；如需提交 MR，另行授权。

## stage
MR !4573 的 CR 修复已完成前端源码提交；Opencraft vendored 快照已同步，待提交并推送。

## verified
- 双站移动菜单显示语言切换；国际站繁体切西语时路由和演示语言同步。
- 四个聊天平台的多语言演示片段及繁体文本已更新，导入脚本同步维护译文。
- 定向测试、`pnpm check`、国内和国际构建通过。
- 全量测试中多处仓库现有失败；已确认韩语玩法卡失败源于 HEAD 原有文案。
- 首次 CI 的 frontend guard 全部通过；opencraft guard 在 CI 环境中因 `node: command not found` 失败。
- CI 触发范围修复后，CN / global 移动菜单聚焦测试通过，`pnpm check` 通过且新增 TypeScript 诊断为 0。
- 最新 master 已修复 opencraft guard 的 Node 初始化；CR 所指出的繁体菜单标签、渠道跑马灯、港式首屏用词与韩语旧测试均已处理。
- CN / global 聚焦测试各 56/56、`pnpm check`、双站构建及 Opencraft sync/check 通过；五份语言片段刷新幂等。

## unverified
- 未在生产环境验证，未触发发布；全量测试未形成完整通过结果；CR 修复后的 CI 尚未运行。Opencraft 插件额外 typecheck 因隔离工作树缺 npm 依赖而未运行。

## discard
- 早期未安装隔离工作树依赖导致的模块解析失败；依赖已在该工作树安装。
- 前一轮为避开缺 Node 的 guard 暂时撤回“中國站”文案；最新 master 已修好 guard，此方案废弃。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/homepage-mobile-locale-demo/lightvela`，分支 `codex/homepage-mobile-language-demo`；前端修复提交 `64c84be50`，其前已合入 `origin/master@d39c9352d`。
- 主 checkout 保持原有状态。

## next_action
- 提交 Opencraft 机械生成快照与本 Task Pack，推送同一个 MR，并核验远端 source SHA 与 CI。

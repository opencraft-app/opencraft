## stage
国际站语言提示已实现，进入 MR 提交与远端核验。

## verified
- 独立 worktree 基于 `origin/master` 的 `10491fb09`，主工作区未修改。
- 国际站默认首页保持英文；无已存选择且浏览器首选语言为已发布非英文版本时提示一次。
- 简体中文提示链接为 `/zh-sg/`；继续英文调用现有语言保存逻辑。
- 相关 139 测试、`pnpm check`、双站构建、SEO 与文档变更检查通过。
- 本地浏览器中的英文首页返回 200 且正常展示；中文浏览器偏好提示已通过组件测试，尚未做中文偏好浏览器实页截图。
- 首页性能预算在本轮和干净 master 都失败，脚本数量无变化，本次增加 819 字节 gzip。

## unverified
- 未验证线上行为；没有发布。
- 全量测试未完成；多处失败，其中一项在干净 master 复现。

## discard
- 无需保留干净 master 对比 worktree；已删除。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/intl-language-suggestion/lightvela`。
- 修改集中在首页语言提示、i18n 初始化快照、聚焦测试和正式设计文档。

## next_action
- 提交并推送独立分支，创建 MR 后核验远端源 SHA、可合并状态和 CI 快照。

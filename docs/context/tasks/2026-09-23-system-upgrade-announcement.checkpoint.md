## stage
实现与本地验证完成，已获提交 MR 授权；等待 commit、push 与创建 MR。

## verified
- 基于 `origin/master@d4c1306221d3b821a8aaaf08299c0f0d3da7af2a` 的隔离 worktree。
- 国内站与国际站公告文案、时间、独立关闭 ID、06:00 自动撤下均有聚焦测试。
- 6 个目标语言字典、类型检查、CN/global 构建均通过。
- 本地 CN/global 首页实页可见，关闭交互与布局状态正确。

## unverified
- 远端分支、MR、CI、合并、发布与生产两站状态均未执行或核验。

## discard
- 首次未安装依赖导致的测试/类型命令启动失败，安装锁定依赖后已由成功结果替代。
- i18n 提取曾暴露与本任务无关的历史生成噪音，已从变更中排除。
- 构建生成的字体二进制差异已从变更中排除。

## restore
- Worktree：`/Users/pablozhong/.codex/worktrees/maintenance-announcement-0923/lightvela`
- 分支：`codex/maintenance-announcement-0923`
- 任务包：`docs/context/tasks/2026-09-23-system-upgrade-announcement.md`

## next_action
commit、push 并创建 MR，再核验远端 SHA、MR 与 CI 即时状态；不得合并、发布或把 MR/CI 通过表述为已发布。

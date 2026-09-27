## stage
MR !4677 的 CR 后续修复和当前 master 合并已完成本地验证，待提交生成物并推送原 MR。

## verified
- 独立 worktree 已合入 `origin/master` 的 `3d6077da7`，主工作区未修改。
- 国际站默认首页保持英文；无已存选择且浏览器首选语言为已发布非英文版本时提示一次。
- 简体中文提示链接为 `/zh-sg/`；继续英文调用现有语言保存逻辑。
- 相关 139 测试、`pnpm check`、双站构建、SEO 与文档变更检查通过。
- 本地浏览器中的英文首页返回 200 且正常展示；中文浏览器偏好提示已通过组件测试，尚未做中文偏好浏览器实页截图。
- 首页性能预算在本轮和干净 master 都失败，脚本数量无变化，本次增加 819 字节 gzip。
- CI 失败点为 `i18n/index.ts` vendored 副本漂移；官方同步后 OpenCraft 130 文件检查、插件类型检查和 83 项聚焦测试通过。
- MR !4677 现有提交 `9a729ca34` 的 CI 已成功。后续修复区分裸英文页自动写入与明确语言选择，目标语文案和移动端层级已更新。
- CR 源码修复已提交 `0bd9dae23`；合并当前 master 为 `511980a7a`。合并后聚焦测试 92 项、国际站配置测试 90 项、OpenCraft 83 项、`pnpm check`、双站构建、OpenCraft 130 文件检查与文档检查通过。
- 合并后首页性能预算仍失败：国内站构建输出 28 个脚本、raw 2,772,944、gzip 940,134 字节，均超过原预算。

## unverified
- 未验证线上行为；没有发布。
- 全量测试未完成；多处失败，其中一项在干净 master 复现。
- CR 后续修复尚未推送，远端 CI 结果待核验。

## discard
- 无需保留干净 master 对比 worktree；已删除。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/intl-language-suggestion/lightvela`。
- 修改集中在首页语言提示、i18n 显式选择标记、聚焦测试、正式设计文档和官方同步的 OpenCraft 副本。

## next_action
- 更新本 Task Pack 的合并后验证记录，单独提交官方同步的 OpenCraft 生成物；推送 MR !4677 后核验远端源 SHA、可合并状态和 CI 快照。

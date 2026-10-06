## stage
Bot 显示文案和各语言译文已调整，并完成本任务的验证与交接。

## verified
- 侧栏与总览各有一个独立的 Bot 生命周期标签映射。
- `running` 和 `paused` 的底层状态及功能判断未修改。
- i18n 提取检查发现新键已补齐六个非简体语种。
- 聚焦测试 3 文件、73 项通过；前端检查通过。
- 国际站与国内站构建通过。
- diff 空白检查、文档校验及 staged 变更影响校验通过。

## unverified
- 未在登录生产账号上进行人工回归；源码尚未提交或发布。
- 未重复运行此前已知存在无关失败及 worker OOM 的完整前端测试。

## discard
- 先前建议的拟人化长文案；用户已选择「在线／离线」。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/homepage-heading-typography/lightvela` 含此前任务未提交改动；仅处理本任务相关差异。

## next_action
- 用户确认后再按需提交、推送或创建 MR。

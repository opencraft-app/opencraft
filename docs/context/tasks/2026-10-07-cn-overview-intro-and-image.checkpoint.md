## stage
独立工作树中的国内站 overview 简介和截图更新完成，准备提交 MR。

## verified
- 简介突出个人 AI 助理与伙伴、云端独立运行及 7×24 小时在线；Hermes Agent 仅作为当前运行基础提及一次。
- 旧版首页图已由 2026-10-07 国内站真实首屏替换，文档源图与公开图一致。
- `pnpm docs:sync`、`pnpm check`、双站构建、OpenCraft 同步检查、源/产物核对与 `git diff --check` 通过。
- 后续将「多通道接入」中的对话对象改为 LightVela；`pnpm check` 再次通过，源文件与 zh-cn 产物均已核对。

## unverified
- 聚焦 Vitest 在测试进程内临时映射 `localhost` 至 `127.0.0.1` 后通过：6 个文件、108 项测试；线上发布与实际文档页未验证。

## discard
- 旧版首页截图及“LightVela 提供的产品是 Hermes Agent”的说法已不适用。

## restore
- 任务记录：`docs/context/tasks/2026-10-07-cn-overview-intro-and-image.md`。
- 文案：`frontend/src/content/docs/01-overview.md`；截图：`frontend/src/content/docs/images/20260424-112540-oxe6.webp`。
- 本次变更已从主工作区移入基于最新 `origin/master` 的独立工作树。

## next_action
- 暂存变更的 change-impact 门禁已通过；提交分支并创建 MR，发布需另行处理。

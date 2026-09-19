---
id: hermes-reasoning-bridge-2026-09-16
type: task
scope: Current-master Hermes model reasoning and Composer catalog cleanup.
status: retired
owner: skipzhang
---

## goal
删除无用的 OpenCraft `agent/list` 扩展，在当前主干完整接通 Hermes reasoning 目录、选择、创建、发送与恢复。

## non_goals
- 不修改 generated AppServer schema，不执行真实付费推理，不读取凭据，不提交、推送或发布。

## acceptance
- `bot/*` 独占 Bot 身份；模型目录不再依赖 `agent/list`。
- GLM 5.3 仅显示 `low/high/max`，默认 high，创建/Turn/恢复贯通且不发送 none。
- 聚焦测试、真实组件 smoke、完整 gate、Electron 打包/签名/窗口验证通过。

## context_receipt
- 根与 OpenCraft AGENTS、当前 opencraft-maintenance/verification、TDD、planning-with-files。
- `docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/chat-ui-architecture.md`。
- 官方 Hermes Agent Desktop/Runtime 当前源码，仅作参考。

## risks
- 工作区曾在旧分支完成一次无效构建；所有证据必须来自本 worktree。

## validation / evidence
- OpenCraft 验收基于 `08b9cf568` 完成；交付前远端 master 前进两条仅修改 `.ci/collaboration-bootstrap.yml` 及其 contract test 的提交，已无冲突 fast-forward 至 `origin/master@1e1a8b181`，本次 OpenCraft 文件零重叠。
- GLM 5.3 仅显示 Light/High/Max，默认 High，Max 写入草稿；创建、Turn 更新和恢复覆盖测试通过。
- Electron 构建、独立 arm64 打包、严格深层 codesign 与打包窗口 CDP 挂载通过。
- 未调用真实模型、未读取凭据、未发布。

## handoff
- stage: complete on current master worktree; no commit or push

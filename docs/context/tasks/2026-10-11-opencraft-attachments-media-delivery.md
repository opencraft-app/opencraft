# OpenCraft 附件与媒体交付

## goal
将本会话已完成的本地自动连接、大附件上传、SSH 附件与通用 MEDIA/PDF 预览提交并推送，经工蜂 MR 合入 master。

## non_goals
- 不发布在线前端、重启服务、修改 GitOps 或同步公开 GitHub 镜像。

## requirement_refs / requirement_excerpt
- 当前会话用户明确授权：“提交 推送 合入master”。此授权覆盖本轮 Git 与 MR 交付，替代各实施 Pack 的未提交状态。

## history_context
- implementation_refs：2026-10-10-local-codex-auto-connect.md、2026-10-10-binary-attachment-upload.md、2026-10-10-ssh-attachment-upload.md、2026-10-11-hermes-media-inspection.md、2026-10-11-pdf-preview.md。
- current_design_refs：docs/engineering/domains/agent-gateway-runtime.md、opencraft/docs/chat-ui-architecture.md、opencraft/design/invariants.md。

## acceptance
- 交付分支包含全部本轮实现，并保留最新 master 的更新。
- 相关检查、推送、MR 状态与远端 master 的提交可回读验证。

## affected_paths
- 本轮 OpenCraft Host/附件上传、共享媒体 Renderer、资源预览、测试与配套正式文档。

## context_receipt
- 已核对根与 OpenCraft AGENTS、change-delivery flow、路由返回的 tapd-gongfeng-delivery flow、gongfeng SKILL 与其 mcporter 依赖说明。
- 未调用外部消息通知，不添加未经请求的 reviewer；复用本机认证且不输出凭据。

## validation / checkpoint
- 原实现的聚焦测试、类型检查、浏览器验证和构建证据见各实施 Pack。
- 已创建 codex/opencraft-attachments-media-20261011；原工作目录为旧基线的 detached HEAD，已 fetch 最新 origin/master，需集成后重新验证。
- 正在核对工蜂客户端与已有配置；尚未推送或创建 MR。

## handoff
- 交付进行中；当前在线服务不属于此次 Git 合入操作。

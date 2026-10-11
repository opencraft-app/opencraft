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
- 实现提交 9a4a7ff2a2；交付分支 codex/opencraft-attachments-media-20261011 已集成 origin/master c292a250f1，三处并行追加冲突均保留双方内容。补齐 master 新增 ms-MY、th-TH 的 10 条媒体文案，SSH 原生能力测试增加 pin:false 断言。
- 集成后六个受影响 workspace 类型检查通过；AppServer 主体 270/270、SSH 85 通过/1 环境跳过、Headless 31/31、Bot-management 32/32、预览与 Host 定义 17/17 通过；i18n 232 消息、边界及排版检查通过。
- master 新增的共享协作包已在当前 checkout 安装自身依赖；没有改动其源码或锁文件。最终集成 Web 构建与实际 Chromium 制品验证通过，仍使用用户 11,924,293 字节 PDF，音视频、原字节下载及卸载均通过。
- 工蜂原有配置可发现，但缺少 GONGFENG_TOKEN 环境变量；复用本机 Git 凭据的只读 get_current_user 返回 Unauthorized。未执行 MR 写操作，已请求用户恢复认证；Git SSH 推送独立验证。
- 全仓文档校验与 staged docs-impact 通过；相对 origin/master 的本轮差异 whitespace 与高置信度凭据扫描通过。完整 merge stage 的 whitespace 检查命中 master 既有文档尾空格，未改动无关历史内容。
- 集成提交 70963611249cb7494ce9160bbe02d0e99e7bff04 已通过 Git SSH 推送；ls-remote 回读来源分支精确匹配，master 仍为 c292a250f1a0a047fea53f495fc2fc9ad2c6e7ee。工作区干净；MR 标题、正文和 master 目标已准备，未创建 MR。
- 后续用户提供工蜂认证；已在仓库外私有 mcporter 配置恢复，get_current_user 验证通过。重新 fetch master 后确认交付分支包含最新 master，继续正常 MR 合并流程，不更改审批或门禁规则。

## handoff
- 实现与集成提交已推送，认证已恢复，正在创建 MR 并核对合入结果；当前在线服务不属于此次 Git 合入操作。

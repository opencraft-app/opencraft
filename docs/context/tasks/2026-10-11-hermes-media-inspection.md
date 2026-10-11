# Hermes media 与 PDF 预览核对

## goal
对照仓库固定版本 ref/hermes-agent desktop，核对 OpenCraft media 接线与 PDF 展示缺口。

## non_goals
- 本轮只读调查，不修改行为、不重启、不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 会话：“hermes 的 media 接线了吗？看看 ref/hermes-agent的desktop”；追加 PDF 展示问题和“pdf预览用的什么库”。

## interface_refs / data_structure_refs
- attachment/stage、fs/readFile、image.attach_bytes/image.attach、MEDIA:、ChatMediaSourceLoader。

## history_context
- current_design_refs：opencraft/docs/chat-ui-architecture.md、platform-architecture.md。
- relevant_evolution：当前 Renderer 只对显式 Markdown 路径处理 MEDIA:。
- superseded_refs：本机 /data/hermes-agent 的 baa344d 副本只用于初步定位；最终结论使用 gitlink 指定的 3c3ab69abb9b08683b5eb15b4e2b8be1198c875f。

## acceptance
- 明确已有接线、缺口、参考 PDF 实现及验证边界。

## affected_paths
- 只读 Hermes bridge、Workbench 资源面板、chat-render 与固定版本参考 desktop。

## required_context
- Router 无匹配；有界搜索 ref 目录为空后定位本机副本，随后下载精确 gitlink 到独立 /tmp 目录核对。

## context_receipt
- 已读根及 OpenCraft AGENTS、维护 SKILL、Chat 与平台文档相关部分、frontend-runtime-openspec-i18n 邻接及 frontend/vitest.config.ts。
- 参考：apps/desktop/src/lib/chat-messages/parts.ts、media.ts、local-preview.ts、components/assistant-ui/markdown-text.tsx、components/chat/preview-attachment.tsx、app/chat/right-rail/preview-file.tsx、electron/media-protocol.ts。

## evidence
- Hermes transport 创建带认证 DashboardFileSystem 的 bridge；附件暂存、fs/readFile、图片输入原生 image.attach_bytes/image.attach 已接。
- OpenCraft MEDIA: 处理限制为 Markdown 文件；未发现音视频 Renderer/Range 播放实现。普通 Markdown 图片通过 Host media loader 读取。
- WorkspaceResourcePanel 只处理图片与可解码文本；文本上限 4 MiB，无 PDF 分支。用户 PDF 头为 %PDF-1.5、11924293 bytes，会进入无法预览分支。
- 精确参考把 MEDIA: 转为分类卡片；音视频经 hermes-media 协议支持 Range；PDF 单独读取 data URL、转 application/pdf Blob、建立 object URL 后在 iframe 展示，未使用 pdf.js/react-pdf。

## risks
- 源码接线与真实 Hermes 账号/实例可用性分开；未触发推理、真实账户请求或重启。

## validation
- 当前 checkout 的 Hermes attachment staging、conversation media、Workbench attachment resolver 聚焦测试共 21/21 通过；git diff --check 通过。
- 线上 version.json 返回 20261010-local-codex-auto-412571440ce9；不将源码检查称为新 Renderer 发布或真实 Hermes 链路验收。

## decisions
- PDF 缺的是展示分支，不能由上传成功推导可预览；媒体输入与输出接线分别说明。

## scan_scope
- 指定 desktop、Hermes bridge、共享渲染与资源预览，不扫描凭据。

## scan_output
- 固定参考在 /tmp/opencraft-hermes-ref-20261011，未改 ref 子模块。

## handoff
- 调查完成；行为未改。待实现项为完整 MEDIA: 输出投影、音视频播放及 PDF 预览。

## checkpoint
- 2026-10-11：已用精确固定参考取代初步副本；PDF 库问题确认是 Chromium 内置查看器 + Blob URL + iframe。

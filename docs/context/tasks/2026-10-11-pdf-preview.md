# PDF.js 文件预览

## goal
为现有 Web/Electron 文件资源面板接入 PDF.js，并将 MEDIA 入口扩展为通用文件识别，支持图片、音视频、PDF 预览与未知文件下载。

## non_goals
- 不重启当前服务、不提交或发布，不扩展到 Expo 原生阅读器。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前会话：用户报告 PDF 无法展示，选择“就 pdf.js 吧 或者有更好的吗”。
- 后续明确要求识别通用 media，不能只解析 Markdown；PDF 是已知可渲染分支，增加统一分类、音视频播放器和未知文件下载兜底。
- 用户确认 PDF 预览不区分后端引擎，所有 Host 共用；只在共享资源展示层选择 PDF 分支，不添加 Hermes/Codex 专属条件。

## interface_refs / data_structure_refs
- 继续使用 fs/readFile 与 BlobResourceService；Renderer 不拿远程路径当本机文件或创建另一鉴权通道。
- PDF 文档、渲染任务、Worker 和下载 URL 归当前资源 View；切换或卸载时取消并释放。

## history_context
- current_design_refs：opencraft/docs/chat-ui-architecture.md、platform-architecture.md、design/invariants.md。
- relevant_evolution：2026-10-11-hermes-media-inspection.md。当前图片/文本面板无 PDF 分支，文本预览限 4 MiB。
- superseded_refs：参考 desktop 的 Chromium iframe 实现仅为比较；本轮选独立 PDF.js。

## acceptance
- 用户约 11.9 MB PDF 在真实 Chromium 中绘制，翻页、缩放、下载成功；窄屏、浅深主题、旧结果取消和损坏文件可恢复。
- 不整本同时绘制，不从 CDN 加载 Worker、字体或 CMap。

## affected_paths
- workbench-web PDF 组件、资源面板、样式、依赖；MEDIA 文件入口与聚焦验证。

## required_context / context_receipt
- Router 无匹配；已在资源面板及已有附件/资源测试执行有界搜索。
- 已读根与 OpenCraft AGENTS、维护 SKILL 与 verification、Chat/平台架构相关章节、frontend-runtime-openspec-i18n 邻接与 frontend/vitest.config.ts；固定 Hermes 参考核对记录见调查 Pack。

## evidence / decisions
- PDF.js 官方文档提供独立渲染层；React 封装不改变内核。npm registry 与官方文档均为 6.4.299；当前 Node v26.7.0 满足其引擎要求。
- 保留此前自动连接、大附件和 SSH 上传修改；本轮实现共享 PDF/media 展示，不改变 Host 执行或附件上传协议。

## risks
- 真实远程账号、推理与生产发布不在默认验收范围；浏览器构建不能证明已打包 Electron 或 Expo。

## validation
- 资源入口与只读保护聚焦测试 25 项通过；Web、chat-render-react、chat-render-web typecheck、i18n 与边界/排版检查通过。
- 用户 11,924,293 字节 PDF 在真实 Chromium 中显示为 23 页；源码和构建制品均通过翻页、缩放、390px 窄屏、主题、原字节下载、损坏 PDF 恢复、音频、视频、未知文件及卸载检查。浏览器 fixture 仅替换 Host 文件读取边界，实际 Renderer、Blob 服务、PDF.js Worker 与资源面板均使用生产组件。
- 最终 Web 构建通过，制品位于 `/tmp/opencraft-media-web-final-20261011`；最终浏览器 fixture 构建位于 `/tmp/opencraft-media-browser-final-20261011`，截图 `/tmp/opencraft-pdf-preview.png`。未覆盖真实远程账号或 Electron 打包安装。
- 显式源码变更集 docs-impact、全仓文档链接校验与 diff whitespace 检查通过；最终 PDF 生命周期修改后 Web typecheck 再次通过。

## scan_scope / scan_output
- 指定 PDF 依赖、现有资源预览与 MEDIA Renderer；无凭据读取。

## handoff / checkpoint
- 2026-10-11：源码实现与隔离构建/浏览器验收完成；尚未替换当前在线前端、重启服务、提交或发布。MEDIA 支持通用文件类型与明确地址，普通行内代码仍保留 Markdown 路径规则，正文内混排 MEDIA 尚未扩展。

## goal
在国内 OpenCraft 内嵌 Chat 中，点击已发送消息的图片缩略图后显示可关闭的放大预览。

## non_goals
- 不改变附件上传、图片字节获取、消息历史或生产发布流程。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮要求（2026-10-01）：已发聊天里的图片文件点击后无法展开，需修复。
- 用户截图：国内站 `/agents/chat` 中已发送图片缩略图被点击后仍停留原尺寸。

## interface_refs / data_structure_refs
- `UserMessageBlock` 从 Timeline 呈现 `image` / `local-image`，点击由 `UserMessageImageViewer` 打开 `ModalSurface`。
- `WorkbenchPresentationRootProvider` 提供嵌入 Shadow DOM 的唯一弹窗呈现根；显式传入 `portalContainer` 的调用方仍优先使用显式目标。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`、`opencraft/docs/platform-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution: 当前源码已有图片预览弹窗，但直接调用 `ModalSurface` 时未提供内嵌呈现根。
- superseded_refs: 无。

## acceptance
- 点击已发送图片后，预览弹窗位于 OpenCraft Shadow DOM 的呈现根内，图片可见，Escape 可关闭。
- 独立 Web 页面现有弹窗路径和显式 portal 目标保持可用。
- 通过相关类型检查、聚焦测试、内嵌浏览器验收及变更影响检查。

## affected_paths
- `opencraft/apps/workbench-web/src/components/modal/modal-surface.tsx`
- `opencraft/tests/fixtures/sent-image-preview.tsx`
- `opencraft/scripts/smoke-sent-image-preview.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`、`site-environment-routing`、`service-opencraft`、`upstream-subtrees`、`release-gitops` Pack；`opencraft/AGENTS.md` 与 `opencraft-maintenance`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@master` | OpenCraft 责任边界 | 定位 Renderer owner |
| `docs/context/domains/site-environment-routing.md@master` | 国内站范围 | 限定验收区域 |
| `docs/context/project/upstream-subtrees.md@master` | 写入真源 | 仅修改 mono2 OpenCraft |
| `docs/context/project/services/opencraft.md@master` | 服务门禁 | 选择类型与聚焦验证 |
| `docs/context/domains/release-gitops.md@master` | 发布边界 | 区分源码和现网 |
| `opencraft/AGENTS.md@master` | 服务说明 | 选择浏览器验收 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@master` | OpenCraft 维护流程 | 以真实可见交互验收 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@master` | 验证清单 | 选择组件、浏览器与构建证据 |
| `opencraft/docs/chat-ui-architecture.md@master` | 已发送图片契约 | 保持既有图片预览行为 |
| `opencraft/docs/platform-architecture.md@master` | 呈现根契约 | 弹窗必须留在嵌入根内 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@master` | 前端测试邻接 | 检查相邻消息布局测试 |

## evidence
- 初次自然语言 route 未命中；有界精确查询 `image attachment` / `image preview` / `attachment thumbnail` 未定位组件，扩大到 `components/conversation` 后定位。
- `UserMessageImageViewer` 已设置点击打开状态，但 `ModalSurface` 未消费 `WorkbenchPresentationRootProvider`；内嵌样式只在 Shadow DOM 内。
- 修复前浏览器 smoke：点击后内嵌根中 30 秒内没有 `Attached image 1 of 1` 弹窗（RED）。
- 修复后同一 smoke：弹窗在内嵌根中，图片宽于缩略图，Escape 关闭，浏览器 pageerror 为 0；截图 `/tmp/cn-opencraft-sent-image-preview.png`（GREEN）。
- Web 工作区 typecheck、边界检查、聚焦测试 7 项、Chat 测试 442 项及内嵌发布构建通过。
- 文档校验 0 error / 0 broken link / 0 warning；staged diff 与变更影响检查通过，后者提示 `wisp/mono2-maintainers` 审阅。

## risks
- 预览遮罩若离开 Shadow DOM，会失去样式与正确层级；回滚本轮 modal root fallback 即可。

## validation
- 聚焦内嵌浏览器 smoke 与工作台呈现根测试。
- `npm run typecheck --workspace @opencraft/workbench-web`、`npm run check:boundaries`、相关构建与文档/变更影响校验。

## decisions
- 让 `ModalSurface` 默认消费当前工作台呈现根，显式 `portalContainer` 继续优先；避免各图片入口各自修补。owner：本轮用户需求。

## scan_scope
- `opencraft/apps/workbench-web/src/components/conversation/`、`components/modal/`、相邻 tests。

## scan_output
- 已定位 `UserMessageImageViewer`、`ModalSurface`、`WorkbenchPresentationRootProvider` 与布局测试。

## handoff
- 本地修复与验证完成；真实登录会话及现网尚未验证，尚未 commit、push、创建 MR 或发布。

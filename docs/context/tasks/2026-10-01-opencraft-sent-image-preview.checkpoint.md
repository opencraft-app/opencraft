## stage
已发送图片预览修复及本地验证完成，待交接。

## verified
- `UserMessageImageViewer` 原来直接调用 `ModalSurface`，它默认将 Radix portal 挂到 document body；国内嵌入工作台的样式与呈现根位于 Shadow DOM。
- 修复前浏览器重现未能在内嵌根找到弹窗；修复后点击显示大图，Escape 关闭，浏览器无 pageerror。
- Web workspace typecheck、边界检查、聚焦测试、442 项 Chat 测试、内嵌发布构建通过。
- CR 跟进将 portal 容器顺序断言接入 `test:embedded-ci`（155 项通过），并为浏览器 smoke 注册 npm 入口、注明外部 Playwright/Chromium 参数；浏览器 smoke 再次通过。
- 文档与 staged 改动影响检查通过；变更影响检查提示 `wisp/mono2-maintainers` 审阅。

## unverified
- 真实登录用户图片附件的字节加载及生产部署后的线上交互尚未验证。

## discard
- 初次 browser smoke 因当前 checkout 未安装 Playwright 模块而无法启动；后用 Codex 捆绑 Playwright 运行同一脚本，不改仓库依赖。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/cn-opencraft-default/lightvela`，分支 `codex/cn-opencraft-default`；此分支同时保留国内 OpenCraft 默认 Chat 的上一项未提交改动。
- 本轮 Task Pack：`docs/context/tasks/2026-10-01-opencraft-sent-image-preview.md`。
- 浏览器截图：`/tmp/cn-opencraft-sent-image-preview.png`。

## next_action
- 向用户交接两项本地改动与验证结果，并按根 `AGENTS.md` 的 Git/发布确认要求等待下一步。

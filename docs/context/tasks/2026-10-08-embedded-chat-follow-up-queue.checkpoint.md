## stage
已完成源码、设计文档改动和仓库门禁；修复本地预览代理指向错误，准备交接。

## verified
- 主站 Agent Chat 由 OpenCraft embedded 元素承载。
- 10 月 5 日提交 `1a53b96c3` 把安装级 steer 默认偏好传给主会话；此前 Composer 默认 queue。
- OpenCraft embedded App 的 Composer 现在优先选择 queue；独立 Workbench 仍读取偏好。
- OpenCraft 聚焦测试 41/41、embedded 回归 176/176、Web 类型检查、边界检查、embedded release 构建和文档检查通过。
- 本 worktree 的国内站预览现运行于 5174，使用 `local-proxy` 指向 `api.lightvela.com`。先前 Chrome 的 Whistle 选中规则仍指向 5175；已将其中国内站 HTTP/HMR 改为 5174 并重新解析，保留国际站设置。原截图标签重新加载后，脚本带本次 `queue-preview` 标记、登录态会话和 embedded 输入框可见。
- `chat-runtime` 测试新增排队消息不进入对话时间线的断言；相关 46 项测试通过。
- 重新运行 embedded 回归 176/176、Workbench typecheck、边界检查、文档检查与 staged change-impact，均通过。

## unverified
- 真实 Hermes 运行中 Turn 的发送后排队尚未经 Agent 操作验收，留给用户在预览中试用。
- synthetic embedded 浏览器 smoke 在加载元素后等待既有错误文案超时；进一步检查显示模拟账号的会话加载失败、页面回退到 legacy，未覆盖运行中 queue。
- 后续复查：5174 本地服务及当前嵌入资源正常返回，但 Chrome 新标签加载了 `__releases/` 生产资源，而非本地 `_next/static`。Whistle 国内站规则曾被改回 5175，现已恢复 5174；Chrome 当前没有通过该映射加载页面，因此本次不能宣称登录态预览已就绪。需用户启用其 Chrome 代理后重新核对。

## discard
- 旧 AgentChat SDK 路径；它不是当前主站 Chat 入口。

## restore
- Worktree: `/Users/pablozhong/.codex/worktrees/chat-embedded-queue/lightvela`。
- 核心改动：`opencraft/apps/workbench-web/src/app.tsx` 的 `defaultFollowUpAction={embedded ? "queue" : defaultFollowUpAction}`。

## next_action
- 保持 5174 预览和国内站 Whistle 映射供用户验收；交接真实 Hermes Turn 未验证的边界。

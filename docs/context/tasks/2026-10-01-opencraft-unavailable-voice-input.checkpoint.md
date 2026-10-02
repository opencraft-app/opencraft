## stage
语音不可用态修复与本地验证完成；用户已明确授权提交 MR。

## verified
- 在修复前的交互测试中，禁用麦克风按钮收到 `pointerdown` 后仍启动临时文本输入。
- 按下与点击处理现都校验 `disabled || !available`；禁用态不显示可操作的 hover 高亮。
- 15 项相关测试、Voice Input 与 Workbench Web 类型检查、`build:web`、文档校验通过。

## unverified
- 未在用户截图所用的浏览器实例中运行这份尚未发布的代码。

## discard
- 直接运行 Workbench workspace build 缺少预览桥接产物；根包 `build:web` 已按正确顺序成功。

## restore
- 工作区：`/Users/pablozhong/.codex/worktrees/chat-action-tooltips/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-01-opencraft-unavailable-voice-input.md`。

## next_action
- 提交、推送并核验用户已授权的 MR；合并和发布另行处理。

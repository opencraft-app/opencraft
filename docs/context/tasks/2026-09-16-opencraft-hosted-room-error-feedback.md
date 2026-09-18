## goal

让 OpenCraft Bot 群聊把 Hermes Hosted Room 的成员执行失败作为持久、可恢复的错误反馈显示在对应会话中。

## non_goals

- 不修复模型供应商额度、Bot Profile 凭据或用户实例数据。
- 不代用户重新发送群消息、取消执行或修改 Hermes 上游运行时。
- 不发布 OpenCraft 构建产物。

## requirement_refs

- 用户 2026-09-16：“要反馈错误 你看看hermes webui 咋做的”。

## interface_refs

- Hermes `groups.log` 的 `turn.failed` 携带 `member_id`、`task_id`、`reason_code` 与错误文本。
- AppServer `AppServerBotExecution.error` 已有结构化错误位；Bot Conversation Source、Timeline 和 View 必须保留同一执行身份。

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/chat-ui-architecture.md`。
- `relevant_evolution`: 当前 Hermes WebUI Chat 嵌入 PTY/TUI，Hermes Desktop 群聊使用 Activity 与 needs-attention 反馈；OpenCraft Hosted Room 只投影失败状态，未呈现失败原因。

## acceptance

- `turn.failed` 经 Bridge、AppServer Source、Timeline 后保留成员身份与稳定失败类别；历史恢复和实时事件一致。
- 群聊在对应 Bot 执行行显示持久的错误提示；额度、配置、鉴权、超时和未知错误使用安全文案，不泄露原始后端文本。
- 成功/取消执行不显示错误，已有消息与其他成员执行不受影响。
- 聚焦测试、类型检查、Bot 管理/群聊测试与文档门禁通过；实际预览证据另行标注。

## affected_paths

- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/group-conversations.ts`
- `opencraft/packages/bot-conversation-appserver/src/source.ts`
- `opencraft/packages/bot-conversation/src/model.ts`
- `opencraft/plugins/bot-chat/src/`
- 相关聚焦测试与正式设计文档。

## required_context

- `frontend-product-surface` 路由命中；实际修改位于 OpenCraft 边界，以 `opencraft/AGENTS.md` 和维护 Skill 为准。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 根路由 must_read | 排除 mono Web 发布范围 |
| `opencraft/AGENTS.md` | OpenCraft 边界 | 状态 owner、预览纪律 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 维护方法 | 群聊恢复与失败证据 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 验证选择 | 聚焦协议与组件测试 |
| `opencraft/docs/chat-ui-architecture.md` | 会话/执行所有权 | 失败属于执行，不伪造聊天消息 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式领域设计 | Hosted Room 只投影上游事实 |
| `ref/hermes-agent/web/src/pages/ChatPage.tsx` | 用户指定 WebUI 参考 | 区分终端运行错误与连接横幅 |
| `ref/hermes-agent/apps/desktop/src/plugins/hermes-bots/data.ts`、`group-activity.ts` | Hermes 群聊参考 | 失败分类与 Activity 反馈 |

## evidence

- 用户房间 `999, skip`：`turn.failed` 原因 `provider_quota_limit`，另一成员后端报 `Unknown provider`；OpenCraft 页面未明确显示这两种错误。
- 用户随后在 999 Direct chat 观察到通用失败卡。实例 backend 日志确认真实错误仍是 HTTP 402 免费额度耗尽；该会话 `message.complete.error_surface` 为 `{layer: billing, code: billing, retryable: false}`。
- 现有 `group-conversations.ts` 对 `turn.failed` 只映射 `status=failed`，`source.ts` 丢弃协议 `error`，`bot-chat-view.tsx` 对失败执行行没有可见内容。
- Hermes WebUI `ChatPage.tsx` 嵌入 PTY/TUI，运行错误留在终端输出、连接错误使用持久横幅；Desktop Bot 群聊用失败 Activity 和配置/额度 needs-attention 类别。OpenCraft 复用执行行，不复制 PTY 呈现。
- Bridge 将 `provider_quota_limit`、缺失 provider、认证、超时归为安全类别；Source 仅保留 code/retryable；Bot View 对对应成员显示 `role=status` 的持久错误卡，不展示原始 stderr。
- 直聊与群聊现在复用 `classifyHermesBotExecutionFailure`；实时 Turn 与 inflight recovery 保留内部 `error_surface` 供安全分类，Renderer 仍只收到 code/retryable。普通 Dashboard 消息历史不持久化 Direct chat 的失败 surface，因此应用完全重启后不能从旧 user/assistant/tool 行重新推断 402；禁止把未知历史失败猜成额度错误。
- 新增群聊历史恢复、Source 增量投影、SSR 可访问呈现测试。`npm run test:bot-management` 23/23、`npm run test:chat` 392/392、`npm run test:extensions`、全部 workspace 类型检查、边界检查与 Web 构建通过。
- 直聊额度分类、嵌套 error 与 error_surface recovery 回归通过；最终 `npm run test:bot-management` 32/32。实机复用临时登录 profile 验证旧失败历史无法可靠恢复 surface，故不宣称旧卡已被重新分类；下一次真实失败才可验收实时结构化提示。
- 首轮完整 gate 在本机 `node-pty/prebuilds/darwin-arm64/spawn-helper` 缺执行位时失败；仅恢复当前 `node_modules` 中该 helper 的 0755 权限后，单独 `local-agent-host` 8/8 通过，完整 `npm run gate` 最终通过（含 Web/Expo Web/iOS 构建）。
- 用户随后要求启动预览；在当前 checkout 构建 Electron release，直接以独立 Bundle ID `ai.lightvela.opencraft.preview.grouperrors.g0pl5r` 打包到 `/tmp/opencraft-group-error-preview.G0pL5r/package/mac-arm64/OpenCraft Group Error Preview.app`，未调用会删除旧 `release/preview` 的标准脚本。`.app` 可执行、托盘素材、严格 codesign 验证通过；打包 renderer 含新增安全错误文案，调试端口 9366 和真实窗口均在线。
- 初次从终端会话直接启动的预览未跨任务驻留；随后改用 macOS `open -na` 启动相同独立 profile，调试端口 9366 与独立 model-storage daemon 参数再次验证在线。未执行登录。`NSWorkspace` 当前仍将 `opencraft://auth/lightvela` 解析到另一份旧预览；该旧预览签名、可执行文件和回调转发代码均存在，但回调转发的真实完成尚未验证。

## risks

- 上游原始错误可能含 URL、凭据或内部诊断；UI 只显示受控类别文案。
- 老房间存在仍在运行、尚未产出终态的任务；不能凭另一个成员的失败伪造其终态。

## validation

- `npm run test:bot-management`、相关 `npx tsx --test`、`npm run check:boundaries`、受影响包类型检查。
- 实际桌面预览需独立产物和 profile；不覆盖用户正在运行的应用。
- `validate_documentation.py --repo . --format json`：0 error、0 warning；`validate_change_impact.py` 对本轮显式路径通过。

## decisions

- 使用既有 `AppServerBotExecution.error` 和 Timeline execution row，失败不写成 Bot 的聊天消息。

## scan_scope

- `ref/hermes-agent/web/src/pages/ChatPage.tsx`、`ref/hermes-agent/apps/desktop/src/plugins/hermes-bots/`；OpenCraft Hosted Room Bridge、Bot Conversation Source/Timeline/View 及聚焦测试。

## handoff

- 源码实现与完整 gate 完成；独立预览已通过 `open -na` 重新启动但 profile 未登录，故尚未在真实 `999, skip` 房间观察错误卡。系统 URL handler 仍指向旧预览，登录时可能临时启动旧进程；成功转发后代码预期其退出，失败时有多出旧窗口的风险。未提交、未发布，也未替换用户当前旧预览。

## checkpoint

### stage

源码、门禁与独立预览启动完成；等待登录后房间视觉验收。

### verified

- 两种现场失败可安全分类并经历史/增量投影；SSR 错误卡、完整 gate 与 Web 构建通过。

### unverified

- 下一次真实 Direct chat / Hosted Room 失败的结构化提示；旧 Direct chat 历史没有持久 failure surface，重启后只剩普通消息行。

### discard

- “WebUI 有独立的 Hosted Room React 错误卡”假设；其 Chat 是嵌入 TUI。

### restore

- 本 Task Pack 与 `opencraft/tests/hermes-group-conversations.test.ts`、`chat-bot-execution-error.test.tsx`；当前旧预览不得覆盖。

### next_action

- 用户在已打开的独立 `.app` 中登录后，打开已有 `999, skip` 房间验证历史失败卡；不发送新消息。

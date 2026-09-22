# OpenCraft Plan 呈现与最新快照所有权

## goal
修复 Plan/Todo 快照被当作普通 transcript Activity 行长期呈现的问题，并按 Codex 的最新快照/fixed-content 模型恢复紧凑计划控件；同时核对 DSH WebUI 的 todo dock 语义。

## non_goals
不改 AppServer `turn/plan/updated` 协议，不删除历史 observation，不把 DSH WebUI 的整套样式或 composer 架构复制进 OpenCraft，不修改计划工具本身。

## requirement_refs
用户截图显示同一 Turn 同时留下 `Step 1 / 3` 与 `Step 3 / 3`，完成后的 Step 仍停在 transcript；要求检查 Codex 与 DSH WebUI，并整改视觉与生命周期。

## context_receipt
根/OpenCraft AGENTS；OpenCraft maintenance Skill 与 verification；`docs/conversation-presentation-r3562.md`；chat-core presenter/projector；Web/Expo Conversation；DSH execution projection；`ref/codex` latest todo selection/fixed in-progress content；打包 DSH WebUI TodoPanel/dock。

## evidence
- Codex `split-items-into-render-groups` 遍历 observation 时覆盖 `todoListItem`，只保留最新快照；`local-conversation-turn` 仅在最新 Turn 进行中把它投影到 fixed content portal。
- DSH WebUI 从 Host `todos` 当前投影读取完整列表，注册到 `conversation.input.dock`，不会把 plan 状态写入 transcript。
- OpenCraft 此前把每个 `todo` block 交给 Agent Activity，因此旧快照和最新快照会同时渲染。
- 修后 97 项 chat-core/presentation 聚焦测试、完整 Chat/AppServer/DSH 回归、全 workspace typecheck、平台边界与完整 `npm run gate` 通过。
- 真实 Chrome smoke 以两个 todo observations 验证旧 `Step 1 / 3` 不进入 transcript、只显示最新 fixed `Step 2 / 3`、popover/Escape 和 Turn 完成撤下；截图 `/tmp/conversation-presentation-todo-{collapsed,expanded}.png`。
- macOS arm64 Developer ID 包 buildId `20260919133456-ece25895141d`，输出 `apps/workbench-electron/release/signed-20260919-133442-plan/`；App/DMG/ZIP 校验和隔离启动通过。无公证 ticket，Gatekeeper 为 `Unnotarized Developer ID`。

## acceptance
- 历史仍保留全部 todo observations，但 transcript/Agent Activity 不渲染任何 todo snapshot。
- 仅最新、仍在运行的 Turn 暴露一个 activeTodo；完成、失败、切为历史 Turn 后撤下。
- Web 在 Composer 上方 sticky footer 显示一个紧凑 Step pill，详情使用浏览器 top layer；Native 消费相同 activeTodo 语义。
- 多快照、完成撤下、popover/Escape、状态 glyph、Web/Expo 类型和真实浏览器 smoke 通过。

## stage / handoff
实现、完整验证与签名包更新完成；未安装到 `/Applications`、未提交、未发布。公证仍缺失。

---
id: hermes-bot-profile-model-settings
type: task
scope: 通过 OpenCraft Bot AppServer 协议与界面配置单个 Hermes Profile 的默认模型。
triggers: ["Hermes Bot", "Profile 模型", "AppServer 配置"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/appserver-protocol/src/bot-conversations.ts
  - opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler.ts
  - docs/engineering/domains/agent-gateway-runtime.md
status: active
reviewed_at: 2026-09-16
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

## goal
通过 OpenCraft Bot AppServer 领域与 Bots 界面暴露单个 Hermes Profile 的模型和 Provider 设置。

## non_goals
- 不改变活动会话的一次性模型选择，也不管理全局 Provider 凭据。
- 不暴露 Provider 密钥，不绕过 Hermes 二次确认门禁。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户需求，2026-09-16：以 Hermes Desktop 为参考，通过 AppServer 协议接入 Bot Profile 模型设置。

## interface_refs / data_structure_refs
- Hermes `profiles.describe` / `profiles.configure` 拥有 Profile 模型与 Provider 持久化。
- OpenCraft `vela/bot-conversations` 拥有 Bot 作用域的配置协议。

## history_context
- Hermes Desktop 通过 Edit Profile → Advanced Profile Config → ModelPicker 编辑，并用 `profiles.configure` 持久化 `{model, provider}`。
- OpenCraft 原实现只提供名称、说明与状态修改，Bot 描述符未投影 Profile 的模型与 Provider。

## acceptance
- Bot 读取和列表在不暴露凭据的前提下投影当前模型与 Provider。
- Bot 作用域更新精确写入对应 Hermes Profile，并保留二次确认语义。
- 当前配置读取不等待模型目录；目录慢或失败时表单保持可编辑并降级手动输入。
- 既有 Bot 管理与聊天行为保持不变。

## affected_paths
- `opencraft/packages/appserver-protocol/src/bot-conversations.ts`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`
- `opencraft/apps/workbench-web/src/components/bot-management.tsx`
- focused Bot/profile tests.

## required_context
- `agent-gateway-runtime`；Hermes Desktop Profile 编辑器、Hermes Profile RPC 契约与 OpenCraft Bot 所有权边界。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `apps/desktop/.../profile-config.tsx@origin/main` | reference profile model editor | preserve model/provider ownership |
| `tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py@origin/main` | Hermes RPC contract | map describe/configure fields |
| `packages/appserver-protocol/src/bot-conversations.ts` | public Bot API owner | add Bot-scoped config surface |
| `opencraft/packages/bot-conversation-appserver/src/service.ts` | client capability boundary | gate and type configuration calls |
| `opencraft/apps/workbench-web/src/components/bot-management.tsx` | Bots property surface | add profile model editor |
| `docs/engineering/domains/agent-gateway-runtime.md` | formal ownership design | record Profile/control-plane boundary |
| `docs/context/domains/agent-gateway-runtime.md` | routed domain pack | confirm OpenCraft owns Hermes projection |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | closest UI adjacency card | check adjacent UI test/build surface |

## evidence
- Red: `npx tsx --test tests/hermes-bot-management.test.ts` failed with `Unknown Bot method: bot/configuration/read`.
- Green: `npm run test:bot-management` passed 25 tests; focused Hermes bridge suite passed 82 tests.
- `npm run test:appserver` passed 153 tests.
- Root `npm run typecheck` passed every workspace; `npm run build:lightvela-web` completed and product-boundary check passed.
- Preview rebuilt and restarted at `http://127.0.0.1:4173/`; anonymous Bots route rendered without runtime errors. Authenticated Profile mutation still requires the selected account/Host runtime.
- 桌面复现：弹窗先显示当前值但整体置灰，约 30 秒后 `model.options` 返回才恢复；确认不是权限问题。
- 红/绿：`configuration/read` 原会调用 `model.options`；拆分后只调用 `profiles.describe`，`configuration/options` 单独读取目录。
- 红/绿：Profile `model.options` settle guard 在 5ms 测试预算内返回受控错误；产品默认预算 20 秒。
- UI 状态测试确认目录加载期间使用可编辑文本输入且保存可用，目录完成后切换为下拉框。
- 最新 arm64 Electron Preview 已重建并精确重启。登录态首帧显示可编辑 Provider/模型文本框和可用保存按钮；目录返回后无损切换为 `111 / deepseek-v4-flash-0731` 下拉框。
- 未连接或没有模型的 Provider 在 bridge 投影层过滤；当前失效配置仍由 UI 单项兜底，不扩散全部禁用目录。
- 加载状态只占用标题栏固定 28px 槽位：加载为旋转图标，失败原位替换为重试按钮；正文无加载文案，弹窗外框和各区几何不变。
- 最新桌面 Preview 实测弹窗维持 compact 外框；加载首帧只有标题栏旋转图标、正文无提示行，完成后同槽清空并显示仅含可用 Provider 的下拉目录。
- OpenCraft `AGENTS.md` 新增 Vibe 原则：局部状态优先复用现有槽位，未经明确确认不得因新增能力扩大窗口、弹窗或面板几何。

## risks
- 模型与 Provider 修改必须限定到所选 Bot Profile，不得泄露凭据或改写其他 Bot。

## validation
- 聚焦 Hermes Profile/Bot 测试、AppServer 类型检查、产品边界检查与 Preview 重建。

## decisions
- Profile 默认模型属于 Bot 配置，不属于 Composer 的会话级选择。

## scan_scope
- Hermes Profile bridge、Bot 协议/服务、Bots 管理界面。

## scan_output
- 已在当前任务中完成有界源码检索，并检查一个前端邻接测试与构建入口。

## handoff
- Complete：未连接目录过滤、静默加载图标、原位重试、固定几何与 Vibe 原则均已实现，并完成最新桌面 Preview 回归。未提交、未创建 MR、未发布生产。

## goal

OpenCraft 的 Bot 产品表面暂时默认隐藏，只在设备本地的内部开发者模式中显示。

## non_goals

- 不删除 Bot 协议、目录、会话、管理能力或已有数据。
- 不把开发者模式当作授权边界。
- 不改变 DSH/Hermes 适配器行为。

## requirement_refs

- 用户：“Bot 功能，暂时默认先隐藏吧，开发者模式才显示。”

## interface_refs

- `ViewContribution.audience` 与 `NavigationContribution.audience` 是宿主呈现策略。
- Bot 动态实体、创建命令与 Bot 会话 View 消费同一 `internalDeveloperMode` 状态。

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`: 内部开发者模式已经统一控制 Plugins、Laboratory、SQLite inspector 与内部 Settings contribution。

## acceptance

- 普通模式没有 Bots 应用入口、Bot 列表、创建入口或可渲染 Bot 深链。
- 5 次 Escape 开启开发者模式后，上述入口同时恢复。
- 在 Bot 页面关闭开发者模式时回到普通 Chat，而不是保留不可导航的内部页面。
- 类型检查、扩展运行时和 Workbench 聚焦测试通过；真实 Electron 预览验证。

## affected_paths

- `opencraft/packages/extension-contract/`
- `opencraft/packages/extension-runtime/`
- `opencraft/apps/workbench-web/`
- `opencraft/plugins/bot-chat/`
- 相关测试和设计文档。

## required_context

- Context router 没有匹配 Pack；执行有界精确搜索。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库规则 | 任务与验证边界 |
| `opencraft/AGENTS.md` | OpenCraft 入口 | 宿主所有权与预览纪律 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft 维护流程 | 保持 AppServer/Host/UI 边界 |
| `opencraft/apps/workbench-web/src/runtime/extension-workbench-projection.tsx` | UI 投影 owner | 统一 Bot 表面门禁 |

## evidence

- `audience: internal` 已标记 Bot management 与 Bot chat 的 View/Navigation；Workbench projection 在普通模式同时移除 Bot 实体和创建命令。
- `workbench-internal-developer-mode` 与 `extension-runtime` 聚焦测试 18/18 通过；完整 `test:workbench:unit`、`test:extensions`、受影响 workspace typecheck、平台边界和 Electron build 通过。
- 初始 macOS arm64 preview 的 ultra Renderer 卡在约 100% CPU 并白屏。根因与修复记录在 `2026-09-16-opencraft-standard-release-minify.md`；降为标准 Oxc minify 后 packaged Renderer 完成加载并恢复正常 CPU。
- 文档验证与精确 changed-file change-impact 检查通过；规则提示最终仍需 `wisp/mono2-maintainers` owner review。

## risks

- 仅隐藏入口会留下深链；通过隐藏内部 View 并在 active view 消失时回退规避。
- 开发者模式不是安全机制；后端权限和协议校验保持不变。

## validation

- 聚焦测试、受影响 workspace typecheck、Workbench unit、build、真实 Electron 预览、change-impact。

## decisions

- 复用通用 `audience: internal` 呈现契约，不使用 Bot ID 字符串硬编码。
- 用户此前明确禁止 graphify；继续使用有界源码检查。

## scan_scope

- extension contract/runtime、Workbench projection、Bot management/chat extension 和现有 developer-mode 测试。

## handoff

- 实现、测试与构建完成；release 白屏已通过标准 minify 修复并完成 packaged runtime 验证。未提交、未发布。

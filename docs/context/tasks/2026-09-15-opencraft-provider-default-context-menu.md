---
id: opencraft-provider-default-context-menu-2026-09-15
type: task
scope: Add a provider-row context-menu action for selecting the default model.
triggers: ["opencraft", "model services", "provider", "default model", "context menu"]
owner: skipzhang
authority: primary
source_of_truth:
  - opencraft/plugins/builtin-agents/src/model-services/view.tsx
  - opencraft/plugins/builtin-agents/src/model-services/controller.ts
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-15
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal
提供商行右键菜单允许通过现有默认模型命令设置默认项，且多模型时不猜测模型。

## non_goals
- 不新增“默认提供商”持久化字段。
- 不改变模型启停、连接保存、凭据或现有会话选择。
- 不提交、推送或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前用户请求与截图：“右键菜单设为默认吧”。

## interface_refs / data_structure_refs
- `agent-default-model` 唯一保存 `{ provider, model, reasoningEffort? }`。
- `ModelServicesController.setDefault(provider, model)` 是唯一 UI 写入路径。
- 单一可用模型直接设置；多个可用模型必须由用户在 Radix 子菜单明确选择。

## history_context
- `current_design_refs`: `opencraft/docs/local-agent-custom-providers.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`: 模型行已有“设为默认”；提供商右键当前仅自定义项有重命名和删除。
- `superseded_refs`: 无。

## acceptance
- 内置及自定义提供商均可打开右键菜单。
- 一个启用模型时显示可直接执行的“设为默认”。
- 多个启用模型时显示“设为默认”子菜单，逐项明确选择。
- 当前默认、禁用/未激活、无模型、脏草稿或只读/忙碌状态不可错误写入。
- 键盘、焦点与关闭行为继续由 Radix ContextMenu 拥有。

## affected_paths
- `opencraft/plugins/builtin-agents/src/model-services/view.tsx`
- `opencraft/scripts/smoke-model-services.ts`
- `opencraft/tests/model-services.test.ts`
- 模型服务正式设计与领域不变量。

## required_context
- `agent-gateway-runtime` Domain Pack。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | 仓库边界 | Task Pack 与门禁 |
| `docs/context/domains/agent-gateway-runtime.md` | 路由结果 | 模型 provider 归属 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft 维护 | 单 owner 与真实桌面验收 |
| `opencraft/docs/local-agent-custom-providers.md` | 模型设置真源 | 复用默认模型命令 |
| `baseline-ui`, `fixing-accessibility`, React best practices | 控件实现 | 保留 Radix 和派生状态 |

## evidence
- Built-in Agents 与 Workbench Web typecheck 通过；模型服务聚焦测试 6/6 通过。
- `smoke:model-services` 通过单模型直接设置、多模型子菜单、当前默认禁用以及原有重命名/删除路径；隔离 DSH 与本地模型端点，无外部模型请求。
- 完整 `npm run gate` 通过，包括 workspace 类型/测试及 Web/Expo/iOS 构建。
- Electron renderer/Host/Daemon 构建、独立 mac-arm64 打包与 `codesign --verify --deep --strict` 通过。
- 打包应用 CDP 实测右键菜单显示“设为默认／重命名／删除”，“设为默认”可用；未点击，不修改真实默认模型。

## risks
- 提供商不是模型；直接选择第一个模型会造成隐藏策略。
- 默认模型不能被停用；菜单状态必须消费同一 default namespace。

## validation
- 聚焦 controller/view 测试、`smoke:model-services`、OpenCraft gate、独立 Electron 预览右键实测。

## decisions
- 不建立 provider-only default。
- 单模型直接项，多模型使用子菜单。

## scan_scope
- Built-in model-services controller/view、相关测试与 smoke。

## scan_output
- 当前右键菜单只包裹自定义提供商；默认写入已存在于模型行。

## handoff
- 完成。独立预览位于 `release/provider-default-context-20260915/mac-arm64/OpenCraft Preview.app`，当前窗口保持菜单打开；未提交、推送或发布。

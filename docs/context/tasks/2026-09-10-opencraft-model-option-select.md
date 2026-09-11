---
id: task-opencraft-model-option-select-2026-09-10
type: task
scope: OpenCraft Hermes Models 的 Option 与 Select 统一消费 Host 语义 token，并修复设置模态窗口内下拉内容的交互层级。
triggers: ["model option token", "model select portal", "floating control"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-10-opencraft-model-option-select.md
status: completed
reviewed_at: 2026-09-10
review_due: 2026-12-09
revision: 1.1.0
precedence: task
derived: false
---

## goal

把 Hermes Models 的用途 Option 与 Radix Select 收敛到嵌入控制原语和语义 token；Select Portal 使用 Workbench 的 floating-control plane，确保在 application modal 内可见、可点击。

## non_goals

- 不改变模型配置、Provider、API Key 或模型探测业务状态。
- 不修改 mono2 frontend 的独立页面。
- 不发布生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-2026-09-10-model-options`：Option 和下拉框都要 token 化；下拉框当前点不开。
- 外部 Issue / MR：`unknown`。

## interface_refs / data_structure_refs

- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/components/ui/select.tsx`：嵌入页面共享 Select 原语。
- `opencraft/plugins/lightvela-hermes/src/upstream/agent-console.css`：Host 主题到嵌入控件 token 的唯一适配边界。
- `opencraft/packages/design-system/src/tokens.web.scss`：application-modal 与 floating-control 层级真源。
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-model-config/agent-model-config-panel.tsx`：模型用途选择业务状态 owner。

## history_context

- `current_design_refs`：`opencraft/docs/platform-architecture.md`。
- `relevant_evolution`：设置已迁入 application modal；Radix Portal 挂载在 `body`，不继承 modal stacking context。源码同步后 Select 丢失 `lv-floating-control`，触发器仍可聚焦但菜单绘制在 modal 后方。
- `superseded_refs`：无。

## acceptance

- Select trigger/content/item/separator 不再自持亮色与选中态，统一消费 `--lv-control-*` / `--lv-option-*`。
- 用途选择使用共享 Option 原语；checked/highlighted/disabled/focus 状态由语义 token 驱动。
- Select 与 Popover Portal 明确选择 `lv-floating-control`，层级来自 `--layer-floating-control`。
- 聚焦策略测试、插件 TypeScript 与 Web production build 通过。

## affected_paths

- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/components/ui/**`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- `opencraft/plugins/lightvela-hermes/src/upstream/agent-console.css`
- `opencraft/tests/lightvela-management-policy.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- 路由器无匹配 Pack；已按要求对 Select、Option、Portal 与设计 token 做限定搜索。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@4ade2ce71` | mono2 Task Pack、验证与文档约束 | 记录本次跨共享 UI 边界变更 |
| `opencraft/AGENTS.md@4ade2ce71` | Web/Expo 与嵌入边界 | 保持业务状态和呈现原语分离 |
| `opencraft/docs/platform-architecture.md@4ade2ce71` | 共享层级与 renderer 所有权 | Select Portal 只选择语义 plane |
| `opencraft/packages/design-system/src/tokens.web.scss@4ade2ce71` | 浏览器层级真源 | 使用 `--layer-floating-control` |
| `opencraft/apps/workbench-web/src/components/modal/modal-surface.tsx@4ade2ce71` | application modal 所有权 | 确认 Portal 是 modal 的 body sibling |

## evidence

- 根因证据：Workbench `application-modal` 使用语义层 230；Radix Select Content 挂载到 `body`，旧实现只使用 Tailwind `z-50`，因此 trigger 获得焦点但菜单绘制在设置模态窗后方。
- 新增共享 `OptionGroup`，页面只传值、标签、禁用策略与回调；radio/card 的 checked、focus、hover、disabled 视觉统一由 `--lv-option-*` 驱动。
- Select trigger/content/item/separator 已改为语义 class；Select/Popover Portal 统一选择 `lv-floating-control`（语义层 250），不再自持数值层级或固定亮色。
- 聚焦策略测试 1/1 通过；Hermes 插件与 Workbench Web TypeScript 通过；Workbench Web production build 通过。
- 文档系统校验通过（2291 文档、0 错误）；30 个当前工作区变更的 change-impact 校验通过，命中 `agent-gateway-runtime`，需要 `wisp/mono2-maintainers` Owner review。

## risks

- Radix content 挂到 `body` 后不在自定义 modal 的 DOM focus trap 内；Radix Select 自持打开期间的 roving focus，关闭后恢复 trigger。
- 回滚：恢复页面局部样式和 `z-50`；这会重新引入暗色不兼容和 modal 后方菜单。

## validation

- `cd opencraft && node --test --import tsx --test-name-pattern "embedded Hermes portals|model options" tests/lightvela-management-policy.test.ts`
- `cd opencraft && npm run typecheck -w @opencraft/plugin-lightvela-hermes`
- `cd opencraft && npm run build -w @opencraft/workbench-web`

## decisions

- 业务页面只提供 Option 值、标签、禁用与选择回调；Web 原语拥有 HTML radio 和状态属性，Host CSS 拥有颜色与交互视觉。
- 浮层组件选择 `floating-control` 语义 plane，不写数值 z-index。

## scan_scope

- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/components/ui/**`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-model-config/**`
- `opencraft/plugins/lightvela-hermes/src/upstream/agent-console.css`
- `opencraft/packages/design-system/src/**`
- `opencraft/apps/workbench-web/src/components/modal/**`

## scan_output

- 路由 query `OpenCraft Hermes Models select dropdown portal z-index option choice design tokens` 无 Pack 命中；限定搜索确认 Select Content 仅使用 `z-50`，低于 application modal 的语义层 230，且既有 CSS 已定义但组件未消费 `lv-floating-control`。

## handoff

- 当前状态：实现与本地验证完成，未 commit、push 或发布。
- 下一步：由用户确认后与工作区内既有首次 Bot 引导改动一并提交。
- 阻塞项：无。

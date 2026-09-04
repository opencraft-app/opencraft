---
id: agent-console-english-collection-labels-task
type: task
scope: 统一国际站英文控制台通道与模型集合入口的复数命名。
triggers: ["agent console english labels", "Channels Models", "国际站导航复数"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/agent-console-english-collection-labels.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：国际站控制台集合标签

## goal

将国际站英文控制台左侧导航及页面标题中的 `Channel` / `Model` 改为更自然的集合命名 `Channels` / `Models`。

## non_goals

- 不改变中文及其他非英文 locale 的现有翻译。
- 不把单个模型选择器、字段标签或实体名称改成复数。
- 不改变路由、配置数据或交互逻辑。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-agent-console-english-plurals`
- 用户确认按海外控制台惯例，把通道和模型集合入口改为英文复数。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-settings-page.tsx`：控制台左侧导航。
- `frontend/src/pages/marketing/agent-channel-panel.tsx`：通道页标题。
- `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`：模型页标题。
- 不变量：`/agents/channels`、`/agents/models` 路由和 Agent 配置协议不变。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：原英文词典把中文“通道”“模型”统一翻译成单数，既服务集合标题也服务单体字段，不能直接全局改词典。
- `superseded_refs`：无。

## acceptance

- 英文左侧导航显示 `Channels` 与 `Models`。
- 英文通道页和模型页标题分别显示 `Channels` 与 `Models`。
- 非英文 locale 继续使用现有词典；模型字段等单体语境继续显示单数。
- 聚焦测试和 i18n 门禁通过。

## affected_paths

- `frontend/src/pages/marketing/agent-provider-locale.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-provider-locale.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-channel-hint-style.test.ts`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/agent-console-english-collection-labels.md`

## required_context

- `frontend-product-surface`
- `site-environment-routing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库提交、Context 与验证规则 | 限定修改及 MR 范围 |
| `frontend/AGENTS.md@working-tree` | 前端服务规则 | 确定聚焦测试与 i18n 门禁 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 双站语言边界 | 保持中文和其他 locale 不变 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认国际站控制台属于共享前端展示层 |

## evidence

- 源码定位确认“通道”“模型”翻译键同时用于集合标题与单体字段，直接修改英文词典会把单个模型字段错误改为复数。
- 聚焦测试通过：4 个测试文件、79 个用例通过，覆盖英文复数解析、导航接线、通道标题和模型配置回归。
- `pnpm check` 通过：i18n 与文档检查通过，TypeScript 诊断 191，基线 276，新增 0。
- Documentation Validator 与 `git diff --check` 通过；Context catalog 已登记本 Task Pack。

## risks

- 语言切换后标题可能沿用旧值；标签解析在 render 时读取当前 `i18n.language`，并由 `useTranslation` 订阅语言变化。

## validation

- `pnpm vitest run src/pages/marketing/__tests__/agent-provider-locale.test.ts src/pages/marketing/__tests__/agent-channel-hint-style.test.ts src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`
- `pnpm check`
- 国际站英文 5174 浏览器检查。
- `git diff --check`

## decisions

- 使用语境化标签解析函数，仅在英文集合入口返回复数；不全局修改“通道”“模型”的英文词典。owner 为 `wisp/mono2-maintainers`。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`
- `frontend/src/i18n/generated/en-US.json`

## scan_output

- 导航与两个页面标题共三个集合语境；其余 `Model` 命中包含选择器、探测结果与字段标签，应保持单数。

## handoff

- 本地实现与验证完成；并入现有 MR !3611，尚未提交或推送。

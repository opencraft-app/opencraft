## goal
将创建 Bot 过程中的加载文案从 Hermes Agent 品牌改为 LightVela Bot，并保持现有动态省略号效果。

## non_goals
- 不调整创建流程、轮询、超时、动画节奏或失败状态。
- 不提交 MR、发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-11）：将“正在给 Hermes Agent 喂咖啡，唤醒大脑中...”改为“正在给 LightVela Bot 喂咖啡，唤醒大脑中...”，动态效果保持。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `CreatingLoadingView`。
- 文案正文不得包含句点；句点继续由 `dotCount` 每 450ms 生成 1 至 3 个。

## history_context
- `current_design_refs`：`docs/implementations/frontend-key-implementation.md`。
- `relevant_evolution`：当前实现以独立定时器渲染动态省略号。
- `superseded_refs`：无。

## acceptance
- 中文加载文案显示 LightVela Bot，不再显示 Hermes Agent。
- 动态省略号的计数、周期和布局不变。
- 快速开始文档与实现说明同步更新。
- 前端 i18n 与类型检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/i18n/generated/**`
- `frontend/src/content/docs/02-quickstart.md`
- `frontend/src/content/docs/global/02-quickstart.md`
- `docs/implementations/frontend-key-implementation.md`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/**`

## required_context
- `frontend-product-surface`
- `docs/context/project/services/frontend.md`
- `frontend/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@0cd79675c3` | 路由器要求 | 确认产品文档真源与 locale parity 要求 |
| `frontend/AGENTS.md@0cd79675c3` | 最近服务规则 | 确认前端最小门禁 |
| `docs/context/tasks/TASK-TEMPLATE.md@0cd79675c3` | Task Pack 契约 | 记录独立文案目标与证据 |

## evidence
- `pnpm i18n:extract` 生成新键 `k_831919bc`，中文、繁中、英文、西语、日语、韩语和印尼语均已补齐 LightVela Bot 文案。
- `pnpm check` 通过：i18n 结构校验通过，TypeScript `174 current / 276 baseline / 0 new / 102 resolved`；保留仓库既有 49 条翻译 warning。
- `sync:mono2-agent-console` 与 `check:mono2-agent-console` 通过，125 个 OpenCraft 生成闭包文件一致。
- 源码差异仅替换 `t(...)` 的品牌正文；`dotCount`、450ms 定时器、`dots` 计算和独立占位 span 均未改动。
- 文档完整性、暂存变更集 change-impact 与 `git diff --check` 均通过。

## risks
- 直接把 `...` 写入翻译文本会破坏动态效果：保持正文无句点，继续复用独立 `dots` span。
- locale 生成物可能漂移：运行 i18n 生成与结构检查，并同步 OpenCraft 生成闭包。

## validation
- `pnpm i18n:extract`
- `pnpm check`
- OpenCraft 同步与漂移检查
- 文档与 change-impact 检查

## decisions
- 仅替换品牌主体，不改动 `dotCount`、450ms 间隔或占位宽度。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/i18n/generated/**`
- 快速开始与实现说明中的旧文案

## scan_output
- 精确检索确认正文与动态点分离；旧文案还存在于 locale 生成物和两份快速开始文档中。

## handoff
- 实现与本地检查已完成；本次变更不包含合并、发布或线上回归。
